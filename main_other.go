//go:build !darwin && !windows
// +build !darwin,!windows

package main

func main() {
	getIsCompiled()
	parseFlags()

	// Handled by wails_app.go (wails tag) or wails_stub.go (!wails tag)
	handleStartup()
}
