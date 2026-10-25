/**
 * output-cleanup.mjs
 *
 * Pure text-cleaning pipeline for PTY command output. Extracted from
 * agent-tools.mjs (executeTerminalCommand) so it can be unit-tested in
 * Node without a DOM.
 *
 * Pipeline order (must match the historical inline implementation):
 *   0. sanitizeText  - ANSI/OSC escape + control character removal
 *   1. prologue strip - initial stty / export setup line
 *   2. command echo strip - everything up to the first newline after the
 *      clean command (only when the command text is present)
 *   3. exit strip - trailing 'exit' command + optional prompt prefix
 *   4. prompt strip - bare shell prompt lines ONLY (see isPromptLine)
 *   5. PS2 strip - bash ">" continuation prompt lines
 *   6. blank-line collapse (3+ newlines -> 2) + trim
 */

/**
 * Strip OSC escape sequences, standard ANSI color/cursor sequences, and
 * non-printable control characters (except newlines and tabs).
 * @param {string} rawStr
 * @returns {string}
 */
export function sanitizeText(rawStr) {
    if (!rawStr) return "";
    let s = rawStr;
    // 1. Strip OSC escape sequences (e.g. \x1b]9;9;...\x1b\ or \x1b]0;...\x07)
    //    Terminators: BEL (\x07), ST (ESC \, two bytes), or bare ESC
    s = s.replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\|\x1b)/g, "");
    // 2. Strip standard ANSI color/cursor escape sequences
    s = s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    // 3. Strip non-printable ASCII control characters except newlines/tabs
    s = s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
    return s;
}

/**
 * A line is a bare prompt token when it is EXACTLY a prompt (root "#",
 * user "$", or the default non-root "bash-N.N$"), optionally followed by
 * trailing whitespace. Echo is disabled in the PTY, so such a line is
 * always a prompt, never command output. Lines merely *containing* "#" or
 * "$" (e.g. "# test", "a # b", "$HOME") are NOT prompts and are preserved.
 * @param {string} line
 * @returns {boolean}
 */
export function isPromptLine(line) {
    return /^#[ \t]*$/.test(line) ||
        /^\$[ \t]*$/.test(line) ||
        /^bash-[\d.]+[#$][ \t]*$/.test(line);
}

/**
 * Run the full cleaning pipeline over a raw PTY output buffer.
 * @param {string} raw - accumulated PTY output (raw bytes as text)
 * @param {string} [cleanCmd] - the clean command string; when present and
 *     found in the buffer, everything up to the first newline after it is
 *     treated as command echo and removed
 * @returns {string} cleaned output
 */
export function cleanOutput(raw, cleanCmd = null) {
    let s = sanitizeText(raw);

    // 1. Strip the initial prologue line containing stty / export setup if present
    s = s.replace(/^[^\n]*(?:stty\s+-echo|export\s+PAGER)[^\n]*\n?/gm, "");

    // 2. Strip command input echo lines up to the first newline after the clean command
    if (cleanCmd && s.includes(cleanCmd)) {
        const idx = s.indexOf(cleanCmd);
        const afterCmd = s.substring(idx + cleanCmd.length);
        const firstNewline = afterCmd.indexOf('\n');
        if (firstNewline !== -1) {
            s = afterCmd.substring(firstNewline + 1);
        } else {
            s = afterCmd;
        }
    }

    // 3. Strip trailing exit command, standalone 'exit' lines, and prompt noise
    //    (tolerate a stray backslash left behind by an unterminated OSC before the prompt)
    s = s.replace(/(?:^|\n)(?:[^\n]*?\\?[#$]\s*)?exit(?:\s+status\s+\d+)?(?=\n|$)/gi, "");

    // 4. Drop bare shell prompt lines. Echo is disabled in this PTY, so a line
    //    that is exactly a prompt token (root "#", user "$", or the default
    //    non-root "bash-N.N$") is always a prompt, never command output.
    //    Lines merely *containing* "#" or "$" (e.g. "# test", "a # b", "$HOME")
    //    are preserved verbatim.
    s = s.split('\n').filter((line) => !isPromptLine(line)).join('\n');

    // 5. Drop bash PS2 continuation prompts: when a command spans
    //    multiple lines (e.g. a quoted multi-line git commit message),
    //    bash prints its PS2 ">" prompt before each continuation line
    //    until the command is complete. Echo is disabled in this PTY,
    //    so a line that is exactly ">" (possibly with trailing space)
    //    is always a prompt, never command output.
    s = s.replace(/^>[ \t]*$/gm, "");

    // Collapse the blank lines left behind (3+ newlines -> 2).
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}
