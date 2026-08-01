import { confirm, intro, isCancel, log, note, select, spinner } from "@clack/prompts";
import { deleteFile } from "@huggingface/hub";
import color from "picocolors";
import { HFDataManager, HFFileEntry } from "../../hf/actions";
import { HFAccount, resolveAccounts } from "../../hf/accounts";
import { deleteManifest } from "../../hf/manifest";
import { EntryStatus, RemoteIndex, entryStatus, fetchRemoteIndex, shardStatus } from "../../raid/status";
import { formatBytes, logHFError } from "../../utils/utils";
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

    // Browse loop, redrawn in place: list -> details page of the picked
    // file (with its actions) -> back to the list
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

        const choice = await select({
            message: `${files.length} file(s) in your vault — select one for details:`,
            maxItems: 8, // keeps long collections scrollable instead of flooding the screen
            options: [
                ...files.map(f => ({
                    value: f.id,
                    label: `${STATUS_ICON[entryStatus(remoteIndex, f)]} ${f.name}`,
                    hint: `${formatBytes(f.size)} — ${f.raid.toUpperCase()} — ${new Date(f.createdAt).toLocaleDateString()}`,
                })),
                { value: "back", label: color.dim("← Back") },
            ],
        });

        // Straight back to the main menu — it redraws immediately,
        // so any farewell message here would be wiped before it's seen
        if (isCancel(choice) || choice === "back") {
            return;
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
    }
}

function accountLabel(accounts: HFAccount[], accountId: string): string {
    return accounts.find(a => a.id === accountId)?.label ?? accountId;
}

async function fileDetailsPage(entry: VaultEntry, remoteIndex: RemoteIndex, accounts: HFAccount[]): Promise<"back" | "deleted"> {
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
                { value: "delete", label: "Delete this file", hint: "removes every shard/manifest from the remote and stops tracking it" },
            ],
        });

        if (isCancel(action) || action === "back") {
            return "back";
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

            const status = shardStatus(remoteIndex, shard);
            if (status === "missing") continue; // already gone remotely

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
