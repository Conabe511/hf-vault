import { commitIter, deleteFile, listFiles } from "@huggingface/hub";
import { HFAccount } from "./accounts";
import { HFFileEntry, HFShard } from "./actions";
import { RaidMode } from "../raid/types";

const MANIFEST_SUFFIX = ".hfmanifest.json";

/**
 * What's discoverable on the remote without the local .hfcoll: which
 * blobs (across which accounts) belong to a file, in what shard roles,
 * how to reassemble them, and the GCM iv/tag needed to decrypt once
 * reassembled. iv/tag are included on purpose — per the README's
 * security notes, they are not secrets, only the AES key is (and that
 * still only lives in .hfkey, keyed by fileId). Deliberately excludes
 * name/mime/createdAt: those stay local-only, since they're what would
 * actually identify the file to a repo visitor.
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

/** Uploads the manifest to one account's repo, alongside that account's shard(s). */
export async function uploadManifest(account: HFAccount, manifest: HFManifest) {
    const content = new Blob([JSON.stringify(manifest) as unknown as BlobPart]);

    for await (const _event of commitIter({
        repo: account.repo,
        accessToken: account.token,
        title: `Upload manifest ${manifestPathFor(manifest.id)}`,
        operations: [{
            operation: "addOrUpdate",
            path: manifestPathFor(manifest.id),
            content,
        }],
    })) {
        // manifests are a few hundred bytes — no progress reporting needed
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

/** Fetches and parses a manifest from one account's repo. Null if missing/unreachable/malformed. */
export async function fetchManifest(account: HFAccount, fileId: string): Promise<HFManifest | null> {
    const url = `https://huggingface.co/${account.repo}/resolve/main/${manifestPathFor(fileId)}`;

    try {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${account.token}` },
        });

        if (!response.ok) return null;

        return JSON.parse(await response.text()) as HFManifest;
    }
    catch (e) {
        return null;
    }
}

/** Lists every manifest's file id present in one account's repo. */
export async function listManifests(account: HFAccount): Promise<string[]> {
    const ids: string[] = [];

    try {
        for await (const entry of listFiles({ repo: account.repo, accessToken: account.token })) {
            if (entry.type === "file" && isManifestPath(entry.path)) {
                ids.push(fileIdFromManifestPath(entry.path));
            }
        }
    }
    catch (e) {
        // repo unreachable — caller treats this the same as "no manifests found here"
    }

    return ids;
}
