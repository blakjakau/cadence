package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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

func TestThemeHandlerKde(t *testing.T) {
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

	res, err := srv.Client().Get(srv.URL + "/api/theme")
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
func TestThemeProviderOrder(t *testing.T) {
	want := []string{"omarchy", "kde", "gnome"}
	if len(themeProviders) != len(want) {
		t.Fatalf("got %d providers want %d", len(themeProviders), len(want))
	}
	for i, p := range themeProviders {
		if p.Name() != want[i] {
			t.Errorf("provider %d: got %q want %q", i, p.Name(), want[i])
		}
	}
}

func TestThemeProviderAvailability(t *testing.T) {
	oldDE := os.Getenv("XDG_CURRENT_DESKTOP")
	oldSession := os.Getenv("XDG_SESSION_DESKTOP")
	oldDs := os.Getenv("DESKTOP_SESSION")
	t.Cleanup(func() {
		os.Setenv("XDG_CURRENT_DESKTOP", oldDE)
		os.Setenv("XDG_SESSION_DESKTOP", oldSession)
		os.Setenv("DESKTOP_SESSION", oldDs)
	})
	setHome(t)

	if (omarchyStateDir() != "") != (omarchyProvider{}).Available() {
		t.Errorf("omarchy availability mismatch with state dir presence")
	}
	os.Setenv("XDG_CURRENT_DESKTOP", "KDE")
	os.Setenv("XDG_SESSION_DESKTOP", "")
	os.Setenv("DESKTOP_SESSION", "")
	if !(kdeProvider{}).Available() || (gnomeProvider{}).Available() {
		t.Errorf("KDE env: want kde available, gnome not")
	}
	os.Setenv("XDG_CURRENT_DESKTOP", "")
	os.Setenv("XDG_SESSION_DESKTOP", "gnome")
	if (kdeProvider{}).Available() || !((gnomeProvider{}).Available()) {
		t.Errorf("GNOME env: want gnome available, kde not")
	}
}

func TestThemeKey(t *testing.T) {
	a := systemThemeState{Detected: true, Source: "omarchy", Theme: "X", Mode: "dark", Colors: map[string]string{"background": "#000000"}}
	if themeKey(a) != themeKey(a) {
		t.Errorf("themeKey not stable")
	}
	b := a
	b.Mode = "light"
	if themeKey(a) == themeKey(b) {
		t.Errorf("themeKey ignores mode change")
	}
	c := a
	c.Colors = map[string]string{"background": "#ffffff"}
	if themeKey(a) == themeKey(c) {
		t.Errorf("themeKey ignores palette change")
	}
}

func TestReadSystemThemeUndetected(t *testing.T) {
	oldDE := os.Getenv("XDG_CURRENT_DESKTOP")
	oldSession := os.Getenv("XDG_SESSION_DESKTOP")
	oldDs := os.Getenv("DESKTOP_SESSION")
	t.Cleanup(func() {
		os.Setenv("XDG_CURRENT_DESKTOP", oldDE)
		os.Setenv("XDG_SESSION_DESKTOP", oldSession)
		os.Setenv("DESKTOP_SESSION", oldDs)
	})
	setHome(t) // empty home: no omarchy dir, no kdeglobals, no gtk settings
	os.Setenv("XDG_CURRENT_DESKTOP", "")
	os.Setenv("XDG_SESSION_DESKTOP", "")
	os.Setenv("DESKTOP_SESSION", "sway")
	if s := readSystemTheme(); s.Detected {
		t.Errorf("got %+v want undetected on unknown desktop", s)
	}
}

func TestBroadcastTheme(t *testing.T) {
	ready := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		fileWatcher.mu.Lock()
		if fileWatcher.subscribers == nil {
			fileWatcher.subscribers = make(map[*websocket.Conn]map[string]string)
		}
		fileWatcher.subscribers[ws] = map[string]string{}
		fileWatcher.mu.Unlock()
		defer fileWatcher.removeClient(ws)
		ready <- ws
		for {
			if _, _, err := ws.NextReader(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	dialer := websocket.Dialer{}
	header := http.Header{"Origin": []string{"http://localhost:3022"}}
	client, _, err := dialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", header)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("server never upgraded the connection")
	}

	state := systemThemeState{Detected: true, Source: "gnome", Theme: "GNOME", Mode: "dark"}
	fileWatcher.broadcastTheme(state)

	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	var msg fileResponse
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatalf("read: %v", err)
	}
	if msg.Action != "theme_changed" {
		t.Fatalf("action=%q want theme_changed", msg.Action)
	}
	data, ok := msg.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("data has type %T want object", msg.Data)
	}
	if data["source"] != "gnome" || data["mode"] != "dark" {
		t.Errorf("data=%v want source=gnome mode=dark", data)
	}
	if _, gone := fileWatcher.subscribers[client]; gone {
		t.Errorf("client conn leaked in subscribers (wrong side of the socket)")
	}
}
