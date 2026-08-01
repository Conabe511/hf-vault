import { confirm, intro, isCancel, log, note, password, select, text } from "@clack/prompts";
import { randomBytes } from "crypto";
import color from "picocolors";
import { readExtraAccounts, saveExtraAccounts } from "../../../utils/hfconf";
import { clearScreen, pressEnterToContinue } from "../../utils/screen";

// Buckets (buckets/[user]/[name]) are the recommended storage type; dataset
// repos are still accepted for anyone pointing an extra account at an
// existing datasets/... vault.
const BUCKET_REPO_PATTERN = /^(buckets|datasets)\/[^/\s]+\/[^/\s]+$/;

function maskToken(token: string): string {
    return token.length > 8 ? `${token.slice(0, 3)}...${token.slice(-4)}` : "***";
}

/**
 * Manages extra Hugging Face accounts beyond the primary one (Settings ->
 * Configuration). RAID modes stripe/mirror/parity across whichever
 * accounts are configured here plus the primary.
 */
export async function accountsPage() {
    while (true) {
        clearScreen();
        intro("Extra Accounts");

        const accounts = readExtraAccounts();

        note(
            `The primary account (Settings -> Configuration) always counts as\n` +
            `the first account. Extra accounts here let RAID modes span more\n` +
            `storage and redundancy than one Hugging Face account alone.`,
            "Extra Accounts"
        );

        const choice = await select({
            message: accounts.length === 0
                ? "No extra accounts configured yet."
                : `${accounts.length} extra account(s):`,
            options: [
                ...accounts.map(a => ({ value: a.id, label: a.label, hint: `${a.repo} — ${maskToken(a.token)}` })),
                { value: "add", label: "+ Add an account" },
                { value: "back", label: color.dim("← Back") },
            ],
        });

        if (isCancel(choice) || choice === "back") {
            return;
        }

        if (choice === "add") {
            await addAccount();
            continue;
        }

        await manageAccount(choice as string);
    }
}

async function addAccount() {
    const label = await text({
        message: "Label for this account:",
        validate: v => (v ? undefined : "A label is required"),
    });
    if (isCancel(label)) return;

    const token = await password({
        message: "Hugging Face token (hf_...):",
        validate: v => (v && v.startsWith("hf_") ? undefined : 'Not a valid Hugging Face token — it must start with "hf_"'),
    });
    if (isCancel(token)) return;

    const repo = await text({
        message: "Bucket (buckets/[user]/[name]):",
        validate: v => (v && BUCKET_REPO_PATTERN.test(v) ? undefined : 'Must match buckets/[user]/[name], e.g. "buckets/FrankyMaca/my-vault-2"'),
    });
    if (isCancel(repo)) return;

    const accounts = readExtraAccounts();
    accounts.push({
        id: randomBytes(8).toString("hex"),
        label: label.toString(),
        token: token.toString(),
        repo: repo.toString(),
    });
    saveExtraAccounts(accounts);

    log.success(`Account "${label}" added.`);
    await pressEnterToContinue();
}

async function manageAccount(id: string) {
    const accounts = readExtraAccounts();
    const account = accounts.find(a => a.id === id);
    if (!account) return;

    const action = await select({
        message: `${account.label} (${account.repo})`,
        options: [
            { value: "back", label: color.dim("← Back") },
            { value: "remove", label: "Remove this account", hint: "files already stored there are left untouched remotely" },
        ],
    });

    if (isCancel(action) || action === "back") {
        return;
    }

    const sure = await confirm({
        message: `Remove "${account.label}" from HF-VAULT? This does not delete any remote files, but files striped/mirrored to it will lose that shard's redundancy.`,
    });

    if (isCancel(sure) || !sure) {
        return;
    }

    saveExtraAccounts(accounts.filter(a => a.id !== id));
    log.success(`Removed "${account.label}".`);
    await pressEnterToContinue();
}
