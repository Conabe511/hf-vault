import { confirm, intro, isCancel, log, note, select, spinner, text } from "@clack/prompts";
import { deleteFile } from "@huggingface/hub";
import { randomBytes } from "crypto";
import color from "picocolors";
import { KeyVault } from "../../cryptography/key-vault";
import { HFDataManager } from "../../hf/actions";
import { HFAccount, resolveAccounts } from "../../hf/accounts";
import {
    HFManifest,
    fetchManifest,
    fileIdFromManifestPath,
    isManifestPath,
} from "../../hf/manifest";
import { classifyRemoteFile, fetchRemoteFiles, RemoteFile } from "../../hf/sync";
import { entryStatus, RemoteIndex } from "../../raid/status";
import { formatBytes, logHFError } from "../../utils/utils";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";

export async function handleSyncProcess() {
    clearScreen();
    intro("Synchronize with Remote");

    const manager = HFDataManager.getInstance();
    const tracked = manager.getFiles();
    const accounts = resolveAccounts();

    if (accounts.length === 0) {
        log.warn("No Hugging Face account is configured yet — set one up in Settings -> Configuration.");
        return;
    }

    const listSpinner = spinner();
    listSpinner.start("Listing remote accounts...");

    const remote = new Map<string, RemoteFile[] | null>();
    for (const account of accounts) {
        remote.set(account.id, await fetchRemoteFiles(account));
    }

    listSpinner.stop("Remote listing done");

    for (const account of accounts) {
        if (remote.get(account.id) === null) {
            log.warn(`Could not reach ${account.label} (${account.repo}) — skipping it (its entries are left untouched).`);
        }
    }

    const remoteIndex: RemoteIndex = new Map();
    for (const account of accounts) {
        const files = remote.get(account.id);
        remoteIndex.set(account.id, files == null ? "unreachable" : new Set(files.map(f => f.path)));
    }

    // 1. Stale entries: tracked locally, but confirmed unrecoverable — every
    //    shard that could cover for the missing one(s) is also gone.
    const stale = tracked.filter(entry => entryStatus(remoteIndex, entry) === "lost");

    // 2. Manifests found on the remote: the map of every file the remote
    //    itself claims to know about, one entry per fileId (first copy found).
    const manifestsById = new Map<string, HFManifest>();
    for (const account of accounts) {
        const files = remote.get(account.id);
        if (!files) continue;

        for (const file of files) {
            if (!isManifestPath(file.path)) continue;
            const fileId = fileIdFromManifestPath(file.path);
            if (manifestsById.has(fileId)) continue;

            const manifest = await fetchManifest(account, fileId);
            if (manifest) manifestsById.set(fileId, manifest);
        }
    }

    // Files the remote describes but that aren't tracked locally at all —
    // candidates for "rebuild from manifest" rather than plain import
    const rebuildable = [...manifestsById.values()].filter(m => !tracked.some(t => t.id === m.id));

    // 3. Foreign files: on the remote, not a manifest, not a shard of any
    //    tracked entry, and not referenced by ANY manifest (tracked or not)
    //    — i.e. genuinely unrelated to how HF-VAULT stores things.
    const trackedPaths = new Set(
        tracked.flatMap(entry => entry.shards.map(s => `${s.accountId}:${s.path}`))
    );
    const manifestReferencedPaths = new Set(
        [...manifestsById.values()].flatMap(m => m.shards.map(s => `${s.accountId}:${s.path}`))
    );

    const foreign: { account: HFAccount; file: RemoteFile }[] = [];
    for (const account of accounts) {
        const files = remote.get(account.id);
        if (!files) continue;

        for (const file of files) {
            if (isManifestPath(file.path)) continue;
            const key = `${account.id}:${file.path}`;
            if (trackedPaths.has(key) || manifestReferencedPaths.has(key)) continue;
            foreign.push({ account, file });
        }
    }

    // Peek at each foreign file's content to guess whether it's encrypted
    const classified: { account: HFAccount; file: RemoteFile; label: string }[] = [];

    if (foreign.length > 0) {
        const classifySpinner = spinner();
        classifySpinner.start(`Inspecting ${foreign.length} unknown remote file(s)...`);

        for (const item of foreign) {
            const content = await classifyRemoteFile(item.account, item.file.path);

            const label =
                content.kind === "plain" ? color.yellow(`not encrypted (${content.format})`) :
                content.kind === "encrypted" ? color.red("encrypted — no local key, cannot decrypt") :
                color.dim("unrecognized content");

            classified.push({ ...item, label });
        }

        classifySpinner.stop("Content inspection done");
    }

    const synced = tracked.length - stale.length;

    note(
        `${color.green("●")} In sync / recoverable: ${synced} file(s)\n` +
        `${color.red("●")} Lost:                  ${stale.length} file(s) (unrecoverable on remote)\n` +
        `${color.cyan("●")} Rebuildable:            ${rebuildable.length} file(s) (remote manifest, no local record)\n` +
        `${color.yellow("●")} Foreign remote:         ${classified.length} file(s) (not part of your vault)`,
        "Sync Summary"
    );

    if (classified.length > 0) {
        note(
            classified
                .map(c => `${c.file.path}  (${formatBytes(c.file.size)}, ${c.account.label})\n  ${c.label}`)
                .join("\n"),
            "Foreign files on remote"
        );
    }

    if (stale.length === 0) {
        log.success("No tracked files are unrecoverable. Nothing to clean up.");
    }
    else {
        note(
            stale.map(s => `${s.name}  (${formatBytes(s.size)}, ${s.raid.toUpperCase()}, ${s.shards.length} shard(s))`).join("\n"),
            "Lost — tracked locally, unrecoverable on remote"
        );

        const cleanup = await confirm({
            message: `Remove these ${stale.length} lost entr${stale.length === 1 ? "y" : "ies"} from local metadata?`,
        });

        if (isCancel(cleanup) || !cleanup) {
            log.info("Kept the entries. They will keep showing as 'lost' in the file list.");
        }
        else {
            for (const entry of stale) {
                manager.removeFile(entry.id);
            }

            // Their decryption keys stay in the vault on purpose: harmless, and
            // still useful if the user happens to keep a copy of a surviving shard
            log.success(`Removed ${stale.length} entr${stale.length === 1 ? "y" : "ies"} from local metadata.`);
        }
    }

    if (rebuildable.length > 0) {
        await manageRebuildableFiles(rebuildable);
    }

    if (classified.length > 0) {
        await manageForeignFiles(classified);
    }
}

