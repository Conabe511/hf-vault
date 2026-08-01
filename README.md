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
                     └─ per-file key          └─ shard manifest (topology only) replicated alongside
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
- **The master password has no reset.** Neither Hugging Face nor HF-VAULT
  ever sees it. Lose it and the files are gone for good — that's the point.

## Features

- Upload with encryption, download with decryption — with real progress bars
- Multi-account RAID0/RAID1/RAID6 storage pooling and redundancy
- File list with live, shard-aware remote status (synced / degraded /
  lost / unknown) and storage usage across every configured account
- Synchronization: detects unrecoverable local entries, foreign files
  uploaded by other means (with an encrypted-or-not content heuristic),
  and files a remote shard **manifest** describes but that have no local
  record (e.g. after `.hfcoll.db` was lost) — lets you import, rebuild, or
  delete them
- Per-file remote deletion from the file list (every shard + manifest copy)
- Master password change (re-encrypts the vault)
- First-run guided setup

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
- IVs and auth tags are not secrets; AES-GCM security rests entirely on
  the keys. They're kept in `.hfcoll.db` locally, and are also written to
  each file's remote shard **manifest** (`<fileId>.hfmanifest.json`) —
  deliberately, so a file can be recovered even if `.hfcoll.db` is lost,
  as long as its AES key is still in `.hfkey`.
- What a repo visitor CAN see: how many files/shards you store, their
  approximate sizes and upload times, and — via a manifest — how a given
  file's shards are laid out across your accounts. What they can't: real
  names, types, or content.
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
