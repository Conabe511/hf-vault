// HF-VAULT Workers API. Deliberately never sees plaintext or an AES key:
// the browser (workers/pages) does all encryption/decryption client-side
// via WebCrypto and only ever sends/receives ciphertext + the (non-secret)
// GCM IV. This Worker's job is everything that DOES need a server: holding
// Hugging Face account tokens, RAID-splitting/joining ciphertext across
// them, and storing file metadata in D1.
//
// Every /api/* route requires `Authorization: Bearer <ACCESS_TOKEN>` — a
// second, independent secret from the vault master password (see
// README's Workers section). Without it, anyone who finds this Worker's
// URL could at least see how many accounts/files exist and attempt to
// brute-force the vault's password offline against the encrypted blob.
import { ensureRepo, uploadBlob, uploadBlobAt, deleteBlob, listRepoPaths } from "./hf";
import {
    HFFileEntry, addFile, getAccounts, addAccount, removeAccount, getConfig, setConfig,
    getFile, getFiles, getVault, listFolders, moveFile, normalizeFolder, putVault, removeFile,
} from "./db";
import { resolveEffectiveRaid, planUpload, buildShardBuffers } from "./raid-layout";
import { HFAccount, RaidMode, ShardAssignment } from "./raid-types";
import { fetchFullCiphertext } from "./reconstruct";

export interface Env {
    DB: D1Database;
    ACCESS_TOKEN: string;
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function checkAuth(req: Request, env: Env): boolean {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return !!env.ACCESS_TOKEN && timingSafeEqual(token, env.ACCESS_TOKEN);
}

function manifestPathFor(fileId: string): string {
    return `${fileId}.hfmanifest`;
}

function randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleStatus(env: Env): Promise<Response> {
    const vault = await getVault(env.DB);
    const accounts = await getAccounts(env.DB);
    return json({ hasVault: vault !== null, accounts: accounts.length });
}

async function handleGetVault(env: Env): Promise<Response> {
    const vault = await getVault(env.DB);
    return vault ? json(vault) : json({ error: "No vault yet" }, 404);
}

async function handlePutVault(req: Request, env: Env): Promise<Response> {
    const body = await req.json().catch(() => null) as { salt?: string; iv?: string; tag?: string; data?: string } | null;
    if (!body?.salt || !body.iv || !body.tag || !body.data) return json({ error: "salt/iv/tag/data required" }, 400);
    await putVault(env.DB, { salt: body.salt, iv: body.iv, tag: body.tag, data: body.data });
    return json({ ok: true });
}

function childFolders(files: { folder: string }[], folder: string): string[] {
    const names = new Set<string>();
    for (const f of files) {
        if (folder === "") {
            if (f.folder === "") continue;
            names.add(f.folder.split("/")[0]);
        }
        else {
            const prefix = `${folder}/`;
            if (!f.folder.startsWith(prefix)) continue;
            const rest = f.folder.slice(prefix.length);
            if (rest) names.add(rest.split("/")[0]);
        }
    }
    return [...names].sort();
}

async function handleListFiles(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const folder = normalizeFolder(url.searchParams.get("folder") ?? "");

    const allFiles = await getFiles(env.DB);
    const filesHere = allFiles
        .filter(f => f.folder === folder)
        .map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.createdAt, raid: f.raid, iv: f.iv }));

    return json({
        folder,
        subfolders: childFolders(allFiles, folder),
        files: filesHere,
        allFolders: await listFolders(env.DB),
    });
}

/** Resolves configured accounts + effective RAID mode, creating repos as needed. Shared by upload. */
async function prepareUploadPlan(env: Env): Promise<{ mode: RaidMode; assignments: ShardAssignment[] } | { error: string }> {
    const accounts = await getAccounts(env.DB);
    if (accounts.length === 0) return { error: "No Hugging Face account configured (see /api/admin/accounts)." };

    const requested = (await getConfig(env.DB, "raid_mode")) as RaidMode ?? "none";
    const { mode, reason } = resolveEffectiveRaid(requested, accounts.length);
    const plan = planUpload(mode, accounts);

    const uniqueAccounts = [...new Map(plan.assignments.map(a => [a.account.id, a.account])).values()];
    for (const account of uniqueAccounts) {
        await ensureRepo(account);
    }

    return { mode, assignments: plan.assignments };
}

