//go:build wails
// +build wails

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Start the background server for WebSockets (Terminal, etc.)
	go runCadenceServer(false)
}

func handleStartup() {
	if headlessFlag {
		RendererMode = "headless"
		runCadenceServer(true)
		return
	}

	appUrl := "http://localhost:" + port + "/"

	// If we are being run by Wails for metadata/bindings generation, 
	// we must skip the dynamic renderers and let wails.Run() handle the introspection.
	exeName := filepath.Base(os.Args[0])
	if strings.Contains(exeName, "wailsbindings") || os.Getenv("tsoutputtype") != "" {
		runWailsApp()
		return
	}

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

	if wailsFlag {
		RendererMode = "wails"
		runWailsApp()
		return
	}

	// Dynamic Chromium detection (Option 4)
	chromePath := findBrowser()
	if chromePath != "" {
		RendererMode = "chrome-app"
		go runCadenceServer(false)
		runChromeApp(chromePath, appUrl)
		return
	}

	// Fallback to Wails natively
	RendererMode = "wails"
	runWailsApp()
}

func runWailsApp() {
	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "", // Keep title empty to discourage OS decorations
		Width:     1280,
		Height:    800,
		Frameless: true,
		DisableResize: false,
		AssetServer: &assetserver.Options{
			Assets:  appEmbedFS,
			Handler: createServerMux(),
		},
		BackgroundColour: &options.RGBA{R: 56, G: 65, B: 68, A: 255},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
		// Enable DevTools
		Debug: options.Debug{
			OpenInspectorOnStartup: false,
		},
		Linux: &linux.Options{
			WindowIsTranslucent: true,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
		},
	})

	if err != nil {
		fmt.Println("Error:", err.Error())
	}
}
