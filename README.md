# HF-VAULT ☁️🔐

Turn a Hugging Face repository into your personal encrypted cloud storage.

HF-VAULT is a terminal app that encrypts your files locally with AES-256
and uploads them to one or more Hugging Face [Storage
Buckets](https://huggingface.co/docs/hub/storage-buckets) — optionally
spread across **multiple accounts** with a **RAID0/RAID1/RAID6** layout to
pool storage or add fault tolerance. What lands on the remote is
indistinguishable from random noise: random hex names, no extensions, no
readable content. Only your machine — holding the keys and a master
password — can turn it back into files.

Buckets are created **public** on purpose: content is opaque
AES-256-GCM ciphertext under random blob names, so nothing readable is
ever exposed, and public buckets get a far larger free quota (8.8TB) than
private ones (100GB) — hence the `HF_STORAGE_TOTAL_TB` default below.

## How it works

```
your file ──> AES-256-GCM encrypt ──> RAID split/mirror ──> one blob per shard, per HF account
                     │                        │
                     └─ per-file key          └─ encrypted shard manifest, replicated alongside
                        ──> key vault (.hfkey)
                               │
                               └─ encrypted with your master password
```

- **Every file gets its own random AES-256 key.** Compromising one file
  never exposes another.
- **Keys live in a local vault file (`.hfkey`)** which is itself encrypted
  (AES-256-GCM, key derived from your master password with scrypt). It is
  never written to disk in plaintext, and it never leaves your machine.
- **File metadata (`.hfcoll.db`, SQLite)** — real names, sizes, dates, and
  which remote blobs are which — stays local only.
- **RAID modes** (optional, configured under *Settings → RAID Mode*) split
  or mirror a file's already-encrypted bytes across whichever accounts you
  configure under *Settings → Accounts*:
  - **RAID0** — stripes across every account: pools their storage into one
    bigger vault, but any one account going down loses the file (no redundancy).
  - **RAID1** — mirrors to every account: any single surviving account is
    enough to recover a file. Needs 2+ accounts.
  - **RAID6** — stripes with dual parity: tolerates up to 2 accounts going
    down at once while still pooling most of their storage. Needs 4+ accounts.
  - If fewer accounts are configured than a mode needs at upload time,
    HF-VAULT falls back to a simpler mode automatically and says so.
  - RAID assignment happens at upload time, so adding an account only
    benefits files uploaded *after* that by default. Sync detects
    already-uploaded files that could now be spread across more accounts
    (same RAID mode, wider stripe/more mirrors/wider data+parity split)
    and offers to **rebalance** them: fully re-download, re-plan across
    every currently configured account, re-upload, then retire the old
    shards — "grow the array" onto the new account(s). It's a real bulk
    operation (opt-in per Sync run, not automatic), and only ever runs on
    fully healthy files — a degraded file is repaired first.
- **Vault folders** are purely virtual — organize files into folders from
  *List your vault files* independently of both the local filesystem they
  came from and the (still randomly-named, flat) remote blob layout.
  Like a filename, a folder path stays local-only (`.hfcoll.db`) and is
  never written to the remote manifest.
- **The master password has no reset.** Neither Hugging Face nor HF-VAULT
  ever sees it. Lose it and the files are gone for good — that's the point.
- **HLS video upload** chunks a video with ffmpeg (stream copy, no
  re-encode) into standard HLS segments, encrypted with ffmpeg's native
  AES-128 — the same scheme every HLS-aware player (VLC included)
  decrypts on its own, given the key. That key is random per video,
  separate from every other key in the vault, and **never uploaded
  anywhere** — it only ever lives in `.hfkey`. Segments and the playlist
  are otherwise handled like any other file (RAID/redundancy applies to
  the encrypted asset record; see *HLS video details* below).

## Features

- Upload with encryption, download with decryption — with real progress bars
- **Upload from a URL** — fetches a file straight from a direct link (e.g.
  a [Copyparty](https://github.com/9001/copyparty) share on another
  machine) and uploads it, so the machine running HF-VAULT doesn't need
  to permanently hold a full local copy of a file that's already sitting
  on another machine. The download still touches local disk as a temp
  file (streamed, not buffered in memory), but it's deleted immediately
  after encryption
- Recursive folder upload, mirroring a local directory's subfolder
  structure into a chosen vault folder; single-file uploads can also be
  filed into a vault folder directly. Vault folders are a virtual
  organization layer, independent of local disk layout and the remote's
  (still flat, randomly-named) blob layout — files can also be moved
  between vault folders after the fact
- Multi-account RAID0/RAID1/RAID6 storage pooling and redundancy
- File list with live, shard-aware remote status (synced / degraded /
  lost / unknown) and storage usage across every configured account
- Synchronization: detects unrecoverable local entries, **degraded**
  RAID1/RAID6 files missing a shard (e.g. after removing/replacing an
  account) and offers to **repair** them — reconstructing the missing
  shard from parity/mirror and re-uploading it to restore full
  redundancy — **rebalanceable** files that could now span more accounts
  than they currently do (accounts added since upload) and offers to
  **grow** them onto the wider account set, foreign files uploaded by
  other means (with an encrypted-or-not content heuristic), and files a
  remote shard **manifest** describes but that have no local record (e.g.
  after `.hfcoll.db` was lost) — lets you import, rebuild, or delete them
- Per-file remote deletion from the file list (every shard + manifest copy)
- **Upload a video (HLS)** / **Download a video (HLS)** — see *HLS video
  details* below
- **Web UI** for bulk upload/download from a browser — see *Web UI* below
- Optional **Cloudflare Workers/Pages deployment** for internet-reachable
  access with client-side (WebCrypto) encryption — see *Cloudflare
  Workers/Pages deployment* below
- Master password change (re-encrypts the vault)
- First-run guided setup

## Web UI

Start it from the CLI's main menu (*Start Web UI*) or run `hfv web` /
`yarn start web` directly — either way it serves on
`http://127.0.0.1:4173` (override the port with `HFV_WEB_PORT`).
Loopback-only and not configurable to bind elsewhere: the web server uses
plain HTTP and a lighter auth model than the CLI (a session cookie gated
behind the master password — see `src/web/server.ts` for the exact
threat model), both fine for "another process on this machine," neither
fine for exposing over a network as-is. Put a reverse proxy with TLS in
front if you actually want remote access.

It covers the bulk-oriented core workflow: browse vault folders, drag-and-
drop or multi-select upload, select multiple files and download them as a
single `.zip`, delete, and move between folders. **Accounts, RAID mode,
and HLS video are CLI-only** — deliberately not exposed over HTTP, to
keep the web surface small (token/account management especially isn't
something to expose to a browser without a lot more hardening than a
personal tool like this warrants). Running the web UI from within an
already-open CLI session shares that session's unlocked vault; started
standalone (`hfv web`), it starts locked and unlocks the same way the CLI
does (master password — first run creates the vault, same as the CLI's
first-run flow).

## Cloudflare Workers/Pages deployment (internet-reachable)

The loopback web UI above is for "another process on the same machine."
`workers/` is a separate, optional deployment for actually reaching your
vault from anywhere: a Cloudflare Worker API (`workers/api`) backed by
D1, and a static Cloudflare Pages frontend (`workers/pages`). It's a
different trust model, not just a different host — worth reading in full
before you deploy it.

**The key design constraint: the Worker never sees a plaintext byte or an
AES key.** All encryption/decryption (file content, the vault, and the
per-file manifest) happens in the browser via WebCrypto. The Worker's job
is everything that *does* need a server: holding Hugging Face account
tokens, RAID-splitting/joining ciphertext across them, and storing file
metadata in D1. This mirrors the local CLI's own trust model (only you,
holding the master password, can ever decrypt anything) even though the
API itself is now reachable over the internet rather than 127.0.0.1.

Two independent secrets gate this deployment:
- **`ACCESS_TOKEN`** — a Worker secret required as `Authorization: Bearer
  <token>` on every `/api/*` route. Without it, the API doesn't respond
  at all — not even to identify that a vault exists. Treat it like a root
  credential; it also gates the account-management and RAID-mode admin
  endpoints (`/api/admin/*`), since there's no CLI to do that from once
  you're on Workers.
- **Master password** — same as the CLI/local web UI, except this vault
  lives in D1 as an encrypted blob (`GET`/`PUT /api/vault`) instead of a
  local `.hfkey` file. **It is not the same vault** — the local `.hfkey`
  derives its password key via scrypt; the browser derives it via
  WebCrypto PBKDF2 (210,000 rounds, SHA-256) since WebCrypto has no
  native scrypt. Files uploaded through Workers/Pages and files uploaded
  through the CLI are both just Hugging Face blobs, so either app can
  eventually see either file's metadata — but each vault only holds the
  keys for files *it* encrypted.

Scope: same bulk-oriented feature set as the local web UI (browse
folders, upload, bulk `.zip` download, delete, move), plus a lightweight
in-browser Settings panel for accounts and RAID mode (there's no
`wrangler`-free way to manage those otherwise). HLS video stays
CLI-only — nothing here changes that.

### Deploying

```bash
cd workers/api
npm install
npx wrangler login                              # your Cloudflare account, not this app's vault
npx wrangler d1 create hf-vault                  # copy the returned database_id into wrangler.toml
npm run db:init                                  # applies schema.sql to the remote D1 database
npx wrangler secret put ACCESS_TOKEN             # pick a long random value
npm run deploy                                   # prints the Worker's https://*.workers.dev URL

cd ../pages
npx wrangler pages deploy . --project-name=hf-vault
```

Then open the Pages URL, enter the Worker URL + `ACCESS_TOKEN` (stored in
`localStorage`), and create the vault with a master password on first
use — same first-run flow as the CLI/local web UI. Add at least one
Hugging Face account from the in-browser Settings panel before
uploading.

## HLS video details

Requires `ffmpeg` in `PATH` for uploading (segmentation + encryption);
`ffprobe` is optional (used only for a duration estimate shown before
you confirm). Downloading needs neither — it's pure file I/O.

> This feature was inspired by
> [Conabe511/polyglot-chunker](https://github.com/Conabe511/polyglot-chunker),
> which chunks video into files that are simultaneously valid PNGs and
> valid MPEG-TS streams (a format-confusion trick, not encryption — a
> repo visitor with the file could still watch it). What's implemented
> here instead is ffmpeg's native HLS **AES-128 encryption**, since
> that's real confidentiality that any standard HLS player already
> speaks, and doesn't need a PNG disguise on top.

Uploading a video (`Upload a video (HLS)`) does the following:

1. Runs `ffmpeg -c copy -f hls -hls_key_info_file ...` locally — segments
   the video (no re-encoding) into `.ts` chunks and encrypts each one
   under a **freshly random AES-128 key and IV** using ffmpeg's own HLS
   encryption support, producing a standard `.m3u8` playlist with an
   `EXT-X-KEY` tag referencing that key by filename.
2. The key is stored **only** in your local `.hfkey` (never uploaded, not
   even encrypted) — it has nothing to do with this vault's own AES-256
   keys. The playlist's key reference is a bare relative filename
   (`hls.key`); that file is never created on the remote at all, only
   materialized locally at download time.
3. Each segment is uploaded as a plain, single-account file (segments are
   already "chunked" by nature, so they skip this vault's RAID
   striping/mirroring — see the caveat below). An **asset record** (JSON:
   the playlist text, the key's filename, and which segment maps to which
   uploaded file) is uploaded as a normal, fully encrypted, RAID-protected
   file named `<video>.hlsasset.json` — this is what ties everything
   together and is itself protected the same way any other file in your
   vault is.

Downloading (`Download a video (HLS)`) reverses this: decrypts the asset
record, downloads every segment under its original filename, writes the
playlist text and the key (read back from `.hfkey`) into the same local
folder, and tells you where to point VLC.

**Caveat**: segments currently upload to a single account with no RAID
redundancy of their own (only the asset record that ties them together
does). Losing that one account loses the video's segments even though the
asset record survives. This keeps the feature's first version simpler;
letting segments use the same RAID/repair/rebalance machinery as regular
files is a reasonable follow-up if it turns out to matter in practice.

**Source compatibility**: stream copy means the source codec must already
be HLS-friendly — H.264 video / AAC audio is the safe bet (what most
MP4/MKV files already contain). ffmpeg will fail plainly if the source
codec can't be muxed into MPEG-TS.

## Getting started (development)

Requires [Bun](https://bun.sh) — `yarn start` runs the app through it
(needed for the built-in `bun:sqlite` local database), and the release
scripts already compile with it.

```bash
yarn install
cp .env.example .env     # fill in your values
yarn start
```

`.env` is for development only and is read from the project directory:

```bash
HF_TOKEN="hf_..."                        # needs read+write repo access
HF_REPO="buckets/you/your-vault-bucket"
APP_KEY_FILE=".hfkey"                    # optional, vault file name
HF_STORAGE_TOTAL_TB="8.8"                # optional, quota shown in the file list (public bucket default)
HF_ACCOUNTS='[{"label":"acct2","token":"hf_...","repo":"buckets/you/vault-2"}]'  # optional, extra accounts
RAID_MODE="none"                         # optional: none | raid0 | raid1 | raid6
```

In development, data files (`.hfkey`, `.hfcoll.db`) live next to the
`.env` (portable mode). Get a token at
https://huggingface.co/settings/tokens.

## Installing as a real command

```bash
yarn build            # bundle to build/app.js
yarn release-macos    # compile self-contained binary ./hfv (+ ad-hoc codesign)
yarn integrate        # copy it into ~/.bun/bin (on your PATH)
```

Then run `hfv` from anywhere. On first launch it asks for your HF token,
repository and vault file name, and stores them in `.hfconf` inside the
OS application-data folder — editable later under *Settings →
Configuration*, no restart needed:

| OS      | App data folder                             |
| ------- | ------------------------------------------- |
| macOS   | `~/Library/Application Support/hf-vault/`   |
| Linux   | `$XDG_CONFIG_HOME/hf-vault/` (`~/.config/hf-vault/`) |
| Windows | `%APPDATA%\hf-vault\`                       |

The vault (`.hfkey`) and metadata (`.hfcoll.db`) live in the same folder.
Configuration precedence: a `.env` in the current directory (development)
always wins over `.hfconf`. Extra accounts and the default RAID mode are
editable under *Settings → Accounts* / *Settings → RAID Mode*.

Upgrading from a version before RAID support: the old flat-JSON `.hfcoll`
is auto-migrated to `.hfcoll.db` (SQLite) on first launch, and the
original file is kept as `.hfcoll.json.bak`.

## Building for other platforms

Bun cross-compiles from any machine — each binary embeds the whole runtime
(~60 MB), so users need nothing installed:

```bash
yarn release-linux        # dist/hfv-linux-x64
yarn release-linux-arm    # dist/hfv-linux-arm64
yarn release-win          # dist/hfv-windows-x64.exe
yarn release-macos-intel  # dist/hfv-macos-x64
yarn release-all          # everything
```

Note: `release-macos` re-signs the binary ad-hoc (bun's own signature can
come out malformed, and Apple Silicon kills unsigned binaries). Ad-hoc
signatures only satisfy *your* machine — distributing macOS binaries to
others requires a Developer ID + notarization. Linux/Windows binaries need
no signing.

## Security notes

- `.hfkey` is AES-256-GCM ciphertext at rest; the encryption key is derived
  from the master password via scrypt with a per-vault random salt. A wrong
  password fails authentication — there is nothing to "guess against"
  offline except the password itself, so choose a strong one.
- IVs and auth tags are not secrets on their own; AES-GCM security rests
  entirely on the keys. They're kept in `.hfcoll.db` locally, and are also
  written into each file's remote shard **manifest** (`<fileId>.hfmanifest`)
  — deliberately, so a file can be recovered even if `.hfcoll.db` is lost,
  as long as its AES key is still in `.hfkey`. The manifest itself is
  encrypted with that same per-file AES key before upload (fresh random IV,
  `[iv][ciphertext][tag]`) — not because the iv/tag inside are secret, but
  because the manifest also lists which *other* accounts/buckets hold the
  rest of that file's shards, which would otherwise be a much bigger leak
  than an opaque blob name, especially since buckets are public.
- What a repo visitor CAN see: how many files/shards you store, their
  approximate sizes, upload times, and the presence of a `.hfmanifest`
  blob per file — never what's inside it. What they can't see: real names,
  types, content, or which other accounts/buckets a file spans.
- `.hfconf` contains your HF token(s) in plaintext (like any CLI
  credential file, e.g. `~/.aws/credentials`) and is written with `600`
  permissions.

## Backing up

Back up **both** `.hfkey` and `.hfcoll.db` (and remember the master
password). The remote shards alone are only as useful as your RAID mode's
redundancy allows, and even a fully recoverable set of shards is useless
without a key: without `.hfkey` there are no AES keys, and without
`.hfcoll.db` (or a remote manifest, as a fallback — see *Synchronization*)
there's no shard topology to reassemble from.
