// HF-VAULT web UI for the Workers/Pages deployment. All AES-GCM
// encryption/decryption happens here (see crypto.js) — the API server
// never sees plaintext or a key. Vanilla JS, no build step, no framework.

const LS_API = "hfv_api_base";
const LS_TOKEN = "hfv_access_token";

const state = {
    apiBase: localStorage.getItem(LS_API) || "",
    accessToken: localStorage.getItem(LS_TOKEN) || "",
    vault: null,       // { salt: Uint8Array, data: {version, keys: {fileId: hexKey}} }
    password: null,    // kept in memory only for this tab's session, to re-persist the vault on key changes
    folder: "",
    selected: new Set(),
};

const root = document.getElementById("app");

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") el.className = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(1)} ${units[i]}`;
}

async function apiFetch(path, opts = {}) {
    const res = await fetch(state.apiBase.replace(/\/$/, "") + path, {
        ...opts,
        headers: { ...(opts.headers || {}), authorization: `Bearer ${state.accessToken}` },
    });
    return res;
}

// ---------- setup (API URL + access token) ----------

function renderSetup() {
    let apiInput, tokenInput;
    root.replaceChildren(
        h("div", { class: "card" },
            h("h1", {}, "HF-VAULT"),
            h("p", { class: "muted" }, "Connect to your Worker API."),
            h("label", {}, "Worker API URL"),
            apiInput = h("input", { type: "text", placeholder: "https://hf-vault-api.<you>.workers.dev", value: state.apiBase }),
            h("label", {}, "Access token"),
            tokenInput = h("input", { type: "password", placeholder: "ACCESS_TOKEN secret", value: state.accessToken }),
            h("button", {
                class: "primary", onclick: () => {
                    state.apiBase = apiInput.value.trim();
                    state.accessToken = tokenInput.value.trim();
                    localStorage.setItem(LS_API, state.apiBase);
                    localStorage.setItem(LS_TOKEN, state.accessToken);
                    renderUnlock();
                }
            }, "Connect"),
        ),
    );
}

// ---------- vault unlock / create ----------

async function renderUnlock() {
    let statusRes;
    try {
        statusRes = await apiFetch("/api/status");
    }
    catch (e) {
        // Network-level failure (DNS, TLS, connection refused — e.g. a
        // stale API URL left over from a previous deploy) throws instead
        // of resolving to a Response, and would otherwise leave the page
        // blank forever with no way back to Setup.
        root.replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, `Could not reach ${state.apiBase || "(no URL set)"} — check the Worker URL.`), h("button", { onclick: renderSetup }, "Back to setup")));
        return;
    }
    if (statusRes.status === 401) {
        root.replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, "Unauthorized — check the access token."), h("button", { onclick: renderSetup }, "Back")));
        return;
    }
    if (!statusRes.ok) {
        root.replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, "Could not reach the API — check the URL."), h("button", { onclick: renderSetup }, "Back")));
        return;
    }

    const vaultRes = await apiFetch("/api/vault");

    if (vaultRes.status === 404) {
        renderCreateVault();
        return;
    }

    const envelope = await vaultRes.json();
    let pwInput, errBox;
    root.replaceChildren(
        h("div", { class: "card" },
            h("h1", {}, "Unlock vault"),
            errBox = h("p", { class: "error hidden" }),
            pwInput = h("input", { type: "password", placeholder: "Master password", onkeydown: e => { if (e.key === "Enter") tryUnlock(); } }),
            h("button", { class: "primary", onclick: () => tryUnlock() }, "Unlock"),
        ),
    );

    async function tryUnlock() {
        try {
            state.vault = await unlockVault(envelope, pwInput.value);
            state.password = pwInput.value;
            renderBrowser();
        }
        catch (e) {
            errBox.textContent = "Wrong password.";
            errBox.classList.remove("hidden");
        }
    }
}

function renderCreateVault() {
    let pw1, pw2, errBox;
    root.replaceChildren(
        h("div", { class: "card" },
            h("h1", {}, "Create vault"),
            h("p", { class: "muted" }, "No vault exists on this Worker yet — set a master password. There is no recovery if you lose it."),
            errBox = h("p", { class: "error hidden" }),
            pw1 = h("input", { type: "password", placeholder: "Master password" }),
            pw2 = h("input", { type: "password", placeholder: "Confirm password" }),
            h("button", {
                class: "primary", onclick: async () => {
                    if (pw1.value.length < 8) { errBox.textContent = "Use at least 8 characters."; errBox.classList.remove("hidden"); return; }
                    if (pw1.value !== pw2.value) { errBox.textContent = "Passwords don't match."; errBox.classList.remove("hidden"); return; }
                    state.vault = createEmptyVault();
                    state.password = pw1.value;
                    await persistVault();
                    renderBrowser();
                }
            }, "Create vault"),
        ),
    );
}

