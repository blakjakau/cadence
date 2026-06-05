package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"strings"
)

// SymbolInfo represents a structural element extracted from a file.
type SymbolInfo struct {
	Name      string `json:"name"`
	Type      string `json:"type"` // "function", "struct", "class", "method"
	Line      int    `json:"line"`
	Length    int    `json:"length,omitempty"`
	Signature string `json:"signature"`
}

// GenerateOutline parses source code and returns a compressed skeleton
// of the file containing only structural declarations, along with a list of symbols.
func GenerateOutline(path string, content string) (string, []SymbolInfo, error) {
	if strings.HasSuffix(path, ".go") {
		return parseGoOutline(path, content)
	}

	// For non-Go files, use a fast regex scanner
	return parseRegexOutline(path, content)
}

func parseGoOutline(path string, content string) (string, []SymbolInfo, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, content, parser.ParseComments)
	if err != nil {
		// Fallback to regex if go code is malformed/incomplete
		return parseRegexOutline(path, content)
	}

	var symbols []SymbolInfo
	var outlineLines []string

	outlineLines = append(outlineLines, fmt.Sprintf("package %s\n", f.Name.Name))

	ast.Inspect(f, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.FuncDecl:
			pos := fset.Position(node.Pos())
			end := fset.Position(node.End())
			length := end.Line - pos.Line + 1
			
			// Reconstruct signature loosely
			recv := ""
			if node.Recv != nil && len(node.Recv.List) > 0 {
				recv = "(...) "
			}
			
			sig := fmt.Sprintf("func %s%s(...)", recv, node.Name.Name)
			outlineLines = append(outlineLines, sig)
			symbols = append(symbols, SymbolInfo{
				Name:      node.Name.Name,
				Type:      "function",
				Line:      pos.Line,
				Length:    length,
				Signature: sig,
			})
			return false // Don't descend into function body
			
		case *ast.GenDecl:
			pos := fset.Position(node.Pos())
			end := fset.Position(node.End())
			length := end.Line - pos.Line + 1
			if node.Tok == token.TYPE {
				for _, spec := range node.Specs {
					if typeSpec, ok := spec.(*ast.TypeSpec); ok {
						sig := fmt.Sprintf("type %s struct/interface { ... }", typeSpec.Name.Name)
						outlineLines = append(outlineLines, sig)
						symbols = append(symbols, SymbolInfo{
							Name:      typeSpec.Name.Name,
							Type:      "struct",
							Line:      pos.Line,
							Length:    length,
							Signature: sig,
						})
					}
				}
			}
		}
		return true
	})

	return strings.Join(outlineLines, "\n"), symbols, nil
}

func parseRegexOutline(path string, content string) (string, []SymbolInfo, error) {
	var symbols []SymbolInfo
	var outlineLines []string
	isPython := strings.HasSuffix(path, ".py")

	lines := strings.Split(content, "\n")
	
	// Regex patterns for JS/TS/Python
	classRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)`)
	funcRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(`)
	arrowFuncRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>`)
	methodRegex := regexp.MustCompile(`^\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{`)
	pythonDefRegex := regexp.MustCompile(`^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(`)
	pythonClassRegex := regexp.MustCompile(`^\s*class\s+([A-Za-z0-9_]+)\s*(?:\(|:)`)
	objArrowFuncRegex := regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>`)
	objFuncRegex := regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*:\s*(?:async\s*)?function\b`)

	for i, line := range lines {
		trimLine := strings.TrimSpace(line)
		if len(trimLine) == 0 {
			continue
		}

		lineNum := i + 1
		matched := false
		
		if matches := classRegex.FindStringSubmatch(line); len(matches) > 1 {
			length := findSymbolLength(lines, i, isPython)
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "class", Line: lineNum, Length: length, Signature: trimLine})
			matched = true
		} else if matches := pythonClassRegex.FindStringSubmatch(line); len(matches) > 1 {
			length := findSymbolLength(lines, i, true)
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "class", Line: lineNum, Length: length, Signature: trimLine})
			matched = true
		} else if matches := funcRegex.FindStringSubmatch(line); len(matches) > 1 {
			length := findSymbolLength(lines, i, isPython)
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Length: length, Signature: trimLine})
			matched = true
		} else if matches := arrowFuncRegex.FindStringSubmatch(line); len(matches) > 1 {
			length := findSymbolLength(lines, i, isPython)
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Length: length, Signature: trimLine})
			matched = true
		} else if matches := pythonDefRegex.FindStringSubmatch(line); len(matches) > 1 {
			length := findSymbolLength(lines, i, true)
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Length: length, Signature: trimLine})
			matched = true
		} else if matches := methodRegex.FindStringSubmatch(line); len(matches) > 1 {
			// Skip basic control structures that look like methods
			skipWords := map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true}
			if !skipWords[matches[1]] {
				length := findSymbolLength(lines, i, isPython)
				symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "method", Line: lineNum, Length: length, Signature: trimLine})
				matched = true
			}
		} else if matches := objArrowFuncRegex.FindStringSubmatch(line); len(matches) > 1 {
			skipWords := map[string]bool{"default": true, "case": true}
			if !skipWords[matches[1]] {
				length := findSymbolLength(lines, i, false)
				symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "method", Line: lineNum, Length: length, Signature: trimLine})
				matched = true
			}
		} else if matches := objFuncRegex.FindStringSubmatch(line); len(matches) > 1 {
			skipWords := map[string]bool{"default": true, "case": true}
			if !skipWords[matches[1]] {
				length := findSymbolLength(lines, i, false)
				symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "method", Line: lineNum, Length: length, Signature: trimLine})
				matched = true
			}
		}

		if matched {
			outlineLines = append(outlineLines, line)
		}
	}

	return strings.Join(outlineLines, "\n"), symbols, nil
}

// findSymbolLength calculates the approximate length of a function/class
func findSymbolLength(lines []string, startIdx int, isPython bool) int {
	if startIdx >= len(lines) {
		return 1
	}
	if isPython {
		startLine := lines[startIdx]
		startIndent := len(startLine) - len(strings.TrimLeft(startLine, " \t"))
		for i := startIdx + 1; i < len(lines); i++ {
			line := lines[i]
			trimLine := strings.TrimSpace(line)
			if trimLine == "" || strings.HasPrefix(trimLine, "#") {
				continue
			}
			indent := len(line) - len(strings.TrimLeft(line, " \t"))
			if indent <= startIndent {
				return i - startIdx
			}
		}
		return len(lines) - startIdx
	}

	depth := 0
	started := false
	inString := false
	var stringChar rune

	for i := startIdx; i < len(lines); i++ {
		line := lines[i]
		for j, char := range line {
			if !inString {
				if char == '"' || char == '\'' || char == '`' {
					inString = true
					stringChar = char
				} else if char == '{' {
					depth++
					started = true
				} else if char == '}' {
					depth--
					if started && depth == 0 {
						return i - startIdx + 1
					}
				} else if char == '/' && j+1 < len(line) && line[j+1] == '/' {
					break 
				}
			} else {
				if char == stringChar {
					if j == 0 || line[j-1] != '\\' {
						inString = false
					}
				}
			}
		}
	}
	return len(lines) - startIdx
}
