import os from "node:os";
import path from "node:path";

export function getAppDataDir(appName: string): string {
    switch (process.platform) {
        case "darwin":
            return path.join(
                os.homedir(),
                "Library",
                "Application Support",
                appName
            );

        case "win32":
            // APPDATA is virtually always set, but a bare `path.join(undefined)`
            // throws a cryptic TypeError — fall back to its well-known location
            return path.join(
                process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
                appName
            );

        case "linux":
            return path.join(
                process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
                appName
            );

        default:
            // BSDs and friends: the XDG convention is the least surprising choice
            return path.join(os.homedir(), ".config", appName);
    }
}
