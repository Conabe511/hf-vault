import { HFAccount, readExtraAccounts } from "../utils/hfconf";

export type { HFAccount };

const PRIMARY_ACCOUNT_ID = "primary";

/**
 * The primary account (HF_TOKEN/HF_REPO) plus every extra account from
 * config, in that order — index 0 is always what RAID planning treats as
 * the "first" disk. Returns [] if nothing is configured yet (first run).
 */
export function resolveAccounts(): HFAccount[] {
    const accounts: HFAccount[] = [];

    if (process.env.HF_TOKEN && process.env.HF_REPO) {
        accounts.push({
            id: PRIMARY_ACCOUNT_ID,
            label: "Primary",
            token: process.env.HF_TOKEN,
            repo: process.env.HF_REPO,
        });
    }

    accounts.push(...readExtraAccounts());

    return accounts;
}

/**
 * Looks up which account owns a given repo, so per-repo Hugging Face API
 * calls can use that account's token instead of assuming a single global
 * HF_TOKEN. Repos are expected to be unique across configured accounts.
 */
export function accountForRepo(repo: string): HFAccount | undefined {
    return resolveAccounts().find(a => a.repo === repo);
}

/** Token for a given repo, or undefined if no configured account owns it. */
export function tokenForRepo(repo: string): string | undefined {
    return accountForRepo(repo)?.token;
}

export function accountById(id: string): HFAccount | undefined {
    return resolveAccounts().find(a => a.id === id);
}
