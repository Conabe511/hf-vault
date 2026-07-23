import { cancel, intro, isCancel, log, progress, select, spinner, text } from "@clack/prompts";
import { unlinkSync } from "fs";
import { Encoder } from "../../cryptography/encoder";
import { HFDataManager } from "../../hf/actions";
import { randomBytes } from "crypto";
import { formatBytes } from "../../utils/utils";
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
    // no point pulling the whole file if we can't decrypt it
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

    // Download with streaming progress bar
    const hfUrl = `https://huggingface.co/${entry.repository}/resolve/main/${entry.path}`;
    const response = await fetch(hfUrl, {
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` }
    });

    if (!response.ok) {
        log.error(`Download failed: ${response.statusText}`);
        return;
    }

    const knownTotal = parseInt(response.headers.get("content-length") ?? "0", 10) || entry.size;
    const dlProgress = progress({ max: 100 }); // clack takes step count, not bytes
    dlProgress.start("Downloading...");

    const chunks: Buffer[] = [];
    let received = 0;
    let dlReportedPct = 0;
    const reader = response.body!.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        const pct = Math.floor((received / knownTotal) * 100);
        const delta = pct - dlReportedPct;
        if (delta > 0) {
            dlProgress.advance(
                delta,
                `Downloading... ${formatBytes(received)} / ${formatBytes(knownTotal)}`
            );
            dlReportedPct = pct;
        }
    }

    dlProgress.stop(`Downloaded ${formatBytes(received)}`);

    const { writeFileSync } = await import("fs");
    const tmpEncrypted = randomBytes(16).toString("hex");
    writeFileSync(tmpEncrypted, Buffer.concat(chunks));

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