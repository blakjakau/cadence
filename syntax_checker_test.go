package main

import (
	"strings"
	"testing"
)

func TestParseSyntaxSmoke(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		content   string
		wantValid bool
	}{
		// Valid cases across languages
		{"valid js", "a.js", "const x = 1;\nfunction f(){ return x; }", true},
		{"valid ts", "a.ts", "const x: number = 1;", true},
		{"valid go", "a.go", "package main\nfunc main() {}\n", true},
		{"valid py", "a.py", "def f():\n    return 1\n", true},
		{"valid json", "a.json", "{\"a\": 1, \"b\": [1,2]}", true},
		{"valid yaml", "a.yaml", "key: value\nlist:\n  - 1\n", true},
		{"valid css", "a.css", ".x { color: red; }", true},
		{"valid html", "a.html", "<div><p>hi</p></div>", true},
		{"valid sql", "a.sql", "SELECT 1;", true},
		{"valid md", "a.md", "# Title\n\nsome text", true},
		{"valid rust", "a.rs", "fn main() {}\n", true},
		{"valid c", "a.c", "int main(void){return 0;}\n", true},
		{"valid ruby", "a.rb", "def f\n  1\nend\n", true},

		// Invalid cases
		{"invalid js", "a.js", "function { return 1; }", false},
		{"invalid go", "a.go", "package main\nfunc main() {\n", false},
		{"invalid json", "a.json", "{\"a\": 1,}", false},
		{"invalid py", "a.py", "def f(:\n    return 1", false},
		{"invalid css", "a.css", ".x { color: }", false},

		// Unsupported extension passes cleanly
		{"unsupported sh", "a.sh", "#!/bin/sh\nif [ 1; then echo hi\n", true},
		{"unsupported toml", "a.toml", "[not valid toml", true},
		{"no ext", "README", "anything at all", true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			valid, errMsg := parseSyntax(c.path, c.content)
			if valid != c.wantValid {
				t.Fatalf("parseSyntax(%q) = valid %v (err %q), want valid %v", c.path, valid, errMsg, c.wantValid)
			}
			if c.wantValid && errMsg != "" {
				t.Fatalf("expected empty error for valid case, got %q", errMsg)
			}
			if !c.wantValid && errMsg == "" {
				t.Fatalf("expected non-empty error for invalid case")
			}
			if !c.wantValid {
				t.Logf("invalid case %q -> %q", c.path, errMsg)
			}
		})
	}
}

// Ensure the error message includes a line/col for an invalid JS case.
func TestParseSyntaxErrorMessageShape(t *testing.T) {
	valid, errMsg := parseSyntax("a.js", "function { return 1; }")
	if valid {
		t.Fatalf("expected invalid")
	}
	if !strings.Contains(errMsg, "line ") || !strings.Contains(errMsg, "col ") {
		t.Fatalf("error message missing line/col: %q", errMsg)
	}
	t.Logf("message: %q", errMsg)
}
