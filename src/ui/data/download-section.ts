import { cancel, intro, isCancel, log, progress, select, spinner, text } from "@clack/prompts";
import { unlinkSync, writeFileSync } from "fs";
import { Encoder } from "../../cryptography/encoder";
import { HFDataManager, HFFileEntry, HFShard } from "../../hf/actions";
import { HFAccount, resolveAccounts } from "../../hf/accounts";
import { randomBytes } from "crypto";
import { formatBytes } from "../../utils/utils";
import { joinShards } from "../../raid/chunk";
import { reconstruct } from "../../raid/parity";
import { KeyVault } from "../../cryptography/key-vault";
import { ensureVaultOpen } from "../utils/vault-access";
import { clearScreen } from "../utils/screen";

export async function handleDownloadProcess() {
    clearScreen();
    intro("Download File");

    const files = HFDataManager.getInstance().getFiles();

    if (files.length === 0) {
        log.warn("No files in your vault yet.");
        return;
    }

    // Let the user pick which file to download
    const choice = await select({
        message: "Select a file to download:",
        options: files.map(f => ({
            value: f.id,
            label: f.name,
            hint: `${(f.size / 1024).toFixed(1)} KB — uploaded ${new Date(f.createdAt).toLocaleDateString()}`
        }))
    });

    if (isCancel(choice)) {
        cancel("Download cancelled");
        return;
    }

    const entry = HFDataManager.getInstance().getFile(choice as string);
    if (!entry) {
        log.error("File not found in local collection.");
        return;
    }

    const destination = await text({
        message: "Enter the destination path (including filename):",
        placeholder: `./${entry.name}`
    });

    if (isCancel(destination)) {
        cancel("Download cancelled");
        return;
    }

    const destStr = destination.toString() || `./${entry.name}`;

    // Unlock the vault and make sure the key is there BEFORE downloading —
    // no point pulling any shard if we can't decrypt the result
    if (!await ensureVaultOpen()) {
        cancel("Download cancelled");
        return;
    }

    if (!KeyVault.getInstance().hasKey(entry.id)) {
        log.error(
            `No decryption key found for "${entry.name}" in the vault. ` +
            `The file cannot be decrypted without it.`
        );
        return;
    }

    const cipherBuffer = await fetchAndReconstruct(entry);
    if (!cipherBuffer) {
        log.error(`Could not download/reconstruct "${entry.name}" — see the messages above.`);
        return;
    }

    const tmpEncrypted = randomBytes(16).toString("hex");
    writeFileSync(tmpEncrypted, cipherBuffer);

    const decSpinner = spinner();
    decSpinner.start("Decrypting file...");
    const encoder = Encoder.forExistingFile(
        entry.id,
        Buffer.from(entry.iv, "hex")
    );

    await encoder.decryptFile(tmpEncrypted, destStr);
    unlinkSync(tmpEncrypted);
    decSpinner.stop("File decrypted");

    log.success(`File saved to ${destStr}`);
}

/**
 * Downloads and reassembles a file's ciphertext from its shards,
 * tolerating unreachable accounts according to its RAID mode:
 * - none: the single shard IS the ciphertext, nothing to reassemble.
 * - raid1: any one reachable mirror is enough.
 * - raid0: no redundancy — every data shard must be reachable.
 * - raid6: missing data shards are reconstructed from P/Q parity, up to 2.
 * Returns null (after logging why) when the file can't be recovered.
 */
