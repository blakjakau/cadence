/**
 * output-cleanup.test.mjs
 *
 * Node test for app/js/util/output-cleanup.mjs (the PTY output cleaning
 * pipeline used by executeTerminalCommand in app/js/agent/agent-tools.mjs).
 *
 * Usage: node tests/output-cleanup.test.mjs
 *
 * Covers the regression where the old blanket per-line regex
 * (lazy match of everything up to the FIRST "#" or "$", plus trailing
 * whitespace, applied with the m flag)
 * stripped everything up to the first "#" or "$" on every line, destroying
 * legitimate output ("# test" -> "test", "a # b" -> "b", "echo $HOME" ->
 * "HOME"). The replacement only removes lines that are EXACTLY a bare shell
 * prompt token, preserving all other "#" / "$" occurrences verbatim.
 *
 * Exits non-zero on any failure.
 */

import { cleanOutput, isPromptLine, sanitizeText } from "../app/js/util/output-cleanup.mjs";

let passCount = 0;
let failCount = 0;
const failures = [];

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passCount++;
        console.log(`  PASS  ${label}`);
    } else {
        failCount++;
        const msg = `FAIL  ${label}\n        expected: ${e}\n        actual:   ${a}`;
        failures.push(msg);
        console.log(msg);
    }
}

function assertTrue(cond, label) {
    if (cond) {
        passCount++;
        console.log(`  PASS  ${label}`);
    } else {
        failCount++;
        const msg = `FAIL  ${label}`;
        failures.push(msg);
        console.log(msg);
    }
}

// ---------------------------------------------------------------------------
// Part 1: isPromptLine — bare prompt tokens only
// ---------------------------------------------------------------------------

function runPromptLineTests() {
    console.log("=".repeat(100));
    console.log("isPromptLine — bare prompt tokens");
    console.log("=".repeat(100));

    // Stripped: exactly a prompt token, optional trailing whitespace
    assertTrue(isPromptLine("#"), "root prompt '#' is a prompt line");
    assertTrue(isPromptLine("# "), "root prompt '# ' is a prompt line");
    assertTrue(isPromptLine("#\t"), "root prompt '#<tab>' is a prompt line");
    assertTrue(isPromptLine("$"), "user prompt '$' is a prompt line");
    assertTrue(isPromptLine("$ "), "user prompt '$ ' is a prompt line");
    assertTrue(isPromptLine("bash-5.2$"), "default non-root prompt 'bash-5.2$' is a prompt line");
    assertTrue(isPromptLine("bash-5.2$ "), "default non-root prompt 'bash-5.2$ ' is a prompt line");
    assertTrue(isPromptLine("bash-3.2#"), "root bash versioned prompt 'bash-3.2#' is a prompt line");

    // Preserved: the reported bug and mid-line / variable cases
    assertTrue(!isPromptLine("# test"), "'# test' is NOT a prompt line (reported bug)");
    assertTrue(!isPromptLine("a # b"), "'a # b' is NOT a prompt line");
    assertTrue(!isPromptLine("echo $HOME"), "'echo $HOME' is NOT a prompt line");
    assertTrue(!isPromptLine("$HOME"), "'$HOME' is NOT a prompt line");
    assertTrue(!isPromptLine("export FOO=$BAR"), "'export FOO=$BAR' is NOT a prompt line");
    assertTrue(!isPromptLine("bash-5.2$ ls"), "'bash-5.2$ ls' has content after prompt -> NOT stripped");
    assertTrue(!isPromptLine("bash-5.2"), "'bash-5.2' (no trailing $/#) is NOT a prompt line");
    assertTrue(!isPromptLine("bashx$"), "'bashx$' (no version) is NOT a prompt line");
    assertTrue(!isPromptLine(""), "empty line is NOT a prompt line");
}

// ---------------------------------------------------------------------------
// Part 2: cleanOutput — single-line behavior (regression table)
// ---------------------------------------------------------------------------

function runSingleLineTests() {
    console.log("\n" + "=".repeat(100));
    console.log("cleanOutput — single-line table (old regex vs new behavior)");
    console.log("=".repeat(100));

    // Old regex (/^.*?[#$]\s*/gm) results shown in comments for contrast.

    assertEqual(cleanOutput("# "), "", "root prompt '# ' -> stripped (old: stripped)");
    assertEqual(cleanOutput("$ "), "", "user prompt '$ ' -> stripped (old: stripped)");
    assertEqual(cleanOutput("bash-5.2$ "), "", "bash-5.2$ -> stripped (old: stripped)");

    // The reported bug: old regex returned "test"; new must preserve "# test".
    assertEqual(cleanOutput("# test"), "# test", "'# test' preserved (old: 'test' BUG)");
    assertEqual(cleanOutput("a # b"), "a # b", "'a # b' preserved (old: 'b' BUG)");
    assertEqual(cleanOutput("echo $HOME"), "echo $HOME", "'echo $HOME' preserved (old: 'HOME' BUG)");
    assertEqual(cleanOutput("$HOME"), "$HOME", "'$HOME' preserved (old: '' BUG)");
    assertEqual(cleanOutput("export FOO=$BAR"), "export FOO=$BAR", "'export FOO=$BAR' preserved (old: 'BAR' BUG)");
    assertEqual(cleanOutput("total 12"), "total 12", "line without #/$ untouched");
    assertEqual(cleanOutput("bash-5.2$ ls"), "bash-5.2$ ls", "prompt glued to command text preserved");
}

