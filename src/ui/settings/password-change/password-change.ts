import { cancel, intro, log, confirm, isCancel, note, password } from "@clack/prompts";
import { KeyVault } from "../../../cryptography/key-vault";
import { ensureVaultOpen } from "../../utils/vault-access";

export async function passwordChangePage() {
    intro("Master Password");

    note(
        "Your password protects the local .hfkey key vault.\n" +
        "It does NOT directly encrypt your files.\n\n" +
        "⚠  If you lose this password, your files cannot be recovered.\n" +
        "   There is no reset — HF-VAULT never sees your keys.",
        "Master Password"
    );

    // Changing the password requires decrypting the vault first,
    // so the user has to prove they know the current one
    if (!await ensureVaultOpen()) {
        cancel("Returning to settings...");
        return;
    }

    while (true) {
        const psw = await password({
            message: "Enter your new master password:",
        });

        if (isCancel(psw)) {
            cancel("Returning to settings...");
            return;
        }

        const confirmation = await password({
            message: "Confirm your new master password:",
        });

        if (isCancel(confirmation)) {
            cancel("Returning to settings...");
            return;
        }

        if (psw !== confirmation) {
            log.warn("Passwords do not match.");

            const retry = await confirm({
                message: "Try again?"
            });

            if (!retry) {
                return;
            }

            continue;
        }

        KeyVault.getInstance().changePassword(psw.toString());
        log.success("Master password updated");
        return;
    }
}
