import { HFAccount } from "../hf/accounts";
import { RaidMode, ShardAssignment, UploadPlan } from "./types";

const MIN_ACCOUNTS: Record<RaidMode, number> = {
    none: 1,
    raid0: 2,
    raid1: 2,
    raid6: 4,
};

/**
 * Downgrades a RAID mode that needs more accounts than are configured:
 * raid6 -> raid1 -> none, raid0/raid1 -> none. Never blocks the upload —
 * it just falls back to whatever the account count actually supports.
 */
export function resolveEffectiveRaid(
    requested: RaidMode,
    numAccounts: number
): { mode: RaidMode; reason?: string } {
    if (numAccounts < MIN_ACCOUNTS[requested]) {
        const fallback: RaidMode = requested === "raid6" && numAccounts >= MIN_ACCOUNTS.raid1
            ? "raid1"
            : "none";

        return {
            mode: fallback,
            reason:
                `${requested.toUpperCase()} needs at least ${MIN_ACCOUNTS[requested]} account(s) ` +
                `(have ${numAccounts}) — falling back to ${fallback === "none" ? "single-account mode" : fallback.toUpperCase()}.`,
        };
    }

    return { mode: requested };
}

/**
 * Assigns configured accounts to shard roles for a given (already
 * fallback-resolved) mode.
 * - none: the first account holds the one and only "data" shard.
 * - raid1: every configured account gets a full mirror copy.
 * - raid0: every configured account gets one data stripe.
 * - raid6: all accounts but the last two get a data stripe; the last two
 *   get the P and Q parity shards.
 */
export function planUpload(mode: RaidMode, accounts: HFAccount[]): UploadPlan {
    const assignments: ShardAssignment[] = [];

    switch (mode) {
        case "none": {
            assignments.push({ account: accounts[0], role: "data", index: 0 });
            break;
        }
        case "raid1": {
            accounts.forEach((account, index) => {
                assignments.push({ account, role: "mirror", index });
            });
            break;
        }
        case "raid0": {
            accounts.forEach((account, index) => {
                assignments.push({ account, role: "data", index });
            });
            break;
        }
        case "raid6": {
            const dataAccounts = accounts.slice(0, -2);
            const [pAccount, qAccount] = accounts.slice(-2);

            dataAccounts.forEach((account, index) => {
                assignments.push({ account, role: "data", index });
            });
            assignments.push({ account: pAccount, role: "parity-p", index: 0 });
            assignments.push({ account: qAccount, role: "parity-q", index: 0 });
            break;
        }
    }

    return { mode, assignments };
}
