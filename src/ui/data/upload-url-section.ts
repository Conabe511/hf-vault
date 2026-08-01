import { cancel, confirm, intro, isCancel, log, note, progress, text } from "@clack/prompts";
import { randomBytes } from "crypto";
import { createWriteStream, unlinkSync } from "fs";
import { HFDataManager } from "../../hf/actions";
import { formatBytes } from "../../utils/utils";
import { pickFolder } from "../utils/folder-picker";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";
import { prepareUploadPlan, uploadOneFile } from "./upload-section";

/** Best-effort filename from a Content-Disposition header or the URL's last path segment. */
function inferNameFromUrl(url: string, contentDisposition: string | null): string {
    if (contentDisposition) {
        const match = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(contentDisposition);
        if (match) {
            try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
        }
    }

    try {
        const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
        if (segment) return decodeURIComponent(segment);
    }
    catch (e) { /* fall through */ }

    return "downloaded-file";
}

/** Parses a single "Name: value" header line into a fetch-ready header object. */
function parseExtraHeader(raw: string): Record<string, string> {
    const trimmed = raw.trim();
    if (!trimmed) return {};

    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
        log.warn('Ignored malformed header (expected "Name: value").');
        return {};
    }

    return { [trimmed.slice(0, idx).trim()]: trimmed.slice(idx + 1).trim() };
}

/**
 * Fetches a file straight from a URL (e.g. a Copyparty share on another
 * machine) and uploads it — for the common case of moving a file between
 * two machines you don't want to fully download-then-reupload by hand.
 * The download still touches local disk (a temp file, streamed rather
 * than buffered in memory), but it's deleted right after encryption
 * rather than becoming a permanent extra copy the way a manual
 * browser-download-then-select-that-file workflow would.
 */
export async function handleUploadFromUrlProcess() {
    clearScreen();
    intro("Upload from URL");

    note(
        `Downloads a file from a URL and uploads it. The download is a\n` +
        `temporary file, deleted right after encryption — nothing extra\n` +
        `is left behind on this machine.`,
        "Upload from URL"
    );

    const url = await text({
        message: "File URL (e.g. a Copyparty link or any direct download URL):",
        validate: value => {
            if (!value) return "A URL is required";
            try {
                const parsed = new URL(value);
                return parsed.protocol === "http:" || parsed.protocol === "https:"
                    ? undefined
                    : "Must be an http:// or https:// URL";
            }
            catch (e) {
                return "Not a valid URL";
            }
        },
    });

    if (isCancel(url)) {
        cancel("Upload cancelled");
        return;
    }

    const urlStr = url.toString();

    const headerInput = await text({
        message: "Extra request header, if the URL needs auth (optional, e.g. \"Authorization: Bearer ...\"):",
        defaultValue: "",
        placeholder: "(leave empty for none)",
    });

    if (isCancel(headerInput)) {
        cancel("Upload cancelled");
        return;
    }

    const headers = parseExtraHeader(headerInput.toString());

    let response: Response;
    try {
        response = await fetch(urlStr, { headers });
    }
    catch (e) {
        log.error(`Could not reach that URL: ${(e as Error).message}`);
        return;
    }

    if (!response.ok || !response.body) {
        log.error(`Download failed: HTTP ${response.status}`);
        return;
    }

    const nameInput = await text({
        message: "Display name for this file in your vault:",
        initialValue: inferNameFromUrl(urlStr, response.headers.get("content-disposition")),
        validate: value => (value ? undefined : "A name is required"),
    });

    if (isCancel(nameInput)) {
        cancel("Upload cancelled");
        return;
    }

    const displayName = nameInput.toString();

    // Streamed to a temp file (never fully buffered in memory), deleted
    // right after upload regardless of outcome — see uploadOneFile below
    const tempPath = randomBytes(16).toString("hex");
    const knownTotal = parseInt(response.headers.get("content-length") ?? "0", 10) || 0;

    const dlProgress = progress({ max: 100 });
    dlProgress.start(`Downloading ${displayName}...`);

    const writer = createWriteStream(tempPath);
    const reader = response.body.getReader();
    let received = 0;
    let reportedPct = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            writer.write(value);
            received += value.length;

            if (knownTotal > 0) {
                const pct = Math.floor((received / knownTotal) * 100);
                const delta = pct - reportedPct;
                if (delta > 0) {
                    dlProgress.advance(delta, `Downloading ${displayName}... ${formatBytes(received)} / ${formatBytes(knownTotal)}`);
                    reportedPct = pct;
                }
            }
        }

        await new Promise<void>((resolve, reject) => {
            writer.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
        });
    }
    catch (e) {
        dlProgress.stop("Download failed");
        log.error((e as Error).message);
        try { unlinkSync(tempPath); } catch (e2) { /* best-effort */ }
        return;
    }

    if (reportedPct < 100) {
        dlProgress.advance(100 - reportedPct, `Downloaded ${formatBytes(received)}`);
    }
    dlProgress.stop(`Downloaded ${displayName} (${formatBytes(received)})`);

    const proceed = await confirm({ message: "Continue with encryption and upload?" });
    if (isCancel(proceed) || !proceed) {
        unlinkSync(tempPath);
        cancel("Upload cancelled");
        return;
    }

    if (!await ensureVaultOpen()) {
        unlinkSync(tempPath);
        cancel("Upload cancelled");
        return;
    }

    const folder = await pickFolder(HFDataManager.getInstance().listFolders(), "Which vault folder should this go into?");
    if (folder === undefined) {
        unlinkSync(tempPath);
        cancel("Upload cancelled");
        return;
    }

    const plan = await prepareUploadPlan();
    if (!plan) {
        unlinkSync(tempPath);
        return;
    }

    const result = await uploadOneFile(tempPath, folder, plan, displayName);

    // Ours to clean up either way — unlike a local-file upload, there's no
    // user-owned original here that should be left alone by default
    try { unlinkSync(tempPath); } catch (e) { /* best-effort */ }

    if (!result.ok) return;

    log.success(`Upload complete — id: ${result.fileId}`);
}