/**
 * Files the remote itself describes (via a manifest) but that have no
 * local .hfcoll record at all — typically because .hfcoll was lost/reset.
 * Rebuilding restores the shard topology and iv/tag from the manifest;
 * the AES key still only comes from .hfkey (by fileId) or manual entry,
 * same as importing a foreign file.
 */
async function manageRebuildableFiles(manifests: HFManifest[]) {
    const remaining = [...manifests];

    while (remaining.length > 0) {
        const choice = await select({
            message: "Files described by a remote manifest but untracked locally:",
            options: [
                ...remaining.map((m, index) => ({
                    value: index,
                    label: m.id,
                    hint: `${m.raid.toUpperCase()} — ${m.shards.length} shard(s)`,
                })),
                { value: -1, label: color.dim("← Done") },
            ],
        });

        if (isCancel(choice) || choice === -1) {
            return;
        }

        const manifest = remaining[choice as number];

        const action = await select({
            message: `${manifest.id} — what do you want to do?`,
            options: [
                { value: "rebuild", label: "Rebuild into local vault", hint: "tracks it again; its original name is unknown" },
                { value: "back", label: color.dim("← Back") },
            ],
        });

        if (isCancel(action) || action === "back") {
            continue;
        }

        HFDataManager.getInstance().addFile({
            id: manifest.id,
            name: `recovered-${manifest.id}`,
            size: manifest.cipherLength,
            mime: "application/octet-stream",
            createdAt: new Date().toISOString(),
            iv: manifest.iv,
            tag: manifest.tag,
            raid: manifest.raid,
            cipherLength: manifest.cipherLength,
            shards: manifest.shards,
        });

        const hasKey = KeyVault.getInstance().isOpen() && KeyVault.getInstance().hasKey(manifest.id);

        log.success(
            hasKey
                ? `Rebuilt "${manifest.id}" — its AES key is already in your vault, so it can be downloaded now.`
                : `Rebuilt "${manifest.id}" — but no AES key is in your vault for it yet, so it can't be decrypted until one is added.`
        );

        remaining.splice(remaining.indexOf(manifest), 1);
    }
}

