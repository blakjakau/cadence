// mode-ai-prompt.js
//
// A markdown mode variant for the AI prompt editor. It extends the standard
// markdown tokenizer with a single "at.mention" token so @tag references
// (e.g. @app/js/agent/agent-tools.mjs, @file.mjs#symbol, @skill-name) are
// rendered as highlighted "chips" (CSS classes: ace_at ace_mention).
//
// Everything else (markdown, embedded code blocks, folding, indentation,
// code-behaviours) is inherited unchanged from the markdown mode.
//
// Loaded on demand by ACE: session.setMode("ace/mode/ai-prompt") resolves to
// this file via config.moduleUrl (component "mode", separator "-"), which in
// turn triggers loading of ace/mode-markdown.js for the deps below.

ace.define("ace/mode/ai-prompt", ["require", "exports", "module",
    "ace/lib/oop",
    "ace/mode/markdown",
    "ace/mode/markdown_highlight_rules"
], function(require, exports, module) {
"use strict";

var oop = require("../lib/oop");
var MarkdownMode = require("./markdown").Mode;
var MarkdownHighlightRules = require("./markdown_highlight_rules").MarkdownHighlightRules;

var AIPromptHighlightRules = function() {
    MarkdownHighlightRules.call(this);

    // One @tag token. The character class covers:
    //   @file.js  @path/to/file.mjs  @path/to/file.mjs#symbol  @skill-name
    // It stops at whitespace and punctuation (including "(", ":", ","), so
    // "(@tag)" and "see @tag:" highlight the tag but not the surrounding
    // text. `#` is included so symbol refs (@file.mjs#Symbol) form one chip.
    var mentionRule = {
        token: "at.mention",
        regex: /@[\w\-./#]+/
    };

    // "basic" is the shared text state (included by start, listblock,
    // blockquote, header), so putting the rule first there makes @tags into
    // chips everywhere plain text is tokenized. No `next` is set, so the
    // tokenizer stays in the current state — markdown / code-fence behaviour
    // is untouched.
    this.$rules["basic"].unshift(mentionRule);

    // Also at the head of "start" so a line that *begins* with a tag matches
    // the chip before any markdown block-level rule runs.
    this.$rules["start"].unshift({
        token: "at.mention",
        regex: mentionRule.regex
    });
};
oop.inherits(AIPromptHighlightRules, MarkdownHighlightRules);

exports.AIPromptHighlightRules = AIPromptHighlightRules;

var Mode = function() {
    MarkdownMode.call(this);
    // Swap in our rules; markdown's folding, indentation, mode delegates and
    // code-behaviours come from MarkdownMode.prototype.
    this.HighlightRules = AIPromptHighlightRules;
};
oop.inherits(Mode, MarkdownMode);

(function() {
    this.$id = "ace/mode/ai-prompt";
}).call(Mode.prototype);

exports.Mode = Mode;
});

(function() {
    ace.require(["ace/mode/ai-prompt"], function(m) {
        if (typeof module == "object" && typeof exports == "object" && module) {
            module.exports = m;
        }
    });
})();
