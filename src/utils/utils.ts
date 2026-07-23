import { log } from "@clack/prompts";

export function mimeFromExtension(ext: string): string {
    const map: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".pdf": "application/pdf", ".zip": "application/zip",
        ".tar": "application/x-tar", ".gz": "application/gzip",
        ".txt": "text/plain", ".json": "application/json",
        ".csv": "text/csv", ".html": "text/html", ".xml": "application/xml",
    };
    return map[ext.toLowerCase()] ?? "application/octet-stream";
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function logHFError(err: unknown) {
    // HubApiError carries statusCode + data (the server's actual JSON error body),
    // which the default String(err) conversion silently drops.
    if (err && typeof err === "object" && "statusCode" in err) {
        const e = err as { statusCode?: number; message?: string; data?: unknown; url?: string };
        log.error(`HTTP ${e.statusCode ?? "?"}: ${e.message ?? "Unknown error"}`);
        if (e.data) {
            log.error(`Server response: ${JSON.stringify(e.data)}`);
        }
        if (e.url) {
            log.error(`URL: ${e.url}`);
        }
    } else {
        log.error(String(err));
    }
}