async function persistVault() {
    const envelope = await sealVault(state.vault, state.password);
    await apiFetch("/api/vault", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
}

function lock() {
    state.vault = null;
    state.password = null;
    state.selected.clear();
    renderUnlock();
}

// ---------- file browser ----------

async function renderBrowser() {
    const res = await apiFetch(`/api/files?folder=${encodeURIComponent(state.folder)}`);
    const { subfolders, files, allFolders } = await res.json();
    state.selected.clear();

    const crumbs = state.folder === "" ? [""] : ["", ...state.folder.split("/")];
    const breadcrumb = h("div", { class: "breadcrumb" },
        crumbs.map((_, i) => {
            const path = crumbs.slice(1, i + 1).join("/");
            return h("span", {},
                h("a", { href: "#", onclick: (e) => { e.preventDefault(); state.folder = path; renderBrowser(); } }, i === 0 ? "root" : crumbs[i]),
                i < crumbs.length - 1 ? " / " : "",
            );
        }),
    );

    const dropzone = h("div", {
        class: "dropzone",
        ondragover: e => { e.preventDefault(); dropzone.classList.add("drag"); },
        ondragleave: () => dropzone.classList.remove("drag"),
        ondrop: async e => {
            e.preventDefault();
            dropzone.classList.remove("drag");
            await uploadFiles([...e.dataTransfer.files]);
        },
    },
        "Drag files here, or ",
        h("label", { class: "filelabel" }, "browse",
            h("input", {
                type: "file", multiple: true, class: "hidden",
                onchange: e => uploadFiles([...e.target.files]),
            }),
        ),
    );

    const folderList = subfolders.map(name => h("div", { class: "row folder" },
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); state.folder = state.folder ? `${state.folder}/${name}` : name; renderBrowser(); } }, `📁 ${name}`),
    ));

    const fileList = files.map(f => {
        const cb = h("input", {
            type: "checkbox", onchange: (e) => {
                if (e.target.checked) state.selected.add(f.id); else state.selected.delete(f.id);
            }
        });
        return h("div", { class: "row" },
            cb,
            h("span", { class: "fname" }, f.name),
            h("span", { class: "fmeta" }, `${formatBytes(f.size)} · ${f.raid}`),
            h("button", { class: "small", onclick: () => downloadOne(f) }, "Download"),
        );
    });

    root.replaceChildren(
        h("div", { class: "toolbar" },
            breadcrumb,
            h("div", { class: "spacer" }),
            h("button", { class: "small", onclick: () => renderSettings() }, "Settings"),
            h("button", { class: "small", onclick: lock }, "Lock"),
        ),
        dropzone,
        h("div", { class: "actions" },
            h("button", { onclick: () => bulkDownload(files) }, "Download selected (.zip)"),
            h("button", { onclick: () => bulkDelete() }, "Delete selected"),
            h("button", { onclick: () => bulkMove(allFolders) }, "Move selected"),
        ),
        h("div", { class: "list" }, folderList.length || fileList.length ? [...folderList, ...fileList] : h("p", { class: "muted" }, "Empty folder.")),
    );
}

// ---------- upload ----------

async function uploadFiles(fileObjs) {
    for (const file of fileObjs) {
        await uploadOne(file);
    }
    renderBrowser();
}

async function uploadOne(file) {
    const plaintext = await file.arrayBuffer();
    const hexKey = await generateFileKeyHex();
    const { iv, cipherBytes } = await encryptFileBytes(hexKey, plaintext);

    const uploadRes = await apiFetch("/api/upload", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
            "x-file-mime": file.type || "application/octet-stream",
            "x-file-size": String(file.size),
            "x-file-folder": encodeURIComponent(state.folder),
            "x-file-iv": iv,
        },
        body: cipherBytes,
    });

    if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({ error: "upload failed" }));
        alert(`Upload of ${file.name} failed: ${err.error}`);
        return;
    }

    const { fileId, raid, cipherLength, shards } = await uploadRes.json();

    state.vault.data.keys[fileId] = hexKey;
    await persistVault();

    const tag = toHex(cipherBytes.subarray(cipherBytes.length - 16));
    const manifestBytes = await encryptManifest(hexKey, { id: fileId, raid, cipherLength, iv, tag, shards });
    await apiFetch("/api/upload-manifest", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-id": fileId },
        body: manifestBytes,
    });
}

