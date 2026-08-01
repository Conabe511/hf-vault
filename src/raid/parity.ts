/**
 * GF(256) arithmetic and the classic RAID-6 P/Q syndrome (Anvin's
 * "Mathematics of RAID-6"), applied per-byte across whole-file shards
 * instead of fixed-size disk blocks (see chunk.ts). P is plain XOR
 * parity (tolerates 1 missing data shard); Q is a Reed-Solomon-style
 * syndrome using powers of the generator 2, letting P+Q jointly recover
 * up to 2 missing data shards.
 */

const PRIMITIVE_POLY = 0x11d;

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

(function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= PRIMITIVE_POLY;
    }
})();

/** 2^i in GF(256) — the Q-syndrome coefficient for data-disk index i. */
function coeff(i: number): number {
    return EXP[i % 255];
}

function gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
}

function gfDiv(a: number, b: number): number {
    if (a === 0) return 0;
    if (b === 0) throw new Error("RAID6 parity: division by zero in GF(256)");
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

function xorInto(target: Buffer, source: Buffer) {
    for (let j = 0; j < target.length; j++) target[j] ^= source[j];
}

export function computeParity(dataShards: Buffer[]): { p: Buffer; q: Buffer } {
    const len = dataShards[0].length;
    const p = Buffer.alloc(len);
    const q = Buffer.alloc(len);

    dataShards.forEach((shard, index) => {
        const c = coeff(index);
        xorInto(p, shard);
        for (let j = 0; j < len; j++) {
            q[j] ^= gfMul(c, shard[j]);
        }
    });

    return { p, q };
}

/**
 * Recovers up to 2 missing entries in `dataShards` (marked `null`) using
 * whichever of `p`/`q` are available. Returns the full, gap-filled data
 * shard array. Throws if there isn't enough parity to recover what's
 * missing (more than 2 missing, or 2 missing with only one of P/Q).
 */
export function reconstruct(
    dataShards: (Buffer | null)[],
    p: Buffer | null,
    q: Buffer | null
): Buffer[] {
    const missing: number[] = [];
    dataShards.forEach((shard, index) => {
        if (shard === null) missing.push(index);
    });

    if (missing.length === 0) {
        return dataShards as Buffer[];
    }

    const present = dataShards
        .map((shard, index) => (shard !== null ? { shard, index } : null))
        .filter((x): x is { shard: Buffer; index: number } => x !== null);

    const len = present[0]?.shard.length ?? p?.length ?? q?.length;
    if (len === undefined) {
        throw new Error("RAID6 reconstruct: nothing available to determine shard length");
    }

    const result = [...dataShards];

    if (missing.length === 1) {
        const [x] = missing;

        if (p) {
            const recovered = Buffer.alloc(len);
            for (const { shard } of present) xorInto(recovered, shard);
            xorInto(recovered, p);
            result[x] = recovered;
            return result as Buffer[];
        }

        if (q) {
            const availQ = Buffer.alloc(len);
            for (const { shard, index } of present) {
                const c = coeff(index);
                for (let j = 0; j < len; j++) availQ[j] ^= gfMul(c, shard[j]);
            }

            const cx = coeff(x);
            const recovered = Buffer.alloc(len);
            for (let j = 0; j < len; j++) {
                recovered[j] = gfDiv(q[j] ^ availQ[j], cx);
            }
            result[x] = recovered;
            return result as Buffer[];
        }

        throw new Error("RAID6 reconstruct: 1 data shard missing but no parity shard is available");
    }

    if (missing.length === 2) {
        if (!p || !q) {
            throw new Error("RAID6 reconstruct: 2 data shards missing, but both P and Q parity are needed and only one is available");
        }

        const [x, y] = missing;
        const cx = coeff(x);
        const cy = coeff(y);

        // pxy = D_x XOR D_y, qxy = 2^x*D_x XOR 2^y*D_y — derived by XORing
        // the present shards' contribution out of P and Q respectively.
        const pxy = Buffer.alloc(len);
        const qxy = Buffer.alloc(len);
        for (const { shard, index } of present) {
            xorInto(pxy, shard);
            const c = coeff(index);
            for (let j = 0; j < len; j++) qxy[j] ^= gfMul(c, shard[j]);
        }
        xorInto(pxy, p);
        for (let j = 0; j < len; j++) qxy[j] ^= q[j];

        const denom = cx ^ cy;
        const dx = Buffer.alloc(len);
        const dy = Buffer.alloc(len);
        for (let j = 0; j < len; j++) {
            const numerator = qxy[j] ^ gfMul(cy, pxy[j]);
            dx[j] = gfDiv(numerator, denom);
            dy[j] = dx[j] ^ pxy[j];
        }

        result[x] = dx;
        result[y] = dy;
        return result as Buffer[];
    }

    throw new Error(`RAID6 reconstruct: ${missing.length} data shards missing, at most 2 are recoverable`);
}
