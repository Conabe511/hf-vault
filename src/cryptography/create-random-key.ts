import { randomBytes } from "crypto";

export function generateAES256Key(): Buffer {
    return Buffer.from(randomBytes(32).toString("hex"), "hex");
}

export function generateAES256IV(): Buffer {
    return randomBytes(12);
}

export const ALG = "aes-256-gcm";