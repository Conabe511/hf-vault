// Local copy of src/raid/types.ts's shapes, with a self-contained HFAccount
// instead of importing src/hf/accounts.ts — that module pulls in
// src/utils/hfconf.ts, which reads process.env/fs and doesn't belong in a
// Workers bundle. chunk.ts and parity.ts have zero such dependencies and
// are imported directly from the main app (see raid-layout.ts).

export type RaidMode = "none" | "raid0" | "raid1" | "raid6";
export type ShardRole = "data" | "parity-p" | "parity-q" | "mirror";

export interface HFAccount {
    id: string;
    label: string;
    token: string;
    repo: string;
}

export interface ShardAssignment {
    account: HFAccount;
    role: ShardRole;
    index: number;
}

export interface UploadPlan {
    mode: RaidMode;
    assignments: ShardAssignment[];
}

export interface HFShard {
    accountId: string;
    repository: string;
    path: string;
    role: ShardRole;
    index: number;
}
