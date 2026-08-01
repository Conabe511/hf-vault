// All client-side crypto for the Workers/Pages deployment. The Worker API
// never receives a plaintext byte or an AES key — everything here runs in
// the browser via WebCrypto. Byte-for-byte compatible with the CLI's file
// format (src/cryptography/encoder.ts): AES-256-GCM, ciphertext with the
// 16-byte auth tag appended at the end, IV carried alongside as metadata
// (not embedded). NOT compatible with the local .hfkey vault format — that
// one derives its password key via scrypt; this one uses WebCrypto PBKDF2
// (210,000 rounds, SHA-256) since WebCrypto has no native scrypt. Two
// separate vaults, by design (see README's Workers section).

const PBKDF2_ITERATIONS = 210000;

function toHex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}
function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}
function concatBytes(...arrs) {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrs) { out.set(a, offset); offset += a.length; }
    return out;
}

async function deriveVaultKey(password, saltBytes) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

/** Fresh, empty vault — call persistVault() after to write it to the Worker. */
function createEmptyVault() {
    return { salt: randomBytes(16), data: { version: 1, keys: {} } };
}

/**
 * Decrypts a vault envelope ({salt,iv,tag,data} hex, from GET /api/vault)
 * with the master password. Throws on a wrong password (GCM auth failure).
 */
async function unlockVault(envelope, password) {
    const salt = fromHex(envelope.salt);
    const key = await deriveVaultKey(password, salt);
    const combined = concatBytes(fromHex(envelope.data), fromHex(envelope.tag));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(envelope.iv) }, key, combined);
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    return { salt, data };
}

/** Encrypts the in-memory vault under the given password with a fresh IV — call before every persist. */
async function sealVault(vault, password) {
    const key = await deriveVaultKey(password, vault.salt);
    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(vault.data))));
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    return { salt: toHex(vault.salt), iv: toHex(iv), tag: toHex(tag), data: toHex(data) };
}

/** Generates a fresh random AES-256 key for a new file, hex-encoded (the vault's storage format). */
async function generateFileKeyHex() {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = await crypto.subtle.exportKey("raw", key);
    return toHex(raw);
}

async function importFileKey(hexKey) {
    return crypto.subtle.importKey("raw", fromHex(hexKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a plaintext ArrayBuffer -> {iv (hex), cipherBytes (Uint8Array, ciphertext+tag)}. */
async function encryptFileBytes(hexKey, plaintextBuf) {
    const key = await importFileKey(hexKey);
    const iv = randomBytes(12);
    const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBuf);
    return { iv: toHex(iv), cipherBytes: new Uint8Array(cipherBuf) };
}

/** Inverse of encryptFileBytes: ciphertext+tag bytes + hex iv -> plaintext ArrayBuffer. */
async function decryptFileBytes(hexKey, ivHex, cipherBytes) {
    const key = await importFileKey(hexKey);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(ivHex) }, key, cipherBytes);
}

// --- manifest blob: [12-byte iv][ciphertext][16-byte tag], self-contained
// (matches src/hf/manifest.ts's on-the-wire format exactly) ---

async function encryptManifest(hexKey, manifestObj) {
    const key = await importFileKey(hexKey);
    const iv = randomBytes(12);
    const cipherBuf = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(manifestObj))));
    return concatBytes(iv, cipherBuf);
}
