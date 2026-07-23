import { cancel, intro, isCancel, select, outro } from "@clack/prompts";
import color from 'picocolors'
import { settingsPage } from "./settings/settings";
import { invalidChoice } from "./utils/invalid";
import { handleUploadProcess } from "./data/upload-section";
import { handleDownloadProcess } from "./data/download-section";
import { handleListFiles } from "./data/list-files";
import { handleSyncProcess } from "./data/sync-section";
import { clearScreen, pressEnterToContinue } from "./utils/screen";

export async function start() {
    while (true) {
        clearScreen();
        intro(color.bgMagenta(" Welcome to HF-VAULT "))
    
        const c1 = await select({
            message: 'Hello! What files you want to upload today?',
            options: [
                { value: "upload", "label": "Upload a file to Cloud" },
                { value: "download", "label": "Download a file to your PC" },
                { value: "list", "label": "List your vault files" },
                { value: "sync", "label": "Synchronize with remote" },
                { value: "settings", "label": "Change settings..."},
                { value: "exit", "label": "Exit"}
            ]
        });

        if (isCancel(c1)) {
            cancel("See you!")
            process.exit(0)
        }
    
        switch (c1) {
            // Upload/download end with results worth reading, so they get an
            // outro + pause before the next loop iteration wipes the screen.
            // List and settings are menus themselves: leaving them should
            // land straight back here without any "Done" ceremony.
            case "upload":
                await handleUploadProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "download":
                await handleDownloadProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "list":
                await handleListFiles();
                break;
            case "sync":
                await handleSyncProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "settings":
                await settingsPage();
                break;
            case "exit":
                cancel("Good bye!")
                process.exit(0)
            default: invalidChoice();
        }
    }
}