//go:build !darwin && !windows
// +build !darwin,!windows

package main

import (
	"os/exec"
	"syscall"
)

func main() {
	getIsCompiled()
	parseFlags()

	// Handled by wails_app.go (wails tag) or wails_stub.go (!wails tag)
	handleStartup()
}

func configureCmdForRestart(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}
