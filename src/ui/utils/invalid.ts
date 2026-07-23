import { log } from "@clack/prompts";

export function invalidChoice() {
    log.error("Invalid choice.");
}