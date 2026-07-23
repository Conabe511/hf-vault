import { intro, log, note, confirm } from "@clack/prompts";
import color from 'picocolors'

export async function alternateKeysPage() {
    intro("Encryption Settings");

    note(
        // `Current: ${enabled ? color.green("ENABLED") : color.yellow("DISABLED")}\n\n` +
        `When ACTIVE: ${color.yellowBright("[reccomended]")}\n` +
        "  • Every file gets its own encryption key\n" +
        "  • Compromising one file does not affect others\n" +
        "  • Decryption requires the key stored in your local vault\n\n" +
        "When DISABLED:\n" +
        "  • The same master AES key is reused for every file\n" +
        `  • Simpler but ${color.underline("less secure")}`,
        "Per-File Encryption Keys"
    );

    const enabled = await confirm({
        message: `Use a different AES key for every encrypted file?`
    });

    if (enabled) {
        log.success("Per-file encryption keys enabled");
    } else {
        log.warn("Files will share the same encryption key");
    }
}