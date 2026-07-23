import {
  createCipheriv,
  randomBytes,
  createDecipheriv
} from "crypto";
import { readFileSync as fsRead, writeFileSync as fsWrite } from "fs";
import { intro, outro, isCancel, cancel, text } from '@clack/prompts'

import { config } from 'dotenv'
config()

const encrypt = false;

import { createRepo } from '@huggingface/hub'

console.log(process.env.HF_TOKEN)
// (async () => {
//   await createRepo({
//     accessToken: "",
//     repo: "spaces/FrankyMaca/my-new-custom-space",
//     visibility: "public",
//   })
//   console.log("Created repo remotely")
// })()

// (async () => {
//   intro("Welcome to HF-VAULT")
//   const value = await text({
//     message: 'What is the meaning of life?',
//   });
  
//   if (isCancel(value)) {
//     cancel('Operation cancelled.');
//     process.exit(0);
//   }
  
//   outro("File is on the ☁️")
// })()

// if (encrypt) {
//   const key = Buffer.from(
//     "b45f6ba75c8306ac0530b1fd523bf7b1ba36c89722554070262bc233f25f744a",
//     "hex"
//   );

//   const iv = randomBytes(12);

//   const plaintext = fsRead("test.txt");

//   const cipher = createCipheriv("aes-256-gcm", key, iv);

//   const encrypted = Buffer.concat([
//     cipher.update(plaintext),
//     cipher.final(),
//   ]);

//   const tag = cipher.getAuthTag();

//   fsWrite(
//     "encrypted.bin",
//     Buffer.concat([iv, tag, encrypted])
//   );
// }
// else {
//   const key = Buffer.from(
//     "b45f6ba75c8306ac0530b1fd523bf7b1ba36c89722554070262bc233f25f744a",
//     "hex"
//   );

//   const data = fsRead("encrypted.bin");

//   const iv = data.subarray(0, 12);
//   const tag = data.subarray(12, 28);
//   const ciphertext = data.subarray(28);

//   const decipher = createDecipheriv("aes-256-gcm", key, iv);
//   decipher.setAuthTag(tag);

//   const decrypted = Buffer.concat([
//     decipher.update(ciphertext),
//     decipher.final(),
//   ]);

//   fsWrite("output.txt", decrypted);
// }