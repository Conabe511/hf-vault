export class HFVRepoNotFound extends Error {
    constructor(message = "The repository does not exist") { super(message) }    
}

export class HFVInvalidName extends Error {
    constructor(message = "The name is not in the proper formt (spaces/[user]/[repository])") { super(message) }    
}

export class HFVInvalidToken extends Error {
    constructor(message = "Missing HF token") { super(message) }    
}
