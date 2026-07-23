import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ALG, generateAES256IV } from "./create-random-key";

export interface KeyVaultData {
    version: number;
    // file id -> hex-encoded AES-256 key
    keys: Record<string, string>;
}

// What actually sits on disk. `data` is the AES-256-GCM ciphertext of the
// KeyVaultData JSON — the keys themselves are never written in plaintext.
// salt/iv/tag are not secrets: they only allow re-deriving the password key
// and authenticating the payload, which still requires the password.
interface VaultEnvelope {
    salt: string;
    iv: string;
    tag: string;
    data: string;
}

const SALT_BYTES = 16;

/**
 * Sole accessor to the .hfkey file. The file is encrypted at rest with a key
 * derived (scrypt) from the user's master password. Any read or mutation goes
 * through the in-RAM copy: open() decrypts it once, every mutation re-encrypts
 * and overwrites the file, close() wipes the RAM copy.
 */
export class KeyVault {
    private static instance: KeyVault;

    private path: string;
    private passwordKey?: Buffer;
    private salt?: Buffer;
    private data?: KeyVaultData;

    private constructor() {
        this.path = process.env.APP_KEY_FILE ?? ".hfkey";
    }

    static getInstance(): KeyVault {
        if (!KeyVault.instance) {
            KeyVault.instance = new KeyVault();
        }

        return KeyVault.instance;
    }

    isOpen(): boolean {
        return this.data !== undefined;
    }

    exists(): boolean {
        return existsSync(this.path);
    }

    /**
     * Unlocks the vault with the master password. If no vault file exists yet,
     * a fresh empty one is created and encrypted with that password.
     * Throws when the password is wrong (GCM authentication fails).
     */
    open(password: string) {
        if (this.isOpen()) return;

        if (!this.exists()) {
            this.salt = randomBytes(SALT_BYTES);
            this.passwordKey = this.deriveKey(password, this.salt);
            this.data = { version: 1, keys: {} };
            this.persist();
            return;
        }

        let parsed: VaultEnvelope & Partial<KeyVaultData>;
        try {
            parsed = JSON.parse(readFileSync(this.path, "utf8"));
        }
        catch (e) { throw Error(".hfkey malformed"); }

        // Legacy plaintext .hfkey (old HFKeyStore format): adopt it and
        // immediately rewrite it encrypted under the given password.
        if (parsed.keys !== undefined) {
            this.salt = randomBytes(SALT_BYTES);
            this.passwordKey = this.deriveKey(password, this.salt);
            this.data = { version: parsed.version ?? 1, keys: parsed.keys };
            this.persist();
            return;
        }

        this.salt = Buffer.from(parsed.salt, "hex");
        this.passwordKey = this.deriveKey(password, this.salt);

        const decipher = createDecipheriv(ALG, this.passwordKey, Buffer.from(parsed.iv, "hex"));
        decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));

        try {
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(parsed.data, "hex")),
                decipher.final(), // throws if the password doesn't match the auth tag
            ]);
            this.data = JSON.parse(plaintext.toString("utf8"));
        }
        catch (e) {
            this.close();
            throw Error("Wrong password (or corrupted .hfkey)");
        }
    }

    version(): number {
        return this.requireOpen().version;
    }

    addKey(id: string, key: Buffer) {
        this.requireOpen().keys[id] = key.toString("hex");
        this.persist();
    }

    getKey(id: string): Buffer | undefined {
        const hex = this.requireOpen().keys[id];
        return hex ? Buffer.from(hex, "hex") : undefined;
    }

    hasKey(id: string): boolean {
        return id in this.requireOpen().keys;
    }

    deleteKey(id: string) {
        delete this.requireOpen().keys[id];
        this.persist();
    }

    /** Re-encrypts the vault under a new password (fresh salt, fresh IV). */
    changePassword(newPassword: string) {
        this.requireOpen();
        this.salt = randomBytes(SALT_BYTES);
        this.passwordKey = this.deriveKey(newPassword, this.salt);
        this.persist();
    }

    /** Locks the vault and wipes the key material held in RAM. */
    close() {
        this.passwordKey?.fill(0);
        this.passwordKey = undefined;
        this.salt = undefined;
        this.data = undefined;
    }

    private requireOpen(): KeyVaultData {
        if (!this.data) {
            throw Error("KeyVault is locked — call open(password) first");
        }
        return this.data;
    }

    private deriveKey(password: string, salt: Buffer): Buffer {
        return scryptSync(password, salt, 32);
    }

    // Encrypts the in-RAM data and overwrites the file on disk.
    // A fresh IV every write — reusing an IV with the same key breaks GCM.
    private persist() {
        if (!this.data || !this.passwordKey || !this.salt) {
            throw Error("KeyVault is locked — call open(password) first");
        }

        const iv = generateAES256IV();
        const cipher = createCipheriv(ALG, this.passwordKey, iv);
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(this.data), "utf8"),
            cipher.final(),
        ]);

        const envelope: VaultEnvelope = {
            salt: this.salt.toString("hex"),
            iv: iv.toString("hex"),
            tag: cipher.getAuthTag().toString("hex"),
            data: ciphertext.toString("hex"),
        };

        writeFileSync(this.path, JSON.stringify(envelope, null, 2));
    }
}
