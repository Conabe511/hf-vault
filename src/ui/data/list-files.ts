import { confirm, intro, isCancel, log, note, select, spinner } from "@clack/prompts";
import { deleteFile } from "@huggingface/hub";
import color from "picocolors";
import { HFDataManager, HFFileEntry } from "../../hf/actions";
import { HFAccount, resolveAccounts } from "../../hf/accounts";
import { deleteManifest } from "../../hf/manifest";
import { EntryStatus, RemoteIndex, entryStatus, fetchRemoteIndex, shardStatus } from "../../raid/status";
import { formatBytes, logHFError } from "../../utils/utils";
import { pickFolder } from "../utils/folder-picker";
import { clearScreen, pressEnterToContinue } from "../utils/screen";

type VaultEntry = HFFileEntry;

// HF exposes no public API for the account storage quota (the settings-page
// endpoint rejects fine-grained tokens), so the total is configured here
// while the used amount is summed from the remote listing itself
const STORAGE_TOTAL_BYTES = parseFloat(process.env.HF_STORAGE_TOTAL_TB ?? "8.8") * 1024 ** 4;

const STATUS_ICON: Record<EntryStatus, string> = {
    synced: color.green("●"),
    degraded: color.yellow("●"),
    lost: color.red("●"),
    unknown: color.dim("●"),
};

function formatUsage(usedBytes: number): string {
    const pct = (usedBytes / STORAGE_TOTAL_BYTES) * 100;
    const pctLabel = pct > 0 && pct < 1 ? "<1%" : `${pct.toFixed(0)}%`;

    return `☁  ${formatBytes(usedBytes)} used of ${formatBytes(STORAGE_TOTAL_BYTES)} (${pctLabel})`;
}

/** Immediate child folder names of `currentFolder` (one level down, not recursive). */
function childFolders(files: VaultEntry[], currentFolder: string): string[] {
    const names = new Set<string>();

    for (const f of files) {
        if (currentFolder === "") {
            if (f.folder === "") continue;
            names.add(f.folder.split("/")[0]);
        }
        else {
            const prefix = `${currentFolder}/`;
            if (!f.folder.startsWith(prefix)) continue;
            const rest = f.folder.slice(prefix.length);
            if (rest) names.add(rest.split("/")[0]);
        }
    }

    return [...names].sort();
}

// Hold the screen with a Back option — a bare log line would be wiped
// instantly by the main menu redrawing over it
async function showEmptyVault() {
    log.warn("No files in the vault");

    await select({
        message: "Nothing to list yet — upload a file first.",
        options: [
            { value: "back", label: color.dim("← Back") },
        ],
    });
}

export async function handleListFiles() {
    clearScreen();
    intro("Your Vault Files");

    const files = [...HFDataManager.getInstance().getFiles()];

    if (files.length === 0) {
        await showEmptyVault();
        return;
    }

    const accounts = resolveAccounts();

    const remoteSpinner = spinner();
    remoteSpinner.start("Checking remote accounts...");
    const { index: remoteIndex, usedBytes } = await fetchRemoteIndex(accounts);
    remoteSpinner.stop("Remote status loaded");

    let bytesShown = usedBytes;
    let currentFolder = "";

    // Browse loop, redrawn in place: folder navigation <-> file details page
    // (with its actions) -> back to whichever folder we were in
    while (true) {
        clearScreen();
        intro("Your Vault Files");

        log.info(
            `${STATUS_ICON.synced} synced   ` +
            `${STATUS_ICON.degraded} degraded (recoverable)   ` +
            `${STATUS_ICON.lost} lost   ` +
            `${STATUS_ICON.unknown} unknown (repo unreachable)`
        );

        log.info(color.cyan(formatUsage(bytesShown)));
        log.info(color.dim(`📁 ${currentFolder || "/"}`));

        const subfolders = childFolders(files, currentFolder);
        const filesHere = files.filter(f => f.folder === currentFolder);

        if (subfolders.length === 0 && filesHere.length === 0) {
            log.warn("This folder is empty.");
        }

        const choice = await select({
            message: `${filesHere.length} file(s), ${subfolders.length} folder(s) here — select one:`,
            maxItems: 10,
            options: [
                ...(currentFolder ? [{ value: "up", label: color.dim("← ..") }] : []),
                ...subfolders.map(name => ({ value: `folder:${name}`, label: `📁 ${name}` })),
                ...filesHere.map(f => ({
                    value: f.id,
                    label: `${STATUS_ICON[entryStatus(remoteIndex, f)]} ${f.name}`,
                    hint: `${formatBytes(f.size)} — ${f.raid.toUpperCase()} — ${new Date(f.createdAt).toLocaleDateString()}`,
                })),
                { value: "back", label: color.dim("← Back") },
            ],
        });

        if (isCancel(choice)) return;

        if (choice === "back") {
            // At root, back leaves to the main menu; otherwise it's "back
            // out of this whole browse session", also to the main menu —
            // navigating up a folder uses ".." explicitly instead
            return;
        }

        if (choice === "up") {
            currentFolder = currentFolder.includes("/")
                ? currentFolder.slice(0, currentFolder.lastIndexOf("/"))
                : "";
            continue;
        }

        if (typeof choice === "string" && choice.startsWith("folder:")) {
            const name = choice.slice("folder:".length);
            currentFolder = currentFolder ? `${currentFolder}/${name}` : name;
            continue;
        }

        const entry = files.find(f => f.id === choice);
        if (!entry) continue;

        const outcome = await fileDetailsPage(entry, remoteIndex, accounts);

        if (outcome === "deleted") {
            files.splice(files.indexOf(entry), 1);

            if (files.length === 0) {
                clearScreen();
                intro("Your Vault Files");
                await showEmptyVault();
                return;
            }
        }
        // "moved" needs no extra bookkeeping here: fileDetailsPage already
        // mutated entry.folder in place, and the next loop iteration
        // recomputes subfolders/filesHere from the same `files` array
    }
}

