package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// systemThemeState carries the working system theme resolved from the active
// desktop: Omarchy themes export a full color palette, while KDE and GNOME
// only contribute a light/dark mode for Cadence to follow.
type systemThemeState struct {
	Detected bool              `json:"detected"`
	Source   string            `json:"source,omitempty"` // "omarchy", "kde" or "gnome"
	Theme    string            `json:"theme,omitempty"`
	Mode     string            `json:"mode,omitempty"` // "dark" or "light"
	Colors   map[string]string `json:"colors,omitempty"`
}

// --- Omarchy ---------------------------------------------------------------

// omarchyStateDir returns the per-session dir Omarchy uses to expose the
// active theme, or "" when Omarchy is not present on this machine.
func omarchyStateDir() string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	stateDir := filepath.Join(homeDir, ".local", "state", "omarchy", "current")
	if _, err := os.Stat(stateDir); err != nil {
		return ""
	}
	return stateDir
}

// omarchyKeyRe matches the simple `key = "value"` lines colors.toml is
// written in. Omarchy's colors.toml has no nested tables or arrays, so this
// line-scanner keeps us free of a TOML dependency.
var omarchyKeyRe = regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$`)

// readOmarchyTheme resolves the current Omarchy theme name and palette.
// It returns detected=false when Omarchy is not installed/active.
func readOmarchyTheme() systemThemeState {
	palette := systemThemeState{Detected: false, Source: "omarchy"}
	stateDir := omarchyStateDir()
	if stateDir == "" {
		return palette
	}

	nameBytes, err := os.ReadFile(filepath.Join(stateDir, "theme.name"))
	if err == nil {
		name := strings.TrimSpace(string(nameBytes))
		name = strings.Title(strings.ReplaceAll(name, "-", " "))
		palette.Theme = name
	}

	colorsFile := filepath.Join(stateDir, "theme", "colors.toml")
	f, err := os.Open(colorsFile)
	if err != nil {
		return palette
	}
	defer f.Close()

	palette.Colors = make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		m := omarchyKeyRe.FindStringSubmatch(scanner.Text())
		if len(m) != 3 {
			continue
		}
		if m[1] == "mode" {
			palette.Mode = strings.ToLower(m[2])
			continue
		}
		palette.Colors[m[1]] = m[2]
	}

	if palette.Mode == "" {
		// A theme without an explicit mode defaults to dark like Omarchy's
		// stock themes, but report detected only when we actually saw colors.
		palette.Mode = "dark"
	}
	if len(palette.Colors) > 0 {
		palette.Detected = true
	}
	return palette
}

// --- Desktop environment ---------------------------------------------------

// desktopEnv identifies the running desktop environment from the session
// variables GNOME/KDE set, so we can follow their color scheme.
func desktopEnv() string {
	for _, key := range []string{"XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"} {
		v := strings.ToLower(os.Getenv(key))
		switch {
		case strings.Contains(v, "kde"), strings.Contains(v, "plasma"):
			return "kde"
		case strings.Contains(v, "gnome"):
			return "gnome"
		}
	}
	return ""
}

// kdeColorSchemeMode reads the global color-scheme entry from a kdeglobals
// file. Entries carrying "Dark" in the scheme name are treated as dark mode.
func kdeColorSchemeMode(data string) (theme, mode string) {
	inGeneral := false
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "["):
			inGeneral = line == "[General]"
		case inGeneral && strings.HasPrefix(line, "ColorScheme="):
			theme = strings.TrimSpace(strings.TrimPrefix(line, "ColorScheme="))
			if strings.Contains(strings.ToLower(theme), "dark") {
				mode = "dark"
			} else {
				mode = "light"
			}
			return theme, mode
		}
	}
	return "", "light"
}

// readKdeTheme resolves the KDE light/dark preference from kdeglobals.
func readKdeTheme() systemThemeState {
	t := systemThemeState{Detected: true, Source: "kde", Mode: "light", Theme: "KDE"}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return t
	}
	data, err := os.ReadFile(filepath.Join(homeDir, ".config", "kdeglobals"))
	if err != nil {
		return t
	}
	if theme, mode := kdeColorSchemeMode(string(data)); theme != "" {
		t.Theme = theme
		t.Mode = mode
	}
	return t
}

// gnomeGsettingsMode asks GSettings what color-scheme GNOME is applying.
// Returns "" when gsettings isn't available or the key is absent.
func gnomeGsettingsMode() string {
	out, err := exec.Command("gsettings", "get", "org.gnome.desktop.interface", "color-scheme").Output()
	if err != nil {
		return ""
	}
	switch strings.Trim(strings.TrimSpace(string(out)), "'") {
	case "prefer-dark":
		return "dark"
	case "default":
		return "light"
	default:
		return ""
	}
}

// gtkSettingsMode extracts GNOME's dark preference from a GTK settings.ini:
// gtk-application-prefer-dark-theme=1 or a *dark* gtk-theme-name both mean
// dark mode.
func gtkSettingsMode(data string) (mode, theme string) {
	inSettings := false
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "["):
			inSettings = line == "[Settings]"
		case inSettings && strings.Contains(line, "="):
			key, value, found := strings.Cut(line, "=")
			if !found {
				continue
			}
			key = strings.TrimSpace(key)
			value = strings.TrimSpace(value)
			switch key {
			case "gtk-application-prefer-dark-theme":
				if value == "1" {
					mode = "dark"
				} else {
					mode = "light"
				}
			case "gtk-theme-name":
				theme = value
			}
		}
	}
	if mode == "" && strings.Contains(strings.ToLower(theme), "dark") {
		mode = "dark"
	}
	if mode == "" {
		mode = "light"
	}
	return mode, theme
}

// readGnomeTheme resolves GNOME's light/dark preference from GSettings,
// falling back to the GTK settings.ini files.
func readGnomeTheme() systemThemeState {
	t := systemThemeState{Detected: true, Source: "gnome", Mode: "light", Theme: "GNOME"}
	if mode := gnomeGsettingsMode(); mode != "" {
		t.Mode = mode
		return t
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return t
	}
	for _, path := range []string{".config/gtk-3.0/settings.ini", ".config/gtk-4.0/settings.ini"} {
		data, rerr := os.ReadFile(filepath.Join(homeDir, path))
		if rerr != nil {
			continue
		}
		mode, theme := gtkSettingsMode(string(data))
		if mode != "" {
			t.Mode = mode
		}
		if theme != "" {
			t.Theme = theme
		}
		return t
	}
	return t
}

// readSystemTheme resolves the platform theme in priority order: Omarchy
// (full palette), then KDE/GNOME (mode only).
func readSystemTheme() systemThemeState {
	if palette := readOmarchyTheme(); palette.Detected {
		return palette
	}
	switch desktopEnv() {
	case "kde":
		return readKdeTheme()
	case "gnome":
		return readGnomeTheme()
	}
	return systemThemeState{Detected: false}
}

func systemThemeHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(readSystemTheme())
}