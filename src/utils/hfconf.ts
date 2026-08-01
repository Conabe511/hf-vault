import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveAppFile } from "./app-paths";

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
}

export const CONFIG_KEYS = ["HF_TOKEN", "HF_REPO", "APP_KEY_FILE"] as const;

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
