import { text } from "@clack/prompts";

/**
 * Clears the visible screen AND the scrollback, homing the cursor —
 * so re-rendered menus stay fixed in place instead of stacking up.
 */
export function clearScreen() {
    // 2J = clear screen, 3J = clear scrollback, H = cursor to top-left
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

/**
 * Blocks until the user presses Enter. Used between a page's final output
 * and the next clearScreen(), so results aren't wiped before they're read.
 */
export async function pressEnterToContinue() {
    await text({
        message: "Press ENTER to return to the menu",
        defaultValue: " ",
        placeholder: "",
    });
}
