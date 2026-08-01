import { confirm, intro, isCancel, log, note, select, spinner } from "@clack/prompts";
import { deleteFile, listFiles } from "@huggingface/hub";
import color from "picocolors";
import { HFDataManager } from "../../hf/actions";
import { formatBytes, logHFError } from "../../utils/utils";
import { clearScreen, pressEnterToContinue } from "../utils/screen";

type VaultEntry = ReturnType<HFDataManager["getFiles"]>[number];

// repo name -> paths that actually exist on the remote,
// or "unreachable" when the repo couldn't be listed
type RemoteIndex = Map<string, Set<string> | "unreachable">;

// HF exposes no public API for the account storage quota (the settings-page
// endpoint rejects fine-grained tokens), so the total is configured here
// while the used amount is summed from the remote listing itself
const STORAGE_TOTAL_BYTES = parseFloat(process.env.HF_STORAGE_TOTAL_TB ?? "8.8") * 1024 ** 4;

async function fetchRemoteIndex(repos: string[]): Promise<{ index: RemoteIndex; usedBytes: number }> {
    const index: RemoteIndex = new Map();
    let usedBytes = 0;

    for (const repo of repos) {
        try {
            const paths = new Set<string>();

            for await (const entry of listFiles({ repo, accessToken: process.env.HF_TOKEN })) {
                if (entry.type === "file") {
                    paths.add(entry.path);
                    usedBytes += entry.size;
                }
            }

            index.set(repo, paths);
        }
        catch (e) {
            index.set(repo, "unreachable");
        }
    }

    return { index, usedBytes };
}

function remoteStatus(index: RemoteIndex, repo: string, path: string): "synced" | "missing" | "unknown" {
    const paths = index.get(repo);

    if (!paths || paths === "unreachable") return "unknown";
    return paths.has(path) ? "synced" : "missing";
}

const STATUS_ICON = {
    synced: color.green("●"),
    missing: color.red("●"),
    unknown: color.yellow("●"),
} as const;

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

    const remoteSpinner = spinner();
    remoteSpinner.start("Checking remote repositories...");
    const repos = [...new Set(files.map(f => f.repository))];
    const { index: remoteIndex, usedBytes } = await fetchRemoteIndex(repos);
    remoteSpinner.stop("Remote status loaded");

    let bytesShown = usedBytes;

    // Browse loop, redrawn in place: list -> details page of the picked
    // file (with its actions) -> back to the list
    while (true) {
        clearScreen();
        intro("Your Vault Files");

        log.info(
            `${STATUS_ICON.synced} on remote   ` +
            `${STATUS_ICON.missing} missing on remote   ` +
            `${STATUS_ICON.unknown} repo unreachable`
        );

        log.info(color.cyan(formatUsage(bytesShown)));

        const choice = await select({
            message: `${files.length} file(s) in your vault — select one for details:`,
            maxItems: 8, // keeps long collections scrollable instead of flooding the screen
            options: [
                ...files.map(f => ({
                    value: f.id,
                    label: `${STATUS_ICON[remoteStatus(remoteIndex, f.repository, f.path)]} ${f.name}`,
                    hint: `${formatBytes(f.size)} — ${new Date(f.createdAt).toLocaleDateString()}`,
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

        const outcome = await fileDetailsPage(entry, remoteIndex);

        if (outcome === "deleted") {
            files.splice(files.indexOf(entry), 1);

            // keep the status dots and the usage counter truthful
            const paths = remoteIndex.get(entry.repository);
            if (paths && paths !== "unreachable" && paths.delete(entry.path)) {
                bytesShown -= entry.size;
            }

            if (files.length === 0) {
                clearScreen();
                intro("Your Vault Files");
                await showEmptyVault();
                return;
            }
        }
    }
}

async function fileDetailsPage(entry: VaultEntry, remoteIndex: RemoteIndex): Promise<"back" | "deleted"> {
    while (true) {
        clearScreen();
        intro("File Details");

        const status = remoteStatus(remoteIndex, entry.repository, entry.path);

        note(
            `Name:        ${entry.name}\n` +
            `Size:        ${formatBytes(entry.size)}\n` +
            `Type:        ${entry.mime}\n` +
            `Uploaded:    ${new Date(entry.createdAt).toLocaleString()}\n` +
            `Repository:  ${entry.repository}\n` +
            `Remote name: ${entry.path}\n` +
            `Remote:      ${STATUS_ICON[status]} ${status}`,
            "File Details"
        );

        // Back listed first: an accidental double-Enter from the list
        // must never land on the destructive option
        const action = await select({
            message: "What do you want to do?",
            options: [
                { value: "back", label: color.dim("← Back to the list") },
                { value: "delete", label: "Delete this file", hint: "removes it from the remote and stops tracking it" },
            ],
        });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        const token = process.env.HF_TOKEN;
        if (!token) {
            log.error("HF_TOKEN is not configured — cannot delete remote files.");
            await pressEnterToContinue();
            continue;
        }

        const sure = await confirm({
            message: `Permanently delete "${entry.name}" from ${entry.repository} and stop tracking it?`,
        });

        if (isCancel(sure) || !sure) {
            continue;
        }

        // Already gone remotely (stale entry)? Then there is nothing to
        // delete on HF — just stop tracking it locally.
        if (status !== "missing") {
            try {
                await deleteFile({
                    repo: entry.repository,
                    path: entry.path,
                    accessToken: token,
                });
            }
            catch (e) {
                logHFError(e);
                log.warn("Remote deletion failed — keeping the local entry so nothing gets lost.");
                await pressEnterToContinue();
                continue;
            }
        }

        HFDataManager.getInstance().removeFile(entry.id);

        // The decryption key stays in the vault on purpose: harmless, and
        // still useful if the user happens to keep a copy of the encrypted blob
        log.success(`Deleted "${entry.name}".`);
        await pressEnterToContinue();
        return "deleted";
    }
}