async function handleUpload(req: Request, env: Env): Promise<Response> {
    const nameHeader = req.headers.get("x-file-name");
    const mime = req.headers.get("x-file-mime") ?? "application/octet-stream";
    const size = parseInt(req.headers.get("x-file-size") ?? "0", 10);
    const folder = normalizeFolder(decodeURIComponent(req.headers.get("x-file-folder") ?? ""));
    const iv = req.headers.get("x-file-iv");
    if (!nameHeader || !iv || !req.body) return json({ error: "x-file-name/x-file-iv headers and a body are required" }, 400);
    const name = decodeURIComponent(nameHeader);

    const cipherBuffer = Buffer.from(await req.arrayBuffer());
    if (cipherBuffer.length === 0) return json({ error: "Empty upload" }, 400);

    const plan = await prepareUploadPlan(env);
    if ("error" in plan) return json({ error: plan.error }, 400);

    const fileId = randomHex(16);
    const shardBuffers = buildShardBuffers(plan.mode, plan.assignments, cipherBuffer);
    const uploaded: { assignment: ShardAssignment; path: string }[] = [];

    try {
        for (const [assignment, buf] of shardBuffers) {
            const path = await uploadBlob(assignment.account, buf, `Upload shard for ${fileId}`);
            uploaded.push({ assignment, path });
        }
    }
    catch (err) {
        for (const shard of uploaded) {
            await deleteBlob(shard.assignment.account, shard.path);
        }
        return json({ error: (err as Error).message }, 500);
    }

    const shards = uploaded.map(({ assignment, path }) => ({
        accountId: assignment.account.id,
        repository: assignment.account.repo,
        path,
        role: assignment.role,
        index: assignment.index,
    }));

    // tag isn't independently meaningful once split across shards (see
    // workers/api/README note) — stored as the last 16 bytes of the whole
    // ciphertext purely for display/consistency; decrypt always uses the
    // full reconstructed buffer, not this field.
    const tag = cipherBuffer.subarray(cipherBuffer.length - 16).toString("hex");

    const entry: HFFileEntry = {
        id: fileId, name, size: size || cipherBuffer.length, mime,
        createdAt: new Date().toISOString(),
        iv, tag, raid: plan.mode, cipherLength: cipherBuffer.length, shards, folder,
    };
    await addFile(env.DB, entry);

    return json({ fileId, raid: plan.mode, cipherLength: cipherBuffer.length, shards });
}

async function handleUploadManifest(req: Request, env: Env): Promise<Response> {
    const fileId = req.headers.get("x-file-id");
    if (!fileId || !req.body) return json({ error: "x-file-id header and a body are required" }, 400);

    const entry = await getFile(env.DB, fileId);
    if (!entry) return json({ error: "Unknown file id" }, 404);

    const bytes = new Uint8Array(await req.arrayBuffer());
    const accounts = await getAccounts(env.DB);
    const uniqueAccountIds = [...new Set(entry.shards.map(s => s.accountId))];

    for (const accountId of uniqueAccountIds) {
        const account = accounts.find(a => a.id === accountId);
        if (!account) continue;
        await uploadBlobAt(account, manifestPathFor(fileId), bytes, `Upload manifest ${fileId}`);
    }

    return json({ ok: true });
}

async function handleDownload(_req: Request, env: Env, id: string): Promise<Response> {
    const entry = await getFile(env.DB, id);
    if (!entry) return json({ error: "Not found" }, 404);

    const accounts = await getAccounts(env.DB);
    const bytes = await fetchFullCiphertext(entry, accounts);
    if (!bytes) return json({ error: "Could not reconstruct this file from its shards" }, 500);

    return new Response(bytes as unknown as BodyInit, {
        headers: {
            "content-type": "application/octet-stream",
            "x-file-iv": entry.iv,
            "x-file-name": encodeURIComponent(entry.name),
            "x-file-mime": entry.mime,
        },
    });
}

async function handleDelete(req: Request, env: Env): Promise<Response> {
    const body = await req.json().catch(() => null) as { ids?: string[] } | null;
    if (!body?.ids?.length) return json({ error: "No files selected" }, 400);

    const accounts = await getAccounts(env.DB);
    const results: { id: string; ok: boolean }[] = [];

    for (const id of body.ids) {
        const entry = await getFile(env.DB, id);
        if (!entry) { results.push({ id, ok: false }); continue; }

        let anyFailure = false;
        const touchedAccountIds = new Set<string>();

        for (const shard of entry.shards) {
            const account = accounts.find(a => a.id === shard.accountId);
            if (!account) continue;
            touchedAccountIds.add(account.id);
            if (!(await deleteBlob(account, shard.path))) anyFailure = true;
        }

        for (const accountId of touchedAccountIds) {
            const account = accounts.find(a => a.id === accountId);
            if (account) await deleteBlob(account, manifestPathFor(id));
        }

        if (!anyFailure) await removeFile(env.DB, id);
        results.push({ id, ok: !anyFailure });
    }

    return json({ results });
}

