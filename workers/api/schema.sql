-- D1 schema for the Cloudflare Workers deployment of HF-VAULT's web API.
-- Mirrors the local bun:sqlite schema in src/hf/actions.ts (files/shards),
-- plus three tables the local CLI doesn't need because it has a
-- filesystem/.hfconf/.hfkey instead: accounts, config, vault.

CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    mime          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    iv            TEXT NOT NULL,
    tag           TEXT NOT NULL,
    raid          TEXT NOT NULL,
    cipher_length INTEGER NOT NULL,
    folder        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS shards (
    file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    repository  TEXT NOT NULL,
    path        TEXT NOT NULL,
    role        TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    PRIMARY KEY (file_id, account_id, path)
);

-- Hugging Face accounts this Worker deploys shards to. Tokens sit in
-- plaintext in D1 (same trust boundary as HF_ACCOUNTS in a local .env) —
-- protected only by the ACCESS_TOKEN gate in front of every /api route.
-- Managed via /api/admin/accounts, itself gated the same way.
CREATE TABLE IF NOT EXISTS accounts (
    id     TEXT PRIMARY KEY,
    label  TEXT NOT NULL,
    token  TEXT NOT NULL,
    repo   TEXT NOT NULL
);

-- Single-row key/value config (currently just raid_mode).
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The encrypted key vault, as one opaque blob (same envelope shape as the
-- local .hfkey: salt/iv/tag/data, all hex). Encrypted client-side —
-- browsers derive the password key via WebCrypto PBKDF2 and AES-GCM
-- encrypt/decrypt the payload; the Worker only ever stores/returns bytes
-- it cannot read. NOT bit-compatible with the local .hfkey format (that
-- one uses scrypt) — the two vaults are deliberately separate.
CREATE TABLE IF NOT EXISTS vault (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    iv   TEXT NOT NULL,
    tag  TEXT NOT NULL,
    data TEXT NOT NULL
);
