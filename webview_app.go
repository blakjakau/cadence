package main

import (
	"log"

	"github.com/webview/webview_go"
)

// runWebviewApp launches the application using the lightweight webview_go renderer.
// This is an alternative to Wails, exposed via the --webview flag.
func runWebviewApp(url string) {
	log.Println("Launching webview_go renderer...")
	
	// Open a new webview instance in debug mode based on the global flag.
	// When true, you can right-click -> Inspect Element to open DevTools.
	w := webview.New(debugLogging)
	defer w.Destroy()

	w.SetTitle("Cadence")
	w.SetSize(1280, 800, webview.HintNone)
	w.Navigate(url)
	
	log.Println("Webview initialized. Waiting for window to close...")
	w.Run()
	log.Println("Webview window closed. Shutting down.")
}