async function handleMove(req: Request, env: Env): Promise<Response> {
    const body = await req.json().catch(() => null) as { ids?: string[]; folder?: string } | null;
    if (!body?.ids?.length || body.folder === undefined) return json({ error: "ids and folder are required" }, 400);

    for (const id of body.ids) await moveFile(env.DB, id, body.folder);
    return json({ ok: true });
}

// --- admin: accounts + raid mode (same ACCESS_TOKEN gate — single-tenant deployment) ---

async function handleGetAccounts(env: Env): Promise<Response> {
    const accounts = await getAccounts(env.DB);
    return json(accounts.map(a => ({ id: a.id, label: a.label, repo: a.repo }))); // tokens never echoed back
}

async function handleAddAccount(req: Request, env: Env): Promise<Response> {
    const body = await req.json().catch(() => null) as Partial<HFAccount> | null;
    if (!body?.label || !body.token || !body.repo) return json({ error: "label/token/repo required" }, 400);

    const account: HFAccount = { id: randomHex(8), label: body.label, token: body.token, repo: body.repo };
    await addAccount(env.DB, account);
    return json({ id: account.id });
}

async function handleDeleteAccount(env: Env, id: string): Promise<Response> {
    await removeAccount(env.DB, id);
    return json({ ok: true });
}

async function handleGetRaidMode(env: Env): Promise<Response> {
    return json({ raidMode: (await getConfig(env.DB, "raid_mode")) ?? "none" });
}

async function handleSetRaidMode(req: Request, env: Env): Promise<Response> {
    const body = await req.json().catch(() => null) as { raidMode?: RaidMode } | null;
    if (!body?.raidMode) return json({ error: "raidMode required" }, 400);
    await setConfig(env.DB, "raid_mode", body.raidMode);
    return json({ ok: true });
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        const { pathname } = url;

        if (req.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "authorization, content-type, x-file-name, x-file-mime, x-file-size, x-file-folder, x-file-id, x-file-iv",
                    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                },
            });
        }

        try {
            if (!checkAuth(req, env)) return json({ error: "Unauthorized" }, 401);

            let res: Response;
            if (req.method === "GET" && pathname === "/api/status") res = await handleStatus(env);
            else if (req.method === "GET" && pathname === "/api/vault") res = await handleGetVault(env);
            else if (req.method === "PUT" && pathname === "/api/vault") res = await handlePutVault(req, env);
            else if (req.method === "GET" && pathname === "/api/files") res = await handleListFiles(req, env);
            else if (req.method === "POST" && pathname === "/api/upload") res = await handleUpload(req, env);
            else if (req.method === "POST" && pathname === "/api/upload-manifest") res = await handleUploadManifest(req, env);
            else if (req.method === "GET" && pathname.startsWith("/api/download/")) res = await handleDownload(req, env, decodeURIComponent(pathname.slice("/api/download/".length)));
            else if (req.method === "POST" && pathname === "/api/delete") res = await handleDelete(req, env);
            else if (req.method === "POST" && pathname === "/api/move") res = await handleMove(req, env);
            else if (req.method === "GET" && pathname === "/api/admin/accounts") res = await handleGetAccounts(env);
            else if (req.method === "POST" && pathname === "/api/admin/accounts") res = await handleAddAccount(req, env);
            else if (req.method === "DELETE" && pathname.startsWith("/api/admin/accounts/")) res = await handleDeleteAccount(env, decodeURIComponent(pathname.slice("/api/admin/accounts/".length)));
            else if (req.method === "GET" && pathname === "/api/admin/raid-mode") res = await handleGetRaidMode(env);
            else if (req.method === "PUT" && pathname === "/api/admin/raid-mode") res = await handleSetRaidMode(req, env);
            else res = json({ error: "Not found" }, 404);

            res.headers.set("access-control-allow-origin", "*");
            // Custom response headers (x-file-iv in particular — the browser
            // needs it to decrypt) aren't readable via res.headers.get() from
            // JS under CORS unless explicitly exposed, even same-origin-ish
            // fetches across the Pages<->Workers domain split.
            res.headers.set("access-control-expose-headers", "x-file-iv, x-file-name, x-file-mime");
            return res;
        }
        catch (err) {
            console.error(err);
            return json({ error: (err as Error).message }, 500);
        }
    },
};
