package main

import (
	"log"

	"github.com/webview/webview_go"
)

// runWebviewApp launches the application using the lightweight webview_go renderer.
// This is exposed via the --webview flag.
func runWebviewApp(url string) {
	log.Println("Launching webview_go renderer...")
	
	// Open a new webview instance in debug mode based on the global flag.
	// When true, you can right-click -> Inspect Element to open DevTools.
	w := webview.New(debugLogging)
	defer w.Destroy()

	w.SetTitle("Cadence")
	w.SetSize(1280, 800, webview.HintNone)

	// Bind JS console logging to debug.log
	w.Bind("logFromJS", func(level, msg string) {
		log.Printf("[JS %s] %s", level, msg)
	})

	w.Init(`
		(function() {
			function sendToBackend(level, args) {
				try {
					const msg = Array.from(args).map(arg => {
						if (typeof arg === 'object') {
							try { return JSON.stringify(arg); } catch(e) { return String(arg); }
						}
						return String(arg);
					}).join(' ');
					window.logFromJS(level, msg);
				} catch(e) {}
			}

			// Override console methods without calling original handlers to prevent outputting to standard output
			console.log = function() {
				sendToBackend('LOG', arguments);
			};
			console.debug = function() {
				sendToBackend('DEBUG', arguments);
			};
			console.warn = function() {
				sendToBackend('WARN', arguments);
			};
			console.error = function() {
				sendToBackend('ERROR', arguments);
			};
			console.info = function() {
				sendToBackend('INFO', arguments);
			};
		})();
	`)

	w.Navigate(url)
	
	log.Println("Webview initialized. Waiting for window to close...")
	w.Run()
	log.Println("Webview window closed. Shutting down.")
}
