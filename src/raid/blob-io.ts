import { commitIter, downloadFile } from "@huggingface/hub";
import { randomBytes } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { HFAccount } from "../hf/accounts";
import { HFFileEntry } from "../hf/actions";
import { joinShards } from "./chunk";
import { reconstruct } from "./parity";

/**
 * Raw shard fetch/upload primitives shared by every maintenance operation
 * that needs to move shard bytes around without the interactive
 * progress-bar UI of the main upload/download flows (repair, rebalance).
 */

export async function fetchBlobBytes(account: HFAccount, path: string): Promise<Buffer | null> {
    try {
        const blob = await downloadFile({ repo: account.repo, path, accessToken: account.token });
        if (!blob) return null;
        return Buffer.from(await blob.arrayBuffer());
    }
    catch (e) {
        return null;
    }
}

export async function uploadBlobBytes(account: HFAccount, bytes: Buffer, title: string): Promise<string> {
    const path = randomBytes(16).toString("hex");
    const tempPath = randomBytes(16).toString("hex");
    writeFileSync(tempPath, bytes);

    try {
        // File-backed content, no custom fetch — see upload-section.ts: an
        // in-memory Blob and a custom progress-tracking fetch both
        // corrupted Xet uploads (buckets require Xet, can't be turned off).
        for await (const _event of commitIter({
            repo: account.repo,
            accessToken: account.token,
            title: `${title} ${path}`,
            operations: [{ operation: "addOrUpdate", path, content: pathToFileURL(tempPath) }],
        })) {
            // caller runs this under its own spinner/progress if any
        }
    } finally {
        unlinkSync(tempPath);
    }

    return path;
}

/**
 * Fetches and reassembles a file's full ciphertext from its shards —
 * reconstructing via parity/mirror if some are missing, same as the
 * interactive download flow, just without progress reporting. Used by
 * maintenance operations (currently: rebalance) that need the complete
 * bytes rather than just decrypting for the user. Returns null if
 * unrecoverable with what's currently reachable.
 */
export async function fetchFullCiphertext(entry: HFFileEntry, accounts: HFAccount[]): Promise<Buffer | null> {
    const accountFor = (id: string) => accounts.find(a => a.id === id);

    if (entry.raid === "none") {
        const shard = entry.shards[0];
        const account = accountFor(shard.accountId);
        return account ? fetchBlobBytes(account, shard.path) : null;
    }

    if (entry.raid === "raid1") {
        for (const shard of entry.shards) {
            const account = accountFor(shard.accountId);
            if (!account) continue;
            const bytes = await fetchBlobBytes(account, shard.path);
            if (bytes) return bytes;
        }
        return null;
    }

    if (entry.raid === "raid0") {
        const dataShards = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
        const buffers: Buffer[] = [];

        for (const shard of dataShards) {
            const account = accountFor(shard.accountId);
            const bytes = account ? await fetchBlobBytes(account, shard.path) : null;
            if (!bytes) return null;
            buffers.push(bytes);
        }

        return joinShards(buffers, entry.cipherLength);
    }

    // raid6
    const dataAssignments = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
    const pShard = entry.shards.find(s => s.role === "parity-p");
    const qShard = entry.shards.find(s => s.role === "parity-q");

    const fetchIfConfigured = async (shard: typeof pShard) => {
        if (!shard) return null;
        const account = accountFor(shard.accountId);
        return account ? fetchBlobBytes(account, shard.path) : null;
    };

    const dataBuffers = await Promise.all(dataAssignments.map(fetchIfConfigured));
    const pBuf = await fetchIfConfigured(pShard);
    const qBuf = await fetchIfConfigured(qShard);

    try {
        const fullData = reconstruct(dataBuffers, pBuf, qBuf);
        return joinShards(fullData, entry.cipherLength);
    }
    catch (e) {
        return null;
    }
}
