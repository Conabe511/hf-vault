import { intro, isCancel, cancel, note, spinner, path, log, confirm, progress } from "@clack/prompts"
import { commitIter, deleteFile, repoExists } from "@huggingface/hub"
import { randomBytes } from "crypto"
import { readFileSync, unlinkSync, writeFileSync } from "fs"
import { extname } from "node:path"
import { pathToFileURL } from "url"
import { inspectFile, createHFRepo, HFDataManager, HFFileEntry, HFShard } from "../../hf/actions"
import { HFAccount, resolveAccounts } from "../../hf/accounts"
import { buildManifest, uploadManifest } from "../../hf/manifest"
import { buildShardBuffers, resolveEffectiveRaid, planUpload } from "../../raid/layout"
import { RaidMode, ShardAssignment, UploadPlan } from "../../raid/types"
import { formatBytes, logHFError, mimeFromExtension } from "../../utils/utils"
import { readRaidMode } from "../../utils/hfconf"
import { Encoder } from "../../cryptography/encoder"
import { KeyVault } from "../../cryptography/key-vault"
import { ensureVaultOpen } from "../utils/vault-access"
import { pickFolder } from "../utils/folder-picker"
import { clearScreen } from "../utils/screen"

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

    const folder = await pickFolder(HFDataManager.getInstance().listFolders(), "Which vault folder should this go into?");
    if (folder === undefined) {
        cancel("Upload cancelled");
        return;
    }

    const plan = await prepareUploadPlan();
    if (!plan) return;

    const result = await uploadOneFile(filePathStr, folder, plan);

    if (!result.ok) {
        return;
    }

    const deleteOriginal = await confirm({
        message: "Delete original file after successful upload?"
    });

    if (!isCancel(deleteOriginal) && deleteOriginal) {
        unlinkSync(filePathStr);
        log.success("Original file deleted.");
    }

    log.success(`Upload complete — id: ${result.fileId}`);
}

interface PreparedUploadPlan {
    mode: RaidMode;
    plan: UploadPlan;
    uniqueAccounts: HFAccount[];
}

/**
 * Resolves accounts/RAID mode/shard plan and makes sure every repo the
 * plan touches exists — once per batch (single file or a whole folder),
 * not once per file, since it's about the accounts, not any one file.
 */
export async function prepareUploadPlan(): Promise<PreparedUploadPlan | null> {
    const accounts = resolveAccounts();
    if (accounts.length === 0) {
        cancel("No Hugging Face account is configured yet — set one up in Settings -> Configuration.");
        return null;
    }

    const { mode, reason } = resolveEffectiveRaid(readRaidMode(), accounts.length);
    if (reason) {
        log.info(reason);
    }

    const plan = planUpload(mode, accounts);
    const uniqueAccounts = [...new Map(plan.assignments.map(a => [a.account.id, a.account])).values()];

    const repoSpinner = spinner();
    repoSpinner.start("Checking repositories...");

    for (const account of uniqueAccounts) {
        if (!(await repoExists({ repo: account.repo, accessToken: account.token }))) {
            repoSpinner.message(`Creating repository for ${account.label}...`);
            await createHFRepo(account.repo, account.token);
        }
    }
    repoSpinner.stop("Repositories ready");

    return { mode, plan, uniqueAccounts };
}

/**
 * Encrypts, RAID-splits, uploads, and tracks one file under the given
 * vault folder, using an already-resolved upload plan (see
 * prepareUploadPlan). Shared by the single-file and folder upload flows.
 */
