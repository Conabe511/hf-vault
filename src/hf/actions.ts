import { createRepo, repoExists, uploadFile } from "@huggingface/hub"
import { HFVInvalidToken, HFVRepoNotFound, HFVInvalidName } from './errors'

export async function createHFRepo(name: string) {

    if (!process.env.HF_TOKEN) {
        throw new HFVInvalidToken()
    }

    try {
        await createRepo({
            accessToken: process.env.HF_TOKEN,
            repo: "spaces/FrankyMaca/my-new-custom-space",
            visibility: "public",
        })
    }
    catch (err) {
        console.log(err)
    }
}

export async function uploadFileToHF(file: File, to: string) {
    if (!process.env.HF_TOKEN) {
        throw new HFVInvalidToken()
    }

    if (isHFNameValid(to)) {
        throw new HFVInvalidName()
    }

    if (!await repoExists({ accessToken: process.env.HF_TOKEN, repo: to})) {
        throw new HFVRepoNotFound()
    }

    try {
        await uploadFile({
            accessToken: process.env.HF_TOKEN,
            repo: to,
            file: file
        })
    }
    catch (err) {
        console.log(err)
    }
}

function isHFNameValid(name: string): boolean {
    return name.split('/').length != 2
}
