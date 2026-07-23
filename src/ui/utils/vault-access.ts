import { isCancel, log, password } from "@clack/prompts";
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
