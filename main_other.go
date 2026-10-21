//go:build !darwin && !windows
// +build !darwin,!windows

package main

import (
	"os/exec"
	"syscall"
)

func handleStartup() {
	if headlessFlag {
		RendererMode = "headless"
		runCadenceServer(true)
		return
	}

	appUrl := "http://localhost:" + port + "/"

	if browserFlag {
		RendererMode = "browser"
		runCadenceServer(true)
		return
	}

	if webviewFlag {
		RendererMode = "webview"
		go runCadenceServer(false)
		runWebviewApp(appUrl)
		return
	}

	// Dynamic Chromium / Chrome App detection
	chromePath := findBrowser()
	if chromePath != "" {
		RendererMode = "chrome-app"
		go runCadenceServer(false)
		runChromeApp(chromePath, appUrl)
		return
	}

	// Fallback to default browser
	RendererMode = "browser"
	browserFlag = true
	runCadenceServer(true)
}

func main() {
	// If reexeced as a sandbox keeper, run the keeper loop (never returns).
	if sandboxKeeperEntry() {
		return
	}
	getIsCompiled()
	parseFlags()
	handleStartup()
}

func configureCmdForRestart(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}
