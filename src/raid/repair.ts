import { HFDataManager, HFFileEntry, HFShard } from "../hf/actions";
import { HFAccount } from "../hf/accounts";
import { buildManifest, uploadManifest } from "../hf/manifest";
import { fetchBlobBytes, uploadBlobBytes } from "./blob-io";
import { computeParity, reconstruct } from "./parity";
import { entryStatus, RemoteIndex, shardStatus } from "./status";

export interface RepairCandidate {
    entry: HFFileEntry;
    missingShards: HFShard[];
}

/**
 * Files worth repairing: RAID1/RAID6 entries currently "degraded" (some
 * shard(s) confirmed missing, but still fully recoverable right now).
 * RAID0/"none" never show up here — they have no redundancy to repair
 * from in the first place (a missing shard there is "lost", not "degraded").
 */
export function findRepairCandidates(tracked: HFFileEntry[], index: RemoteIndex): RepairCandidate[] {
    const candidates: RepairCandidate[] = [];

    for (const entry of tracked) {
        if (entry.raid !== "raid1" && entry.raid !== "raid6") continue;
        if (entryStatus(index, entry) !== "degraded") continue;

        const missingShards = entry.shards.filter(s => shardStatus(index, s) === "missing");
        if (missingShards.length > 0) {
            candidates.push({ entry, missingShards });
        }
    }

    return candidates;
}

/**
 * Picks which configured account a repaired shard should land on: the
 * shard's original account if it's still configured (the account itself
 * is fine, just that one blob got deleted), otherwise any configured
 * account that doesn't already hold a shard for this file.
 */
function pickTargetAccount(missing: HFShard, accounts: HFAccount[], usedAccountIds: Set<string>): HFAccount | undefined {
    const same = accounts.find(a => a.id === missing.accountId);
    if (same) return same;

    return accounts.find(a => !usedAccountIds.has(a.id));
}

interface RepairResult {
    ok: boolean;
    message: string;
}

/**
 * Repairs one degraded entry: reconstructs the missing shard(s) from
 * whatever redundancy is still intact, re-uploads them to a target
 * account, updates the local shard list, and refreshes the manifest on
 * every account now holding a shard for this file.
 */
export async function repairEntry(candidate: RepairCandidate, accounts: HFAccount[]): Promise<RepairResult> {
    const { entry, missingShards } = candidate;
    const accountFor = (id: string) => accounts.find(a => a.id === id);

    const usedAccountIds = new Set(
        entry.shards.filter(s => !missingShards.includes(s)).map(s => s.accountId)
    );

    let recoveredBytes: Map<HFShard, Buffer>;
    try {
        recoveredBytes = entry.raid === "raid1"
            ? await recoverRaid1(entry, missingShards, accountFor)
            : await recoverRaid6(entry, missingShards, accountFor);
    }
    catch (e) {
        return { ok: false, message: `"${entry.name}": ${(e as Error).message}` };
    }

    const replacements: HFShard[] = [];

    for (const missing of missingShards) {
        const bytes = recoveredBytes.get(missing);
        if (!bytes) {
            return { ok: false, message: `"${entry.name}": could not recover its ${missing.role} shard.` };
        }

        const target = pickTargetAccount(missing, accounts, usedAccountIds);
        if (!target) {
            return { ok: false, message: `"${entry.name}": no spare account available to hold its repaired ${missing.role} shard.` };
        }

        usedAccountIds.add(target.id);
        const path = await uploadBlobBytes(target, bytes, "Repair");

        replacements.push({ accountId: target.id, repository: target.repo, path, role: missing.role, index: missing.index });
    }

    const newShards = [
        ...entry.shards.filter(s => !missingShards.includes(s)),
        ...replacements,
    ];

    HFDataManager.getInstance().setShards(entry.id, newShards);

    const manifest = buildManifest({ id: entry.id, raid: entry.raid, cipherLength: entry.cipherLength, iv: entry.iv, tag: entry.tag, shards: newShards });
    const touchedAccounts = [...new Map(newShards.map(s => [s.accountId, accountFor(s.accountId)])).values()]
        .filter((a): a is HFAccount => a !== undefined);

    for (const account of touchedAccounts) {
        await uploadManifest(account, manifest);
    }

    return { ok: true, message: `"${entry.name}": repaired ${replacements.length} shard(s).` };
}

async function recoverRaid1(
    entry: HFFileEntry,
    missingShards: HFShard[],
    accountFor: (id: string) => HFAccount | undefined
): Promise<Map<HFShard, Buffer>> {
    const survivors = entry.shards.filter(s => s.role === "mirror" && !missingShards.includes(s));

    let bytes: Buffer | null = null;
    for (const survivor of survivors) {
        const account = accountFor(survivor.accountId);
        if (!account) continue;
        bytes = await fetchBlobBytes(account, survivor.path);
        if (bytes) break;
    }

    if (!bytes) {
        throw new Error("no reachable mirror to repair from");
    }

    const result = new Map<HFShard, Buffer>();
    for (const missing of missingShards) {
        result.set(missing, bytes);
    }
    return result;
}

async function recoverRaid6(
    entry: HFFileEntry,
    missingShards: HFShard[],
    accountFor: (id: string) => HFAccount | undefined
): Promise<Map<HFShard, Buffer>> {
    const dataAssignments = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
    const pShard = entry.shards.find(s => s.role === "parity-p");
    const qShard = entry.shards.find(s => s.role === "parity-q");

    const fetchIfPresent = async (shard: HFShard | undefined): Promise<Buffer | null> => {
        if (!shard || missingShards.includes(shard)) return null;
        const account = accountFor(shard.accountId);
        if (!account) return null;
        return fetchBlobBytes(account, shard.path);
    };

    const dataBuffers = await Promise.all(dataAssignments.map(fetchIfPresent));
    const pBuf = await fetchIfPresent(pShard);
    const qBuf = await fetchIfPresent(qShard);

    const missingDataIndices = dataAssignments
        .filter(s => missingShards.includes(s))
        .map(s => s.index);

    // reconstruct() is a no-op passthrough when nothing's missing from dataBuffers
    const fullData = reconstruct(dataBuffers, pBuf, qBuf);

    const result = new Map<HFShard, Buffer>();

    for (const index of missingDataIndices) {
        const shard = dataAssignments.find(s => s.index === index)!;
        result.set(shard, fullData[index]);
    }

    const needP = pShard && missingShards.includes(pShard);
    const needQ = qShard && missingShards.includes(qShard);
    if (needP || needQ) {
        const { p, q } = computeParity(fullData);
        if (needP) result.set(pShard!, p);
        if (needQ) result.set(qShard!, q);
    }

    return result;
}
