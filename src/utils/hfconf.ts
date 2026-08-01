import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveAppFile } from "./app-paths";

/**
 * An additional Hugging Face account used to pool/replicate storage
 * beyond the primary HF_TOKEN/HF_REPO. Kept here (rather than in
 * src/hf/accounts.ts) so this low-level config module has no dependency
 * on the higher-level account registry — accounts.ts imports this type.
 */
export interface HFAccount {
    id: string;
    label: string;
    token: string;
    repo: string;
}

export type RaidMode = "none" | "raid0" | "raid1" | "raid6";

/**
 * Runtime configuration, stored as JSON in .hfconf inside the app-data
 * folder. This is the installed-app counterpart of the developer .env:
 * same keys, but editable from inside the app (Settings -> Configuration)
 * without restarting. Values from .env always win, so development setups
 * keep working untouched.
 */
export interface HFConfig {
    HF_TOKEN?: string;
    HF_REPO?: string;
    APP_KEY_FILE?: string;
    // JSON-encoded HFAccount[] — see readAccounts()/saveAccounts() below.
    // Named to match its .env counterpart (HF_ACCOUNTS) so it flows
    // through the same generic string read/save/process.env machinery as
    // every other config key, no special-casing needed there.
    HF_ACCOUNTS?: string;
    // Stored as a plain string (like every other config key) — readRaidMode()
    // is what narrows it to a real RaidMode, defaulting invalid/missing to "none".
    RAID_MODE?: string;
}

export const CONFIG_KEYS = ["HF_TOKEN", "HF_REPO", "APP_KEY_FILE", "HF_ACCOUNTS", "RAID_MODE"] as const;

export function hfconfPath(): string {
    return resolveAppFile(".hfconf");
}

export function readHFConfig(): HFConfig {
    try {
        if (existsSync(hfconfPath())) {
            return JSON.parse(readFileSync(hfconfPath(), "utf8"));
        }
    }
    catch (e) {
        // a malformed .hfconf shouldn't brick the app — the first-run
        // setup will simply ask for the values again
    }

    return {};
}

/**
 * Loads stored values into process.env WITHOUT overriding anything a
 * developer .env already set — the rest of the app reads process.env
 * everywhere, so this is the single integration point.
 */
export function applyHFConfig() {
    const conf = readHFConfig();

    for (const key of CONFIG_KEYS) {
        if (!process.env[key] && conf[key]) {
            process.env[key] = conf[key];
        }
    }
}

/**
 * Persists the given values (empty/undefined fields keep their stored
 * value) and applies them to the running process immediately — settings
 * changes take effect without a restart.
 */
export function saveHFConfig(update: HFConfig) {
    const conf = readHFConfig();

    for (const key of CONFIG_KEYS) {
        const value = update[key];
        if (value !== undefined && value !== "") {
            conf[key] = value;
        }
    }

    // the token is a credential — keep the file owner-readable only
    writeFileSync(hfconfPath(), JSON.stringify(conf, null, 2), { mode: 0o600 });

    for (const key of CONFIG_KEYS) {
        if (conf[key]) {
            process.env[key] = conf[key];
        }
    }
}

/**
 * Parses the extra-accounts list out of process.env.HF_ACCOUNTS (set
 * from either .env or .hfconf by applyHFConfig()). Malformed JSON is
 * treated as "no extra accounts" rather than crashing the app.
 */
export function readExtraAccounts(): HFAccount[] {
    const raw = process.env.HF_ACCOUNTS;
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (e) {
        return [];
    }
}

/** Persists the extra-accounts list to .hfconf (dev .env is read-only to the app). */
export function saveExtraAccounts(accounts: HFAccount[]) {
    saveHFConfig({ HF_ACCOUNTS: JSON.stringify(accounts) });
}

export function readRaidMode(): RaidMode {
    const mode = process.env.RAID_MODE;
    return mode === "raid0" || mode === "raid1" || mode === "raid6" ? mode : "none";
}
