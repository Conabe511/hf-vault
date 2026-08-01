import { intro, isCancel, log, note, select } from "@clack/prompts";
import { readRaidMode, saveHFConfig } from "../../../utils/hfconf";
import { clearScreen, pressEnterToContinue } from "../../utils/screen";

export async function raidModePage() {
    clearScreen();
    intro("RAID Mode");

    note(
        `RAID0 — stripe across accounts: pools their storage into one bigger\n` +
        `  vault, but any one account going down loses every file (no redundancy).\n\n` +
        `RAID1 — mirror to every configured account: any single surviving\n` +
        `  account is enough to recover a file. Needs 2+ accounts.\n\n` +
        `RAID6 — stripe + dual parity: tolerates up to 2 accounts going down\n` +
        `  at once, while still pooling most of their storage. Needs 4+ accounts.\n\n` +
        `If fewer accounts are configured than a mode needs at upload time,\n` +
        `HF-VAULT falls back to a simpler mode for that upload and says so.`,
        "RAID Modes"
    );

    const current = readRaidMode();

    const mode = await select({
        message: `Default RAID mode for new uploads (current: ${current.toUpperCase()}):`,
        initialValue: current,
        options: [
            { value: "none", label: "None", hint: "single account, no striping/redundancy" },
            { value: "raid0", label: "RAID0", hint: "stripe — max pooled storage, zero redundancy" },
            { value: "raid1", label: "RAID1", hint: "mirror — full redundancy, no extra storage" },
            { value: "raid6", label: "RAID6", hint: "stripe + dual parity — pooled storage AND 2-account fault tolerance" },
        ],
    });

    if (isCancel(mode)) {
        log.info("RAID mode unchanged.");
        return;
    }

    saveHFConfig({ RAID_MODE: mode.toString() });
    log.success(`Default RAID mode set to ${mode.toString().toUpperCase()}.`);
    await pressEnterToContinue();
}
