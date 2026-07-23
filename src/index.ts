import {
    createCipheriv,
    randomBytes,
    createDecipheriv
} from "crypto";
import { readFileSync as fsRead, writeFileSync as fsWrite } from "fs";
import { intro, outro, isCancel, cancel, text } from '@clack/prompts'
import { createReadStream } from "node:fs";

import { config } from 'dotenv'
import { Encoder } from "./cryptography/create-random-key";
config();

(async () => {
  intro("Welcome to HF-VAULT")
  const value = await text({
    message: 'What is the meaning of life?',
  });

  if (isCancel(value)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }

  outro("File is on the ☁️")
})();

(async () => {
    const encoder = new Encoder()

    await encoder.encryptFile("episode.mp4", "myfile.mp4")

    console.log("finished encrypting")

    await encoder.decryptFile("myfile.mp4", "out.mp4")

    console.log("finished decrypting")
})();