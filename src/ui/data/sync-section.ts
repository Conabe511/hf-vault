import { confirm, intro, isCancel, log, note, select, spinner, text } from "@clack/prompts";
import { deleteFile } from "@huggingface/hub";
import { randomBytes } from "crypto";
import color from "picocolors";
import { KeyVault } from "../../cryptography/key-vault";
import { HFDataManager } from "../../hf/actions";
import { classifyRemoteFile, fetchRemoteFiles, RemoteFile } from "../../hf/sync";
import { formatBytes, logHFError } from "../../utils/utils";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";

// HF boilerplate that exists in every repo — not user data, never reported
const HOUSEKEEPING_FILES = new Set([".gitattributes", "README.md"]);

export async function handleSyncProcess() {
    clearScreen();
    intro("Synchronize with Remote");

    const manager = HFDataManager.getInstance();
    const tracked = manager.getFiles();

    // Repos to inspect: everything referenced by local metadata,
    // plus the currently configured one (it may hold foreign files
    // even before the first vault upload)
    const repos = new Set(tracked.map(f => f.repository));
    if (process.env.HF_REPO) {
        repos.add(process.env.HF_REPO);
    }

    if (repos.size === 0) {
        log.warn("Nothing to synchronize: no tracked files and no HF_REPO configured.");
        return;
    }

    const listSpinner = spinner();
    listSpinner.start("Listing remote repositories...");

    const remote = new Map<string, RemoteFile[] | null>();
    for (const repo of repos) {
        remote.set(repo, await fetchRemoteFiles(repo));
    }

    listSpinner.stop("Remote listing done");

    for (const [repo, files] of remote) {
        if (files === null) {
            log.warn(`Could not reach ${repo} — skipping it (its entries are left untouched).`);
        }
    }

    // 1. Stale entries: tracked locally, but the remote file was deleted.
    //    Only counted when the repo WAS reachable — an unreachable repo
    //    proves nothing about the files inside it.
    const stale = tracked.filter(entry => {
        const files = remote.get(entry.repository);
        return files !== null && files !== undefined && !files.some(f => f.path === entry.path);
    });

    // 2. Foreign files: on the remote, but unknown to local metadata
    const trackedPaths = new Set(tracked.map(f => `${f.repository}/${f.path}`));
    const foreign: { repo: string; file: RemoteFile }[] = [];

    for (const [repo, files] of remote) {
        for (const file of files ?? []) {
            if (HOUSEKEEPING_FILES.has(file.path)) continue;
            if (!trackedPaths.has(`${repo}/${file.path}`)) {
                foreign.push({ repo, file });
            }
        }
    }

    // Peek at each foreign file's content to guess whether it's encrypted
    const classified: { repo: string; file: RemoteFile; label: string }[] = [];

    if (foreign.length > 0) {
        const classifySpinner = spinner();
        classifySpinner.start(`Inspecting ${foreign.length} unknown remote file(s)...`);

        for (const item of foreign) {
            const content = await classifyRemoteFile(item.repo, item.file.path);

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
        `${color.green("●")} In sync:        ${synced} file(s)\n` +
        `${color.red("●")} Stale locally:  ${stale.length} file(s) (deleted on remote)\n` +
        `${color.yellow("●")} Foreign remote: ${classified.length} file(s) (not in your vault)`,
        "Sync Summary"
    );

    if (classified.length > 0) {
        note(
            classified
                .map(c => `${c.file.path}  (${formatBytes(c.file.size)}, ${c.repo})\n  ${c.label}`)
                .join("\n"),
            "Foreign files on remote"
        );
    }

    if (stale.length === 0) {
        log.success("Local metadata matches the remote. Nothing to clean up.");
    }
    else {
        note(
            stale.map(s => `${s.name}  (${formatBytes(s.size)}, was ${s.repository}/${s.path})`).join("\n"),
            "Deleted on remote, still tracked locally"
        );

        const cleanup = await confirm({
            message: `Remove these ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} from local metadata?`,
        });

        if (isCancel(cleanup) || !cleanup) {
            log.info("Kept the stale entries. They will show as 'missing on remote' in the file list.");
        }
        else {
            for (const entry of stale) {
                manager.removeFile(entry.id);
            }

            // Their decryption keys stay in the vault on purpose: harmless, and
            // still useful if the user happens to keep a copy of the encrypted blob
            log.success(`Removed ${stale.length} entr${stale.length === 1 ? "y" : "ies"} from local metadata.`);
        }
    }

    if (classified.length > 0) {
        await manageForeignFiles(classified);
    }
}

interface ForeignItem {
    repo: string;
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
                    hint: `${formatBytes(item.file.size)} — ${item.repo}`,
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
            const token = process.env.HF_TOKEN;
            if (!token) {
                log.error("HF_TOKEN is not configured — cannot delete remote files.");
                continue;
            }

            const sure = await confirm({
                message: `Permanently delete ${item.file.path} from ${item.repo}?`,
            });

            if (isCancel(sure) || !sure) {
                continue;
            }

            try {
                await deleteFile({
                    repo: item.repo,
                    path: item.file.path,
                    accessToken: token,
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
 * Tracks a foreign remote file in local metadata. Its real name, type and
 * creation date are unknowable (that information never left the machine
 * that uploaded it), so the entry is mostly empty. If the user saved the
 * file's AES-256 key and IV, both go into the vault/metadata and the file
 * becomes fully downloadable + decryptable again.
 */
async function importForeignFile(item: ForeignItem) {
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
        repository: item.repo,
        path: item.file.path,
        iv: ivHex,
        tag: "",
    });

    log.success(
        keyStored
            ? `Imported ${item.file.path} with its key — it can be downloaded and decrypted.`
            : `Imported ${item.file.path} without a key — tracked, but not decryptable.`
    );
}
