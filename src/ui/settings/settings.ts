import { intro, select } from "@clack/prompts";
import { invalidChoice } from "../utils/invalid";
import { alternateKeysPage } from "./alternative-key-page/alternative-key-page";
import { passwordChangePage } from "./password-change/password-change";

export async function settingsPage() {
    intro("Settings")
    const c1 = await select({
        message: 'Select one:',
        options: [
            { value: "change-password", "label": "Change master password" },
            { value: "alternate-keys", "label": "Alternate the AES key for each file encryption" },
            { value: "settings", "label": "Change settings... (coming soon)", disabled: true }
        ]
    });

    switch (c1) {
        case "change-password":
            await passwordChangePage()
            break;
        case "alternate-keys":
            await alternateKeysPage()
            break;
        default: invalidChoice()
    }
}