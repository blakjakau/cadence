package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// runChromeApp launches the given Chromium-based browser executable in App mode.
// It uses a persistent profile directory to ensure local storage (workspaces, AI history)
// survives between sessions, while keeping the app isolated from the user's main browser profile.
func runChromeApp(chromePath string, url string) error {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get user config dir: %w", err)
	}

	profileDir := filepath.Join(configDir, "Cadence", "chrome-profile")
	if err := os.MkdirAll(profileDir, 0755); err != nil {
		return fmt.Errorf("failed to create cadence chrome profile dir: %w", err)
	}

	args := []string{
		fmt.Sprintf("--app=%s", url),
		fmt.Sprintf("--user-data-dir=%s", profileDir),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
	}

	cmd := exec.Command(chromePath, args...)
	
	log.Printf("Launching Chrome App Mode: %s %v", chromePath, args)

	// We run it synchronously so the Go backend stays alive until the window is closed.
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("chrome execution failed: %w", err)
	}

	log.Println("Chrome App window closed. Shutting down.")
	return nil
}
