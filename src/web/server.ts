import { deleteFile } from "@huggingface/hub";
import { randomBytes } from "crypto";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { zipSync } from "fflate";
import { HFDataManager, HFFileEntry, normalizeFolder } from "../hf/actions";
import { HFAccount, resolveAccounts } from "../hf/accounts";
import { deleteManifest } from "../hf/manifest";
import { KeyVault } from "../cryptography/key-vault";
import { Encoder } from "../cryptography/encoder";
import { fetchRemoteIndex, entryStatus } from "../raid/status";
import { prepareUploadPlan, uploadOneFile } from "../ui/data/upload-section";
import { fetchAndReconstruct } from "../ui/data/download-section";
import { APP_JS, INDEX_HTML, STYLE_CSS } from "./assets";

const COOKIE_NAME = "hfv_session";
const sessions = new Set<string>();

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function getCookie(req: Request, name: string): string | undefined {
    const header = req.headers.get("cookie");
    if (!header) return undefined;

    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }

    return undefined;
}

/**
 * Single gate for every protected endpoint: a valid session cookie, only
 * ever issued after a correct master password (see handleUnlock). Doesn't
 * separately check KeyVault.isOpen() — sessions and the vault's open
 * state are always kept in lockstep (both created together on unlock,
 * both cleared together on lock), so one check covers both.
 */
function requireSession(req: Request): boolean {
    const token = getCookie(req, COOKIE_NAME);
    return !!token && sessions.has(token);
}

function assetResponse(body: string, contentType: string): Response {
    return new Response(body, { headers: { "content-type": contentType } });
}

async function handleStatus(_req: Request): Promise<Response> {
    const vault = KeyVault.getInstance();
    return json({
        vaultExists: vault.exists(),
        unlocked: vault.isOpen(),
        accounts: resolveAccounts().length,
    });
}

async function handleUnlock(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { password?: string } | null;
    if (!body?.password) return json({ error: "Password required" }, 400);

    const vault = KeyVault.getInstance();

    if (!vault.isOpen()) {
        try {
            vault.open(body.password);
        }
        catch (e) {
            return json({ error: "Wrong password" }, 401);
        }
    }

    const token = randomBytes(32).toString("hex");
    sessions.add(token);

    return new Response(JSON.stringify({ ok: true }), {
        headers: {
            "content-type": "application/json",
            // Strict + no Secure flag: this server is loopback-only HTTP by
            // design (see startWebServer) — SameSite=Strict is what
            // actually matters here, blocking the cookie from ever being
            // sent on a cross-site request (the main defense against some
            // other page in your browser hitting this API on your behalf).
            "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`,
        },
    });
}

async function handleLock(req: Request): Promise<Response> {
    const token = getCookie(req, COOKIE_NAME);
    if (token) sessions.delete(token);

    // Closing wipes the in-RAM key material — every other session (if any)
    // loses access too, same as locking the vault from the CLI would.
    KeyVault.getInstance().close();
    sessions.clear();

    return json({ ok: true });
}

/** Immediate child folder names of `folder` (one level down, not recursive) — mirrors list-files.ts. */
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

async function handleListFiles(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const folder = normalizeFolder(url.searchParams.get("folder") ?? "");

    const allFiles = HFDataManager.getInstance().getFiles();
    const accounts = resolveAccounts();
    const { index, usedBytes } = await fetchRemoteIndex(accounts);

    const filesHere = allFiles
        .filter(f => f.folder === folder)
        .map(f => ({
            id: f.id,
            name: f.name,
            size: f.size,
            mime: f.mime,
            createdAt: f.createdAt,
            raid: f.raid,
            status: entryStatus(index, f),
        }));

    return json({
        folder,
        subfolders: childFolders(allFiles, folder),
        files: filesHere,
        allFolders: HFDataManager.getInstance().listFolders(),
        usedBytes,
    });
}

async function handleUpload(req: Request): Promise<Response> {
    const form = await req.formData();
    const folder = normalizeFolder(String(form.get("folder") ?? ""));
    const incoming = form.getAll("files").filter((f): f is File => f instanceof File);

    if (incoming.length === 0) return json({ error: "No files provided" }, 400);

    const plan = await prepareUploadPlan();
    if (!plan) return json({ error: "No Hugging Face account is configured (use the CLI's Settings -> Configuration)." }, 400);

    const results: { name: string; ok: boolean; fileId?: string }[] = [];

    for (const file of incoming) {
        const tempPath = randomBytes(16).toString("hex");
        writeFileSync(tempPath, Buffer.from(await file.arrayBuffer()));

        try {
            const result = await uploadOneFile(tempPath, folder, plan, file.name);
            results.push(result.ok ? { name: file.name, ok: true, fileId: result.fileId } : { name: file.name, ok: false });
        }
        finally {
            try { unlinkSync(tempPath); } catch (e) { /* best-effort */ }
        }
    }

    return json({ results });
}

/** Reconstructed bytes, decrypted if the entry isn't raw — shared by single and zip download. */
async function reconstructAndDecrypt(entry: HFFileEntry): Promise<Buffer | null> {
    const cipherBuffer = await fetchAndReconstruct(entry);
    if (!cipherBuffer) return null;
    if (entry.raw) return cipherBuffer;

    const tempIn = randomBytes(16).toString("hex");
    const tempOut = randomBytes(16).toString("hex");
    writeFileSync(tempIn, cipherBuffer);

    try {
        const encoder = Encoder.forExistingFile(entry.id, Buffer.from(entry.iv, "hex"));
        await encoder.decryptFile(tempIn, tempOut);
        return readFileSync(tempOut);
    }
    finally {
        try { unlinkSync(tempIn); } catch (e) { /* best-effort */ }
        try { unlinkSync(tempOut); } catch (e) { /* best-effort */ }
    }
}

