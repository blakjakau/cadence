package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/odvcencio/gotreesitter"
	"github.com/odvcencio/gotreesitter/grammars"
)

// grammarForExt maps a lower-cased file extension to the tree-sitter grammar
// constructor for that language. Only the languages we actually want to check
// are imported, keeping the embedded grammar set small.
var grammarForExt = map[string]func() *gotreesitter.Language{
	// JavaScript family
	".js":   grammars.JavascriptLanguage,
	".mjs":  grammars.JavascriptLanguage,
	".cjs":  grammars.JavascriptLanguage,
	".jsx":  grammars.JavascriptLanguage,
	".ts":   grammars.TypescriptLanguage,
	".tsx":  grammars.TsxLanguage,
	// Go
	".go": grammars.GoLanguage,
	// Python
	".py":  grammars.PythonLanguage,
	".pyi": grammars.PythonLanguage,
	// Rust
	".rs": grammars.RustLanguage,
	// C / C++ / C#
	".c":    grammars.CLanguage,
	".h":    grammars.CLanguage,
	".cpp":  grammars.CppLanguage,
	".cc":   grammars.CppLanguage,
	".cxx":  grammars.CppLanguage,
	".hpp":  grammars.CppLanguage,
	".cs":   grammars.CSharpLanguage,
	// Ruby
	".rb": grammars.RubyLanguage,
	// Data / markup / style
	".json":     grammars.JsonLanguage,
	".yaml":     grammars.YamlLanguage,
	".yml":      grammars.YamlLanguage,
	".html":     grammars.HtmlLanguage,
	".htm":      grammars.HtmlLanguage,
	".css":      grammars.CssLanguage,
	".sql":      grammars.SqlLanguage,
	".md":       grammars.MarkdownLanguage,
	".markdown": grammars.MarkdownLanguage,
}

// supportedFor reports whether the file extension has a known tree-sitter
// grammar and can therefore be authoritatively syntax-checked.
func supportedFor(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	_, ok := grammarForExt[ext]
	return ok
}

// parseSyntax parses content with the tree-sitter grammar for the given file
// path and reports whether it is syntactically valid plus a concise error
// message (first error/missing node, with line/col and a short excerpt).
//
// Unsupported extensions (no known grammar) pass cleanly with valid=true and
// an empty error, matching the previous behaviour for unhandled languages.
func parseSyntax(path, content string) (valid bool, errMsg string) {
	ext := strings.ToLower(filepath.Ext(path))
	langFn, ok := grammarForExt[ext]
	if !ok {
		// No grammar for this extension: nothing to check, pass cleanly.
		return true, ""
	}

	lang := langFn()
	parser := gotreesitter.NewParser(lang)

	tree, err := parser.Parse([]byte(content))
	if err != nil {
		// A hard parse failure is treated as invalid with the error surfaced.
		return false, fmt.Sprintf("parse failed: %v", err)
	}
	defer tree.Release()

	root := tree.RootNode()
	if root == nil {
		// Some grammars return a nil root for empty input; treat as valid.
		return true, ""
	}

	// A tree is syntactically clean when the root has no error/missing node.
	if !root.HasErrorOrMissing() {
		return true, ""
	}

	// Find the first offending node (pre-order) to build a concise message.
	offender := findFirstErrorNode(root)
	if offender == nil {
		return false, "syntax error"
	}

	start := offender.StartPoint()
	label := offender.Type(lang)
	if offender.IsMissing() {
		label = "missing " + label
	}

	excerpt := trimExcerpt(offender.Text([]byte(content)))
	msg := fmt.Sprintf("line %d, col %d: %s", start.Row+1, start.Column+1, label)
	if excerpt != "" {
		msg += " near " + excerpt
	}
	return false, msg
}

// findFirstErrorNode returns the first node (pre-order DFS) that is an error
// or missing node, or nil if none is found.
func findFirstErrorNode(n *gotreesitter.Node) *gotreesitter.Node {
	if n == nil {
		return nil
	}
	if n.IsError() || n.IsMissing() {
		return n
	}
	for i := 0; i < n.ChildCount(); i++ {
		if found := findFirstErrorNode(n.Child(i)); found != nil {
			return found
		}
	}
	return nil
}

// trimExcerpt collapses whitespace/newlines and trims the node text to a short
// single-line snippet suitable for an error message.
func trimExcerpt(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Replace runs of whitespace (incl. newlines) with a single space.
	s = strings.Join(strings.Fields(s), " ")
	const max = 40
	if len(s) > max {
		s = s[:max] + "..."
	}
	return s
}
