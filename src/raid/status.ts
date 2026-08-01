import { listFiles } from "@huggingface/hub";
import { HFFileEntry, HFShard } from "../hf/actions";
import { HFAccount } from "../hf/accounts";
import { isManifestPath } from "../hf/manifest";

// accountId -> paths that actually exist on that account's remote repo,
// or "unreachable" when the repo couldn't be listed
export type RemoteIndex = Map<string, Set<string> | "unreachable">;

/** Lists every configured account's repo once, building the RemoteIndex + total used bytes (manifests excluded). */
export async function fetchRemoteIndex(accounts: HFAccount[]): Promise<{ index: RemoteIndex; usedBytes: number }> {
    const index: RemoteIndex = new Map();
    let usedBytes = 0;

    for (const account of accounts) {
        try {
            const paths = new Set<string>();

            for await (const entry of listFiles({ repo: account.repo, accessToken: account.token })) {
                if (entry.type === "file") {
                    paths.add(entry.path);
                    if (!isManifestPath(entry.path)) {
                        usedBytes += entry.size;
                    }
                }
            }

            index.set(account.id, paths);
        }
        catch (e) {
            index.set(account.id, "unreachable");
        }
    }

    return { index, usedBytes };
}

export type ShardStatus = "synced" | "missing" | "unknown";
export type EntryStatus = "synced" | "degraded" | "lost" | "unknown";

export function shardStatus(index: RemoteIndex, shard: HFShard): ShardStatus {
    const paths = index.get(shard.accountId);

    if (!paths || paths === "unreachable") return "unknown";
    return paths.has(shard.path) ? "synced" : "missing";
}

/**
 * Rolls per-shard status up into one status for the file, according to
 * how much redundancy its RAID mode actually provides:
 * - synced: every shard confirmed present.
 * - degraded: some shards missing/unreachable, but the mode's redundancy
 *   (a surviving mirror, or RAID6 parity) can still recover the file.
 * - lost: confirmed missing shard(s) with no redundancy left to cover it.
 * - unknown: nothing confirmed missing, but not enough repos were
 *   reachable to call it fully synced either.
 */
export function entryStatus(index: RemoteIndex, entry: HFFileEntry): EntryStatus {
    const dataShards = entry.shards.filter(s => s.role === "data" || s.role === "mirror");
    const dataStatuses = dataShards.map(s => shardStatus(index, s));

    if (entry.raid === "raid1") {
        if (dataStatuses.every(s => s === "synced")) return "synced";
        if (dataStatuses.some(s => s === "synced")) return "degraded";
        if (dataStatuses.every(s => s === "missing")) return "lost";
        return "unknown";
    }

    if (entry.raid === "none" || entry.raid === "raid0") {
        if (dataStatuses.every(s => s === "synced")) return "synced";
        if (dataStatuses.some(s => s === "missing")) return "lost";
        return "unknown";
    }

    // raid6: data and parity shards are interchangeable redundancy units —
    // any 2 losses anywhere among the D+2 members still leave the D data
    // shards fully reconstructible (that's the defining property of
    // RAID6/Reed-Solomon dual parity), regardless of whether the losses
    // land on data or parity. So the loss count alone (not which role it
    // hit) determines recoverability; unlike the old version of this
    // function, losing only parity (data untouched) is still surfaced as
    // "degraded" rather than silently "synced", since the safety margin
    // for a *future* loss has shrunk even though nothing is unreadable yet.
    const parityShards = entry.shards.filter(s => s.role === "parity-p" || s.role === "parity-q");
    const parityStatuses = parityShards.map(s => shardStatus(index, s));

    const allStatuses = [...dataStatuses, ...parityStatuses];
    const missing = allStatuses.filter(s => s === "missing").length;
    const unknown = allStatuses.filter(s => s === "unknown").length;

    if (missing === 0 && unknown === 0) return "synced";
    if (missing > 2) return "lost";
    if (missing + unknown > 2) return "unknown"; // could still tip past the 2-loss tolerance
    return "degraded";
}
