import { listFiles } from "@huggingface/hub";
import { HFAccount } from "./accounts";

export interface RemoteFile {
    path: string;
    size: number;
}

/**
 * Lists the files of one account's repo, or null when it can't be reached
 * (deleted, private, offline...). Unreachable is deliberately distinct from
 * empty: sync must never treat "couldn't check" as "files are gone".
 */
export async function fetchRemoteFiles(account: HFAccount): Promise<RemoteFile[] | null> {
    try {
        const files: RemoteFile[] = [];

        for await (const entry of listFiles({ repo: account.repo, accessToken: account.token })) {
            if (entry.type === "file") {
                files.push({ path: entry.path, size: entry.size });
            }
        }

        return files;
    }
    catch (e) {
        return null;
    }
}

export type RemoteContentKind =
    | { kind: "plain"; format: string }
    | { kind: "encrypted" }
    | { kind: "unknown" };

// Recognizable plaintext formats by their magic bytes. Encrypted data has no
// signature — so a known signature is strong evidence a file is NOT ours.
// This also correctly classifies compressed formats (zip/gzip), which look
// as random as ciphertext but keep their magic header.
const SIGNATURES: { format: string; test: (b: Buffer) => boolean }[] = [
    { format: "pdf", test: b => b.subarray(0, 5).toString("latin1") === "%PDF-" },
    { format: "png", test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e },
    { format: "jpeg", test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { format: "gif", test: b => b.subarray(0, 4).toString("latin1") === "GIF8" },
    { format: "zip", test: b => b[0] === 0x50 && b[1] === 0x4b },
    { format: "gzip", test: b => b[0] === 0x1f && b[1] === 0x8b },
    { format: "mp4/mov", test: b => b.subarray(4, 8).toString("latin1") === "ftyp" },
    { format: "wav/avi/webp", test: b => b.subarray(0, 4).toString("latin1") === "RIFF" },
    { format: "mp3", test: b => b.subarray(0, 3).toString("latin1") === "ID3" },
    { format: "flac", test: b => b.subarray(0, 4).toString("latin1") === "fLaC" },
    { format: "ogg", test: b => b.subarray(0, 4).toString("latin1") === "OggS" },
    { format: "mkv/webm", test: b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

function looksLikeText(buf: Buffer): boolean {
    if (buf.length === 0) return true;

    let printable = 0;
    for (const byte of buf) {
        if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
            printable++;
        }
    }

    return printable / buf.length > 0.95;
}

// Bits of information per byte, 0..8. AES ciphertext is indistinguishable
// from random noise, so a 4KB sample sits at ~7.95; structured plaintext
// formats score visibly lower.
function shannonEntropy(buf: Buffer): number {
    if (buf.length === 0) return 0;

    const counts = new Array<number>(256).fill(0);
    for (const byte of buf) counts[byte]++;

    let entropy = 0;
    for (const count of counts) {
        if (count === 0) continue;
        const p = count / buf.length;
        entropy -= p * Math.log2(p);
    }

    return entropy;
}

/**
 * Downloads only the first 4KB of a remote file (Range request) and guesses
 * whether it's encrypted. Heuristic: known format signature or mostly-text
 * content -> plain; otherwise high entropy -> encrypted.
 */
export async function classifyRemoteFile(account: HFAccount, path: string): Promise<RemoteContentKind> {
    const url = `https://huggingface.co/${account.repo}/resolve/main/${path}`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${account.token}`,
            Range: "bytes=0-4095",
        },
    });

    if (!response.ok) {
        return { kind: "unknown" };
    }

    const sample = Buffer.from(await response.arrayBuffer());

    for (const signature of SIGNATURES) {
        if (signature.test(sample)) {
            return { kind: "plain", format: signature.format };
        }
    }

    if (looksLikeText(sample)) {
        return { kind: "plain", format: "text" };
    }

    return shannonEntropy(sample) >= 7.5
        ? { kind: "encrypted" }
        : { kind: "unknown" };
}
