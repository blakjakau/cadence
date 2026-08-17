//go:build !plan9
// +build !plan9

package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"path/filepath"
	"strings"
	"time"
)

// This function now contains the core server logic, moved from main().
func runCadenceServer(block bool) {
	manageAPIKey(keyFlag)

	if installUserFlag {
		msg, err := InstallUser()
		log.Println(msg)
		if err != nil { os.Exit(1) }
		os.Exit(0)
	}
	if installServiceFlag {
		msg, err := InstallService()
		log.Println(msg)
		if err != nil { os.Exit(1) }
		os.Exit(0)
	}
	if uninstallFlag {
		msg, err := Uninstall()
		log.Println(msg)
		if err != nil { os.Exit(1) }
		os.Exit(0)
	} else if len(flag.Args()) > 0 && flag.Args()[0] == "kill" {
		log.Println("Shutting down Cadence via command line kill command.")
		os.Exit(0)
	}

	if rootFlag != "" {
		fileAPIRoot = rootFlag
	} else {
		homeDir, err := os.UserHomeDir()
		if err == nil { fileAPIRoot = homeDir } else { fileAPIRoot = "." }
	}
	go fileWatcher.run()
	updateLastActivity()
	if !noIdleShutdownFlag {
		go startIdleShutdownManager(60 * time.Minute)
	}
	startTime = time.Now()
	
	initWorkspaceManager() // Initialize workspace persistence

	mux := createServerMux()

	log.Printf("File API Root: %s", fileAPIRoot)
	log.Printf("Cadence v%s - listening for WS connections (localhost:%s)", version, port)
	log.Println("------------------------------------------------------------")

	if browserFlag && !headlessFlag {
		go func() {
			time.Sleep(500 * time.Millisecond)
			openBrowser("http://localhost:" + port + "/")
		}()
	}

	if block {
		err := startServer(":"+port, activityMiddleware(corsMiddleware(mux)))
		if err != nil {
			if browserFlag {
				log.Printf("Server likely already running (%v). Opening browser and exiting.", err)
				openBrowser("http://localhost:" + port + "/")
				os.Exit(0)
			}
			log.Fatal("startServer: ", err)
		}
	} else {
		// Start background server (needed for WebSockets in Native mode)
		go func() {
			err := startServer(":"+port, activityMiddleware(corsMiddleware(mux)))
			if err != nil {
				log.Println("startServer (async) Error: ", err)
			}
		}()
	}
}

func createServerMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/terminal", terminalServer)
	mux.HandleFunc("/up", upcheckHandler)
	mux.HandleFunc("/files", filesApiHandler)
	mux.HandleFunc("/api/config", appConfigHandler)
	mux.HandleFunc("/api/check-syntax", checkSyntaxHandler)
	mux.HandleFunc("/api/workspace", workspaceHandler)
	mux.HandleFunc("/api/session", sessionHandler)
	mux.HandleFunc("/api/sessions", sessionsHandler)
	mux.HandleFunc("/api/restart", restartHandler)
	mux.HandleFunc("/api/stop", stopHandler)
	mux.HandleFunc("/kill", installationHandler(killHandler))
	mux.HandleFunc("/install-service", installationHandler(InstallService))
	mux.HandleFunc("/uninstall", installationHandler(Uninstall))
	mux.HandleFunc("/install-user", installationHandler(InstallUser))

	mux.HandleFunc("/launch", func(w http.ResponseWriter, r *http.Request) {
		protocol := "web+cadence"
		if serveFlag != "" {
			protocol = "web+cadencedev"
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html>
<html>
<head>
	<title>Launching Cadence...</title>
	<script>
		window.location.href = "` + protocol + `://start";
		setTimeout(() => {
			window.location.href = "/";
		}, 300);
	</script>
</head>
<body style="background: #1e1e1e; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
	<h2>Launching Cadence...</h2>
</body>
</html>`))
	})

	if serveFlag != "" {
		log.Printf("Serving live frontend from: %s", serveFlag)
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.SetCookie(w, &http.Cookie{Name: "cadence_dev", Value: "true", Path: "/"})
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Expires", "0")
			http.FileServer(http.Dir(serveFlag)).ServeHTTP(w, r)
		}))
	} else {
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.SetCookie(w, &http.Cookie{Name: "cadence_dev", Value: "false", Path: "/", MaxAge: -1})
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Expires", "0")
			http.FileServer(http.FS(getAppFS())).ServeHTTP(w, r)
		}))
	}
	return mux
}

func parseFlags() {
	flag.BoolVar(&debugLogging, "debug", true, "Enable debug logging")
	flag.BoolVar(&keyFlag, "key", false, "Manage and print the API key for no-origin requests, then exit.")
	flag.BoolVar(&installUserFlag, "install-user", false, "Install Cadence as a user-level application and protocol handler.")
	flag.BoolVar(&installServiceFlag, "install-service", false, "Install Cadence as a systemd service (requires root).")
	flag.BoolVar(&uninstallFlag, "uninstall", false, "Uninstall user and/or system Cadence installations.")
	flag.StringVar(&rootFlag, "root", "", "Set the root directory for the file API (defaults to user's home directory).")
	flag.BoolVar(&noIdleShutdownFlag, "no-idle-shutdown", true, "Disable automatic shutdown due to inactivity. Recommended for services.")
	flag.StringVar(&serveFlag, "serve", "", "Serve live static files from this directory instead of embedded assets.")
	flag.BoolVar(&browserFlag, "browser", false, "Open in the default browser instead of a native window.")
	flag.BoolVar(&webviewFlag, "webview", false, "Open using the lightweight webview_go renderer instead of Wails.")
	flag.BoolVar(&wailsFlag, "wails", false, "Force opening using the Wails rendering engine (if compiled).")
	flag.BoolVar(&headlessFlag, "headless", false, "Run in headless mode (no UI or browser launch).")
	flag.Parse()

	if serveFlag != "" {
		port = "3023"
	}

	if keyFlag {
		manageAPIKey(keyFlag)
		os.Exit(0)
	}

	initLogging()
}

func initLogging() {
	configDir, err := os.UserConfigDir()
	if err == nil {
		appConfigDir := filepath.Join(configDir, "cadence")
		os.MkdirAll(appConfigDir, 0700)
		logPath := filepath.Join(appConfigDir, "debug.log")
		// Open the file with O_TRUNC to wipe it fresh on each launch
		file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0666)
		if err == nil {
			log.SetOutput(file)
			log.Println("--- Cadence Session Started ---")
		} else {
			log.Printf("Failed to open debug.log: %v", err)
		}
	}
}

// Global variables remain accessible
const version = "0.1.2"
var port = "3022"
var allowedOrigins = map[string]bool{
	"https://cadence.jakbox.dev": true,
	"https://cadence.jakbox.net": true,
	"https://code.jakbox.dev": true,
	"https://code.jakbox.net": true,
	"http://localhost:8083":  true,
	"http://localhost:3022":  true,
	"http://localhost:3023":  true,
	"http://localhost":       true,
	"http://wails.localhost": true,
	"wails://wails.localhost": true,
	"wails://wails": true,
	"wails://": true,
	"http://127.0.0.1:3022": true,
	"http://127.0.0.1:3023": true,
}
var rootFlag string
var serveFlag string
var browserFlag bool
var webviewFlag bool
var wailsFlag bool
var headlessFlag bool
var RendererMode string = "unknown"
var keyFlag bool
var installUserFlag bool
var installServiceFlag bool
var uninstallFlag bool
var noIdleShutdownFlag bool
var debugLogging bool = true
var requiredAPIKey string
var isCompiledBuild bool
var fileAPIRoot string
var lastActivityTimestamp atomic.Int64
// (Keep all your other helper functions like updateLastActivity, etc., here too)
// --- Helper Functions ---
func getIsCompiled() {
	exePath, err := os.Executable()
	if err != nil {
		log.Printf("Warning: Could not determine executable path: %v", err)
	} else {
		exeName := filepath.Base(exePath)
		isCompiledBuild = strings.HasPrefix(exeName, "cadence-") || exeName == "cadence" || exeName == "cadence.exe"
	}
}
func updateLastActivity() {
	lastActivityTimestamp.Store(time.Now().Unix())
}
func activityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		updateLastActivity()
		next.ServeHTTP(w, r)
	})
}
// corsMiddleware adds the necessary headers to handle CORS requests.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Cadence-Key")
		}
		// Handle preflight requests by immediately returning.
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func startIdleShutdownManager(timeout time.Duration) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		if atomic.LoadInt32(&activeConnections) == 0 {
			lastActivity := lastActivityTimestamp.Load()
			idleDuration := time.Since(time.Unix(lastActivity, 0))
			if idleDuration >= timeout {
				log.Printf("Shutting down due to inactivity for over %v.", timeout)
				os.Exit(0)
			}
		}
	}
}
func installationHandler(handlerFunc func() (string, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		remoteIP, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
		if remoteIP != "127.0.0.1" && remoteIP != "::1" {
			log.Printf("[SECURITY] Denied installation request from remote address: %s", r.RemoteAddr)
			http.Error(w, "Forbidden: Installation actions are only allowed from localhost.", http.StatusForbidden)
			return
		}
		msg, err := handlerFunc()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if err != nil {
			http.Error(w, msg, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(msg))
	}
}
func killHandler() (string, error) {
	if noIdleShutdownFlag {
		return "Kill command is disabled when running with --no-idle-shutdown.", fmt.Errorf("kill command disabled")
	}
	log.Println("Received /kill request. Shutting down application.")
	go func() { time.Sleep(100 * time.Millisecond); os.Exit(0) }()
	return "Cadence server is shutting down.", nil
}

var mainServer *http.Server

func startServer(addr string, handler http.Handler) error {
	var listener net.Listener
	var err error

	for i := 0; i < 30; i++ { // Try for up to 3 seconds
		listener, err = net.Listen("tcp", addr)
		if err == nil {
			break
		}
		log.Printf("Port %s is busy, retrying in 100ms... (%d/30)", addr, i+1)
		time.Sleep(100 * time.Millisecond)
	}

	if err != nil {
		return err
	}

	mainServer = &http.Server{
		Addr:    addr,
		Handler: handler,
	}

	return mainServer.Serve(listener)
}

func restartHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	log.Println("Received /api/restart request. Preparing to restart server...")

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"restarting"}`))

	go func() {
		time.Sleep(250 * time.Millisecond)
		restartProcess()
	}()
}

func stopHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	log.Println("Received /api/stop request. Shutting down server...")

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"stopping"}`))

	go func() {
		time.Sleep(250 * time.Millisecond)
		log.Println("Exiting process.")
		os.Exit(0)
	}()
}

func restartProcess() {
	log.Println("Relaunching process...")

	argv0, err := exec.LookPath(os.Args[0])
	if err != nil {
		log.Printf("Failed to find path of executable: %v", err)
		os.Exit(1)
	}

	// Filter out browser/webview/wails flags and force --headless flag
	var args []string
	for _, arg := range os.Args[1:] {
		if arg == "--browser" || arg == "-browser" ||
			arg == "--webview" || arg == "-webview" ||
			arg == "--wails" || arg == "-wails" ||
			arg == "--headless" || arg == "-headless" {
			continue
		}
		args = append(args, arg)
	}
	args = append(args, "--headless")

	var cmd *exec.Cmd
	if strings.Contains(argv0, "go-build") || strings.Contains(argv0, "/tmp/") {
		goBin, err := exec.LookPath("go")
		wd, wdErr := os.Getwd()
		if err == nil && wdErr == nil {
			log.Println("Detected 'go run' execution. Relaunching via 'go run .'")
			runArgs := append([]string{"run", "."}, args...)
			cmd = exec.Command(goBin, runArgs...)
			cmd.Dir = wd
		}
	}

	if cmd == nil {
		cmd = exec.Command(argv0, args...)
	}

	configureCmdForRestart(cmd)
	cmd.Env = os.Environ()

	err = cmd.Start()
	if err != nil {
		log.Printf("Failed to start child process: %v", err)
		os.Exit(1)
	}

	log.Printf("Child process started with PID %d, exiting current process.", cmd.Process.Pid)
	os.Exit(0)
}

func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "linux":
		err = exec.Command("xdg-open", url).Start()
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default:
		err = fmt.Errorf("unsupported platform")
	}
	if err != nil {
		log.Printf("Failed to open browser: %v", err)
	}
}