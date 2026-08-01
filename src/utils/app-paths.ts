import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAppDataDir } from "./os-detect";

/**
 * Where hf-vault keeps its files (.env config, .hfkey vault, .hfcoll
 * metadata). A global `hfv` command can be launched from any directory,
 * so app files must NEVER be resolved against the current working dir —
 * they'd scatter wherever the user happened to be standing.
 */
export const APP_DATA_DIR = getAppDataDir("hf-vault");

/**
 * Portable/development mode: a .env sitting in the current directory means
 * "this folder owns its own vault" — data files stay next to it. That is
 * exactly the situation in `yarn run start` from the project root. The
 * released binary runs from folders without a .env, so it uses APP_DATA_DIR.
 */
const portableMode = existsSync(join(process.cwd(), ".env"));

/**
 * Resolves an app-owned file name to where it belongs (cwd in portable/dev
 * mode, the OS app-data folder otherwise), creating the folder on first
 * use. Absolute paths pass through untouched, so env vars like
 * APP_KEY_FILE can still relocate a file anywhere.
 */
export function resolveAppFile(name: string): string {
    if (isAbsolute(name)) {
        return name;
    }

    if (portableMode) {
        return join(process.cwd(), name);
    }

    mkdirSync(APP_DATA_DIR, { recursive: true });
    return join(APP_DATA_DIR, name);
}
