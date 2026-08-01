// Minimal store-only (uncompressed) ZIP writer — no external dependency
// for a static Pages deployment. Good enough for already-random-looking
// decrypted file bytes, which rarely compress well anyway.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]); }

function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
    const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
    return { time, day };
}

/** files: [{name: string, data: Uint8Array}] -> Uint8Array (a valid, uncompressed .zip) */
function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime(new Date());

    for (const { name, data } of files) {
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(data);

        const localHeader = concat(
            u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(day),
            u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
        );
        chunks.push(localHeader, data);

        const centralHeader = concat(
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(day),
            u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
            u32(0), u32(offset), nameBytes,
        );
        central.push(centralHeader);

        offset += localHeader.length + data.length;
    }

    const centralBytes = concat(...central);
    const centralStart = offset;
    const eocd = concat(
        u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
        u32(centralBytes.length), u32(centralStart), u16(0),
    );

    return concat(...chunks, centralBytes, eocd);
}

function concat(...parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
