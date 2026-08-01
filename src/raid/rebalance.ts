import { deleteFile } from "@huggingface/hub";
import { HFDataManager, HFFileEntry, HFShard } from "../hf/actions";
import { HFAccount } from "../hf/accounts";
import { buildManifest, deleteManifest, uploadManifest } from "../hf/manifest";
import { fetchFullCiphertext, uploadBlobBytes } from "./blob-io";
import { buildShardBuffers, planUpload } from "./layout";
import { entryStatus, RemoteIndex } from "./status";

export interface RebalanceCandidate {
    entry: HFFileEntry;
    currentShardCount: number;
    desiredShardCount: number;
}

const MIN_ACCOUNTS_FOR: Record<"raid0" | "raid1" | "raid6", number> = {
    raid0: 2,
    raid1: 2,
    raid6: 4,
};

/**
 * Files that could make use of accounts added since they were last
 * uploaded/rebalanced: same RAID mode, but planning it fresh against
 * every currently configured account would use MORE of them than the
 * file's current shard layout does (a wider stripe, another mirror, or a
 * wider data+parity split). This is "grow the array", not "change RAID
 * level" — a file's mode never changes, only how many members it spans.
 *
 * Only "synced" files are candidates: a degraded file should be repaired
 * first (see repair.ts) so rebalance always starts from a fully healthy,
 * unambiguous shard set.
 */
export function findRebalanceCandidates(
    tracked: HFFileEntry[],
    accounts: HFAccount[],
    index: RemoteIndex
): RebalanceCandidate[] {
    const candidates: RebalanceCandidate[] = [];

    for (const entry of tracked) {
        if (entry.raid === "none") continue; // always exactly 1 account by definition, nothing to grow into
        if (accounts.length < MIN_ACCOUNTS_FOR[entry.raid]) continue;
        if (entryStatus(index, entry) !== "synced") continue;

        const desiredPlan = planUpload(entry.raid, accounts);
        const desiredShardCount = entry.raid === "raid1"
            ? desiredPlan.assignments.length
            : desiredPlan.assignments.filter(a => a.role === "data").length;

        const currentShardCount = entry.raid === "raid1"
            ? entry.shards.filter(s => s.role === "mirror").length
            : entry.shards.filter(s => s.role === "data").length;

        if (desiredShardCount > currentShardCount) {
            candidates.push({ entry, currentShardCount, desiredShardCount });
        }
    }

    return candidates;
}

interface RebalanceResult {
    ok: boolean;
    message: string;
}

/**
 * Re-plans one file across every currently configured account (same RAID
 * mode, wider split), uploads the new shard set, swaps it in, then
 * retires whatever the old layout no longer needs. The new layout is
 * fully written (shards + manifest) before anything old is deleted, so a
 * failure partway through never leaves the file worse off than it started.
 */
export async function rebalanceEntry(entry: HFFileEntry, accounts: HFAccount[]): Promise<RebalanceResult> {
    const cipherBuffer = await fetchFullCiphertext(entry, accounts);
    if (!cipherBuffer) {
        return { ok: false, message: `"${entry.name}": could not reconstruct its current content to rebalance.` };
    }

    const plan = planUpload(entry.raid, accounts);
    const shardBuffers = buildShardBuffers(entry.raid, plan.assignments, cipherBuffer);

    const newShards: HFShard[] = [];
    const uploadedLocations: { account: HFAccount; path: string }[] = [];

    try {
        for (const [assignment, buf] of shardBuffers) {
            const path = await uploadBlobBytes(assignment.account, buf, "Rebalance");
            newShards.push({
                accountId: assignment.account.id,
                repository: assignment.account.repo,
                path,
                role: assignment.role,
                index: assignment.index,
            });
            uploadedLocations.push({ account: assignment.account, path });
        }
    }
    catch (e) {
        // Best-effort cleanup of whatever landed before the failure — the
        // OLD shards are untouched, so the file is exactly as it was
        for (const { account, path } of uploadedLocations) {
            try {
                await deleteFile({ repo: account.repo, path, accessToken: account.token });
            } catch (e2) { /* best-effort */ }
        }
        return { ok: false, message: `"${entry.name}": rebalance upload failed (${(e as Error).message}). Left untouched.` };
    }

    // New layout first: write shards + manifest before touching anything old
    const manifest = buildManifest({ id: entry.id, raid: entry.raid, cipherLength: entry.cipherLength, iv: entry.iv, tag: entry.tag, shards: newShards });
    const newAccounts = [...new Map(newShards.map(s => [s.accountId, accounts.find(a => a.id === s.accountId)])).values()]
        .filter((a): a is HFAccount => a !== undefined);

    for (const account of newAccounts) {
        await uploadManifest(account, manifest);
    }

    HFDataManager.getInstance().setShards(entry.id, newShards);

    // Now retire the old layout: delete every old shard, and drop the
    // manifest from any account that's no longer part of this file at all
    const oldShards = entry.shards;
    const newAccountIds = new Set(newShards.map(s => s.accountId));

    for (const old of oldShards) {
        const account = accounts.find(a => a.id === old.accountId);
        if (!account) continue; // account no longer configured — nothing we can clean up there
        try {
            await deleteFile({ repo: account.repo, path: old.path, accessToken: account.token });
        } catch (e) { /* best-effort */ }
    }

    for (const old of oldShards) {
        if (newAccountIds.has(old.accountId)) continue; // manifest already refreshed above
        const account = accounts.find(a => a.id === old.accountId);
        if (account) await deleteManifest(account, entry.id);
    }

    return {
        ok: true,
        message: `"${entry.name}": rebalanced from ${oldShards.length} to ${newShards.length} shard(s) across ${newAccounts.length} account(s).`,
    };
}
