// RAID-aware ciphertext reconstruction — operates purely on ciphertext
// bytes (no AES key involved, see raid-layout.ts's header comment), so it's
// safe to run in the Worker even though the Worker never sees plaintext.
import { joinShards } from "../../../src/raid/chunk";
import { reconstruct as reconstructParity } from "../../../src/raid/parity";
import { HFFileEntry } from "./db";
import { HFAccount } from "./raid-types";
import { fetchBlob } from "./hf";

export async function fetchFullCiphertext(entry: HFFileEntry, accounts: HFAccount[]): Promise<Uint8Array | null> {
    const accountFor = (id: string) => accounts.find(a => a.id === id);

    if (entry.raid === "none") {
        const shard = entry.shards[0];
        const account = shard && accountFor(shard.accountId);
        return account ? fetchBlob(account, shard.path) : null;
    }

    if (entry.raid === "raid1") {
        for (const shard of entry.shards) {
            const account = accountFor(shard.accountId);
            if (!account) continue;
            const bytes = await fetchBlob(account, shard.path);
            if (bytes) return bytes;
        }
        return null;
    }

    if (entry.raid === "raid0") {
        const dataShards = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
        const buffers: Buffer[] = [];

        for (const shard of dataShards) {
            const account = accountFor(shard.accountId);
            const bytes = account ? await fetchBlob(account, shard.path) : null;
            if (!bytes) return null;
            buffers.push(Buffer.from(bytes));
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
        const bytes = account ? await fetchBlob(account, shard.path) : null;
        return bytes ? Buffer.from(bytes) : null;
    };

    const dataBuffers = await Promise.all(dataAssignments.map(fetchIfConfigured));
    const pBuf = await fetchIfConfigured(pShard);
    const qBuf = await fetchIfConfigured(qShard);

    try {
        const fullData = reconstructParity(dataBuffers, pBuf, qBuf);
        return joinShards(fullData, entry.cipherLength);
    }
    catch (e) {
        return null;
    }
}
