import { intro, isCancel, cancel, note, spinner, path, log, confirm } from "@clack/prompts";
import { repoExists, uploadFilesWithProgress } from "@huggingface/hub";
import { randomBytes } from "crypto";
import { statSync, unlinkSync } from "fs";
import { pathToFileURL } from "url";
import { inspectFile, createHFRepo, HFDataManager } from "../../hf/actions";
import { formatBytes, logHFError, mimeFromExtension } from "../../utils/utils";
import { Encoder } from "../../cryptography/encoder";
import { KeyVault } from "../../cryptography/key-vault";
import { ensureVaultOpen } from "../utils/vault-access";

export async function handleUploadProcess() {
    intro("Upload File");

    // Single path prompt — removed the duplicate text() call
    const filePath = await path({
        message: 'Select a file to upload:',
        root: process.cwd(),
        directory: false,
    });

    if (isCancel(filePath)) {
        cancel("Upload cancelled");
        return;
    }

    const filePathStr = filePath.toString();
    const metadata = await inspectFile(filePathStr);

    note(
        `Name:  ${metadata.name}\nSize:  ${formatBytes(metadata.size)}\nType:  ${metadata.extension}`,
        "File Information"
    );

    const proceed = await confirm({
        message: "Continue with encryption and upload?"
    });

    if (isCancel(proceed) || !proceed) {
        cancel("Upload cancelled");
        return;
    }

    // The vault must be unlocked before encrypting: the new file's key
    // is stored in it the moment the Encoder is created
    if (!await ensureVaultOpen()) {
        cancel("Upload cancelled");
        return;
    }

    // Ensure the repo exists
    const repoSpinner = spinner();
    repoSpinner.start("Checking repository...");

    if (!process.env.HF_REPO) {
        cancel("The repository is not configured in .env")
        return;
    }
    
    if (!(await repoExists({ repo: process.env.HF_REPO, accessToken: process.env.HF_TOKEN }))) {
        repoSpinner.message("Creating repository...");
        await createHFRepo(process.env.HF_REPO);
    }
    repoSpinner.stop("Repository ready");

    // Encrypt — spinner since it's local I/O and fast relative to upload
    const encSpinner = spinner();
    encSpinner.start("Encrypting file...");
    const fileId = randomBytes(16).toString("hex");
    const encoder = Encoder.forNewFile(fileId);
    const outputName = randomBytes(16).toString("hex");
    await encoder.encryptFile(filePathStr, outputName);
    encSpinner.stop("File encrypted");

    const totalBytes = statSync(outputName).size;

    const uploadSpinner = spinner();
    uploadSpinner.start("Uploading...");

    try {
        // Drain the generator fully — the upload only completes once all events are consumed
        for await (const _ of uploadFilesWithProgress({
            repo: process.env.HF_REPO,
            accessToken: process.env.HF_TOKEN,
            files: [{
                path: outputName,
                content: pathToFileURL(outputName),
            }],
        })) {
            // ignoring progress events, just letting the upload run to completion
        }
    } catch (err) {
        uploadSpinner.stop("Upload failed");
        logHFError(err);
        unlinkSync(outputName);
        // The key was registered when the Encoder was created — don't
        // leave an orphan entry in the vault for a file that never made it
        KeyVault.getInstance().deleteKey(fileId);
        return;
    }

    uploadSpinner.stop(`Uploaded ${formatBytes(totalBytes)}`);

    // Persist metadata — the AES key is already in the encrypted vault
    // (stored by Encoder.forNewFile), so files stay decryptable even after
    // an app reset (e.g. .hfcoll being wiped/rebuilt) as long as .hfkey survives
    HFDataManager.getInstance().addFile({
        id: fileId,
        name: metadata.name,
        size: metadata.size,
        mime: mimeFromExtension(metadata.extension),
        createdAt: metadata.createdAt.toISOString(),
        repository: process.env.HF_REPO,
        path: outputName,
        iv: encoder.getIV().toString("hex"),
        tag: encoder.getAuthTag().toString("hex"),
    });

    unlinkSync(outputName);

    const deleteOriginal = await confirm({
        message: "Delete original file after successful upload?"
    });

    if (!isCancel(deleteOriginal) && deleteOriginal) {
        unlinkSync(filePathStr);
        log.success("Original file deleted.");
    }

    log.success(`Upload complete — id: ${fileId}`);
}