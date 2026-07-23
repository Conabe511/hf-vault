import { createRepo, repoExists, uploadFile } from "@huggingface/hub"
import { HFVInvalidToken, HFVRepoNotFound, HFVInvalidName } from './errors'
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname } from "node:path"

export async function createHFRepo(name: string) {

    if (!process.env.HF_TOKEN) {
        throw new HFVInvalidToken()
    }

    if (!isHFNameValid(name)) {
        throw new HFVInvalidName()
    }

    try {
        await createRepo({
            accessToken: process.env.HF_TOKEN,
            repo: name,
            visibility: "public",
        })
    }
    catch (err) {
        console.log(err)
    }
}

export async function uploadFileToHF(file: File, to: string) {
    if (!process.env.HF_TOKEN) {
        throw new HFVInvalidToken()
    }

    if (!isHFNameValid(to)) {
        throw new HFVInvalidName()
    }

    if (!await repoExists({ accessToken: process.env.HF_TOKEN, repo: to})) {
        throw new HFVRepoNotFound()
    }

    try {
        await uploadFile({
            accessToken: process.env.HF_TOKEN,
            repo: to,
            file: file
        })
    }
    catch (err) {
        console.log(err)
    }
}

const HF_REPO_TYPE_PREFIXES = ["spaces", "datasets", "models"];

function isHFNameValid(name: string): boolean {
    const parts = name.split('/');
    // valid: "user/repo" (2 parts, implicit model repo)
    // or "spaces|datasets|models/user/repo" (3 parts, explicit repo type)
    if (parts.length === 2) return true;
    if (parts.length === 3 && HF_REPO_TYPE_PREFIXES.includes(parts[0])) return true;
    return false;
}

export async function inspectFile(path: string) {

    const info = statSync(path);

    return {
        name: basename(path),
        size: info.size,
        extension: extname(path),
        createdAt: info.birthtime,
        modifiedAt: info.mtime,
    };
}

interface HFFileEntry {
    id: string;
    name: string;
    size: number;
    mime: string;
    createdAt: string;

    repository: string;
    path: string;

    iv: string;
    tag: string;
}

interface HFCollection {
    version: number;
    files: HFFileEntry[];
}

export class HFDataManager {
    private static instance: HFDataManager;

    private collectionPath: string;
    private collection?: HFCollection;

    private constructor(path = ".hfcoll") {
        this.collectionPath = path;
    }

    static getInstance(): HFDataManager {
        if (!HFDataManager.instance) {
            HFDataManager.instance = new HFDataManager();
        }

        return HFDataManager.instance;
    }

    private load(): HFCollection {
        if (!this.collection) {
            if (!existsSync(this.collectionPath)) {
                this.collection = {
                    version: 1,
                    files: []
                };
            } else {
                this.collection = JSON.parse(
                    readFileSync(this.collectionPath, "utf8")
                );
            }
        }

        return this.collection ?? { version: 0, files: [ ]};
    }

    private save() {
        if (!this.collection) return;

        writeFileSync(
            this.collectionPath,
            JSON.stringify(this.collection, null, 2)
        );
    }

    addFile(file: HFFileEntry) {
        const collection = this.load();
        collection.files.push(file);
        this.save();
    }

    getFiles(): HFFileEntry[] {
        return this.load().files;
    }

    getFile(id: string) {
        return this.load().files.find(x => x.id === id);
    }

    removeFile(id: string) {
        const collection = this.load();
        collection.files = collection.files.filter(x => x.id !== id);
        this.save();
    }
}