async function fetchAndReconstruct(entry: HFFileEntry): Promise<Buffer | null> {
    const accounts = resolveAccounts();
    const accountFor = (id: string) => accounts.find(a => a.id === id);

    const fetchOne = async (shard: HFShard, label: string): Promise<Buffer | null> => {
        const account = accountFor(shard.accountId);
        if (!account) {
            log.warn(`${label}: account "${shard.accountId}" is no longer configured.`);
            return null;
        }
        return downloadShard(account, shard.path, label);
    };

    if (entry.raid === "none") {
        return fetchOne(entry.shards[0], entry.name);
    }

    if (entry.raid === "raid1") {
        for (const shard of entry.shards) {
            const buf = await fetchOne(shard, `mirror (${accountFor(shard.accountId)?.label ?? shard.accountId})`);
            if (buf) return buf;
        }
        log.error("All mirror copies are unreachable — nothing to recover.");
        return null;
    }

    if (entry.raid === "raid0") {
        const dataShards = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
        const buffers: Buffer[] = [];

        for (const shard of dataShards) {
            const buf = await fetchOne(shard, `data shard ${shard.index + 1}/${dataShards.length}`);
            if (!buf) {
                log.error(`RAID0 has no redundancy — data shard ${shard.index + 1} is unrecoverable.`);
                return null;
            }
            buffers.push(buf);
        }

        return joinShards(buffers, entry.cipherLength);
    }

    if (entry.raid === "raid6") {
        const dataAssignments = entry.shards.filter(s => s.role === "data").sort((a, b) => a.index - b.index);
        const pShard = entry.shards.find(s => s.role === "parity-p");
        const qShard = entry.shards.find(s => s.role === "parity-q");

        const dataBuffers: (Buffer | null)[] = [];
        for (const shard of dataAssignments) {
            dataBuffers.push(await fetchOne(shard, `data shard ${shard.index + 1}/${dataAssignments.length}`));
        }

        const missing = dataBuffers.filter(b => b === null).length;

        if (missing === 0) {
            return joinShards(dataBuffers as Buffer[], entry.cipherLength);
        }

        log.info(`${missing} data shard(s) unreachable — attempting reconstruction from parity...`);

        const pBuf = pShard ? await fetchOne(pShard, "parity P") : null;
        const qBuf = qShard ? await fetchOne(qShard, "parity Q") : null;

        try {
            const recovered = reconstruct(dataBuffers, pBuf, qBuf);
            log.success(`Reconstructed ${missing} missing data shard(s) from parity.`);
            return joinShards(recovered, entry.cipherLength);
        } catch (e) {
            log.error(`RAID6 reconstruction failed: ${(e as Error).message}`);
            return null;
        }
    }

    log.error(`Unknown RAID mode "${entry.raid}" on this entry.`);
    return null;
}

/** Downloads one shard with a progress bar; returns null (after logging) on any failure. */
async function downloadShard(account: HFAccount, path: string, label: string): Promise<Buffer | null> {
    const hfUrl = `https://huggingface.co/${account.repo}/resolve/main/${path}`;

    let response: Response;
    try {
        response = await fetch(hfUrl, {
            headers: { Authorization: `Bearer ${account.token}` }
        });
    } catch (e) {
        log.warn(`${label}: ${account.label} is unreachable.`);
        return null;
    }

    if (!response.ok || !response.body) {
        log.warn(`${label}: not found on ${account.label} (HTTP ${response.status}).`);
        return null;
    }

    const knownTotal = parseInt(response.headers.get("content-length") ?? "0", 10) || 0;
    const dlProgress = progress({ max: 100 });
    dlProgress.start(`Downloading ${label}...`);

    const chunks: Buffer[] = [];
    let received = 0;
    let dlReportedPct = 0;
    const reader = response.body.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;

        if (knownTotal > 0) {
            const pct = Math.floor((received / knownTotal) * 100);
            const delta = pct - dlReportedPct;
            if (delta > 0) {
                dlProgress.advance(delta, `Downloading ${label}... ${formatBytes(received)} / ${formatBytes(knownTotal)}`);
                dlReportedPct = pct;
            }
        }
    }

    if (dlReportedPct < 100) {
        dlProgress.advance(100 - dlReportedPct, `Downloaded ${formatBytes(received)}`);
    }
    dlProgress.stop(`Downloaded ${label} (${formatBytes(received)})`);

    return Buffer.concat(chunks);
}
