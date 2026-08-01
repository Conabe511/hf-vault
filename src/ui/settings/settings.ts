import { intro, select } from "@clack/prompts";
import { invalidChoice } from "../utils/invalid";
import { alternateKeysPage } from "./alternative-key-page/alternative-key-page";
import { passwordChangePage } from "./password-change/password-change";
import { configurationPage } from "./configuration/configuration";
import { accountsPage } from "./accounts/accounts";
import { raidModePage } from "./raid-mode/raid-mode";
import color from "picocolors"

import { clearScreen } from "../utils/screen";

export async function settingsPage() {
    clearScreen();
    intro("Settings")
    const c1 = await select({
        message: 'Select one:',
        options: [
            { value: "change-password", "label": "Change master password" },
            { value: "alternate-keys", "label": "Alternate the AES key for each file encryption" },
            { value: "configuration", "label": "Configuration", hint: "HF token, repository, key file" },
            { value: "accounts", label: "Accounts", hint: "extra Hugging Face accounts for RAID storage" },
            { value: "raid-mode", label: "RAID Mode", hint: "none / RAID0 / RAID1 / RAID6" },
            { value: "back", label: color.dim("← Back") }
        ],
        showInstructions: false
    });

    switch (c1) {
        case "change-password":
            await passwordChangePage()
            break;
        case "alternate-keys":
            await alternateKeysPage()
            break;
        case "configuration":
            await configurationPage()
            break;
        case "accounts":
            await accountsPage()
            break;
        case "raid-mode":
            await raidModePage()
            break;
        case "back":
            return;
        default: invalidChoice()
    }
}