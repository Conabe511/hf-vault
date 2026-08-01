import { cancel, confirm, intro, isCancel, log, note, path } from "@clack/prompts";
import { readdirSync, unlinkSync } from "fs";
import { dirname, join, relative } from "node:path";
import { HFDataManager, normalizeFolder } from "../../hf/actions";
import { prepareUploadPlan, uploadOneFile } from "./upload-section";
import { pickFolder } from "../utils/folder-picker";
import { clearScreen } from "../utils/screen";
import { ensureVaultOpen } from "../utils/vault-access";

/** Recursively lists every file under `dir` (files only, subfolders walked). */
function walkFiles(dir: string): string[] {
    const results: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            results.push(...walkFiles(full));
        }
        else if (entry.isFile()) {
            results.push(full);
        }
    }

    return results;
}

export async function handleUploadFolderProcess() {
    clearScreen();
    intro("Upload Folder");

    const dirPath = await path({
        message: "Select a local folder to upload:",
        root: process.cwd(),
        directory: true,
    });

    if (isCancel(dirPath)) {
        cancel("Upload cancelled");
        return;
    }

    const dirPathStr = dirPath.toString();

    let files: string[];
    try {
        files = walkFiles(dirPathStr);
    }
    catch (e) {
        log.error(`Could not read "${dirPathStr}" as a folder.`);
        return;
    }

    if (files.length === 0) {
        log.warn("That folder has no files to upload (checked recursively).");
        return;
    }

    note(
        `Folder:  ${dirPathStr}\nFiles:   ${files.length} (recursive)`,
        "Folder Information"
    );

    const proceed = await confirm({
        message: `Upload all ${files.length} file(s), mirroring their subfolder structure in the vault?`,
    });

    if (isCancel(proceed) || !proceed) {
        cancel("Upload cancelled");
        return;
    }

    if (!await ensureVaultOpen()) {
        cancel("Upload cancelled");
        return;
    }

    const destination = await pickFolder(
        HFDataManager.getInstance().listFolders(),
        "Which vault folder should this local folder's contents go under?"
    );

    if (destination === undefined) {
        cancel("Upload cancelled");
        return;
    }

    const plan = await prepareUploadPlan();
    if (!plan) return;

    let succeeded = 0;
    const failed: string[] = [];
    const uploadedPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
        const filePathStr = files[i];
        const relativePath = relative(dirPathStr, filePathStr);
        const relativeDir = dirname(relativePath);
        const relativeFolder = relativeDir === "." ? "" : normalizeFolder(relativeDir);
        const vaultFolder = normalizeFolder([destination, relativeFolder].filter(Boolean).join("/"));

        log.info(`File ${i + 1}/${files.length}: ${relativePath}`);

        const result = await uploadOneFile(filePathStr, vaultFolder, plan);

        if (result.ok) {
            succeeded++;
            uploadedPaths.push(filePathStr);
        }
        else {
            failed.push(relativePath);
        }
    }

    if (failed.length > 0) {
        note(failed.join("\n"), "Failed to upload");
    }

    log.success(`Uploaded ${succeeded}/${files.length} file(s) into "${destination || "(root)"}".`);

    if (succeeded > 0) {
        const deleteOriginals = await confirm({
            message: `Delete the ${succeeded} successfully uploaded local file(s)?`,
        });

        if (!isCancel(deleteOriginals) && deleteOriginals) {
            for (const filePathStr of uploadedPaths) {
                try { unlinkSync(filePathStr); } catch (e) { /* best-effort */ }
            }
            log.success("Original files deleted.");
        }
    }
}
