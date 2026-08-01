import { Database } from "bun:sqlite";
import { createRepo, repoExists, uploadFile } from "@huggingface/hub"
import { HFVInvalidToken, HFVRepoNotFound, HFVInvalidName } from './errors'
import { existsSync, readFileSync, renameSync, statSync } from "node:fs"
import { basename, extname } from "node:path"
import { resolveAppFile } from "../utils/app-paths"
import { RaidMode } from "../raid/types"

export async function createHFRepo(name: string, token: string) {

    if (!token) {
        throw new HFVInvalidToken()
    }

    if (!isHFNameValid(name)) {
        throw new HFVInvalidName()
    }

    try {
        await createRepo({
            accessToken: token,
            repo: name,
            visibility: "public",
        })
    }
    catch (err) {
        console.log(err)
    }
}

export async function uploadFileToHF(file: File, to: string, token: string) {
    if (!token) {
        throw new HFVInvalidToken()
    }

    if (!isHFNameValid(to)) {
        throw new HFVInvalidName()
    }

    if (!await repoExists({ accessToken: token, repo: to})) {
        throw new HFVRepoNotFound()
    }

    try {
        await uploadFile({
            accessToken: token,
            repo: to,
            file: file
        })
    }
    catch (err) {
        console.log(err)
    }
}

const HF_REPO_TYPE_PREFIXES = ["spaces", "datasets", "models"];

export function isHFNameValid(name: string): boolean {
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

export interface HFShard {
    accountId: string;
    repository: string;
    path: string;
    role: "data" | "parity-p" | "parity-q" | "mirror";
    index: number;
}

export interface HFFileEntry {
    id: string;
    name: string;
    size: number;
    mime: string;
    createdAt: string;

    iv: string;
    tag: string;

    // How this file's ciphertext is laid out across accounts, and how
    // long that ciphertext was before shard padding (needed to trim the
    // reassembled buffer on download — irrelevant for "none", which has
    // exactly one shard holding the whole ciphertext untouched).
    raid: RaidMode;
    cipherLength: number;
    shards: HFShard[];
}

// Legacy pre-RAID .hfcoll JSON shape — read once, for migration only.
interface LegacyCollection {
    version: number;
    files: {
        id: string; name: string; size: number; mime: string; createdAt: string;
        repository: string; path: string; iv: string; tag: string;
    }[];
}

function ensureSchema(db: Database) {
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
        CREATE TABLE IF NOT EXISTS files (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            size          INTEGER NOT NULL,
            mime          TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            iv            TEXT NOT NULL,
            tag           TEXT NOT NULL,
            raid          TEXT NOT NULL,
            cipher_length INTEGER NOT NULL
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS shards (
            file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            account_id  TEXT NOT NULL,
            repository  TEXT NOT NULL,
            path        TEXT NOT NULL,
            role        TEXT NOT NULL,
            shard_index INTEGER NOT NULL,
            PRIMARY KEY (file_id, account_id, path)
        )
    `);
}

/**
 * One-time upgrade path from the old flat-JSON .hfcoll to the SQLite
 * .hfcoll.db. Only runs when a .hfcoll.db doesn't exist yet but a legacy
 * .hfcoll does; every old entry becomes a single-shard raid:"none" file.
 * The old file is kept (renamed, not deleted) as a safety net.
 */
function migrateLegacyCollection(dbPath: string) {
    if (existsSync(dbPath)) return;

    const legacyPath = resolveAppFile(".hfcoll");
    if (!existsSync(legacyPath)) return;

    let legacy: LegacyCollection;
    try {
        legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
    }
    catch (e) {
        return; // malformed legacy file — behave as if there was none
    }

    const db = new Database(dbPath, { create: true });
    ensureSchema(db);

    const insertFile = db.prepare(
        `INSERT INTO files (id, name, size, mime, created_at, iv, tag, raid, cipher_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 0)`
    );
    const insertShard = db.prepare(
        `INSERT INTO shards (file_id, account_id, repository, path, role, shard_index)
         VALUES (?, 'primary', ?, ?, 'data', 0)`
    );

    const migrate = db.transaction((files: LegacyCollection["files"]) => {
        for (const f of files) {
            insertFile.run(f.id, f.name, f.size, f.mime, f.createdAt, f.iv ?? "", f.tag ?? "");
            insertShard.run(f.id, f.repository, f.path);
        }
    });

    migrate(legacy.files ?? []);
    db.close();

    renameSync(legacyPath, resolveAppFile(".hfcoll.json.bak"));
}

interface FileRow {
    id: string; name: string; size: number; mime: string; created_at: string;
    iv: string; tag: string; raid: string; cipher_length: number;
}

interface ShardRow {
    file_id: string; account_id: string; repository: string; path: string;
    role: HFShard["role"]; shard_index: number;
}

export class HFDataManager {
    private static instance: HFDataManager;

    private db: Database;

    private constructor(path = ".hfcoll.db") {
        const dbPath = resolveAppFile(path);
        migrateLegacyCollection(dbPath);

        this.db = new Database(dbPath, { create: true });
        ensureSchema(this.db);
    }

    static getInstance(): HFDataManager {
        if (!HFDataManager.instance) {
            HFDataManager.instance = new HFDataManager();
        }

        return HFDataManager.instance;
    }

    private toEntry(fileRow: FileRow, shardRows: ShardRow[]): HFFileEntry {
        return {
            id: fileRow.id,
            name: fileRow.name,
            size: fileRow.size,
            mime: fileRow.mime,
            createdAt: fileRow.created_at,
            iv: fileRow.iv,
            tag: fileRow.tag,
            raid: fileRow.raid as RaidMode,
            cipherLength: fileRow.cipher_length,
            shards: shardRows
                .filter(s => s.file_id === fileRow.id)
                .sort((a, b) => a.shard_index - b.shard_index)
                .map(s => ({
                    accountId: s.account_id,
                    repository: s.repository,
                    path: s.path,
                    role: s.role,
                    index: s.shard_index,
                })),
        };
    }

    addFile(file: HFFileEntry) {
        const insertFile = this.db.prepare(
            `INSERT INTO files (id, name, size, mime, created_at, iv, tag, raid, cipher_length)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertShard = this.db.prepare(
            `INSERT INTO shards (file_id, account_id, repository, path, role, shard_index)
             VALUES (?, ?, ?, ?, ?, ?)`
        );

        const tx = this.db.transaction((f: HFFileEntry) => {
            insertFile.run(f.id, f.name, f.size, f.mime, f.createdAt, f.iv, f.tag, f.raid, f.cipherLength);
            for (const s of f.shards) {
                insertShard.run(f.id, s.accountId, s.repository, s.path, s.role, s.index);
            }
        });

        tx(file);
    }

    getFiles(): HFFileEntry[] {
        const fileRows = this.db.query("SELECT * FROM files ORDER BY created_at DESC").all() as FileRow[];
        const shardRows = this.db.query("SELECT * FROM shards").all() as ShardRow[];

        return fileRows.map(f => this.toEntry(f, shardRows));
    }

    getFile(id: string): HFFileEntry | undefined {
        const fileRow = this.db.query("SELECT * FROM files WHERE id = ?").get(id) as FileRow | null;
        if (!fileRow) return undefined;

        const shardRows = this.db.query("SELECT * FROM shards WHERE file_id = ?").all(id) as ShardRow[];
        return this.toEntry(fileRow, shardRows);
    }

    removeFile(id: string) {
        // ON DELETE CASCADE (foreign_keys pragma is on) takes the shards with it
        this.db.run("DELETE FROM files WHERE id = ?", [id]);
    }
}
