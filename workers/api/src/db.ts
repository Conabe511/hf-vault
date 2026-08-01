// D1-backed equivalent of src/hf/actions.ts's HFDataManager, plus the
// accounts/config/vault tables the local CLI doesn't need (it has
// .hfconf/.hfkey on disk instead). Schema: ./schema.sql.
import { HFAccount, HFShard, RaidMode } from "./raid-types";

export interface HFFileEntry {
    id: string;
    name: string;
    size: number;
    mime: string;
    createdAt: string;
    iv: string;
    tag: string;
    raid: RaidMode;
    cipherLength: number;
    shards: HFShard[];
    folder: string;
}

interface FileRow {
    id: string; name: string; size: number; mime: string; created_at: string;
    iv: string; tag: string; raid: string; cipher_length: number; folder: string;
}
interface ShardRow {
    file_id: string; account_id: string; repository: string; path: string;
    role: HFShard["role"]; shard_index: number;
}

function toEntry(f: FileRow, shardRows: ShardRow[]): HFFileEntry {
    return {
        id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.created_at,
        iv: f.iv, tag: f.tag, raid: f.raid as RaidMode, cipherLength: f.cipher_length, folder: f.folder,
        shards: shardRows
            .filter(s => s.file_id === f.id)
            .sort((a, b) => a.shard_index - b.shard_index)
            .map(s => ({ accountId: s.account_id, repository: s.repository, path: s.path, role: s.role, index: s.shard_index })),
    };
}

export function normalizeFolder(path: string): string {
    return path
        .replace(/\\/g, "/")
        .split("/")
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .join("/");
}

export async function getFiles(db: D1Database, folder?: string): Promise<HFFileEntry[]> {
    const fileRows = folder === undefined
        ? (await db.prepare("SELECT * FROM files ORDER BY created_at DESC").all<FileRow>()).results
        : (await db.prepare("SELECT * FROM files WHERE folder = ? ORDER BY created_at DESC").bind(folder).all<FileRow>()).results;

    const shardRows = (await db.prepare("SELECT * FROM shards").all<ShardRow>()).results;
    return fileRows.map(f => toEntry(f, shardRows));
}

export async function getFile(db: D1Database, id: string): Promise<HFFileEntry | null> {
    const fileRow = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
    if (!fileRow) return null;
    const shardRows = (await db.prepare("SELECT * FROM shards WHERE file_id = ?").bind(id).all<ShardRow>()).results;
    return toEntry(fileRow, shardRows);
}

export async function addFile(db: D1Database, f: HFFileEntry): Promise<void> {
    const statements = [
        db.prepare(
            `INSERT INTO files (id, name, size, mime, created_at, iv, tag, raid, cipher_length, folder)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(f.id, f.name, f.size, f.mime, f.createdAt, f.iv, f.tag, f.raid, f.cipherLength, normalizeFolder(f.folder)),
        ...f.shards.map(s =>
            db.prepare(
                `INSERT INTO shards (file_id, account_id, repository, path, role, shard_index)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(f.id, s.accountId, s.repository, s.path, s.role, s.index)
        ),
    ];
    await db.batch(statements);
}

export async function removeFile(db: D1Database, id: string): Promise<void> {
    await db.batch([
        db.prepare("DELETE FROM shards WHERE file_id = ?").bind(id),
        db.prepare("DELETE FROM files WHERE id = ?").bind(id),
    ]);
}

export async function moveFile(db: D1Database, id: string, folder: string): Promise<void> {
    await db.prepare("UPDATE files SET folder = ? WHERE id = ?").bind(normalizeFolder(folder), id).run();
}

export async function listFolders(db: D1Database): Promise<string[]> {
    const rows = (await db.prepare("SELECT DISTINCT folder FROM files WHERE folder != '' ORDER BY folder").all<{ folder: string }>()).results;
    return rows.map(r => r.folder);
}

// --- accounts ---

export async function getAccounts(db: D1Database): Promise<HFAccount[]> {
    return (await db.prepare("SELECT * FROM accounts").all<HFAccount>()).results;
}

export async function addAccount(db: D1Database, account: HFAccount): Promise<void> {
    await db.prepare("INSERT INTO accounts (id, label, token, repo) VALUES (?, ?, ?, ?)")
        .bind(account.id, account.label, account.token, account.repo).run();
}

export async function removeAccount(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
}

// --- config ---

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
    const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
    await db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, value).run();
}

// --- vault (opaque encrypted blob; see schema.sql) ---

export interface VaultEnvelope {
    salt: string;
    iv: string;
    tag: string;
    data: string;
}

export async function getVault(db: D1Database): Promise<VaultEnvelope | null> {
    return await db.prepare("SELECT salt, iv, tag, data FROM vault WHERE id = 1").first<VaultEnvelope>();
}

export async function putVault(db: D1Database, envelope: VaultEnvelope): Promise<void> {
    await db.prepare(
        `INSERT INTO vault (id, salt, iv, tag, data) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, iv = excluded.iv, tag = excluded.tag, data = excluded.data`
    ).bind(envelope.salt, envelope.iv, envelope.tag, envelope.data).run();
}