function accountLabel(accounts: HFAccount[], accountId: string): string {
    return accounts.find(a => a.id === accountId)?.label ?? accountId;
}

async function fileDetailsPage(entry: VaultEntry, remoteIndex: RemoteIndex, accounts: HFAccount[]): Promise<"back" | "deleted" | "moved"> {
    while (true) {
        clearScreen();
        intro("File Details");

        const status = entryStatus(remoteIndex, entry);

        const shardLines = entry.shards
            .map(s => {
                const shardStat = shardStatus(remoteIndex, s);
                const icon = STATUS_ICON[shardStat === "synced" ? "synced" : shardStat === "missing" ? "lost" : "unknown"];
                return `  ${icon} ${s.role} — ${accountLabel(accounts, s.accountId)}`;
            })
            .join("\n");

        note(
            `Name:        ${entry.name}\n` +
            `Folder:      ${entry.folder || "/"}\n` +
            `Size:        ${formatBytes(entry.size)}\n` +
            `Type:        ${entry.mime}\n` +
            `Uploaded:    ${new Date(entry.createdAt).toLocaleString()}\n` +
            `RAID mode:   ${entry.raid.toUpperCase()}\n` +
            `Overall:     ${STATUS_ICON[status]} ${status}\n` +
            `Shards:\n${shardLines}`,
            "File Details"
        );

        // Back listed first: an accidental double-Enter from the list
        // must never land on the destructive option
        const action = await select({
            message: "What do you want to do?",
            options: [
                { value: "back", label: color.dim("← Back to the list") },
                { value: "move", label: "Move to another folder", hint: "vault-only — doesn't touch anything on disk or remotely" },
                { value: "delete", label: "Delete this file", hint: "removes every shard/manifest from the remote and stops tracking it" },
            ],
        });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        if (action === "move") {
            const newFolder = await pickFolder(HFDataManager.getInstance().listFolders(), `Move "${entry.name}" to:`);
            if (newFolder === undefined) continue;

            HFDataManager.getInstance().moveFile(entry.id, newFolder);
            entry.folder = newFolder;

            log.success(`Moved "${entry.name}" to ${newFolder || "/"}.`);
            return "moved";
        }

        const sure = await confirm({
            message: `Permanently delete "${entry.name}" (${entry.shards.length} shard(s) across its accounts) and stop tracking it?`,
        });

        if (isCancel(sure) || !sure) {
            continue;
        }

        let anyFailure = false;

        for (const shard of entry.shards) {
            const account = accounts.find(a => a.id === shard.accountId);
            if (!account) continue; // account no longer configured — nothing we can do remotely

            const shardStat = shardStatus(remoteIndex, shard);
            if (shardStat === "missing") continue; // already gone remotely

            try {
                await deleteFile({ repo: account.repo, path: shard.path, accessToken: account.token });
            }
            catch (e) {
                logHFError(e);
                anyFailure = true;
            }
        }

        const uniqueAccounts = [...new Map(entry.shards.map(s => [s.accountId, accounts.find(a => a.id === s.accountId)])).values()]
            .filter((a): a is HFAccount => a !== undefined);

        for (const account of uniqueAccounts) {
            await deleteManifest(account, entry.id);
        }

        if (anyFailure) {
            log.warn("Some shards failed to delete remotely — keeping the local entry so nothing gets lost.");
            await pressEnterToContinue();
            continue;
        }

        HFDataManager.getInstance().removeFile(entry.id);

        // The decryption key stays in the vault on purpose: harmless, and
        // still useful if the user happens to keep a copy of the encrypted blob
        log.success(`Deleted "${entry.name}".`);
        await pressEnterToContinue();
        return "deleted";
    }
}
