import { createRepo } from "@huggingface/hub"

export async function createHFRepo(name: string) {

    if (!process.env.HF_TOKEN) {
        throw Error("A HuggingFace token is required.")
    }

    await createRepo({
        accessToken: process.env.HF_TOKEN,
        repo: "spaces/FrankyMaca/my-new-custom-space",
        visibility: "public",
    })
    console.log("Created repo remotely")
}