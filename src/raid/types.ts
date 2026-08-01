export type RaidMode = "none" | "raid0" | "raid1" | "raid6";

export type ShardRole = "data" | "parity-p" | "parity-q" | "mirror";

import { HFAccount } from "../hf/accounts";

export interface ShardAssignment {
    account: HFAccount;
    role: ShardRole;
    index: number;
}

export interface UploadPlan {
    mode: RaidMode;
    // Every account the upload needs to touch, each with the role/index
    // it plays in that account's shard. Order matters for raid0/raid6:
    // shards are sliced in this order.
    assignments: ShardAssignment[];
}