// ---------- download ----------

async function fetchAndDecrypt(entry) {
    const res = await apiFetch(`/api/download/${entry.id}`);
    if (!res.ok) throw new Error("download failed");

    const cipherBytes = new Uint8Array(await res.arrayBuffer());
    const iv = res.headers.get("x-file-iv");
    const hexKey = state.vault.data.keys[entry.id];
    if (!hexKey) throw new Error("no key in the vault for this file");

    const plaintext = await decryptFileBytes(hexKey, iv, cipherBytes);
    return new Uint8Array(plaintext);
}

async function downloadOne(entry) {
    try {
        const plaintext = await fetchAndDecrypt(entry);
        triggerDownload(entry.name, plaintext);
    }
    catch (e) {
        alert(`Could not download ${entry.name}: ${e.message}`);
    }
}

function triggerDownload(name, bytes) {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function bulkDownload(files) {
    const chosen = files.filter(f => state.selected.has(f.id));
    if (chosen.length === 0) { alert("Select at least one file."); return; }

    const entries = [];
    const usedNames = new Set();
    for (const f of chosen) {
        try {
            const bytes = await fetchAndDecrypt(f);
            let name = f.name, n = 1;
            while (usedNames.has(name)) name = `${f.name} (${n++})`;
            usedNames.add(name);
            entries.push({ name, data: bytes });
        }
        catch (e) { /* skip failures, continue with the rest */ }
    }

    if (entries.length === 0) { alert("None of the selected files could be reconstructed."); return; }
    triggerDownload("hf-vault-download.zip", zipStore(entries));
}

// ---------- delete / move ----------

async function bulkDelete() {
    if (state.selected.size === 0) { alert("Select at least one file."); return; }
    if (!confirm(`Delete ${state.selected.size} file(s)? This cannot be undone.`)) return;

    await apiFetch("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...state.selected] }) });
    renderBrowser();
}

async function bulkMove(allFolders) {
    if (state.selected.size === 0) { alert("Select at least one file."); return; }
    const target = prompt(`Move to which folder? (existing: ${allFolders.join(", ") || "none"})\nLeave blank for root.`, "");
    if (target === null) return;

    await apiFetch("/api/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...state.selected], folder: target }) });
    renderBrowser();
}

// ---------- settings (accounts + RAID mode) ----------

async function renderSettings() {
    const [accountsRes, raidRes] = await Promise.all([apiFetch("/api/admin/accounts"), apiFetch("/api/admin/raid-mode")]);
    const accounts = await accountsRes.json();
    const { raidMode } = await raidRes.json();

    let labelInput, tokenInput, repoInput, raidSelect;

    root.replaceChildren(
        h("div", { class: "card" },
            h("div", { class: "toolbar" }, h("h1", {}, "Settings"), h("div", { class: "spacer" }), h("button", { class: "small", onclick: renderBrowser }, "Back")),

            h("h2", {}, "RAID mode"),
            raidSelect = h("select", {},
                ["none", "raid0", "raid1", "raid6"].map(m => h("option", { value: m, selected: m === raidMode }, m)),
            ),
            h("button", {
                onclick: async () => {
                    await apiFetch("/api/admin/raid-mode", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ raidMode: raidSelect.value }) });
                    renderSettings();
                }
            }, "Save"),

            h("h2", {}, "Accounts"),
            h("div", { class: "list" }, accounts.map(a => h("div", { class: "row" },
                h("span", {}, `${a.label} — ${a.repo}`),
                h("button", { class: "small", onclick: async () => { await apiFetch(`/api/admin/accounts/${a.id}`, { method: "DELETE" }); renderSettings(); } }, "Remove"),
            ))),

            h("h3", {}, "Add account"),
            labelInput = h("input", { placeholder: "Label" }),
            repoInput = h("input", { placeholder: "buckets/user/repo-name" }),
            tokenInput = h("input", { type: "password", placeholder: "HF access token (hf_...)" }),
            h("button", {
                class: "primary", onclick: async () => {
                    if (!labelInput.value || !repoInput.value || !tokenInput.value) return;
                    await apiFetch("/api/admin/accounts", {
                        method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ label: labelInput.value, repo: repoInput.value, token: tokenInput.value }),
                    });
                    renderSettings();
                }
            }, "Add"),
        ),
    );
}

// ---------- boot ----------

if (!state.apiBase || !state.accessToken) renderSetup();
else renderUnlock();
