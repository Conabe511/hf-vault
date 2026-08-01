// Static assets for the web UI, embedded as plain strings rather than
// served from disk — this file gets bundled straight into the app by
// esbuild the same way any other module does, so it survives both the
// dev (bun run) and compiled-binary (bun build --compile) paths with no
// separate asset-copying step to keep in sync.

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HF-VAULT</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="app">Loading…</div>
<script src="/app.js"></script>
</body>
</html>
`;

export const STYLE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --panel: #171a21;
  --border: #2a2f3a;
  --text: #e6e8eb;
  --dim: #9aa1ac;
  --accent: #4f8cff;
  --danger: #ff5c5c;
  --ok: #3ecf8e;
  --warn: #e8b339;
  --lost: #ff5c5c;
  --unknown: #7a8290;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}

#app { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }

h1 { font-size: 20px; margin: 0 0 4px; }
.subtitle { color: var(--dim); margin: 0 0 24px; font-size: 13px; }

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
}

.form-row { margin-bottom: 14px; }
.form-row label { display: block; margin-bottom: 6px; color: var(--dim); font-size: 13px; }
input[type=password], input[type=text] {
  width: 100%;
  padding: 9px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #0c0e12;
  color: var(--text);
  font-size: 14px;
}

button {
  cursor: pointer;
  border: 1px solid var(--border);
  background: #1f2430;
  color: var(--text);
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 13px;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
button:disabled { opacity: 0.4; cursor: default; }

.error { color: var(--danger); font-size: 13px; margin-top: 10px; }

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.toolbar .spacer { flex: 1; }

.breadcrumb { color: var(--dim); font-size: 13px; margin-bottom: 10px; }
.breadcrumb button { background: none; border: none; color: var(--accent); padding: 0 4px; font-size: 13px; }

.dropzone {
  border: 2px dashed var(--border);
  border-radius: 10px;
  padding: 24px;
  text-align: center;
  color: var(--dim);
  margin-bottom: 16px;
}
.dropzone.drag { border-color: var(--accent); color: var(--text); }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); font-size: 13px; }
th { color: var(--dim); font-weight: 500; }
tr.row:hover { background: rgba(255,255,255,0.03); }
.folder-row { cursor: pointer; }
.folder-row:hover { color: var(--accent); }

.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.status-synced { background: var(--ok); }
.status-degraded { background: var(--warn); }
.status-lost { background: var(--lost); }
.status-unknown { background: var(--unknown); }

.dim { color: var(--dim); }
.usage { color: var(--dim); font-size: 13px; margin-bottom: 12px; }
`;

