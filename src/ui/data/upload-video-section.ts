import { cancel, confirm, intro, isCancel, log, note, path, select, spinner, text } from "@clack/prompts";
import { repoExists } from "@huggingface/hub";
import { randomBytes } from "crypto";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { basename, extname } from "node:path";
import { createHFRepo, HFDataManager } from "../../hf/actions";
import { HFAccount, resolveAccounts } from "../../hf/accounts";
import { KeyVault } from "../../cryptography/key-vault";
import { checkFfmpeg, probeDurationSeconds, segmentAndEncryptHls } from "../../hls/ffmpeg";
import { uploadBlobBytes } from "../../raid/blob-io";
import { formatBytes } from "../../utils/utils";
import { pickFolder } from "../utils/folder-picker";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";
import { prepareUploadPlan, uploadOneFile } from "./upload-section";

// KeyVault entries are otherwise keyed by fileId (32 hex chars) — this
// prefix keeps HLS keys visually distinct and out of that namespace,
// even though nothing currently enforces fileIds can't collide with it.
const HLS_KEY_PREFIX = "hls:";
const ASSET_SUFFIX = ".hlsasset.json";

interface HlsAssetRecord {
    version: 1;
    videoId: string;
    // Playlist text verbatim (relative segment/key references) — the
    // actual thing VLC opens, reconstructed byte-for-byte at download time.
    m3u8: string;
    keyFilename: string;
    segments: { name: string; fileId: string }[];
}

