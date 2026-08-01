# HF-VAULT ☁️🔐

Turn a Hugging Face repository into your personal encrypted cloud storage.

HF-VAULT is a terminal app that encrypts your files locally with AES-256
and uploads them to a Hugging Face repo. What lands on the remote is
indistinguishable from random noise: random hex names, no extensions, no
readable content. Only your machine — holding the keys and a master
password — can turn them back into files.

## How it works

```
your file ──> AES-256-GCM encrypt ──> random-named blob ──> HF repo
                     │
                     └─ per-file key ──> key vault (.hfkey)
                                            │
                                            └─ encrypted with your master password
```

- **Every file gets its own random AES-256 key.** Compromising one file
  never exposes another.
- **Keys live in a local vault file (`.hfkey`)** which is itself encrypted
  (AES-256-GCM, key derived from your master password with scrypt). It is
  never written to disk in plaintext, and it never leaves your machine.
- **File metadata (`.hfcoll`)** — real names, sizes, dates, and which
  remote blob is which — also stays local only.
- **The master password has no reset.** Neither Hugging Face nor HF-VAULT
  ever sees it. Lose it and the files are gone for good — that's the point.

## Features

- Upload with encryption, download with decryption — with real progress bars
- File list with live remote status (synced / missing / unreachable) and
  storage usage
- Synchronization: detects files deleted from the HF UI (stale entries),
  foreign files uploaded by other means (with an encrypted-or-not content
  heuristic), lets you import or delete them
- Per-file remote deletion from the file list
- Master password change (re-encrypts the vault)
- First-run guided setup

## Getting started (development)

```bash
yarn install
cp .env.example .env     # fill in your values
yarn start
```

`.env` is for development only and is read from the project directory:

```bash
HF_TOKEN="hf_..."                        # needs read+write repo access
HF_REPO="datasets/you/your-vault-repo"
APP_KEY_FILE=".hfkey"                    # optional, vault file name
HF_STORAGE_TOTAL_TB="8.8"                # optional, quota shown in the file list
```

In development, data files (`.hfkey`, `.hfcoll`) live next to the `.env`
(portable mode). Get a token at https://huggingface.co/settings/tokens.

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

The vault (`.hfkey`) and metadata (`.hfcoll`) live in the same folder.
Configuration precedence: a `.env` in the current directory (development)
always wins over `.hfconf`.

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
- IVs and auth tags stored in `.hfcoll` are not secrets; AES-GCM security
  rests entirely on the keys.
- What a repo visitor CAN see: how many files you store, their approximate
  sizes, and upload times. What they can't: names, types, content.
- `.hfconf` contains your HF token in plaintext (like any CLI credential
  file, e.g. `~/.aws/credentials`) and is written with `600` permissions.

## Backing up

Back up **both** `.hfkey` and `.hfcoll` (and remember the master
password). The remote blobs alone are useless: without the vault there
are no keys, and without the metadata there are no IVs/names.