// ---------------------------------------------------------------------------
// Part 3: cleanOutput — multi-line buffers
// ---------------------------------------------------------------------------

function runMultiLineTests() {
    console.log("\n" + "=".repeat(100));
    console.log("cleanOutput — multi-line buffers");
    console.log("=".repeat(100));

    // Prologue + output + trailing prompt (typical PTY capture).
    assertEqual(
        cleanOutput("stty -echo; export PAGER=cat\n# test\n# "),
        "# test",
        "prologue + '# test' + trailing prompt -> '# test'"
    );

    // Multiple bare prompts interleaved with real output.
    assertEqual(
        cleanOutput("# \nfoo\n$ \nbar\nbash-5.2$ "),
        "foo\nbar",
        "interleaved bare prompts all stripped, output preserved"
    );

    // Trailing prompt with no trailing newline (common final chunk).
    assertEqual(
        cleanOutput("hello\nworld\n# "),
        "hello\nworld",
        "trailing '# ' without final newline stripped"
    );

    // Blank lines left behind by prompt removal are collapsed (3+ -> 2).
    assertEqual(
        cleanOutput("a\n#\nb\n$ \nc"),
        "a\nb\nc",
        "prompt lines removed, no leftover blank lines"
    );

    // PS2 continuation prompt lines are still stripped (step 5). With echo
    // disabled, real PS2 continuation lines are bare ">" (or "> "), never
    // "> content".
    assertEqual(
        cleanOutput(">\n> \nline1\nline2"),
        "line1\nline2",
        "PS2 bare '>' continuation lines stripped"
    );

    // A line that is exactly ">" is a prompt; "a > b" (redirect) is not.
    // Stripping the bare ">" line leaves a double newline, which the collapse
    // step (3+ -> 2) does not touch, so the blank line is preserved.
    assertEqual(
        cleanOutput("a > b\n>\nc"),
        "a > b\n\nc",
        "redirect 'a > b' preserved, bare '>' stripped (blank line left)"
    );

    // Command echo strip: everything up to first newline after cleanCmd removed.
    // Realistic buffer: command echoed once, then its output, then a prompt.
    assertEqual(
        cleanOutput("echo hello\nhello\n# ", "echo hello"),
        "hello",
        "command echo line stripped via cleanCmd, trailing prompt stripped"
    );

    // cleanCmd not present -> no echo strip, prompts still filtered.
    assertEqual(
        cleanOutput("out1\n# \nout2", "not-present-cmd"),
        "out1\nout2",
        "absent cleanCmd: no echo strip, prompt line still filtered"
    );

    // cleanCmd null -> pipeline runs without echo strip.
    assertEqual(
        cleanOutput("# \nresult\n$ "),
        "result",
        "null cleanCmd: prompts filtered, output preserved"
    );

    // Empty / whitespace inputs.
    assertEqual(cleanOutput(""), "", "empty buffer -> empty");
    assertEqual(cleanOutput("   \n  "), "", "whitespace-only buffer -> empty");
}

// ---------------------------------------------------------------------------
// Part 4: sanitizeText — escape sequences and control characters
// ---------------------------------------------------------------------------

function runSanitizeTests() {
    console.log("\n" + "=".repeat(100));
    console.log("sanitizeText — escape/control stripping");
    console.log("=".repeat(100));

    assertEqual(
        sanitizeText("\x1b]0;title\x07text"),
        "text",
        "OSC title sequence (BEL-terminated) stripped"
    );
    assertEqual(
        sanitizeText("\x1b]9;9\x1b\\text"),
        "text",
        "OSC sequence (ST-terminated) stripped"
    );
    assertEqual(
        sanitizeText("\x1b[31mred\x1b[0m"),
        "red",
        "ANSI color sequences stripped"
    );
    assertEqual(
        sanitizeText("a\x00b\x01c"),
        "abc",
        "control characters (NUL, SOH) stripped"
    );
    assertEqual(
        sanitizeText("line1\nline2\ttabbed"),
        "line1\nline2\ttabbed",
        "newlines and tabs preserved"
    );
    assertEqual(
        sanitizeText(""),
        "",
        "empty string -> empty"
    );

    // End-to-end: ANSI-wrapped prompt line still recognized as a prompt.
    assertEqual(
        cleanOutput("\x1b[1m#\x1b[0m \nreal output\n# "),
        "real output",
        "ANSI-colored prompt line stripped end-to-end"
    );
}

// ---------------------------------------------------------------------------
// Part 5: exit-strip regression (pre-existing behavior, must not change)
// ---------------------------------------------------------------------------

function runExitStripTests() {
    console.log("\n" + "=".repeat(100));
    console.log("cleanOutput — exit strip (regression guard)");
    console.log("=".repeat(100));

    assertEqual(
        cleanOutput("some output\n# exit status 0\n# "),
        "some output",
        "'exit status 0' line with prompt prefix stripped"
    );
    assertEqual(
        cleanOutput("line1\nexit\nline2"),
        "line1\nline2",
        "standalone 'exit' line stripped"
    );
    assertEqual(
        cleanOutput("done\n# exit\n# "),
        "done",
        "trailing '# exit' prompt + exit stripped"
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runPromptLineTests();
runSingleLineTests();
runMultiLineTests();
runSanitizeTests();
runExitStripTests();

console.log("\n" + "=".repeat(100));
console.log(`SUMMARY: ${passCount} passed, ${failCount} failed`);
console.log("=".repeat(100));

if (failCount > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(f);
    process.exit(1);
} else {
    console.log("ALL TESTS PASSED");
}
