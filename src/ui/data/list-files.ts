import { intro, isCancel, log, note, select, spinner } from "@clack/prompts";
import { listFiles } from "@huggingface/hub";
import color from "picocolors";
import { HFDataManager } from "../../hf/actions";
import { formatBytes } from "../../utils/utils";
import { clearScreen } from "../utils/screen";

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

function formatUsage(usedBytes: number): string {
    const pct = (usedBytes / STORAGE_TOTAL_BYTES) * 100;
    const pctLabel = pct > 0 && pct < 1 ? "<1%" : `${pct.toFixed(0)}%`;

    return `☁  ${formatBytes(usedBytes)} used of ${formatBytes(STORAGE_TOTAL_BYTES)} (${pctLabel})`;
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

export async function handleListFiles() {
    clearScreen();
    intro("Your Vault Files");

    const files = HFDataManager.getInstance().getFiles();

    if (files.length === 0) {
        log.warn("No files in your vault yet.");
        return;
    }

    const remoteSpinner = spinner();
    remoteSpinner.start("Checking remote repositories...");
    const repos = [...new Set(files.map(f => f.repository))];
    const { index: remoteIndex, usedBytes } = await fetchRemoteIndex(repos);
    remoteSpinner.stop("Remote status loaded");

    // Browse loop, redrawn in place: every iteration clears the screen and
    // re-renders header + legend + (details of the last picked file) + list,
    // so the menu stays fixed instead of stacking down the terminal
    let selected: ReturnType<typeof files.find> = undefined;

    while (true) {
        clearScreen();
        intro("Your Vault Files");

        log.info(
            `${STATUS_ICON.synced} on remote   ` +
            `${STATUS_ICON.missing} missing on remote   ` +
            `${STATUS_ICON.unknown} repo unreachable`
        );

        log.info(color.cyan(formatUsage(usedBytes)));

        if (selected) {
            const status = remoteStatus(remoteIndex, selected.repository, selected.path);

            note(
                `Name:        ${selected.name}\n` +
                `Size:        ${formatBytes(selected.size)}\n` +
                `Type:        ${selected.mime}\n` +
                `Uploaded:    ${new Date(selected.createdAt).toLocaleString()}\n` +
                `Repository:  ${selected.repository}\n` +
                `Remote name: ${selected.path}\n` +
                `Remote:      ${STATUS_ICON[status]} ${status}`,
                "File Details"
            );
        }

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

        selected = files.find(f => f.id === choice);
    }
}
