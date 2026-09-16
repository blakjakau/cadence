package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestGtkSettingsMode(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantMode  string
		wantTheme string
	}{
		{"empty", "", "light", ""},
		{"prefer dark", "[Settings]\ngtk-application-prefer-dark-theme=1\n", "dark", ""},
		{"prefer light", "[Settings]\ngtk-application-prefer-dark-theme=0\n", "light", ""},
		{"theme name dark", "[Settings]\ngtk-theme-name=Adwaita-dark\n", "dark", "Adwaita-dark"},
		{"theme name light", "[Settings]\ngtk-theme-name=Adwaita\n", "light", "Adwaita"},
		{"outside settings ignored", "[Sound]\ngtk-theme-name=Adwaita-dark\n", "light", ""},
		{"both keys", "[Settings]\ngtk-theme-name=Adwaita\ngtk-application-prefer-dark-theme=1\n", "dark", "Adwaita"},
	}
	for _, c := range cases {
		mode, theme := gtkSettingsMode(c.input)
		if mode != c.wantMode || theme != c.wantTheme {
			t.Errorf("%s: got mode=%q theme=%q want mode=%q theme=%q", c.name, mode, theme, c.wantMode, c.wantTheme)
		}
	}
}

func TestKdeColorSchemeMode(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantMode  string
		wantTheme string
	}{
		{"dark", "[General]\nColorScheme=BreezeDark\n", "dark", "BreezeDark"},
		{"light", "[General]\nColorScheme=BreezeLight\n", "light", "BreezeLight"},
		{"other sections first", "[Icons]\nTheme=Breeze\n[General]\nColorScheme=Adwaita Dark\n", "dark", "Adwaita Dark"},
		{"missing", "[General]\nSomethingElse=value\n", "light", ""},
		{"no general section", "[Icons]\nTheme=Breeze\nColorScheme=BreezeDark\n", "light", ""},
	}
	for _, c := range cases {
		theme, mode := kdeColorSchemeMode(c.input)
		if mode != c.wantMode || theme != c.wantTheme {
			t.Errorf("%s: got theme=%q mode=%q want theme=%q mode=%q", c.name, theme, mode, c.wantTheme, c.wantMode)
		}
	}
}

func setHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	oldHome := os.Getenv("HOME")
	t.Cleanup(func() { os.Setenv("HOME", oldHome) })
	os.Setenv("HOME", tmp)
	return tmp
}

func TestReadKdeTheme(t *testing.T) {
	home := setHome(t)
	noFile := readKdeTheme()
	if !noFile.Detected || noFile.Source != "kde" || noFile.Mode != "light" || noFile.Theme != "KDE" {
		t.Errorf("missing kdeglobals: got %+v want detected kde light", noFile)
	}

	os.MkdirAll(filepath.Join(home, ".config"), 0o755)
	os.WriteFile(filepath.Join(home, ".config", "kdeglobals"), []byte("[General]\nColorScheme=BreezeDark\n"), 0o644)
	withFile := readKdeTheme()
	if !withFile.Detected || withFile.Mode != "dark" || withFile.Theme != "BreezeDark" {
		t.Errorf("kdeglobals present: got %+v want detected kde dark BreezeDark", withFile)
	}
}

