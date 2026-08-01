// Hugging Face I/O for the Worker: same @huggingface/hub calls the CLI
// uses, but content is always an in-memory Blob/ArrayBuffer — Workers have
// no filesystem, so the pathToFileURL(tempFile) trick the CLI uses to dodge
// the Xet-corruption bug isn't available. That bug was root-caused (see
// src/hf/manifest.ts / blob-io.ts comments) to a *custom fetch* substituting
// the request body, not to in-memory content itself — plain Blob content
// with the library's own fetch was the actually-safe combination all along,
// which is what every call here uses.
import { commitIter, deleteFile, downloadFile, repoExists, createRepo, listFiles } from "@huggingface/hub";
import { HFAccount } from "./raid-types";

function randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureRepo(account: HFAccount): Promise<void> {
    if (await repoExists({ repo: account.repo, accessToken: account.token })) return;

    await createRepo({
        accessToken: account.token,
        repo: account.repo,
        // Public buckets get the 8.8TB free quota vs 100GB private — same
        // reasoning as src/hf/actions.ts: content is opaque ciphertext
        // under random blob names, nothing readable is ever exposed.
        visibility: "public",
    });
}

/** Uploads `bytes` to a fresh random-named blob in account.repo, returns the blob path. */
export async function uploadBlob(account: HFAccount, bytes: Uint8Array, title: string): Promise<string> {
    const path = randomHex(16);
    const blob = new Blob([bytes]);

    for await (const _event of commitIter({
        repo: account.repo,
        accessToken: account.token,
        title: `${title} ${path}`,
        operations: [{ operation: "addOrUpdate", path, content: blob }],
    })) {
        // no progress UI server-side; the client tracks its own upload progress
    }

    return path;
}

/** Uploads `bytes` to a specific known path (used for manifests, which are named `<fileId>.hfmanifest`). */
export async function uploadBlobAt(account: HFAccount, path: string, bytes: Uint8Array, title: string): Promise<void> {
    const blob = new Blob([bytes]);

    for await (const _event of commitIter({
        repo: account.repo,
        accessToken: account.token,
        title: `${title} ${path}`,
        operations: [{ operation: "addOrUpdate", path, content: blob }],
    })) {
        // no-op
    }
}

export async function fetchBlob(account: HFAccount, path: string): Promise<Uint8Array | null> {
    try {
        const blob = await downloadFile({ repo: account.repo, path, accessToken: account.token });
        if (!blob) return null;
        return new Uint8Array(await blob.arrayBuffer());
    }
    catch (e) {
        return null;
    }
}

export async function deleteBlob(account: HFAccount, path: string): Promise<boolean> {
    try {
        await deleteFile({ repo: account.repo, path, accessToken: account.token });
        return true;
    }
    catch (e) {
        return false;
    }
}

export async function listRepoPaths(account: HFAccount): Promise<Set<string> | "unreachable"> {
    try {
        const paths = new Set<string>();
        for await (const entry of listFiles({ repo: account.repo, accessToken: account.token })) {
            if (entry.type === "file") paths.add(entry.path);
        }
        return paths;
    }
    catch (e) {
        return "unreachable";
    }
}
