/**
 * File-granularity erasure coding: a buffer is cut into `count` equal
 * slices (zero-padded so it divides evenly), not disk-style fixed-size
 * blocks. Simpler and sufficient for per-file RAID striping/parity.
 */
export function splitIntoShards(buffer: Buffer, count: number): Buffer[] {
    if (count < 1) {
        throw new Error("splitIntoShards: count must be >= 1");
    }

    const shardLength = Math.ceil(buffer.length / count) || 1;
    const padded = Buffer.alloc(shardLength * count);
    buffer.copy(padded);

    const shards: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        shards.push(padded.subarray(i * shardLength, (i + 1) * shardLength));
    }

    return shards;
}

/** Inverse of splitIntoShards: concatenates data shards in order, then trims the zero padding. */
export function joinShards(shards: Buffer[], originalLength: number): Buffer {
    return Buffer.concat(shards).subarray(0, originalLength);
}
