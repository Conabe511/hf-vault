import { intro, isCancel, log, note, password, text } from "@clack/prompts";
import { KeyVault } from "../../../cryptography/key-vault";
import { hfconfPath, saveHFConfig } from "../../../utils/hfconf";
import { clearScreen, pressEnterToContinue } from "../../utils/screen";

function maskToken(token: string): string {
    return token.length > 8 ? `${token.slice(0, 3)}...${token.slice(-4)}` : "***";
}

// HF-VAULT stores files in bucket repos: buckets/[user]/[name] (mutable,
// unversioned object storage — a better fit than dataset repos, which are
// git-backed and rack up a commit per upload/delete). Dataset repos are
// still accepted here for anyone with an existing datasets/... vault.
const BUCKET_REPO_PATTERN = /^(buckets|datasets)\/[^/\s]+\/[^/\s]+$/;

/**
 * View/edit the runtime configuration stored in .hfconf. Also serves as
 * the first-run setup: when required values are missing at startup, the
 * app lands here before showing the main menu.
 */
export async function configurationPage(firstRun = false) {
    clearScreen();
    intro(firstRun ? "Welcome to HF-VAULT" : "Configuration");

    if (firstRun) {
        note(
            `HF-VAULT can't work without a Hugging Face access token and\n` +
            `a repository to store your encrypted files in.\n\n` +
            `You can create a token at https://huggingface.co/settings/tokens\n` +
            `(it needs read + write access to your repositories).\n\n` +
            `These values are saved to ${hfconfPath()}\n` +
            `and can be changed anytime under Settings -> Configuration.`,
            "First-time setup"
        );
    }

    const current = {
        token: process.env.HF_TOKEN,
        repo: process.env.HF_REPO,
        keyFile: process.env.APP_KEY_FILE ?? ".hfkey",
    };

    const token = await password({
        message: current.token
            ? `Hugging Face token (Enter keeps ${maskToken(current.token)}):`
            : "Hugging Face token (hf_...):",
        validate: value => {
            if (!value) {
                return current.token ? undefined : "A token is required";
            }
            return value.startsWith("hf_")
                ? undefined
                : 'Not a valid Hugging Face token — it must start with "hf_"';
        },
    });

    if (isCancel(token)) {
        log.info("Configuration unchanged.");
        return;
    }

    const repo = await text({
        message: "Bucket (buckets/[user]/[name]):",
        initialValue: current.repo ?? "",
        validate: value =>
            value && BUCKET_REPO_PATTERN.test(value)
                ? undefined
                : 'Must match buckets/[user]/[name], e.g. "buckets/FrankyMaca/my-vault"',
    });

    if (isCancel(repo)) {
        log.info("Configuration unchanged.");
        return;
    }

    const keyFile = await text({
        message: "Key vault file name:",
        initialValue: current.keyFile,
        validate: value => (value ? undefined : "The key file needs a name"),
    });

    if (isCancel(keyFile)) {
        log.info("Configuration unchanged.");
        return;
    }

    saveHFConfig({
        HF_TOKEN: token.toString(),
        HF_REPO: repo.toString(),
        APP_KEY_FILE: keyFile.toString(),
    });

    // If the vault file was renamed, drop the in-RAM session so the next
    // vault access opens (or creates) the file at its new location
    if (keyFile.toString() !== current.keyFile && KeyVault.getInstance().isOpen()) {
        KeyVault.getInstance().close();
        log.info("Key vault locked — it will reopen from the new file.");
    }

    log.success(`Configuration saved to ${hfconfPath()}`);
    await pressEnterToContinue();
}
