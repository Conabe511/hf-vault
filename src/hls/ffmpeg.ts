import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "node:path";

/**
 * HLS video chunking + native AES-128 segment encryption, via ffmpeg's own
 * `-f hls` muxer — no re-encoding (stream copy), no custom crypto code:
 * ffmpeg produces segments already encrypted exactly the way any standard
 * HLS player (VLC included) expects to decrypt them, given the key.
 */

export interface HlsSegment {
    /** Filename as referenced by the playlist, e.g. "chunk_00000.ts". */
    name: string;
    /** Local path to the encrypted segment file. */
    path: string;
}

export interface HlsChunkResult {
    /** The playlist text verbatim, with relative segment/key references. */
    m3u8Text: string;
    segments: HlsSegment[];
    /** The key URI as written into the playlist's EXT-X-KEY tag. */
    keyFilename: string;
}

export function checkFfmpeg(): string {
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg) {
        throw new Error("ffmpeg not found in PATH — required to chunk a video into HLS segments.");
    }
    return ffmpeg;
}

/** Best-effort video duration in seconds; null if ffprobe isn't available or the probe fails. */
export async function probeDurationSeconds(inputPath: string): Promise<number | null> {
    const ffprobe = Bun.which("ffprobe");
    if (!ffprobe) return null;

    try {
        const proc = Bun.spawn(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", inputPath],
            { stdout: "pipe", stderr: "ignore" }
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        const duration = parseFloat(JSON.parse(out)?.format?.duration);
        return Number.isFinite(duration) ? duration : null;
    }
    catch (e) {
        return null;
    }
}

const KEY_FILENAME = "hls.key";

/**
 * Segments `inputPath` into AES-128-CBC-encrypted HLS `.ts` chunks under
 * `key`, writing everything into `workDir` (created if needed). The key
 * itself is written to a scratch file just long enough for ffmpeg to read
 * it, then deleted immediately — it is never meant to leave the caller's
 * possession (the caller owns `key` and is responsible for storing it,
 * e.g. in the local key vault; this function never sees where it came
 * from or where it's going).
 */
export async function segmentAndEncryptHls(
    inputPath: string,
    workDir: string,
    chunkSeconds: number,
    key: Buffer
): Promise<HlsChunkResult> {
    const ffmpeg = checkFfmpeg();
    mkdirSync(workDir, { recursive: true });

    const keyFilePath = join(workDir, "_ffmpeg_key_material.bin");
    const keyInfoPath = join(workDir, "_ffmpeg_key_info.txt");

    // ffmpeg's -hls_key_info_file format: 3 lines — the URI to write into
    // the playlist's EXT-X-KEY tag, the local path to read the raw key
    // bytes from, and a hex IV (NO "0x" prefix on this line — ffmpeg adds
    // that itself in the resulting playlist; a prefix here silently
    // truncates the parsed IV by 2 hex digits and fails with an "Error
    // setting option encryption_iv" mid-run). The IV line is NOT optional
    // in practice either: leaving it out doesn't make ffmpeg fall back to
    // the spec's sequence-number-derived per-segment IV — it writes a
    // literal all-zero IV instead, reused for every segment under the
    // same key. A random (if still single, whole-asset) IV is a
    // straightforward improvement over that well-known weak default.
    const iv = randomBytes(16);
    writeFileSync(keyFilePath, key);
    writeFileSync(keyInfoPath, `${KEY_FILENAME}\n${keyFilePath}\n${iv.toString("hex")}\n`);

    const playlistPath = join(workDir, "playlist.m3u8");
    const segmentPattern = join(workDir, "chunk_%05d.ts");

    const proc = Bun.spawn(
        [
            ffmpeg,
            "-y",
            "-i", inputPath,
            "-c", "copy",
            "-f", "hls",
            "-hls_time", String(chunkSeconds),
            "-hls_playlist_type", "vod",
            "-hls_key_info_file", keyInfoPath,
            "-hls_segment_filename", segmentPattern,
            playlistPath,
        ],
        { stdout: "ignore", stderr: "pipe" }
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Key material and the key-info file are local-only scratch — never
    // referenced again, and definitely never uploaded anywhere
    try { unlinkSync(keyFilePath); } catch (e) { /* best-effort */ }
    try { unlinkSync(keyInfoPath); } catch (e) { /* best-effort */ }

    if (exitCode !== 0) {
        throw new Error(`ffmpeg failed to segment/encrypt the video:\n${stderr.slice(-2000)}`);
    }

    if (!existsSync(playlistPath)) {
        throw new Error("ffmpeg reported success but produced no playlist file.");
    }

    const m3u8Text = readFileSync(playlistPath, "utf8");

    const segments: HlsSegment[] = m3u8Text
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))
        .map(name => ({ name, path: join(workDir, name) }));

    if (segments.length === 0) {
        throw new Error("ffmpeg produced a playlist with no segments.");
    }

    for (const segment of segments) {
        if (!existsSync(segment.path)) {
            throw new Error(`Playlist references "${segment.name}", but that segment file is missing.`);
        }
    }

    return { m3u8Text, segments, keyFilename: KEY_FILENAME };
}
