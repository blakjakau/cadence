package main

import (
	"embed"
	"io/fs"
)

//go:embed app/*
//go:embed app/assets/*
//go:embed app/css/*
//go:embed app/images/*
//go:embed app/js/*
//go:embed app/ace/*
var appEmbedFS embed.FS

// getAppFS returns a filesystem that is rooted in the "app" directory of the embedded FS
func getAppFS() fs.FS {
	subFS, err := fs.Sub(appEmbedFS, "app")
	if err != nil {
		panic("Failed to get sub FS for embedded app: " + err.Error())
	}
	return subFS
}