async function handleDownload(_req: Request, id: string): Promise<Response> {
    const entry = HFDataManager.getInstance().getFile(id);
    if (!entry) return json({ error: "Not found" }, 404);

    if (!KeyVault.getInstance().hasKey(entry.id) && !entry.raw) {
        return json({ error: "No decryption key in the vault for this file" }, 409);
    }

    const output = await reconstructAndDecrypt(entry);
    if (!output) return json({ error: "Could not download/reconstruct this file" }, 500);

    return new Response(output as unknown as BodyInit, {
        headers: {
            "content-type": entry.mime || "application/octet-stream",
            "content-disposition": `attachment; filename="${encodeURIComponent(entry.name)}"`,
        },
    });
}

async function handleDownloadZip(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { ids?: string[] } | null;
    if (!body?.ids?.length) return json({ error: "No files selected" }, 400);

    const zipEntries: Record<string, Uint8Array> = {};
    const usedNames = new Set<string>();
    let skipped = 0;

    for (const id of body.ids) {
        const entry = HFDataManager.getInstance().getFile(id);
        if (!entry) { skipped++; continue; }

        const output = await reconstructAndDecrypt(entry);
        if (!output) { skipped++; continue; }

        let name = entry.name;
        let n = 1;
        while (usedNames.has(name)) name = `${entry.name} (${n++})`;
        usedNames.add(name);

        zipEntries[name] = new Uint8Array(output);
    }

    if (Object.keys(zipEntries).length === 0) return json({ error: "None of the selected files could be reconstructed" }, 500);

    const zipped = zipSync(zipEntries);

    return new Response(zipped as BodyInit, {
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="hf-vault-download.zip"`,
            "x-skipped-count": String(skipped),
        },
    });
}

async function handleDelete(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { ids?: string[] } | null;
    if (!body?.ids?.length) return json({ error: "No files selected" }, 400);

    const accounts = resolveAccounts();
    const results: { id: string; ok: boolean }[] = [];

    for (const id of body.ids) {
        const entry = HFDataManager.getInstance().getFile(id);
        if (!entry) { results.push({ id, ok: false }); continue; }

        let anyFailure = false;

        for (const shard of entry.shards) {
            const account = accounts.find(a => a.id === shard.accountId);
            if (!account) continue;

            try {
                await deleteFile({ repo: account.repo, path: shard.path, accessToken: account.token });
            }
            catch (e) {
                anyFailure = true;
            }
        }

        const uniqueAccounts = [...new Map(entry.shards.map(s => [s.accountId, accounts.find(a => a.id === s.accountId)])).values()]
            .filter((a): a is HFAccount => a !== undefined);

        for (const account of uniqueAccounts) {
            await deleteManifest(account, entry.id);
        }

        if (!anyFailure) {
            HFDataManager.getInstance().removeFile(entry.id);
        }

        results.push({ id, ok: !anyFailure });
    }

    return json({ results });
}

async function handleMove(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { ids?: string[]; folder?: string } | null;
    if (!body?.ids?.length || body.folder === undefined) return json({ error: "ids and folder are required" }, 400);

    const folder = normalizeFolder(body.folder);
    for (const id of body.ids) {
        HFDataManager.getInstance().moveFile(id, folder);
    }

    return json({ ok: true });
}

export function startWebServer(port: number, hostname: string) {
    const server = Bun.serve({
        port,
        hostname,
        async fetch(req) {
            const url = new URL(req.url);
            const { pathname } = url;

            try {
                if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
                    return assetResponse(INDEX_HTML, "text/html; charset=utf-8");
                }
                if (req.method === "GET" && pathname === "/app.js") {
                    return assetResponse(APP_JS, "application/javascript; charset=utf-8");
                }
                if (req.method === "GET" && pathname === "/style.css") {
                    return assetResponse(STYLE_CSS, "text/css; charset=utf-8");
                }

                if (req.method === "GET" && pathname === "/api/status") return await handleStatus(req);
                if (req.method === "POST" && pathname === "/api/unlock") return await handleUnlock(req);
                if (req.method === "POST" && pathname === "/api/lock") return await handleLock(req);

                if (!requireSession(req)) return json({ error: "Unauthorized — unlock the vault first" }, 401);

                if (req.method === "GET" && pathname === "/api/files") return await handleListFiles(req);
                if (req.method === "POST" && pathname === "/api/upload") return await handleUpload(req);
                if (req.method === "GET" && pathname.startsWith("/api/download/")) {
                    return await handleDownload(req, decodeURIComponent(pathname.slice("/api/download/".length)));
                }
                if (req.method === "POST" && pathname === "/api/download-zip") return await handleDownloadZip(req);
                if (req.method === "POST" && pathname === "/api/delete") return await handleDelete(req);
                if (req.method === "POST" && pathname === "/api/move") return await handleMove(req);

                return json({ error: "Not found" }, 404);
            }
            catch (e) {
                console.error(e);
                return json({ error: (e as Error).message }, 500);
            }
        },
    });

    return server;
}
