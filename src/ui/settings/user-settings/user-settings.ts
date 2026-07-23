import { intro, log, select } from "@clack/prompts";
import { invalidChoice } from "../../utils/invalid";

export async function userSettingsPage() {
    intro("User Settings");

    const choice = await select({
        message: "Select a setting to modify:",
        options: [
            {
                value: "auto-delete",
                label: "Automatic original file deletion",
                hint: "Delete files after successful upload"
            },
            {
                value: "compression",
                label: "Enable compression before encryption",
                hint: "Save storage space"
            },
            {
                value: "notifications",
                label: "Upload notifications",
                hint: "Show upload progress and completion messages"
            },
            {
                value: "cache",
                label: "Local cache management",
                hint: "Manage temporary encrypted files"
            }
        ]
    });

    switch (choice) {
        case "auto-delete":
            log.info("Automatic deletion settings — coming soon.");
            break;
        case "compression":
            log.info("Compression settings — coming soon.");
            break;
        case "notifications":
            log.info("Notification settings — coming soon.");
            break;
        case "cache":
            log.info("Cache management — coming soon.");
            break;
        default:
            invalidChoice();
    }
}