export async function handleUploadVideoProcess() {
    clearScreen();
    intro("Upload Video (HLS)");

    try {
        checkFfmpeg();
    }
    catch (e) {
        log.error((e as Error).message);
        return;
    }

    note(
        `Segments a video into HLS chunks, encrypted with ffmpeg's native\n` +
        `AES-128 (the same scheme any standard HLS player, including VLC,\n` +
        `decrypts natively) — a separate random key from every other file\n` +
        `in this vault, never uploaded anywhere, kept only in .hfkey.\n\n` +
        `Uses stream copy (no re-encode): the source codec must already be\n` +
        `HLS-compatible (H.264/AAC is the safe bet — matches what MP4/MKV\n` +
        `commonly contain).`,
        "Upload Video (HLS)"
    );

    const filePath = await path({
        message: "Select a video file to upload:",
        root: process.cwd(),
        directory: false,
    });

    if (isCancel(filePath)) {
        cancel("Upload cancelled");
        return;
    }

    const filePathStr = filePath.toString();
    const duration = await probeDurationSeconds(filePathStr);

    note(
        `File:     ${basename(filePathStr)}\n` +
        `Duration: ${duration ? `${duration.toFixed(1)}s` : "unknown (ffprobe unavailable)"}`,
        "Video Information"
    );

    const chunkDurationInput = await text({
        message: "Segment length in seconds:",
        initialValue: "10",
        validate: value => (Number(value) > 0 ? undefined : "Must be a positive number"),
    });

    if (isCancel(chunkDurationInput)) {
        cancel("Upload cancelled");
        return;
    }

    const chunkSeconds = Number(chunkDurationInput);

    const proceed = await confirm({ message: "Continue with chunking, encryption, and upload?" });
    if (isCancel(proceed) || !proceed) {
        cancel("Upload cancelled");
        return;
    }

    if (!await ensureVaultOpen()) {
        cancel("Upload cancelled");
        return;
    }

    const accounts = resolveAccounts();
    if (accounts.length === 0) {
        cancel("No Hugging Face account is configured yet — set one up in Settings -> Configuration.");
        return;
    }

    let segmentAccount: HFAccount;
    if (accounts.length === 1) {
        segmentAccount = accounts[0];
    }
    else {
        note(
            `Video segments are uploaded to a single account (no RAID split) —\n` +
            `they're already "chunked" by nature, and the asset record below\n` +
            `is what's actually protected by your configured RAID mode.`,
            "Account for segments"
        );

        const choice = await select({
            message: "Which account should hold this video's segments?",
            options: accounts.map(a => ({ value: a.id, label: a.label, hint: a.repo })),
        });

        if (isCancel(choice)) {
            cancel("Upload cancelled");
            return;
        }

        segmentAccount = accounts.find(a => a.id === choice)!;
    }

    const folder = await pickFolder(
        HFDataManager.getInstance().listFolders(),
        "Which vault folder should this video go into?"
    );

    if (folder === undefined) {
        cancel("Upload cancelled");
        return;
    }

    const repoSpinner = spinner();
    repoSpinner.start(`Checking ${segmentAccount.label}'s repository...`);
    if (!(await repoExists({ repo: segmentAccount.repo, accessToken: segmentAccount.token }))) {
        repoSpinner.message(`Creating repository for ${segmentAccount.label}...`);
        await createHFRepo(segmentAccount.repo, segmentAccount.token);
    }
    repoSpinner.stop("Repository ready");

    const videoId = randomBytes(16).toString("hex");
    const key = randomBytes(16);
    const workDir = randomBytes(16).toString("hex");

    const chunkSpinner = spinner();
    chunkSpinner.start("Segmenting and encrypting with ffmpeg...");

    let chunkResult;
    try {
        chunkResult = await segmentAndEncryptHls(filePathStr, workDir, chunkSeconds, key);
    }
    catch (e) {
        chunkSpinner.stop("Chunking failed");
        log.error((e as Error).message);
        rmSync(workDir, { recursive: true, force: true });
        return;
    }
    chunkSpinner.stop(`${chunkResult.segments.length} segment(s) produced`);

    const segmentRecords: { name: string; fileId: string }[] = [];
    const uploadSpinner = spinner();
    let failed = false;

    for (let i = 0; i < chunkResult.segments.length; i++) {
        const segment = chunkResult.segments[i];
        uploadSpinner.start(`Uploading segment ${i + 1}/${chunkResult.segments.length} (${segment.name})...`);

        try {
            const bytes = readFileSync(segment.path);
            const blobPath = await uploadBlobBytes(segmentAccount, bytes, "Upload video segment");
            const fileId = randomBytes(16).toString("hex");

            HFDataManager.getInstance().addFile({
                id: fileId,
                name: segment.name,
                size: bytes.length,
                mime: "video/mp2t",
                createdAt: new Date().toISOString(),
                iv: "",
                tag: "",
                raid: "none",
                cipherLength: bytes.length,
                shards: [{
                    accountId: segmentAccount.id,
                    repository: segmentAccount.repo,
                    path: blobPath,
                    role: "data",
                    index: 0,
                }],
                folder,
                raw: true,
            });

            segmentRecords.push({ name: segment.name, fileId });
            uploadSpinner.stop(`Segment ${i + 1}/${chunkResult.segments.length} uploaded (${formatBytes(bytes.length)})`);
        }
        catch (e) {
            uploadSpinner.stop(`Segment ${i + 1}/${chunkResult.segments.length} failed`);
            log.error((e as Error).message);
            failed = true;
            break;
        }
    }

    if (failed) {
        log.warn(
            `Upload stopped partway through — ${segmentRecords.length}/${chunkResult.segments.length} segment(s) ` +
            `made it and are left in place (harmless orphans; delete the folder from List your vault files if you want them gone).`
        );
        rmSync(workDir, { recursive: true, force: true });
        return;
    }

    // The key is stored ONLY here — never uploaded, remote or otherwise —
    // and never included in the m3u8/asset record beyond its filename
    KeyVault.getInstance().addKey(`${HLS_KEY_PREFIX}${videoId}`, key);

    const asset: HlsAssetRecord = {
        version: 1,
        videoId,
        m3u8: chunkResult.m3u8Text,
        keyFilename: chunkResult.keyFilename,
        segments: segmentRecords,
    };

    // Both prepareUploadPlan() and uploadOneFile() report their own
    // spinner/progress feedback (repo checks, encrypt, upload, manifest) —
    // no spinner of our own here, to avoid two competing for the terminal
    // line at once.
    const plan = await prepareUploadPlan();
    if (!plan) {
        rmSync(workDir, { recursive: true, force: true });
        return;
    }

    log.info("Writing HLS asset record...");

    const assetTempPath = randomBytes(16).toString("hex");
    writeFileSync(assetTempPath, JSON.stringify(asset));

    const videoBaseName = basename(filePathStr, extname(filePathStr));
    const assetResult = await uploadOneFile(assetTempPath, folder, plan, `${videoBaseName}${ASSET_SUFFIX}`);

    try { unlinkSync(assetTempPath); } catch (e) { /* best-effort */ }
    rmSync(workDir, { recursive: true, force: true });

    if (!assetResult.ok) {
        log.error(
            `The video's segments uploaded, but its asset record didn't — the video isn't playable ` +
            `without it. The segments are harmless orphans; delete the "${folder || "/"}" folder from ` +
            `List your vault files to clean them up, and try again.`
        );
        return;
    }

    const deleteOriginal = await confirm({ message: "Delete original video file after successful upload?" });
    if (!isCancel(deleteOriginal) && deleteOriginal) {
        unlinkSync(filePathStr);
        log.success("Original file deleted.");
    }

    log.success(`Video uploaded — ${chunkResult.segments.length} segment(s), id: ${assetResult.fileId}`);
}
