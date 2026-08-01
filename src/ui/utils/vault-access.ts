import { isCancel, log, note, password } from "@clack/prompts";
import { KeyVault } from "../../cryptography/key-vault";

/**
 * Makes sure the KeyVault is unlocked, prompting for the master password
 * when it isn't. On first run (no .hfkey yet) the password is asked twice
 * and becomes the new master password. Returns false if the user cancels.
 */
export async function ensureVaultOpen(): Promise<boolean> {
    const vault = KeyVault.getInstance();

    if (vault.isOpen()) {
        return true;
    }

    const firstRun = !vault.exists();

    if (firstRun) {
        const keyFileName = process.env.APP_KEY_FILE ?? ".hfkey";

        note(
            `This is the first file you're adding. HF-VAULT will create a\n` +
            `secure key file (${keyFileName}) that maps the AES keys used to\n` +
            `decrypt each of your files.\n\n` +
            `The master password you choose now is what protects that file.\n\n` +
            `⚠  Choose it wisely and don't forget it — without it your\n` +
            `   files cannot be recovered. There is no reset.`,
            "Create a Master Password"
        );
    }

    while (true) {
        const psw = await password({
            message: firstRun
                ? "Create a master password for your key vault:"
                : "Enter your master password to unlock the key vault:",
        });

        if (isCancel(psw)) {
            return false;
        }

        if (firstRun) {
            const confirmation = await password({
                message: "Confirm your master password:",
            });

            if (isCancel(confirmation)) {
                return false;
            }

            if (psw !== confirmation) {
                log.warn("Passwords do not match.");
                continue;
            }
        }

        try {
            vault.open(psw.toString());
            return true;
        }
        catch (e) {
            log.warn("Wrong password, try again.");
        }
    }
}