interface ForeignItem {
    account: HFAccount;
    file: RemoteFile;
    label: string;
}

async function manageForeignFiles(items: ForeignItem[]) {
    const remaining = [...items];

    while (remaining.length > 0) {
        const choice = await select({
            message: "Manage foreign files:",
            options: [
                ...remaining.map((item, index) => ({
                    value: index,
                    label: item.file.path,
                    hint: `${formatBytes(item.file.size)} — ${item.account.label}`,
                })),
                { value: -1, label: color.dim("← Done") },
            ],
        });

        if (isCancel(choice) || choice === -1) {
            return;
        }

        const item = remaining[choice as number];

        const action = await select({
            message: `${item.file.path} — what do you want to do?`,
            options: [
                { value: "import", label: "Import into local vault", hint: "track it; optionally provide its AES key" },
                { value: "delete", label: "Delete from remote", hint: "permanent, cannot be undone" },
                { value: "back", label: color.dim("← Back") },
            ],
        });

        if (isCancel(action) || action === "back") {
            continue;
        }

        if (action === "delete") {
            const sure = await confirm({
                message: `Permanently delete ${item.file.path} from ${item.account.label}?`,
            });

            if (isCancel(sure) || !sure) {
                continue;
            }

            try {
                await deleteFile({
                    repo: item.account.repo,
                    path: item.file.path,
                    accessToken: item.account.token,
                });
                remaining.splice(remaining.indexOf(item), 1);
                log.success(`Deleted ${item.file.path} from the remote.`);
            }
            catch (e) {
                logHFError(e);
            }

            continue;
        }

        await importForeignFile(item);
        remaining.splice(remaining.indexOf(item), 1);
    }
}

/**
 * Tracks a foreign remote file in local metadata, as a single-shard
 * raid:"none" entry. Its real name, type and creation date are unknowable
 * (that information never left the machine that uploaded it). If the user
 * saved the file's AES-256 key and IV, both go into the vault/metadata and
 * the file becomes fully downloadable + decryptable again.
 */
async function importForeignFile(item: { account: HFAccount; file: RemoteFile }) {
    const fileId = randomBytes(16).toString("hex");

    let ivHex = "";
    let keyStored = false;

    const hasKey = await confirm({
        message: "Do you have this file's AES-256 key saved somewhere?",
    });

    if (!isCancel(hasKey) && hasKey) {
        const keyHex = await text({
            message: "Paste the key (64 hex characters):",
            validate: value =>
                /^[0-9a-fA-F]{64}$/.test(value ?? "")
                    ? undefined
                    : "An AES-256 key is exactly 64 hex characters (32 bytes)",
        });

        if (!isCancel(keyHex)) {
            const iv = await text({
                message: "Paste the IV (24 hex characters — without it, decryption is impossible):",
                validate: value =>
                    /^[0-9a-fA-F]{24}$/.test(value ?? "")
                        ? undefined
                        : "The IV is exactly 24 hex characters (12 bytes)",
            });

            if (!isCancel(iv)) {
                // Storing the key requires the (unlocked) vault — it is
                // never written anywhere in plaintext
                if (await ensureVaultOpen()) {
                    KeyVault.getInstance().addKey(fileId, Buffer.from(keyHex.toString(), "hex"));
                    ivHex = iv.toString();
                    keyStored = true;
                }
                else {
                    log.warn("Vault stayed locked — importing without the key.");
                }
            }
        }
    }

    HFDataManager.getInstance().addFile({
        id: fileId,
        name: item.file.path,
        size: item.file.size,
        mime: "application/octet-stream",
        createdAt: new Date().toISOString(),
        iv: ivHex,
        tag: "",
        raid: "none",
        cipherLength: item.file.size,
        shards: [{
            accountId: item.account.id,
            repository: item.account.repo,
            path: item.file.path,
            role: "data",
            index: 0,
        }],
    });

    log.success(
        keyStored
            ? `Imported ${item.file.path} with its key — it can be downloaded and decrypted.`
            : `Imported ${item.file.path} without a key — tracked, but not decryptable.`
    );
}
