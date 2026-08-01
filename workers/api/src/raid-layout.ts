// Ports src/raid/layout.ts to the Worker's local HFAccount shape.
// splitIntoShards/joinShards/computeParity/reconstruct are pure byte math
// with zero Node-specific imports, so they're reused directly rather than
// copied — see src/raid/chunk.ts and src/raid/parity.ts.
import { splitIntoShards } from "../../../src/raid/chunk";
import { computeParity } from "../../../src/raid/parity";
import { HFAccount, RaidMode, ShardAssignment, UploadPlan } from "./raid-types";

const MIN_ACCOUNTS: Record<RaidMode, number> = {
    none: 1,
    raid0: 2,
    raid1: 2,
    raid6: 4,
};

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

export function planUpload(mode: RaidMode, accounts: HFAccount[]): UploadPlan {
    const assignments: ShardAssignment[] = [];

    switch (mode) {
        case "none":
            assignments.push({ account: accounts[0], role: "data", index: 0 });
            break;
        case "raid1":
            accounts.forEach((account, index) => assignments.push({ account, role: "mirror", index }));
            break;
        case "raid0":
            accounts.forEach((account, index) => assignments.push({ account, role: "data", index }));
            break;
        case "raid6": {
            const dataAccounts = accounts.slice(0, -2);
            const [pAccount, qAccount] = accounts.slice(-2);
            dataAccounts.forEach((account, index) => assignments.push({ account, role: "data", index }));
            assignments.push({ account: pAccount, role: "parity-p", index: 0 });
            assignments.push({ account: qAccount, role: "parity-q", index: 0 });
            break;
        }
    }

    return { mode, assignments };
}

export function buildShardBuffers(
    mode: RaidMode,
    assignments: ShardAssignment[],
    cipherBuffer: Buffer
): Map<ShardAssignment, Buffer> {
    const result = new Map<ShardAssignment, Buffer>();

    if (mode === "none") {
        result.set(assignments[0], cipherBuffer);
        return result;
    }

    if (mode === "raid1") {
        for (const assignment of assignments) result.set(assignment, cipherBuffer);
        return result;
    }

    const dataAssignments = assignments.filter(a => a.role === "data").sort((a, b) => a.index - b.index);
    const dataShards = splitIntoShards(cipherBuffer, dataAssignments.length);
    dataAssignments.forEach((assignment, i) => result.set(assignment, dataShards[i]));

    if (mode === "raid6") {
        const pAssignment = assignments.find(a => a.role === "parity-p")!;
        const qAssignment = assignments.find(a => a.role === "parity-q")!;
        const { p, q } = computeParity(dataShards);
        result.set(pAssignment, p);
        result.set(qAssignment, q);
    }

    return result;
}