export const APP_JS = `
const app = document.getElementById("app");
let state = { folder: "", selected: new Set() };

async function api(path, opts) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts && opts.headers) } });
  if (res.status === 401) { render(); throw new Error("locked"); }
  return res;
}

async function fetchStatus() {
  const res = await fetch("/api/status");
  return res.json();
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "onclick" || k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}

async function render() {
  const status = await fetchStatus();
  app.innerHTML = "";

  if (!status.unlocked) {
    app.appendChild(renderUnlock(status));
    return;
  }

  app.appendChild(await renderBrowser());
}

function renderUnlock(status) {
  const firstRun = !status.vaultExists;
  const pw = h("input", { type: "password", placeholder: "Master password" });
  const pw2 = firstRun ? h("input", { type: "password", placeholder: "Confirm password" }) : null;
  const errorBox = h("div", { class: "error" });

  const submit = async () => {
    errorBox.textContent = "";
    if (firstRun && pw.value !== pw2.value) { errorBox.textContent = "Passwords do not match."; return; }
    if (!pw.value) { errorBox.textContent = "Password is required."; return; }

    const res = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw.value }) });
    if (!res.ok) { const body = await res.json().catch(() => ({})); errorBox.textContent = body.error || "Could not unlock."; return; }
    render();
  };

  pw.addEventListener("keydown", e => { if (e.key === "Enter" && !firstRun) submit(); });

  return h("div", { class: "panel" },
    h("h1", {}, "HF-VAULT"),
    h("p", { class: "subtitle" }, firstRun ? "No vault yet — choose a master password to create one." : "Enter your master password to unlock the vault."),
    h("div", { class: "form-row" }, h("label", {}, "Master password"), pw),
    firstRun ? h("div", { class: "form-row" }, h("label", {}, "Confirm password"), pw2) : null,
    h("button", { class: "primary", onclick: submit }, firstRun ? "Create vault" : "Unlock"),
    errorBox
  );
}

async function renderBrowser() {
  const res = await api("/api/files?folder=" + encodeURIComponent(state.folder));
  const data = await res.json();
  state.selected = new Set([...state.selected].filter(id => data.files.some(f => f.id === id)));

  const container = h("div", {});
  container.appendChild(h("h1", {}, "HF-VAULT"));
  container.appendChild(h("p", { class: "subtitle" }, "Bulk upload/download — for accounts, RAID mode, and video, use the CLI."));

  // breadcrumb
  const parts = data.folder ? data.folder.split("/") : [];
  const crumb = h("div", { class: "breadcrumb" }, h("button", { onclick: () => { state.folder = ""; render(); } }, "/"));
  let acc = "";
  for (const p of parts) {
    acc = acc ? acc + "/" + p : p;
    const target = acc;
    crumb.appendChild(document.createTextNode(" / "));
    crumb.appendChild(h("button", { onclick: () => { state.folder = target; render(); } }, p));
  }
  container.appendChild(crumb);

  container.appendChild(h("div", { class: "usage" }, "Used: " + formatBytes(data.usedBytes || 0)));

  // toolbar
  const fileInput = h("input", { type: "file", multiple: "true", style: "display:none" });
  fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

  const lockBtn = h("button", { onclick: async () => { await api("/api/lock", { method: "POST" }); render(); } }, "Lock vault");
  const uploadBtn = h("button", { class: "primary", onclick: () => fileInput.click() }, "Upload files…");
  const downloadBtn = h("button", { onclick: downloadSelected, disabled: state.selected.size === 0 ? "true" : undefined }, "Download selected" + (state.selected.size ? " (" + state.selected.size + ")" : ""));
  const deleteBtn = h("button", { class: "danger", onclick: deleteSelected, disabled: state.selected.size === 0 ? "true" : undefined }, "Delete selected");
  const moveBtn = h("button", { onclick: moveSelected, disabled: state.selected.size === 0 ? "true" : undefined }, "Move selected…");

  container.appendChild(h("div", { class: "toolbar" }, uploadBtn, fileInput, downloadBtn, moveBtn, deleteBtn, h("div", { class: "spacer" }), lockBtn));

  // dropzone
  const dropzone = h("div", { class: "dropzone" }, "Drag & drop files here to upload into \\"" + (data.folder || "/") + "\\"");
  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  container.appendChild(dropzone);

  const statusBox = h("div", { class: "error" });
  container.appendChild(statusBox);

  // table
  const table = h("table", {});
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Name"), h("th", {}, "Size"), h("th", {}, "RAID"), h("th", {}, "Uploaded"))));
  const tbody = h("tbody", {});

  for (const folder of data.subfolders) {
    tbody.appendChild(h("tr", { class: "row folder-row", onclick: () => { state.folder = data.folder ? data.folder + "/" + folder : folder; render(); } },
      h("td", {}, ""), h("td", {}, "📁 " + folder), h("td", {}, ""), h("td", {}, ""), h("td", {})
    ));
  }

  for (const f of data.files) {
    const cb = h("input", { type: "checkbox" });
    cb.checked = state.selected.has(f.id);
    cb.addEventListener("change", () => { if (cb.checked) state.selected.add(f.id); else state.selected.delete(f.id); render(); });

    const link = h("a", { href: "/api/download/" + encodeURIComponent(f.id) }, f.name);

    tbody.appendChild(h("tr", { class: "row" },
      h("td", {}, cb),
      h("td", {}, h("span", { class: "status-dot status-" + f.status }), link),
      h("td", { class: "dim" }, formatBytes(f.size)),
      h("td", { class: "dim" }, f.raid.toUpperCase()),
      h("td", { class: "dim" }, new Date(f.createdAt).toLocaleDateString())
    ));
  }

  table.appendChild(tbody);
  container.appendChild(table);

  if (data.files.length === 0 && data.subfolders.length === 0) {
    container.appendChild(h("p", { class: "dim" }, "This folder is empty."));
  }

  async function uploadFiles(fileList) {
    statusBox.textContent = "";
    const form = new FormData();
    form.append("folder", data.folder);
    for (const file of fileList) form.append("files", file);

    statusBox.textContent = "Uploading " + fileList.length + " file(s)…";
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) { statusBox.textContent = body.error || "Upload failed."; return; }

    const failed = (body.results || []).filter(r => !r.ok);
    statusBox.textContent = failed.length ? failed.length + " file(s) failed to upload." : "";
    render();
  }

  async function downloadSelected() {
    if (state.selected.size === 0) return;
    if (state.selected.size === 1) {
      window.location.href = "/api/download/" + encodeURIComponent([...state.selected][0]);
      return;
    }
    const res = await api("/api/download-zip", { method: "POST", body: JSON.stringify({ ids: [...state.selected] }) });
    if (!res.ok) { statusBox.textContent = "Download failed."; return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "hf-vault-download.zip";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteSelected() {
    if (state.selected.size === 0) return;
    if (!confirm("Permanently delete " + state.selected.size + " file(s) from the remote? This cannot be undone.")) return;
    const res = await api("/api/delete", { method: "POST", body: JSON.stringify({ ids: [...state.selected] }) });
    const body = await res.json().catch(() => ({}));
    const failed = (body.results || []).filter(r => !r.ok).length;
    statusBox.textContent = failed ? failed + " file(s) failed to delete." : "";
    state.selected.clear();
    render();
  }

  async function moveSelected() {
    if (state.selected.size === 0) return;
    const target = prompt("Move selected file(s) to which folder? (blank = root)", data.folder);
    if (target === null) return;
    await api("/api/move", { method: "POST", body: JSON.stringify({ ids: [...state.selected], folder: target }) });
    state.selected.clear();
    render();
  }

  return container;
}

render();
`;
