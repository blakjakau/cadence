#!/usr/bin/env bash

# Anchor to the repo root so dist/, the build-osx script, and `go build .`
# resolve correctly regardless of the caller's cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# Build tags to embed only the tree-sitter grammars we actually use.
# Without these, the `grammars` package embeds all 206 (~15 MB).
# With the subset tags we drop to ~2 MB (saves ~13 MB per binary).
GRAMMAR_TAGS="grammar_subset \
  grammar_subset_javascript grammar_subset_typescript grammar_subset_tsx \
  grammar_subset_go grammar_subset_python grammar_subset_rust \
  grammar_subset_c grammar_subset_cpp grammar_subset_c_sharp \
  grammar_subset_ruby grammar_subset_json grammar_subset_yaml \
  grammar_subset_html grammar_subset_css grammar_subset_sql \
  grammar_subset_markdown grammar_subset_markdown_inline"

# Define build functions for clarity
build_for_linux() {
  echo "build for ... linux amd64"
  mkdir -p dist
  # Prepend the project-local pkgconfig shim first: it bridges webkit2gtk-4.0 ->
  # webkit2gtk-4.1 (webview_go hard-requires the 4.0 .pc name). This keeps the
  # build working inside the sandbox, where $HOME is an ephemeral mount and the
  # user's ~/.pkgconfig shim is not visible.
  local pkg_path=""
  if [[ -d "$(pwd)/.pkgconfig" ]]; then pkg_path="$(pwd)/.pkgconfig:"; fi
  PKG_CONFIG_PATH="${pkg_path}${PKG_CONFIG_PATH}" GOOS=linux GOARCH=amd64 go build -tags "$GRAMMAR_TAGS" -ldflags="-s -w" -o dist/cadence-linux-x64 .
}

build_for_mac() {
  echo "--- Delegating macOS build and sign process to build-osx script ---"
  # Pass along any extra flags, like --no-recompile
  ./build-osx.sh "$1"
  if [ $? -ne 0 ]; then
    echo "Error: macOS remote build failed. Aborting."
    exit 1
  fi
}

build_for_windows() {
  echo "build for ... windows amd64"
  # The "-H windowsgui" flag builds the executable as a GUI application, preventing the console window from appearing.
  GOOS=windows GOARCH=amd64 CGO_ENABLED=1 go build -tags "$GRAMMAR_TAGS" -ldflags="-s -w -H windowsgui" -o dist/cadence-windows-x64.exe .;
}

# Initialize flags
BUILD_LINUX=0
BUILD_MAC=0
BUILD_WIN=0
NO_RECOMPILE_FLAG=""

# Default behavior: If no flags, detect current OS
if [ $# -eq 0 ]; then
  echo "No flags provided. Detecting current OS for default build..."
  case "$(uname -s)" in
    Linux)
      echo "Detected Linux. Building for Linux."
      BUILD_LINUX=1
      ;;
    Darwin)
      echo "Detected macOS. Building for macOS."
      BUILD_MAC=1
      ;;
    *)
      echo "Could not detect a default OS. Building for all platforms."
      BUILD_LINUX=1; BUILD_MAC=1; BUILD_WIN=1
      ;;
  esac
else
  # Parse command-line flags
  for arg in "$@"
  do
    case $arg in
      --all)   BUILD_LINUX=1; BUILD_MAC=1; BUILD_WIN=1 ;;
      --linux) BUILD_LINUX=1 ;;
      --mac)   BUILD_MAC=1 ;;
      --win)   BUILD_WIN=1 ;;
      --no-recompile) NO_RECOMPILE_FLAG="--no-recompile" ;;
      *)       echo "Unknown option: $arg"; echo "Usage: $0 [--all] [--linux] [--mac] [--win] [--no-recompile]"; exit 1 ;;
    esac
  done
fi

# Execute builds based on flags
if [ $BUILD_LINUX -eq 1 ]; then build_for_linux; fi
if [ $BUILD_WIN -eq 1 ]; then build_for_windows; fi
if [ $BUILD_MAC -eq 1 ]; then build_for_mac "$NO_RECOMPILE_FLAG"; fi

echo "Build process complete."
