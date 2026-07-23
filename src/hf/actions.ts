import { createRepo } from "@huggingface/hub"

export async function createHFRepo(name: string) {

    if (!process.env.HF_TOKEN) {
        throw Error("A HuggingFace token is required.")
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