func TestReadGnomeTheme(t *testing.T) {
	oldSession := os.Getenv("XDG_CURRENT_DESKTOP")
	oldPath := os.Getenv("PATH")
	t.Cleanup(func() {
		os.Setenv("XDG_CURRENT_DESKTOP", oldSession)
		os.Setenv("PATH", oldPath)
	})
	os.Setenv("XDG_CURRENT_DESKTOP", "GNOME")
	// Remove gsettings from PATH so the test exercises the settings.ini
	// fallback regardless of what the host has installed.
	os.Setenv("PATH", "/nonexistent")

	home := setHome(t)
	noFile := readGnomeTheme()
	if !noFile.Detected || noFile.Source != "gnome" || noFile.Mode != "light" {
		t.Errorf("missing gtk config: got %+v want detected gnome light", noFile)
	}

	os.MkdirAll(filepath.Join(home, ".config", "gtk-3.0"), 0o755)
	os.WriteFile(filepath.Join(home, ".config", "gtk-3.0", "settings.ini"), []byte("[Settings]\ngtk-application-prefer-dark-theme=1\n"), 0o644)
	withDark := readGnomeTheme()
	if !withDark.Detected || withDark.Source != "gnome" || withDark.Mode != "dark" {
		t.Errorf("dark gtk config: got %+v want detected gnome dark", withDark)
	}

	os.WriteFile(filepath.Join(home, ".config", "gtk-3.0", "settings.ini"), []byte("[Settings]\ngtk-theme-name=Adwaita\n"), 0o644)
	withLight := readGnomeTheme()
	if !withLight.Detected || withLight.Mode != "light" || withLight.Theme != "Adwaita" {
		t.Errorf("light gtk config: got %+v want detected gnome light Adwaita", withLight)
	}
}

func TestDesktopEnv(t *testing.T) {
	oldDE := os.Getenv("XDG_CURRENT_DESKTOP")
	oldSession := os.Getenv("XDG_SESSION_DESKTOP")
	oldDs := os.Getenv("DESKTOP_SESSION")
	t.Cleanup(func() {
		os.Setenv("XDG_CURRENT_DESKTOP", oldDE)
		os.Setenv("XDG_SESSION_DESKTOP", oldSession)
		os.Setenv("DESKTOP_SESSION", oldDs)
	})
	os.Setenv("XDG_CURRENT_DESKTOP", "KDE")
	os.Setenv("XDG_SESSION_DESKTOP", "")
	os.Setenv("DESKTOP_SESSION", "")
	if got := desktopEnv(); got != "kde" {
		t.Errorf("XDG_CURRENT_DESKTOP=KDE: got %q want kde", got)
	}
	os.Setenv("XDG_CURRENT_DESKTOP", "")
	os.Setenv("XDG_SESSION_DESKTOP", "gnome")
	if got := desktopEnv(); got != "gnome" {
		t.Errorf("XDG_SESSION_DESKTOP=gnome: got %q want gnome", got)
	}
	os.Setenv("XDG_SESSION_DESKTOP", "")
	os.Setenv("DESKTOP_SESSION", "plasma")
	if got := desktopEnv(); got != "kde" {
		t.Errorf("DESKTOP_SESSION=plasma: got %q want kde", got)
	}
	os.Setenv("DESKTOP_SESSION", "sway")
	if got := desktopEnv(); got != "" {
		t.Errorf("DESKTOP_SESSION=sway: got %q want empty", got)
	}
}

func TestSystemThemeHandlerKde(t *testing.T) {
	oldDE := os.Getenv("XDG_CURRENT_DESKTOP")
	oldSession := os.Getenv("XDG_SESSION_DESKTOP")
	oldDs := os.Getenv("DESKTOP_SESSION")
	t.Cleanup(func() {
		os.Setenv("XDG_CURRENT_DESKTOP", oldDE)
		os.Setenv("XDG_SESSION_DESKTOP", oldSession)
		os.Setenv("DESKTOP_SESSION", oldDs)
	})
	os.Setenv("XDG_CURRENT_DESKTOP", "KDE")
	os.Setenv("XDG_SESSION_DESKTOP", "")
	os.Setenv("DESKTOP_SESSION", "")

	home := setHome(t)
	os.MkdirAll(filepath.Join(home, ".config"), 0o755)
	os.WriteFile(filepath.Join(home, ".config", "kdeglobals"), []byte("[General]\nColorScheme=BreezeDark\n"), 0o644)

	mux := createServerMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/api/omarchy-theme")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status=%d want 200", res.StatusCode)
	}

	var st systemThemeState
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	if !st.Detected || st.Source != "kde" || st.Mode != "dark" || st.Theme != "BreezeDark" {
		t.Errorf("got %+v want detected kde dark BreezeDark", st)
	}
}