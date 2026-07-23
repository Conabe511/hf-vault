import { confirm, intro, isCancel, log, note, spinner } from "@clack/prompts";
import color from "picocolors";
import { HFDataManager } from "../../hf/actions";
import { classifyRemoteFile, fetchRemoteFiles, RemoteFile } from "../../hf/sync";
import { formatBytes } from "../../utils/utils";
import { clearScreen } from "../utils/screen";

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
        log.info(
            "Foreign files are only reported — the vault never touches data\n   it did not upload."
        );
    }

    if (stale.length === 0) {
        log.success("Local metadata matches the remote. Nothing to clean up.");
        return;
    }

    note(
        stale.map(s => `${s.name}  (${formatBytes(s.size)}, was ${s.repository}/${s.path})`).join("\n"),
        "Deleted on remote, still tracked locally"
    );

    const cleanup = await confirm({
        message: `Remove these ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} from local metadata?`,
    });

    if (isCancel(cleanup) || !cleanup) {
        log.info("Kept the stale entries. They will show as 'missing on remote' in the file list.");
        return;
    }

    for (const entry of stale) {
        manager.removeFile(entry.id);
    }

    // Their decryption keys stay in the vault on purpose: harmless, and
    // still useful if the user happens to keep a copy of the encrypted blob
    log.success(`Removed ${stale.length} entr${stale.length === 1 ? "y" : "ies"} from local metadata.`);
}
