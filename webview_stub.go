//go:build !webview

package main

import (
	"log"
	"time"
)

// runWebviewApp handles the --webview flag in builds without the optional
// webview_go renderer. It explains the missing support, falls back to the
// default browser, and blocks so the background server keeps running.
// Rebuild with `-tags webview` (requires webkit2gtk-4.0 and gtk+-3.0)
// to enable the embedded native window.
func runWebviewApp(url string) {
	log.Println("[webview] WebView renderer was not compiled into this build.")
	log.Println("[webview] Rebuild with `go build -tags webview` and install webkit2gtk-4.0 + gtk+-3.0 to enable it.")
	log.Println("[webview] Falling back to the default browser instead.")
	openBrowser(url)
	for {
		time.Sleep(time.Hour)
	}
}