export async function uploadOneFile(
    filePathStr: string,
    folder: string,
    { mode, plan, uniqueAccounts }: PreparedUploadPlan,
    // Overrides the tracked name/mime — for callers whose local path is a
    // throwaway temp file, not the file's real name (e.g. upload-from-URL,
    // where filePathStr is just where the download landed).
    nameOverride?: string
): Promise<{ ok: true; fileId: string } | { ok: false }> {
    const metadata = await inspectFile(filePathStr);
    const name = nameOverride ?? metadata.name;
    const mime = mimeFromExtension(nameOverride ? extname(nameOverride) : metadata.extension);

    // Encrypt — spinner since it's local I/O and fast relative to upload
    const encSpinner = spinner();
    encSpinner.start(`Encrypting ${name}...`);
    const fileId = randomBytes(16).toString("hex");
    const encoder = Encoder.forNewFile(fileId);
    const tempCipherPath = randomBytes(16).toString("hex");
    await encoder.encryptFile(filePathStr, tempCipherPath);
    encSpinner.stop("File encrypted");

    const cipherBuffer = readFileSync(tempCipherPath);
    const cipherLength = cipherBuffer.length;

    const shardBuffers = buildShardBuffers(mode, plan.assignments, cipherBuffer);
    const totalBytes = [...shardBuffers.values()].reduce((sum, b) => sum + b.length, 0);

    const uploadProgress = progress({ max: 100 });
    uploadProgress.start(`Preparing upload of ${name}...`);

    // Same monotonic advance() trick as a single-shard upload, just scaled
    // to give each shard a slice of the 0-100 bar proportional to its size
    let position = 0;
    const advanceTo = (target: number, message: string) => {
        const delta = Math.min(Math.floor(target), 100) - position;
        uploadProgress.advance(Math.max(delta, 0), message);
        position += Math.max(delta, 0);
    };

    const shardEntries = [...shardBuffers.entries()];
    const uploaded: { assignment: ShardAssignment; path: string }[] = [];
    let bytesDoneBefore = 0;

    try {
        for (let i = 0; i < shardEntries.length; i++) {
            const [assignment, buf] = shardEntries[i];
            const blobPath = randomBytes(16).toString("hex");
            const base = (bytesDoneBefore / totalBytes) * 100;
            const weight = (buf.length / totalBytes) * 100;
            const label = `${assignment.role} shard ${i + 1}/${shardEntries.length} (${assignment.account.label})`;

            // Content is written to a real temp file and referenced by URL
            // (rather than handed over as an in-memory Blob) to go through
            // the same, well-tested upload path the app always used for its
            // single-file uploads — a raw in-memory Blob was observed to
            // produce a corrupted xorb server-side on Hugging Face's Xet
            // storage (buckets require Xet; it can't be turned off for them).
            const shardTempPath = randomBytes(16).toString("hex");
            writeFileSync(shardTempPath, buf);

            try {
                // No custom `fetch` here: bucket uploads go through Hugging
                // Face's Xet CAS protocol (raw binary xorb POSTs), not the
                // LFS/S3-PUT path progressFetch's body-substitution trick was
                // built and tested for — wrapping that request body was
                // producing a corrupted xorb server-side. commitIter still
                // reports per-shard "uploading" progress on its own either way.
                for await (const event of commitIter({
                    repo: assignment.account.repo,
                    accessToken: assignment.account.token,
                    title: `Upload ${blobPath}`,
                    operations: [{
                        operation: "addOrUpdate",
                        path: blobPath,
                        content: pathToFileURL(shardTempPath),
                    }],
                })) {
                    if (event.event === "fileProgress" && event.state === "hashing") {
                        advanceTo(base + event.progress * weight * 0.2, `${label}: hashing...`);
                    }
                    else if (event.event === "fileProgress" && event.state === "uploading") {
                        advanceTo(
                            base + weight * (0.2 + event.progress * 0.79),
                            `${label}: uploading... ${formatBytes(event.progress * buf.length)} / ${formatBytes(buf.length)}`
                        );
                    }
                    else if (event.event === "phase" && event.phase === "committing") {
                        advanceTo(base + weight * 0.99, `${label}: finalizing commit...`);
                    }
                }
            } finally {
                unlinkSync(shardTempPath);
            }

            uploaded.push({ assignment, path: blobPath });
            bytesDoneBefore += buf.length;
        }
    } catch (err) {
        uploadProgress.stop("Upload failed");
        logHFError(err);

        // Best-effort cleanup of whatever already landed remotely, plus
        // the vault key registered when the Encoder was created — don't
        // leave orphans for a file that never fully made it
        for (const shard of uploaded) {
            try {
                await deleteFile({
                    repo: shard.assignment.account.repo,
                    path: shard.path,
                    accessToken: shard.assignment.account.token,
                });
            } catch (e) { /* best-effort */ }
        }

        unlinkSync(tempCipherPath);
        KeyVault.getInstance().deleteKey(fileId);
        return { ok: false };
    }

    advanceTo(100, "Upload complete");
    uploadProgress.stop(`Uploaded ${name} — ${formatBytes(totalBytes)} across ${shardEntries.length} shard(s)`);

    const shards: HFShard[] = uploaded.map(({ assignment, path: blobPath }) => ({
        accountId: assignment.account.id,
        repository: assignment.account.repo,
        path: blobPath,
        role: assignment.role,
        index: assignment.index,
    }));

    // Manifest lets the remote itself describe how these shards fit back
    // together — replicated to every account this upload touched
    const manifestSpinner = spinner();
    manifestSpinner.start("Writing shard manifest...");
    const manifest = buildManifest({
        id: fileId,
        raid: mode,
        cipherLength,
        iv: encoder.getIV().toString("hex"),
        tag: encoder.getAuthTag().toString("hex"),
        shards,
    });
    for (const account of uniqueAccounts) {
        await uploadManifest(account, manifest);
    }
    manifestSpinner.stop("Manifest written");

    const entry: HFFileEntry = {
        id: fileId,
        name,
        size: metadata.size,
        mime,
        createdAt: metadata.createdAt.toISOString(),
        iv: encoder.getIV().toString("hex"),
        tag: encoder.getAuthTag().toString("hex"),
        raid: mode,
        cipherLength,
        shards,
        folder,
        raw: false,
    };

    // Persist metadata — the AES key is already in the encrypted vault
    // (stored by Encoder.forNewFile), so files stay decryptable even after
    // an app reset (e.g. .hfcoll.db being wiped/rebuilt) as long as .hfkey survives
    HFDataManager.getInstance().addFile(entry);

    unlinkSync(tempCipherPath);

    return { ok: true, fileId };
}
