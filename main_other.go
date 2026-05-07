//go:build !darwin && !windows
// +build !darwin,!windows

package main

import (
	"github.com/webview/webview_go"
)

func main() {
	// 1. Initialize the server logic (parses flags internally)
	// We call it with block=false if we want to run the webview on the main thread.
	// But we need to know the flag state first. 
	// Since runCadenceServer handles flag.Parse(), we call it first.
	
	// Temporarily call it with block=true if browserFlag is set, 
	// or block=false if we want to proceed to webview.
	// However, we don't know browserFlag until runCadenceServer(false) returns.
	
	runCadenceServer(false)

	if browserFlag {
		// In browser mode, we need to block here because runCadenceServer(false) returned.
		// We'll just wait forever or until the process is killed.
		select {}
	} else {
		// Native Window Mode
		w := webview.New(false)
		defer w.Destroy()
		w.SetTitle("Cadence")
		w.SetSize(1280, 800, webview.HintNone)
		w.Navigate("http://localhost:" + port)
		w.Run()
	}
}
