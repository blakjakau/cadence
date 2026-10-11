//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// startPty returns an io.ReadWriteCloser (the PTY master), a process handle
// (with .Pid), and a resize function. When sandbox is non-nil the shell runs
// inside a shared sandbox namespace (see sandbox_unix.go); otherwise it runs
// directly on the host.
func startPty(shell string, homeDir string, prompt string, sandbox *SandboxConfig) (io.ReadWriteCloser, *ptyProcess, func(cols, rows int), error) {
	if sandbox != nil {
		// Sandbox path: the keeper forks the shell into its namespace attached
		// to a pty. The owner label ties this PTY to a sandbox instance.
		sandbox.Shell = shell
		if sandbox.Cwd == "" {
			sandbox.Cwd = homeDir
		}
		if prompt != "" {
			sandbox.Env = append(sandbox.Env, "PS1="+prompt)
		}
		h, err := startSandboxedShell(sandbox, sandbox.Owner)
		if err != nil {
			return nil, nil, nil, err
		}
		// The in-ns shell is a grandchild (keeper forked it), so the server
		// cannot Wait() on it directly; the pty master reaching EOF signals exit.
		return h.Master, &ptyProcess{Pid: h.Pid, Kill: h.Kill}, h.Resize, nil
	}

	// Unsandboxed path: run the shell directly on the host.
	c := exec.Command(shell)
	c.Dir = homeDir
	c.Env = append(os.Environ(), "TERM=xterm-256color")

	if shell == "bash" || shell == "zsh" {
		c.Env = append(c.Env, `PROMPT_COMMAND=printf "\033]9;9;%s\033\\" "${PWD}"`)
		if prompt != "" {
			c.Env = append(c.Env, "PS1="+prompt)
		}
	}

	// pty.Start returns an *os.File, which satisfies the io.ReadWriteCloser interface.
	ptmx, err := pty.Start(c)
	if err != nil {
		return nil, nil, nil, err
	}

	resizeFunc := func(cols, rows int) {
		pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}

	pid := -1
	proc := &ptyProcess{Pid: pid}
	if c.Process != nil {
		proc.Pid = c.Process.Pid
		proc.Kill = func() { c.Process.Kill() }
		proc.Wait = func() { c.Process.Wait() }
	}
	return ptmx, proc, resizeFunc, nil
}
