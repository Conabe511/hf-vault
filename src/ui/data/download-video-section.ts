import { cancel, intro, isCancel, log, select, text } from "@clack/prompts";
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "node:path";
import { HFDataManager } from "../../hf/actions";
import { Encoder } from "../../cryptography/encoder";
import { KeyVault } from "../../cryptography/key-vault";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";
import { fetchAndReconstruct } from "./download-section";

const HLS_KEY_PREFIX = "hls:";
const ASSET_SUFFIX = ".hlsasset.json";

interface HlsAssetRecord {
    version: 1;
    videoId: string;
    m3u8: string;
    keyFilename: string;
    segments: { name: string; fileId: string }[];
}

/**
 * Reconstructs a previously-uploaded HLS video into a local, directly
 * VLC-playable folder: the playlist verbatim, the AES-128 key
 * materialized ONLY here (from .hfkey — it was never uploaded anywhere),
 * and every segment under its original ffmpeg-chosen name so the
 * playlist's relative references resolve without any rewriting.
 */
export async function handleDownloadVideoProcess() {
    clearScreen();
    intro("Download Video (HLS)");

    const assets = HFDataManager.getInstance().getFiles().filter(f => f.name.endsWith(ASSET_SUFFIX));

    if (assets.length === 0) {
        log.warn("No HLS videos in your vault yet (upload one via \"Upload video to Cloud\").");
        return;
    }

    const choice = await select({
        message: "Select a video to download:",
        options: assets.map(f => ({
            value: f.id,
            label: f.name.slice(0, -ASSET_SUFFIX.length),
            hint: f.folder || "/",
        })),
    });

    if (isCancel(choice)) {
        cancel("Download cancelled");
        return;
    }

    const assetEntry = HFDataManager.getInstance().getFile(choice as string);
    if (!assetEntry) {
        log.error("Video not found in local collection.");
        return;
    }

    const defaultDestDir = `./${assetEntry.name.slice(0, -ASSET_SUFFIX.length)}`;
    const destInput = await text({
        message: "Destination folder (created if it doesn't exist):",
        placeholder: defaultDestDir,
    });

    if (isCancel(destInput)) {
        cancel("Download cancelled");
        return;
    }

    const destDir = destInput.toString() || defaultDestDir;

    if (!await ensureVaultOpen()) {
        cancel("Download cancelled");
        return;
    }

    if (!KeyVault.getInstance().hasKey(assetEntry.id)) {
        log.error(`No decryption key found for "${assetEntry.name}" in the vault.`);
        return;
    }

    // No spinner of our own around fetchAndReconstruct — it (and the
    // per-shard downloadShard it calls) already renders its own progress
    // bars, which would otherwise compete for the terminal line.
    log.info("Downloading asset record...");

    const assetCipher = await fetchAndReconstruct(assetEntry);
    if (!assetCipher) {
        log.error("Could not download/reconstruct the asset record — see the messages above.");
        return;
    }

    const tmpEncrypted = randomBytes(16).toString("hex");
    writeFileSync(tmpEncrypted, assetCipher);
    const tmpDecrypted = randomBytes(16).toString("hex");

    let asset: HlsAssetRecord;
    try {
        const encoder = Encoder.forExistingFile(assetEntry.id, Buffer.from(assetEntry.iv, "hex"));
        await encoder.decryptFile(tmpEncrypted, tmpDecrypted);
        asset = JSON.parse(readFileSync(tmpDecrypted, "utf8"));
    }
    catch (e) {
        log.error(`Could not decrypt/parse the asset record: ${(e as Error).message}`);
        return;
    }
    finally {
        try { unlinkSync(tmpEncrypted); } catch (e) { /* best-effort */ }
        try { unlinkSync(tmpDecrypted); } catch (e) { /* best-effort */ }
    }

    log.success(`Asset record loaded (${asset.segments.length} segment(s))`);

    const hlsKey = KeyVault.getInstance().getKey(`${HLS_KEY_PREFIX}${asset.videoId}`);
    if (!hlsKey) {
        log.error(
            `No HLS decryption key found for this video (expected under "${HLS_KEY_PREFIX}${asset.videoId}" ` +
            `in .hfkey). Without it the segments can be downloaded but never played.`
        );
        return;
    }

    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "playlist.m3u8"), asset.m3u8);
    writeFileSync(join(destDir, asset.keyFilename), hlsKey);

    let downloaded = 0;

    for (let i = 0; i < asset.segments.length; i++) {
        const segment = asset.segments[i];
        log.info(`Segment ${i + 1}/${asset.segments.length}: ${segment.name}`);

        const segmentEntry = HFDataManager.getInstance().getFile(segment.fileId);
        if (!segmentEntry) {
            log.warn(`Segment ${i + 1}/${asset.segments.length}: not tracked locally, skipped`);
            continue;
        }

        const bytes = await fetchAndReconstruct(segmentEntry);
        if (!bytes) {
            log.warn(`Segment ${i + 1}/${asset.segments.length}: unrecoverable, skipped`);
            continue;
        }

        writeFileSync(join(destDir, segment.name), bytes);
        downloaded++;
    }

    if (downloaded < asset.segments.length) {
        log.warn(
            `${asset.segments.length - downloaded}/${asset.segments.length} segment(s) could not be recovered — ` +
            `the playlist in ${destDir} will have gaps.`
        );
    }

    log.success(`Saved to ${destDir}/playlist.m3u8 — open it in VLC (or any HLS-aware player).`);
}
