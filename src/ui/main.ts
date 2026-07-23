import { cancel, intro, isCancel, select, outro } from "@clack/prompts";
import color from 'picocolors'
import { settingsPage } from "./settings/settings";
import { invalidChoice } from "./utils/invalid";
import { handleUploadProcess } from "./data/upload-section";
import { handleDownloadProcess } from "./data/download-section";

export async function start() {
    while (true) {
        intro(color.bgMagenta(" Welcome to HF-VAULT "))
    
        const c1 = await select({
            message: 'Hello! What files you want to upload today?',
            options: [
                { value: "upload", "label": "Upload a file to Cloud" },
                { value: "download", "label": "Download a file to your PC" },
                { value: "settings", "label": "Change settings..."}
            ]
        });

        if (isCancel(c1)) {
            cancel("See you!")
            process.exit(0)
        }
    
        switch (c1) {
            case "upload":
                await handleUploadProcess();
                break;
            case "download":
                await handleDownloadProcess();
                break;
            case "settings":
                await settingsPage();
                break;
            default: invalidChoice();
        }
        
        outro("Done ☁️")
    }
}