import { CipherGCM, createCipheriv, randomBytes, createDecipheriv, DecipherGCM } from "crypto";
import { createReadStream, createWriteStream } from "fs";

function generateAES256Key(): Buffer {
    return Buffer.from(randomBytes(32).toString("hex"), "hex");
}

function generateAES256IV(): Buffer {
    return randomBytes(12);
}

const ALG = "aes-256-gcm";

export class Encoder {

    private key: Buffer;
    private iv: Buffer;
    private cipher: CipherGCM;

    constructor() {
        this.key = generateAES256Key();
        this.iv = generateAES256IV();
        this.cipher = createCipheriv(
            ALG,
            this.key,
            this.iv
        );
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

    getKey(): Buffer {
        return this.key;
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