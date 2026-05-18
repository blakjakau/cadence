//go:build !wails
// +build !wails

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

func handleStartup() {
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
		RendererMode = "wails-stub"
		runWailsApp()
		return
	}

	chromePath := findBrowser()
	if chromePath != "" {
		RendererMode = "chrome-app"
		go runCadenceServer(false)
		runChromeApp(chromePath, appUrl)
		return
	}

	RendererMode = "wails-stub"
	runWailsApp()
}

func runWailsApp() {
	log.Println("Wails support not compiled in. (Standard Go build)")
	log.Println("To run in browser mode, use: cadence --browser")
	
	// Don't block here, so Wails can finish its introspection during build.
	return
}
