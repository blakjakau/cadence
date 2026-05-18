package main

import (
	"os"
	"os/exec"
	"runtime"
)

// findBrowser locates a Chromium-based browser executable on the host system.
func findBrowser() string {
	var paths []string

	switch runtime.GOOS {
	case "windows":
		paths = []string{
			os.Getenv("LocalAppData") + "\\Google\\Chrome\\Application\\chrome.exe",
			os.Getenv("ProgramFiles") + "\\Google\\Chrome\\Application\\chrome.exe",
			os.Getenv("ProgramFiles(x86)") + "\\Google\\Chrome\\Application\\chrome.exe",
			os.Getenv("LocalAppData") + "\\Chromium\\Application\\chrome.exe",
			os.Getenv("ProgramFiles") + "\\Chromium\\Application\\chrome.exe",
			os.Getenv("ProgramFiles(x86)") + "\\Chromium\\Application\\chrome.exe",
			os.Getenv("ProgramFiles(x86)") + "\\Microsoft\\Edge\\Application\\msedge.exe",
			os.Getenv("ProgramFiles") + "\\Microsoft\\Edge\\Application\\msedge.exe",
		}
	case "darwin":
		paths = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		}
	case "linux":
		paths = []string{
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"microsoft-edge-stable",
			"microsoft-edge-dev",
			"brave-browser",
		}
	}

	for _, path := range paths {
		if runtime.GOOS == "linux" {
			// On Linux, use LookPath to find the executable in the PATH
			if p, err := exec.LookPath(path); err == nil {
				return p
			}
		} else {
			// On Windows and macOS, check absolute paths
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}

	return ""
}
