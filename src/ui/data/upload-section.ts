import { intro, isCancel, cancel, note, spinner, path, log, confirm, progress } from "@clack/prompts";
import { commitIter, repoExists } from "@huggingface/hub";
import { randomBytes } from "crypto";
import { statSync, unlinkSync } from "fs";
import { pathToFileURL } from "url";
import { inspectFile, createHFRepo, HFDataManager } from "../../hf/actions";
import { formatBytes, logHFError, mimeFromExtension } from "../../utils/utils";
import { Encoder } from "../../cryptography/encoder";
import { KeyVault } from "../../cryptography/key-vault";
import { progressFetch } from "../../hf/progress-fetch";
import { ensureVaultOpen } from "../utils/vault-access";
import { clearScreen } from "../utils/screen";

export async function handleUploadProcess() {
    clearScreen();
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

    const uploadProgress = progress({ max: 100 });
    uploadProgress.start("Preparing upload...");

    // The generator reports fileProgress 0->1 TWICE per file: once while
    // hashing, once while uploading. Fed straight into one bar that looks
    // like the bar filling up and snapping back — so both passes are mapped
    // onto a single 0-100 scale instead. advance() can't go backwards,
    // hence the monotonic "position" tracking.
    let position = 0;
    const advanceTo = (target: number, message: string) => {
        const delta = Math.min(Math.floor(target), 100) - position;
        uploadProgress.advance(Math.max(delta, 0), message);
        position += Math.max(delta, 0);
    };

    try {
        // Drain the generator fully — the upload only completes once all events are consumed
        // commitIter instead of uploadFilesWithProgress: same event stream,
        // but it accepts a custom fetch. The wrapper's own progress reporting
        // needs XMLHttpRequest (browser-only), so in Node it goes silent
        // during the transfer — progressFetch fills exactly that gap.
        for await (const event of commitIter({
            repo: process.env.HF_REPO,
            accessToken: process.env.HF_TOKEN,
            title: `Upload ${outputName}`,
            fetch: progressFetch,
            operations: [{
                operation: "addOrUpdate",
                path: outputName,
                content: pathToFileURL(outputName),
            }],
        })) {
            if (event.event === "fileProgress" && event.state === "hashing") {
                advanceTo(event.progress * 20, "Hashing...");
            }
            else if (event.event === "fileProgress" && event.state === "uploading") {
                advanceTo(
                    20 + event.progress * 79,
                    `Uploading... ${formatBytes(event.progress * totalBytes)} / ${formatBytes(totalBytes)}`
                );
            }
            else if (event.event === "phase" && event.phase === "committing") {
                advanceTo(99, "Finalizing commit...");
            }
        }
    } catch (err) {
        uploadProgress.stop("Upload failed");
        logHFError(err);
        unlinkSync(outputName);
        // The key was registered when the Encoder was created — don't
        // leave an orphan entry in the vault for a file that never made it
        KeyVault.getInstance().deleteKey(fileId);
        return;
    }

    advanceTo(100, "Upload complete");
    uploadProgress.stop(`Uploaded ${formatBytes(totalBytes)}`);

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