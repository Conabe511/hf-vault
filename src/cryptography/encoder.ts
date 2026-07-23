import { CipherGCM, createCipheriv, createDecipheriv } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { ALG, generateAES256IV, generateAES256Key } from "./create-random-key";
import { KeyVault } from "./key-vault";

export class Encoder {

    private key: Buffer;
    private iv: Buffer;
    private cipher: CipherGCM;

    private constructor(key: Buffer, iv: Buffer) {
        this.key = key;
        this.iv = iv;
        this.cipher = null as any;
    }

    /**
     * Encoder for encrypting a new file: generates a fresh AES-256 key and
     * hands it straight to the KeyVault (which persists it encrypted).
     * The raw key never leaves the cryptography layer.
     * The vault must be open, otherwise this throws.
     */
    static forNewFile(fileId: string): Encoder {
        const key = generateAES256Key();
        KeyVault.getInstance().addKey(fileId, key);

        const encoder = new Encoder(key, generateAES256IV());
        encoder.cipher = createCipheriv(ALG, encoder.key, encoder.iv);
        return encoder;
    }

    /**
     * Encoder for decrypting an already-uploaded file: the key is looked up
     * in the KeyVault by file id. The vault must be open, otherwise this throws.
     */
    static forExistingFile(fileId: string, iv: Buffer): Encoder {
        const key = KeyVault.getInstance().getKey(fileId);

        if (!key) {
            throw Error(`No key in the vault for file ${fileId}`);
        }

        return new Encoder(key, iv);
    }

    encryptChunk(chunk: Buffer): Buffer {
        return this.cipher.update(chunk);
    }

    finalize(): Buffer {
        return this.cipher.final();
    }

    getAuthTag(): Buffer {
        return this.cipher.getAuthTag();
    }

    getIV(): Buffer {
        return this.iv;
    }

    finish(): void {
        this.cipher.final()
    }

    async encryptFile(input: string, output: string) {
        const reader = createReadStream(input, {
            highWaterMark: 50 * 1024 * 1024,
        });

        const writer = createWriteStream(output);

        for await (const chunk of reader) {
            const encrypted = this.encryptChunk(chunk);

            writer.write(encrypted);
        }

        const final = this.finalize();

        if (final.length > 0) {
            writer.write(final);
        }

        const tag = this.getAuthTag();
        writer.write(tag);
        writer.end();

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });
    }

    async decryptFile(input: string, output: string) {
        const reader = createReadStream(input, {
            highWaterMark: 50 * 1024 * 1024,
        });

        const writer = createWriteStream(output);

        const decipher = createDecipheriv(
            ALG,
            this.key,
            this.iv
        );

        let lastChunk: Buffer | null = null;

        for await (const chunk of reader) {
            if (lastChunk) {
                const decrypted = decipher.update(lastChunk);
                writer.write(decrypted);
            }

            lastChunk = chunk;
        }

        if (!lastChunk) {
            throw new Error("Encrypted file is empty");
        }

        // Remove auth tag from the end
        const tag = lastChunk.subarray(lastChunk.length - 16);
        const finalCiphertext = lastChunk.subarray(0, lastChunk.length - 16);

        decipher.setAuthTag(tag);

        if (finalCiphertext.length > 0) {
            writer.write(decipher.update(finalCiphertext));
        }

        // Verifies authenticity
        const final = decipher.final();

        if (final.length > 0) {
            writer.write(final);
        }

        writer.end();

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });
    }
}
