import { intro, isCancel, cancel, note, spinner, path, log, confirm, progress } from "@clack/prompts"
import { commitIter, deleteFile, repoExists } from "@huggingface/hub"
import { randomBytes } from "crypto"
import { readFileSync, statSync, unlinkSync } from "fs"
import { inspectFile, createHFRepo, HFDataManager, HFShard } from "../../hf/actions"
import { resolveAccounts } from "../../hf/accounts"
import { buildManifest, uploadManifest } from "../../hf/manifest"
import { resolveEffectiveRaid, planUpload } from "../../raid/layout"
import { splitIntoShards } from "../../raid/chunk"
import { computeParity } from "../../raid/parity"
import { RaidMode, ShardAssignment } from "../../raid/types"
import { formatBytes, logHFError, mimeFromExtension } from "../../utils/utils"
import { readRaidMode } from "../../utils/hfconf"
import { Encoder } from "../../cryptography/encoder"
import { KeyVault } from "../../cryptography/key-vault"
import { progressFetch } from "../../hf/progress-fetch"
import { ensureVaultOpen } from "../utils/vault-access"
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

    const accounts = resolveAccounts();
    if (accounts.length === 0) {
        cancel("No Hugging Face account is configured yet — set one up in Settings -> Configuration.");
        return;
    }

    const { mode, reason } = resolveEffectiveRaid(readRaidMode(), accounts.length);
    if (reason) {
        log.info(reason);
    }

    const plan = planUpload(mode, accounts);
    const uniqueAccounts = [...new Map(plan.assignments.map(a => [a.account.id, a.account])).values()];

    // Ensure every repo this upload touches exists
    const repoSpinner = spinner();
    repoSpinner.start("Checking repositories...");

    for (const account of uniqueAccounts) {
        if (!(await repoExists({ repo: account.repo, accessToken: account.token }))) {
            repoSpinner.message(`Creating repository for ${account.label}...`);
            await createHFRepo(account.repo, account.token);
        }
    }
    repoSpinner.stop("Repositories ready");

    // Encrypt — spinner since it's local I/O and fast relative to upload
    const encSpinner = spinner();
    encSpinner.start("Encrypting file...");
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
    uploadProgress.start("Preparing upload...");

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

            for await (const event of commitIter({
                repo: assignment.account.repo,
                accessToken: assignment.account.token,
                title: `Upload ${blobPath}`,
                fetch: progressFetch as typeof fetch,
                operations: [{
                    operation: "addOrUpdate",
                    path: blobPath,
                    content: new Blob([buf as unknown as BlobPart]),
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
        return;
    }

    advanceTo(100, "Upload complete");
    uploadProgress.stop(`Uploaded ${formatBytes(totalBytes)} across ${shardEntries.length} shard(s)`);

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

    // Persist metadata — the AES key is already in the encrypted vault
    // (stored by Encoder.forNewFile), so files stay decryptable even after
    // an app reset (e.g. .hfcoll.db being wiped/rebuilt) as long as .hfkey survives
    HFDataManager.getInstance().addFile({
        id: fileId,
        name: metadata.name,
        size: metadata.size,
        mime: mimeFromExtension(metadata.extension),
        createdAt: metadata.createdAt.toISOString(),
        iv: encoder.getIV().toString("hex"),
        tag: encoder.getAuthTag().toString("hex"),
        raid: mode,
        cipherLength,
        shards,
    });

    unlinkSync(tempCipherPath);

    const deleteOriginal = await confirm({
        message: "Delete original file after successful upload?"
    });

    if (!isCancel(deleteOriginal) && deleteOriginal) {
        unlinkSync(filePathStr);
        log.success("Original file deleted.");
    }

    log.success(`Upload complete — id: ${fileId}`);
}

/** Slices/replicates the encrypted buffer into one Buffer per shard assignment, per RAID mode. */
function buildShardBuffers(
    mode: RaidMode,
    assignments: ShardAssignment[],
    cipherBuffer: Buffer
): Map<ShardAssignment, Buffer> {
    const result = new Map<ShardAssignment, Buffer>();

    if (mode === "none") {
        result.set(assignments[0], cipherBuffer);
        return result;
    }

    if (mode === "raid1") {
        for (const assignment of assignments) {
            result.set(assignment, cipherBuffer);
        }
        return result;
    }

    // raid0 / raid6: split across the "data" assignments, in index order
    const dataAssignments = assignments
        .filter(a => a.role === "data")
        .sort((a, b) => a.index - b.index);

    const dataShards = splitIntoShards(cipherBuffer, dataAssignments.length);
    dataAssignments.forEach((assignment, i) => result.set(assignment, dataShards[i]));

    if (mode === "raid6") {
        const pAssignment = assignments.find(a => a.role === "parity-p")!;
        const qAssignment = assignments.find(a => a.role === "parity-q")!;
        const { p, q } = computeParity(dataShards);
        result.set(pAssignment, p);
        result.set(qAssignment, q);
    }

    return result;
}
