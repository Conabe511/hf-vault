import { commitIter, deleteFile, downloadFile } from "@huggingface/hub";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { ALG, generateAES256IV } from "../cryptography/create-random-key";
import { KeyVault } from "../cryptography/key-vault";
import { HFAccount } from "./accounts";
import { HFFileEntry, HFShard } from "./actions";
import { RaidMode } from "../raid/types";

// No ".json" — the uploaded blob is opaque AES-256-GCM ciphertext, not
// readable JSON. The suffix itself is unavoidably visible (sync needs a
// discoverable naming convention), but nothing behind it is anymore.
const MANIFEST_SUFFIX = ".hfmanifest";

/**
 * What's discoverable on the remote without the local .hfcoll: which
 * blobs (across which accounts) belong to a file, in what shard roles,
 * how to reassemble them, and the GCM iv/tag needed to decrypt once
 * reassembled. This is encrypted with the file's own AES key before
 * upload (see encryptManifest/decryptManifest below) — a repo visitor
 * would otherwise learn the names of every OTHER account/bucket a file
 * is spread across, which is a much bigger leak than an opaque blob
 * name, especially since buckets are public. The trade-off is exactly
 * the same as for file content itself: recovering a manifest requires
 * the same AES key (from .hfkey, by fileId) that recovering the file
 * would need anyway, so this adds no new failure mode.
 */
export interface HFManifest {
    id: string;
    raid: RaidMode;
    cipherLength: number;
    iv: string;
    tag: string;
    shards: HFShard[];
}

export function manifestPathFor(fileId: string): string {
    return `${fileId}${MANIFEST_SUFFIX}`;
}

export function isManifestPath(path: string): boolean {
    return path.endsWith(MANIFEST_SUFFIX);
}

export function fileIdFromManifestPath(path: string): string {
    return path.slice(0, -MANIFEST_SUFFIX.length);
}

export function buildManifest(entry: Pick<HFFileEntry, "id" | "raid" | "cipherLength" | "iv" | "tag" | "shards">): HFManifest {
    return {
        id: entry.id,
        raid: entry.raid,
        cipherLength: entry.cipherLength,
        iv: entry.iv,
        tag: entry.tag,
        shards: entry.shards,
    };
}

// [12-byte IV][ciphertext][16-byte GCM tag] — self-contained, like the
// tag-appended format Encoder already uses for file content, so no
// separate metadata is needed to decrypt a manifest blob.
function encryptManifestBytes(key: Buffer, plaintext: Buffer): Buffer {
    const iv = generateAES256IV();
    const cipher = createCipheriv(ALG, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

function decryptManifestBytes(key: Buffer, blob: Buffer): Buffer {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(12, blob.length - 16);

    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Uploads the (encrypted) manifest to one account's repo, alongside that
 * account's shard(s). Requires the file's AES key to already be in the
 * (unlocked) vault — true for every caller today: a fresh upload just
 * registered it, and repair only runs after the vault has been opened.
 */
export async function uploadManifest(account: HFAccount, manifest: HFManifest) {
    const key = KeyVault.getInstance().getKey(manifest.id);
    if (!key) {
        throw new Error(`No AES key in the vault for ${manifest.id} — cannot encrypt its manifest.`);
    }

    const encrypted = encryptManifestBytes(key, Buffer.from(JSON.stringify(manifest)));

    // Written to a real temp file and referenced by URL rather than handed
    // over as an in-memory Blob — see the matching note in upload-section.ts:
    // an in-memory Blob was observed to produce a corrupted xorb on
    // Hugging Face's Xet storage (mandatory for buckets).
    const tempPath = randomBytes(16).toString("hex");
    writeFileSync(tempPath, encrypted);

    try {
        for await (const _event of commitIter({
            repo: account.repo,
            accessToken: account.token,
            title: `Upload manifest ${manifestPathFor(manifest.id)}`,
            operations: [{
                operation: "addOrUpdate",
                path: manifestPathFor(manifest.id),
                content: pathToFileURL(tempPath),
            }],
        })) {
            // manifests are a few hundred bytes — no progress reporting needed
        }
    } finally {
        unlinkSync(tempPath);
    }
}

/** Best-effort delete; failures are swallowed since this runs during cleanup/rollback paths. */
export async function deleteManifest(account: HFAccount, fileId: string): Promise<void> {
    try {
        await deleteFile({
            repo: account.repo,
            path: manifestPathFor(fileId),
            accessToken: account.token,
        });
    }
    catch (e) {
        // nothing to do — the manifest may never have made it, or the repo is unreachable
    }
}

/**
 * Fetches and decrypts a manifest from one account's repo. Null if
 * missing/unreachable/malformed, OR if the vault is locked/doesn't have
 * this file's key — a manifest is exactly as recoverable as the file
 * content it describes, no more and no less.
 */
export async function fetchManifest(account: HFAccount, fileId: string): Promise<HFManifest | null> {
    const key = KeyVault.getInstance().getKey(fileId);
    if (!key) return null;

    try {
        // downloadFile (rather than a hand-built URL) resolves correctly for
        // both bucket and dataset repos — buckets have no "resolve/main/..."
        // revision segment, unlike git-backed dataset repos.
        const blob = await downloadFile({
            repo: account.repo,
            path: manifestPathFor(fileId),
            accessToken: account.token,
        });

        if (!blob) return null;

        const plaintext = decryptManifestBytes(key, Buffer.from(await blob.arrayBuffer()));
        return JSON.parse(plaintext.toString("utf8")) as HFManifest;
    }
    catch (e) {
        return null;
    }
}
