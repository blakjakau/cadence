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
				Signature: sig,
			})
			return false // Don't descend into function body
			
		case *ast.GenDecl:
			pos := fset.Position(node.Pos())
			if node.Tok == token.TYPE {
				for _, spec := range node.Specs {
					if typeSpec, ok := spec.(*ast.TypeSpec); ok {
						sig := fmt.Sprintf("type %s struct/interface { ... }", typeSpec.Name.Name)
						outlineLines = append(outlineLines, sig)
						symbols = append(symbols, SymbolInfo{
							Name:      typeSpec.Name.Name,
							Type:      "struct",
							Line:      pos.Line,
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

	lines := strings.Split(content, "\n")
	
	// Regex patterns for JS/TS/Python
	classRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)`)
	funcRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(`)
	arrowFuncRegex := regexp.MustCompile(`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>`)
	methodRegex := regexp.MustCompile(`^\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{`)
	pythonDefRegex := regexp.MustCompile(`^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(`)
	pythonClassRegex := regexp.MustCompile(`^\s*class\s+([A-Za-z0-9_]+)\s*(?:\(|:)`)

	for i, line := range lines {
		trimLine := strings.TrimSpace(line)
		if len(trimLine) == 0 {
			continue
		}

		lineNum := i + 1
		matched := false
		
		if matches := classRegex.FindStringSubmatch(line); len(matches) > 1 {
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "class", Line: lineNum, Signature: trimLine})
			matched = true
		} else if matches := pythonClassRegex.FindStringSubmatch(line); len(matches) > 1 {
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "class", Line: lineNum, Signature: trimLine})
			matched = true
		} else if matches := funcRegex.FindStringSubmatch(line); len(matches) > 1 {
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Signature: trimLine})
			matched = true
		} else if matches := arrowFuncRegex.FindStringSubmatch(line); len(matches) > 1 {
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Signature: trimLine})
			matched = true
		} else if matches := pythonDefRegex.FindStringSubmatch(line); len(matches) > 1 {
			symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "function", Line: lineNum, Signature: trimLine})
			matched = true
		} else if matches := methodRegex.FindStringSubmatch(line); len(matches) > 1 {
			// Skip basic control structures that look like methods
			skipWords := map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true}
			if !skipWords[matches[1]] {
				symbols = append(symbols, SymbolInfo{Name: matches[1], Type: "method", Line: lineNum, Signature: trimLine})
				matched = true
			}
		}

		if matched {
			outlineLines = append(outlineLines, line)
		}
	}

	return strings.Join(outlineLines, "\n"), symbols, nil
}
