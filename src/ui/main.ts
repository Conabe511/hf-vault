import { cancel, intro, isCancel, log, select, outro } from "@clack/prompts";
import color from 'picocolors'
import { settingsPage } from "./settings/settings";
import { invalidChoice } from "./utils/invalid";
import { startWebServer } from "../web/server";
import { handleUploadProcess } from "./data/upload-section";
import { handleUploadFolderProcess } from "./data/upload-folder-section";
import { handleUploadFromUrlProcess } from "./data/upload-url-section";
import { handleUploadVideoProcess } from "./data/upload-video-section";
import { handleDownloadProcess } from "./data/download-section";
import { handleDownloadVideoProcess } from "./data/download-video-section";
import { handleListFiles } from "./data/list-files";
import { handleSyncProcess } from "./data/sync-section";
import { clearScreen, pressEnterToContinue } from "./utils/screen";
import { configurationPage } from "./settings/configuration/configuration";

const WEB_PORT = parseInt(process.env.HFV_WEB_PORT ?? "4173", 10) || 4173;
const WEB_HOST = "127.0.0.1";

export async function start() {
    // The app is unusable without a token and a repository: when either is
    // missing (fresh install, no .env / .hfconf) run the setup first
    if (!process.env.HF_TOKEN || !process.env.HF_REPO) {
        await configurationPage(true);
    }

    let webServerUrl: string | undefined;

    while (true) {
        clearScreen();
        intro(color.bgMagenta(" Welcome to HF-VAULT "))
    
        const c1 = await select({
            message: 'Hello! What files you want to upload today?',
            options: [
                { value: "upload", "label": "Upload a file to Cloud" },
                { value: "upload-folder", "label": "Upload a folder to Cloud", hint: "recursive, mirrors subfolders into a vault folder" },
                { value: "upload-url", "label": "Upload from a URL", hint: "e.g. a Copyparty link — no permanent local copy" },
                { value: "upload-video", "label": "Upload a video (HLS)", hint: "chunked + AES-128 encrypted, playable in VLC" },
                { value: "download", "label": "Download a file to your PC" },
                { value: "download-video", "label": "Download a video (HLS)", hint: "reconstructs a VLC-playable local folder" },
                { value: "list", "label": "List your vault files" },
                { value: "sync", "label": "Synchronize with remote" },
                { value: "settings", "label": "Change settings..."},
                {
                    value: "web",
                    label: webServerUrl ? "Web UI is running" : "Start Web UI",
                    hint: webServerUrl ?? "bulk upload/download from a browser — accounts/RAID/video stay CLI-only",
                },
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
            case "upload-folder":
                await handleUploadFolderProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "upload-url":
                await handleUploadFromUrlProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "upload-video":
                await handleUploadVideoProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "download":
                await handleDownloadProcess();
                outro("Done ☁️")
                await pressEnterToContinue();
                break;
            case "download-video":
                await handleDownloadVideoProcess();
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
            case "web":
                if (!webServerUrl) {
                    startWebServer(WEB_PORT, WEB_HOST);
                    webServerUrl = `http://${WEB_HOST}:${WEB_PORT}`;
                }
                log.success(`Web UI running at ${webServerUrl} (shares this session's vault — unlocking one unlocks both).`);
                await pressEnterToContinue();
                break;
            case "exit":
                cancel("Good bye!")
                process.exit(0)
            default: invalidChoice();
        }
    }
}