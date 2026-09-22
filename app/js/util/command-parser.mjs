/**
 * command-parser.mjs
 *
 * Pure, dependency-free shell command-line parser for auditing `run_command`
 * invocations. No DOM access — importable by the browser app and by Node
 * (e.g. `node tests/command-parser.test.mjs`).
 *
 * Public API:
 *   parseCommandLine(cmd)  -> { segments, programs, warnings, stats }
 *   extractPrograms(cmd)   -> [programName, ...]  (flat, ordered, deduped)
 *   classifyProgram(name)  -> { category: "safe"|"moderate"|"dangerous", reason }
 *
 * The parser is intentionally conservative: it is not a full POSIX shell
 * implementation. It performs a quote/escape-aware single pass that:
 *   - splits the line into segments on top-level `;` `&&` `||` `|` `&` and
 *     newlines,
 *   - understands `$( )`, backticks and `${ }` substitutions (recurses into
 *     them for program extraction),
 *   - detects heredocs (`<<`), comments, redirects and background `&`,
 *   - strips redirects/annotations when extracting the program + args.
 */

// ---------------------------------------------------------------------------
// Program classification catalog
// ---------------------------------------------------------------------------

/**
 * Built-in risk catalog. Ordered matters: first matching entry wins.
 * Each entry: { name: string, category: "safe"|"moderate"|"dangerous", reason: string }
 */
const CATALOG = [
    // --- dangerous: destructive / system-level -----------------------------
    { name: "rm",            category: "dangerous", reason: "Recursively/permanently deletes files; `rm -rf` on the wrong path is unrecoverable." },
    { name: "rmdir",         category: "dangerous", reason: "Removes directories." },
    { name: "dd",            category: "dangerous", reason: "Raw block-level writes; can destroy disks (`dd if=/dev/zero of=/dev/sda`)." },
    { name: "mkfs",          category: "dangerous", reason: "Formats a filesystem, destroying all data on the target." },
    { name: "fdisk",         category: "dangerous", reason: "Partitions a disk; can destroy existing data." },
    { name: "parted",        category: "dangerous", reason: "Partitions a disk; can destroy existing data." },
    { name: "shred",         category: "dangerous", reason: "Securely overwrites and deletes files." },
    { name: "wipefs",        category: "dangerous", reason: "Wipes filesystem signatures." },
    { name: "mkswap",        category: "dangerous", reason: "Creates a swap area, overwriting the target." },
    { name: "swapon",        category: "dangerous", reason: "Activates swap devices." },
    { name: "shutdown",      category: "dangerous", reason: "Shuts down or reboots the host." },
    { name: "reboot",        category: "dangerous", reason: "Reboots the host." },
    { name: "halt",          category: "dangerous", reason: "Halts the host." },
    { name: "poweroff",      category: "dangerous", reason: "Powers off the host." },
    { name: "init",          category: "dangerous", reason: "System init; can change runlevels." },
    { name: "systemctl",     category: "dangerous", reason: "Starts/stops system services; can disrupt the host." },
    { name: "service",       category: "dangerous", reason: "Starts/stops system services." },
    { name: "mount",         category: "dangerous", reason: "Mounts filesystems; can mount over existing data." },
    { name: "umount",        category: "dangerous", reason: "Unmounts filesystems." },
    { name: "chmod",         category: "dangerous", reason: "Changes permissions; `chmod -R 777` exposes files to all users." },
    { name: "chown",         category: "dangerous", reason: "Changes ownership; recursive use can break system state." },
    { name: "chgrp",         category: "dangerous", reason: "Changes group ownership." },
    { name: "kill",          category: "dangerous", reason: "Sends signals to processes; `kill -9` force-kills without cleanup." },
    { name: "killall",       category: "dangerous", reason: "Kills all processes matching a name." },
    { name: "pkill",         category: "dangerous", reason: "Kills processes matching a pattern." },
    { name: "sudo",          category: "dangerous", reason: "Elevates privileges; the *next* program is what actually runs." },
    { name: "su",            category: "dangerous", reason: "Switches user; grants another user's privileges." },
    { name: "useradd",       category: "dangerous", reason: "Creates a system user." },
    { name: "userdel",       category: "dangerous", reason: "Deletes a system user." },
    { name: "usermod",       category: "dangerous", reason: "Modifies a system user." },
    { name: "passwd",        category: "dangerous", reason: "Changes passwords." },
    { name: "visudo",        category: "dangerous", reason: "Edits sudoers; a mistake locks you out." },
    { name: "iptables",      category: "dangerous", reason: "Modifies firewall rules; can lock out network access." },
    { name: "ip",            category: "moderate",    reason: "Network configuration; some subcommands are destructive." },
    { name: "ifconfig",      category: "moderate",    reason: "Network interface configuration." },
    { name: "crontab",       category: "dangerous", reason: "Installs cron jobs; persists actions across reboots." },
    { name: "at",            category: "moderate",    reason: "Schedules one-shot jobs." },
    { name: "curl",          category: "moderate",    reason: "Downloads/executes remote content; `curl | sh` is a classic install vector." },
    { name: "wget",          category: "moderate",    reason: "Downloads remote content; may be piped to a shell." },
    { name: "nc",            category: "dangerous", reason: "Netcat; can open arbitrary network connections." },
    { name: "ncat",          category: "dangerous", reason: "Netcat; can open arbitrary network connections." },
    { name: "ssh",           category: "moderate",    reason: "Remote access; can run commands on other hosts." },
    { name: "scp",           category: "moderate",    reason: "Copies files to/from remote hosts." },
    { name: "rsync",         category: "moderate",    reason: "Syncs files; `--delete` is destructive." },
    { name: "docker",        category: "moderate",    reason: "Container management; `docker system prune -a` removes all unused images/containers." },
    { name: "kubectl",       category: "moderate",    reason: "Kubernetes control; can delete deployments/namespaces." },
    { name: "helm",          category: "moderate",    reason: "Kubernetes package management." },
    { name: "git",           category: "moderate",    reason: "VCS; `git push --force` / `git reset --hard` can destroy history or work." },
    { name: "hg",            category: "moderate",    reason: "VCS." },
    { name: "svn",           category: "moderate",    reason: "VCS." },
    { name: "npm",           category: "moderate",    reason: "Runs arbitrary lifecycle scripts from the registry." },
    { name: "yarn",          category: "moderate",    reason: "Runs arbitrary lifecycle scripts from the registry." },
    { name: "pnpm",          category: "moderate",    reason: "Runs arbitrary lifecycle scripts from the registry." },
    { name: "pip",           category: "moderate",    reason: "Installs Python packages; runs install scripts." },
    { name: "pip3",          category: "moderate",    reason: "Installs Python packages; runs install scripts." },
    { name: "go",            category: "moderate",    reason: "Go toolchain; `go run`/`go install` compile and run code." },
    { name: "cargo",         category: "moderate",    reason: "Rust toolchain; builds and runs code." },
    { name: "make",          category: "moderate",    reason: "Build system; runs arbitrary recipe commands." },
    { name: "cmake",         category: "moderate",    reason: "Build system; runs arbitrary recipe commands." },
    { name: "gradle",        category: "moderate",    reason: "Build system; runs arbitrary task code." },
    { name: "mvn",           category: "moderate",    reason: "Build system; runs arbitrary plugin code." },
    { name: "node",          category: "moderate",    reason: "Executes JavaScript; `node -e` runs inline code." },
    { name: "python",        category: "moderate",    reason: "Executes Python; `python -c` runs inline code." },
    { name: "python3",       category: "moderate",    reason: "Executes Python; `python3 -c` runs inline code." },
    { name: "ruby",          category: "moderate",    reason: "Executes Ruby; `ruby -e` runs inline code." },
    { name: "perl",          category: "moderate",    reason: "Executes Perl; `perl -e` runs inline code." },
    { name: "php",           category: "moderate",    reason: "Executes PHP; `php -r` runs inline code." },
    { name: "lua",           category: "moderate",    reason: "Executes Lua." },
    { name: "bash",          category: "moderate",    reason: "Shell; can run arbitrary commands, often receives piped scripts." },
    { name: "sh",            category: "moderate",    reason: "Shell; can run arbitrary commands, often receives piped scripts." },
    { name: "zsh",           category: "moderate",    reason: "Shell; can run arbitrary commands." },
    { name: "dash",          category: "moderate",    reason: "Shell; can run arbitrary commands." },
    { name: "ksh",           category: "moderate",    reason: "Shell; can run arbitrary commands." },
    { name: "source",        category: "moderate",    reason: "Sources a script in the current shell." },
    { name: "eval",          category: "dangerous", reason: "Evaluates arbitrary strings as shell code." },
    { name: "exec",          category: "moderate",    reason: "Replaces the shell with a program." },
    { name: "env",           category: "safe",        reason: "Runs a program with a modified environment (wrapper)." },
    { name: "nohup",         category: "safe",        reason: "Runs a program ignoring SIGHUP (wrapper)." },
    { name: "nice",          category: "safe",        reason: "Runs a program with a modified priority (wrapper)." },
    { name: "ionice",        category: "safe",        reason: "Runs a program with a modified I/O priority (wrapper)." },
    { name: "timeout",       category: "safe",        reason: "Runs a program with a timeout (wrapper)." },
    { name: "xargs",         category: "moderate",    reason: "Executes a program per input line; the *next* program is what actually runs." },
    { name: "find",          category: "moderate",    reason: "File search; `-exec`/`-delete` run arbitrary actions." },
    { name: "tee",           category: "safe",        reason: "Writes stdin to files and stdout." },
    { name: "awk",           category: "moderate",    reason: "Text processing; can invoke `system()` for shell commands." },
    { name: "sed",           category: "moderate",    reason: "Text processing; `-i` edits files in place." },
    { name: "grep",          category: "safe",        reason: "Searches text." },
    { name: "rg",            category: "safe",        reason: "Searches text (ripgrep)." },
    { name: "cat",           category: "safe",        reason: "Prints file contents." },
    { name: "head",          category: "safe",        reason: "Prints the start of files." },
    { name: "tail",          category: "safe",        reason: "Prints the end of files." },
    { name: "less",          category: "safe",        reason: "Paged viewer." },
    { name: "more",          category: "safe",        reason: "Paged viewer." },
    { name: "ls",            category: "safe",        reason: "Lists directory contents." },
    { name: "dir",           category: "safe",        reason: "Lists directory contents." },
    { name: "tree",          category: "safe",        reason: "Prints a directory tree." },
    { name: "stat",          category: "safe",        reason: "Prints file metadata." },
    { name: "file",          category: "safe",        reason: "Identifies file types." },
    { name: "which",         category: "safe",        reason: "Locates executables." },
    { name: "whereis",       category: "safe",        reason: "Locates executables." },
    { name: "type",          category: "safe",        reason: "Shows how a command is interpreted." },
    { name: "echo",          category: "safe",        reason: "Prints text." },
    { name: "printf",        category: "safe",        reason: "Prints formatted text." },
    { name: "true",          category: "safe",        reason: "No-op; always succeeds." },
    { name: "false",         category: "safe",        reason: "No-op; always fails." },
    { name: "test",          category: "safe",        reason: "Evaluates a condition." },
    { name: "[",             category: "safe",        reason: "Evaluates a condition (test builtin)." },
    { name: ":",             category: "safe",        reason: "Shell no-op builtin." },
    { name: "pwd",           category: "safe",        reason: "Prints the working directory." },
    { name: "cd",            category: "safe",        reason: "Changes the working directory." },
    { name: "export",        category: "safe",        reason: "Exports shell variables." },
    { name: "unset",         category: "safe",        reason: "Unsets shell variables." },
    { name: "set",           category: "safe",        reason: "Sets shell options." },
    { name: "alias",         category: "safe",        reason: "Manages shell aliases." },
    { name: "history",       category: "safe",        reason: "Shows shell history." },
    { name: "man",           category: "safe",        reason: "Shows manual pages." },
    { name: "help",          category: "safe",        reason: "Shows shell help." },
    { name: "uname",         category: "safe",        reason: "Prints system information." },
    { name: "whoami",        category: "safe",        reason: "Prints the current user." },
    { name: "id",            category: "safe",        reason: "Prints user/group IDs." },
    { name: "hostname",      category: "safe",        reason: "Prints the hostname." },
    { name: "uptime",        category: "safe",        reason: "Prints system uptime." },
    { name: "date",          category: "safe",        reason: "Prints/sets the date (setting requires root)." },
    { name: "df",            category: "safe",        reason: "Prints disk usage." },
    { name: "du",            category: "safe",        reason: "Prints disk usage." },
    { name: "free",          category: "safe",        reason: "Prints memory usage." },
    { name: "ps",            category: "safe",        reason: "Lists processes." },
    { name: "top",           category: "safe",        reason: "Shows process usage." },
    { name: "htop",          category: "safe",        reason: "Shows process usage." },
    { name: "lsof",          category: "safe",        reason: "Lists open files/sockets." },
    { name: "netstat",       category: "safe",        reason: "Shows network statistics." },
    { name: "ss",            category: "safe",        reason: "Shows socket statistics." },
    { name: "ping",          category: "safe",        reason: "Sends ICMP echo requests." },
    { name: "traceroute",    category: "safe",        reason: "Traces a network route." },
    { name: "dig",           category: "safe",        reason: "DNS lookup." },
    { name: "nslookup",      category: "safe",        reason: "DNS lookup." },
    { name: "host",          category: "safe",        reason: "DNS lookup." },
    { name: "whois",         category: "safe",        reason: "Looks up domain registration." },
    { name: "mv",            category: "moderate",    reason: "Moves/renames files; overwrites by default." },
    { name: "cp",            category: "moderate",    reason: "Copies files; overwrites by default." },
    { name: "ln",            category: "moderate",    reason: "Creates links; can overwrite targets." },
    { name: "mkdir",         category: "safe",        reason: "Creates directories." },
    { name: "touch",         category: "safe",        reason: "Creates empty files / updates timestamps." },
    { name: "tar",           category: "moderate",    reason: "Archives; `tar -x` can overwrite files (path traversal risk)." },
    { name: "zip",           category: "safe",        reason: "Compresses files." },
    { name: "unzip",         category: "moderate",    reason: "Extracts archives; can overwrite files." },
    { name: "gunzip",        category: "safe",        reason: "Decompresses files." },
    { name: "gzip",          category: "safe",        reason: "Compresses files." },
    { name: "bzip2",         category: "safe",        reason: "Compresses files." },
    { name: "7z",            category: "moderate",    reason: "Archives; can overwrite files." },
    { name: "patch",         category: "moderate",    reason: "Applies diffs; can modify many files." },
    { name: "diff",          category: "safe",        reason: "Compares files." },
    { name: "wc",            category: "safe",        reason: "Counts lines/words/bytes." },
    { name: "sort",          category: "safe",        reason: "Sorts lines." },
    { name: "uniq",          category: "safe",        reason: "Filters adjacent duplicate lines." },
    { name: "cut",           category: "safe",        reason: "Cuts out sections of each line." },
    { name: "tr",            category: "safe",        reason: "Translates characters." },
    { name: "xargs",         category: "moderate",    reason: "Executes a program per input line." },
    { name: "watch",         category: "safe",        reason: "Runs a command repeatedly." },
    { name: "time",          category: "safe",        reason: "Times a command." },
    { name: "sleep",         category: "safe",        reason: "Delays execution for a number of seconds." },
    { name: "xxd",           category: "safe",        reason: "Prints a hex dump of a file." },
    { name: "od",            category: "safe",        reason: "Prints a byte/octal dump of a file." },
    { name: "strings",       category: "safe",        reason: "Extracts printable strings from a file." },
    { name: "sha256sum",     category: "safe",        reason: "Prints a SHA-256 checksum." },
    { name: "md5sum",        category: "safe",        reason: "Prints an MD5 checksum." },
    { name: "cmp",           category: "safe",        reason: "Compares files byte-by-byte." },
    { name: "jq",            category: "safe",        reason: "Processes JSON with queries." },
    { name: "yq",            category: "safe",        reason: "Processes YAML with queries." },
    { name: "ulimit",        category: "safe",        reason: "Shows/sets shell resource limits." },
    { name: "jobs",          category: "safe",        reason: "Lists background jobs." },
    { name: "fg",            category: "safe",        reason: "Brings a background job to the foreground." },
    { name: "bg",            category: "safe",        reason: "Resumes a stopped job in the background." },
    { name: "wait",          category: "safe",        reason: "Waits for background jobs." },
    { name: "disown",        category: "safe",        reason: "Removes a job from the shell's job table." },
    { name: "trap",          category: "safe",        reason: "Handles shell signals." },
    { name: "read",          category: "safe",        reason: "Reads a line from stdin." },
    { name: "let",           category: "safe",        reason: "Arithmetic evaluation." },
    { name: "declare",       category: "safe",        reason: "Declares shell variables." },
    { name: "local",         category: "safe",        reason: "Declares local variables." },
    { name: "return",        category: "safe",        reason: "Returns from a function." },
    { name: "exit",          category: "safe",        reason: "Exits the shell." },
    { name: "break",         category: "safe",        reason: "Breaks out of a loop." },
    { name: "continue",      category: "safe",        reason: "Continues a loop." },
    { name: "case",          category: "safe",        reason: "Case statement." },
    { name: "if",            category: "safe",        reason: "Conditional statement." },
    { name: "for",           category: "safe",        reason: "Loop statement." },
    { name: "while",         category: "safe",        reason: "Loop statement." },
    { name: "do",            category: "safe",        reason: "Starts a loop or conditional body." },
    { name: "done",          category: "safe",        reason: "Ends a loop or conditional body." },
    { name: "then",          category: "safe",        reason: "Introduces the body of a conditional." },
    { name: "else",          category: "safe",        reason: "Conditional else branch." },
    { name: "elif",          category: "safe",        reason: "Conditional else-if branch." },
    { name: "fi",            category: "safe",        reason: "Ends a conditional statement." },
    { name: "until",         category: "safe",        reason: "Loop statement." },
    { name: "function",      category: "safe",        reason: "Function definition." },
    { name: "select",        category: "safe",        reason: "Select statement." },
    { name: "getopts",       category: "safe",        reason: "Parses shell options." },
    { name: "shopt",         category: "safe",        reason: "Sets shell options." },
    { name: "builtin",       category: "safe",        reason: "Runs a shell builtin." },
    { name: "enable",        category: "safe",        reason: "Enables shell builtins." },
    { name: "disable",       category: "safe",        reason: "Disables shell builtins." },
    { name: "command",       category: "safe",        reason: "Runs a command, bypassing functions." },
    { name: "hash",          category: "safe",        reason: "Caches command paths." },
    { name: "type",          category: "safe",        reason: "Shows how a command is interpreted." },
    { name: "compgen",       category: "safe",        reason: "Completion generation." },
    { name: "complete",      category: "safe",        reason: "Completion configuration." },
    { name: "bind",          category: "safe",        reason: "Readline key bindings." },
    { name: "fc",            category: "safe",        reason: "Fixes/edits shell history." },
    { name: "history",       category: "safe",        reason: "Shows shell history." },
    { name: "logout",        category: "safe",        reason: "Exits a login shell." },
    { name: "mapfile",       category: "safe",        reason: "Reads lines into an array." },
    { name: "readarray",     category: "safe",        reason: "Reads lines into an array." },
    { name: "shuf",          category: "safe",        reason: "Shuffles lines." },
    { name: "split",         category: "safe",        reason: "Splits files." },
    { name: "paste",         category: "safe",        reason: "Merges lines." },
    { name: "pr",            category: "safe",        reason: "Formats for printing." },
    { name: "column",        category: "safe",        reason: "Formats into columns." },
    { name: "fmt",           category: "safe",        reason: "Formats text." },
    { name: "fold",          category: "safe",        reason: "Folds long lines." },
    { name: "nl",            category: "safe",        reason: "Numbers lines." },
    { name: "expand",        category: "safe",        reason: "Converts tabs to spaces." },
    { name: "unexpand",      category: "safe",        reason: "Converts spaces to tabs." },
    { name: "seq",           category: "safe",        reason: "Prints a sequence of numbers." },
    { name: "yes",           category: "safe",        reason: "Prints a string repeatedly." },
    { name: "losetup",       category: "dangerous", reason: "Sets up loop devices." },
    { name: "mknod",         category: "dangerous", reason: "Creates special files." },
    { name: "insmod",        category: "dangerous", reason: "Inserts a kernel module." },
    { name: "rmmod",         category: "dangerous", reason: "Removes a kernel module." },
    { name: "modprobe",      category: "dangerous", reason: "Loads a kernel module." },
    { name: "sysctl",        category: "dangerous", reason: "Modifies kernel parameters." },
    { name: "syslog",        category: "safe",        reason: "Logs to syslog." },
    { name: "journalctl",    category: "safe",        reason: "Shows journal logs." },
    { name: "dmesg",         category: "safe",        reason: "Shows kernel messages." },
    { name: "strace",        category: "moderate",    reason: "Traces system calls; can attach to processes." },
    { name: "ltrace",        category: "moderate",    reason: "Traces library calls; can attach to processes." },
    { name: "gdb",           category: "moderate",    reason: "Debugger; can attach to processes." },
    { name: "valgrind",      category: "moderate",    reason: "Runs a program under a memory checker." },
    { name: "perf",          category: "moderate",    reason: "Performance profiling; can attach to processes." },
    { name: "tcpdump",       category: "moderate",    reason: "Captures network traffic." },
    { name: "tshark",        category: "moderate",    reason: "Captures network traffic." },
    { name: "wireshark",     category: "moderate",    reason: "Captures network traffic." },
    { name: "nmap",          category: "moderate",    reason: "Scans hosts/services." },
    { name: "masscan",       category: "dangerous", reason: "Very fast port scanner; can be used for abuse." },
    { name: "hydra",         category: "dangerous", reason: "Password cracking tool." },
    { name: "john",          category: "dangerous", reason: "Password cracking tool." },
    { name: "hashcat",       category: "dangerous", reason: "Password cracking tool." },
    { name: "sqlmap",        category: "dangerous", reason: "SQL injection tool." },
    { name: "metasploit",    category: "dangerous", reason: "Exploitation framework." },
    { name: "msfconsole",    category: "dangerous", reason: "Exploitation framework." },
    { name: "aircrack-ng",   category: "dangerous", reason: "WiFi cracking tool." },
    { name: "wifite",        category: "dangerous", reason: "WiFi cracking tool." },
    { name: "ettercap",      category: "dangerous", reason: "Network sniffing/spoofing tool." },
    { name: "mitmproxy",     category: "moderate",    reason: "Man-in-the-middle proxy." },
    { name: "lynx",          category: "safe",        reason: "Text browser." },
    { name: "w3m",           category: "safe",        reason: "Text browser." },
    { name: "elinks",        category: "safe",        reason: "Text browser." },
    { name: "vim",           category: "moderate",    reason: "Editor; can execute shell commands (`:!`)." },
    { name: "vi",            category: "moderate",    reason: "Editor; can execute shell commands (`:!`)." },
    { name: "nano",          category: "moderate",    reason: "Editor; can execute shell commands (`^R^X`)." },
    { name: "emacs",         category: "moderate",    reason: "Editor; can execute shell commands." },
    { name: "code",          category: "moderate",    reason: "Editor; can execute shell commands." },
    { name: "atop",          category: "safe",        reason: "System activity viewer." },
    { name: "vmstat",        category: "safe",        reason: "Reports virtual memory statistics." },
    { name: "iostat",        category: "safe",        reason: "Reports I/O statistics." },
    { name: "sar",           category: "safe",        reason: "Reports system activity." },
    { name: "mpstat",        category: "safe",        reason: "Reports per-processor statistics." },
    { name: "pidstat",       category: "safe",        reason: "Reports per-process statistics." },
    { name: "smem",          category: "safe",        reason: "Reports memory usage." },
    { name: "psmisc",        category: "safe",        reason: "Process utilities." },
    { name: "pstree",        category: "safe",        reason: "Shows a process tree." },
    { name: "pgrep",         category: "safe",        reason: "Finds processes matching a pattern." },
    { name: "pidof",         category: "safe",        reason: "Finds PIDs of a program." },
    { name: "fuser",         category: "moderate",    reason: "Shows which processes use a file; can kill them." },
    { name: "ifstat",        category: "safe",        reason: "Reports interface statistics." },
    { name: "vnstat",        category: "safe",        reason: "Reports network traffic." },
    { name: "iftop",         category: "safe",        reason: "Reports per-host traffic." },
    { name: "nethogs",       category: "safe",        reason: "Reports per-process traffic." },
    { name: "bandwidth",     category: "safe",        reason: "Reports bandwidth usage." },
    { name: "tc",            category: "dangerous", reason: "Traffic control; can shape/throttle network." },
    { name: "nft",           category: "dangerous", reason: "Modifies firewall rules (nftables)." },
    { name: "nftables",      category: "dangerous", reason: "Modifies firewall rules (nftables)." },
    { name: "ip6tables",     category: "dangerous", reason: "Modifies IPv6 firewall rules." },
    { name: "firewalld",     category: "dangerous", reason: "Modifies firewall rules." },
    { name: "ufw",           category: "dangerous", reason: "Modifies firewall rules." },
    { name: "rsyslogd",      category: "moderate",    reason: "Syslog daemon." },
    { name: "syslog-ng",     category: "moderate",    reason: "Syslog daemon." },
    { name: "cron",          category: "moderate",    reason: "Cron daemon." },
    { name: "crond",         category: "moderate",    reason: "Cron daemon." },
    { name: "atd",           category: "moderate",    reason: "At daemon." },
    { name: "anacron",       category: "moderate",    reason: "Cron-like scheduler." },
    { name: "systemd",       category: "moderate",    reason: "System daemon." },
    { name: "systemd-analyze", category: "safe",      reason: "Analyzes systemd startup." },
    { name: "kern.log",      category: "safe",        reason: "Kernel log." },
    { name: "logger",        category: "safe",        reason: "Sends messages to syslog." },
    { name: "logrotate",     category: "moderate",    reason: "Rotates log files." },
    { name: "logwatch",      category: "safe",        reason: "Summarizes log files." },
    { name: "fail2ban",      category: "moderate",    reason: "Bans IP addresses." },
];

/**
 * Classifies a program name into a risk category.
 * Programs not in the catalog are treated as HIGH risk (fail-closed): an
 * unrecognized program could be anything, so it is surfaced as dangerous with
 * an explanatory reason that UI can use as a tooltip.
 * @param {string} name
 * @returns {{category: "safe"|"moderate"|"dangerous", reason: string}}
 */
export function classifyProgram(name) {
    const key = String(name || "").toLowerCase().trim();
    const base = key.split("/").pop(); // strip any path prefix
    const entry = CATALOG.find(e => e.name === base) || CATALOG.find(e => e.name === key);
    if (entry) return { category: entry.category, reason: entry.reason };
    return { category: "dangerous", reason: "High risk because this program is unknown" };
}

// ---------------------------------------------------------------------------
// Tokenizer / scanner
// ---------------------------------------------------------------------------

/**
 * Single-pass scanner over a command line.
 *
 * Produces a flat list of "events" describing the top-level structure:
 *   { kind: "word", text, quoted }          — a top-level word
 *   { kind: "sep",  text }                  — a top-level separator (; && || | & \n)
 *   { kind: "redirect", text }              — a top-level redirect (>, >>, <, 2>, ...)
 *   { kind: "comment", text }               — a top-level # comment
 *   { kind: "heredoc", delimiter, text }    — a heredoc body
 *
 * Substitutions `$( ... )` and backticks are captured as *inline* events so
 * the caller can recurse into them.
 *
 * @param {string} cmd
 * @returns {Array<object>}
 */
function scanTopLevel(cmd) {
    const events = [];
    const n = cmd.length;
    let i = 0;
    let word = "";
    let wordHasQuote = false;
    let wordStart = -1; // index of the first char of the current word
    let subStack = []; // stack of { type: "dollar"|"backtick", depth }

    const flushWord = () => {
        if (word.length > 0) {
            // `end` is the index just past the last word char (exclusive).
            events.push({ kind: "word", text: word, quoted: wordHasQuote, start: wordStart, end: i });
            word = "";
            wordHasQuote = false;
            wordStart = -1;
        }
    };

    // Record the start of a word on the first character added.
    const ensureWordStart = () => {
        if (wordStart === -1) wordStart = i;
    };

    while (i < n) {
        const c = cmd[i];
        const next = i + 1 < n ? cmd[i + 1] : "";

        // --- inside a substitution? -------------------------------------
        if (subStack.length > 0) {
            const top = subStack[subStack.length - 1];
            if (top.type === "dollar") {
                // `$( ... )` — track nested parens; the outer `$(` is already
                // captured, so we just need to find the matching `)`.
                if (c === "(") top.depth++;
                else if (c === ")") {
                    if (top.depth === 0) {
                        subStack.pop();
                        i++;
                        continue;
                    }
                    top.depth--;
                }
                i++;
                continue;
            } else {
                // backtick — scan until the closing backtick
                if (c === "`") {
                    subStack.pop();
                    i++;
                    continue;
                }
                i++;
                continue;
            }
        }

        // --- top-level state --------------------------------------------
        if (c === "\\") {
            // escape: next char is literal
            ensureWordStart();
            word += (i + 1 < n ? cmd[i + 1] : "");
            i += 2;
            continue;
        }
        if (c === "'") {
            // single quote: literal until next '
            ensureWordStart();
            wordHasQuote = true;
            i++;
            while (i < n && cmd[i] !== "'") { word += cmd[i]; i++; }
            i++; // skip closing '
            continue;
        }
        if (c === '"') {
            // double quote: until next ", honoring backslash escapes.
            // Inside double quotes, $(...) and backticks ARE expanded (unlike
            // single quotes), so scan for them and emit substitution events.
            // Plain variable expansion ($var / ${var}) is NOT a substitution.
            ensureWordStart();
            wordHasQuote = true;
            i++;
            while (i < n && cmd[i] !== '"') {
                const ch = cmd[i];
                if (ch === "\\" && i + 1 < n) { ensureWordStart(); word += cmd[i] + cmd[i + 1]; i += 2; continue; }
                if (ch === "$" && cmd[i + 1] === "(") {
                    // $( ... ) substitution inside double quotes
                    const start = i + 2;
                    let depth = 0;
                    i += 2;
                    while (i < n) {
                        if (cmd[i] === "(") depth++;
                        else if (cmd[i] === ")") {
                            if (depth === 0) break;
                            depth--;
                        }
                        i++;
                    }
                    const inner = cmd.slice(start, i);
                    // Span covers the full `$( ... )` (from `$` to just past `)`).
                    events.push({ kind: "substitution", type: "dollar", text: inner, start: start - 2, end: i + 1 });
                    i++; // skip closing )
                    continue;
                }
                if (ch === "`") {
                    // backtick substitution inside double quotes
                    const start = i + 1;
                    i++;
                    while (i < n && cmd[i] !== "`") {
                        if (cmd[i] === "\\" && i + 1 < n) i++;
                        i++;
                    }
                    const inner = cmd.slice(start, i);
                    // Span covers the full `...` (from opening backtick to just past closing).
                    events.push({ kind: "substitution", type: "backtick", text: inner, start: start - 1, end: i + 1 });
                    i++; // skip closing `
                    continue;
                }
                ensureWordStart();
                word += ch; i++;
            }
            i++; // skip closing "
            continue;
        }
        if (c === "`") {
            // backtick substitution: capture the inner command as a sub-event
            ensureWordStart();
            wordHasQuote = true;
            const start = i + 1;
            i++;
            while (i < n && cmd[i] !== "`") {
                if (cmd[i] === "\\" && i + 1 < n) i++;
                i++;
            }
            const inner = cmd.slice(start, i);
            // Span covers the full `...` (from opening backtick to just past closing).
            events.push({ kind: "substitution", type: "backtick", text: inner, start: start - 1, end: i + 1 });
            i++; // skip closing `
            continue;
        }
        if (c === "$" && next === "(") {
            // `$( ... )` substitution
            ensureWordStart();
            wordHasQuote = true;
            const start = i + 2;
            let depth = 0;
            i += 2;
            while (i < n) {
                if (cmd[i] === "(") depth++;
                else if (cmd[i] === ")") {
                    if (depth === 0) break;
                    depth--;
                }
                i++;
            }
            const inner = cmd.slice(start, i);
            // Span covers the full `$( ... )` (from `$` to just past `)`).
            events.push({ kind: "substitution", type: "dollar", text: inner, start: start - 2, end: i + 1 });
            i++; // skip closing )
            continue;
        }
        if (c === "$" && next === "{") {
            // `${ ... }` — treat as a word fragment (variable expansion)
            ensureWordStart();
            word += "$";
            i++;
            continue;
        }
        if (c === "#" && (word === "" || /\s$/.test(word))) {
            // comment: to end of line
            const lineEnd = cmd.indexOf("\n", i);
            const text = cmd.slice(i, lineEnd === -1 ? n : lineEnd);
            events.push({ kind: "comment", text });
            i = lineEnd === -1 ? n : lineEnd;
            continue;
        }
        if (c === ";" || (c === "&" && next === "&") || (c === "|" && next === "|") || c === "|" || c === "&") {
            flushWord();
            const isDouble = (c === "&" && next === "&") || (c === "|" && next === "|");
            events.push({ kind: "sep", text: isDouble ? c + next : c });
            i += isDouble ? 2 : 1;
            continue;
        }
        if (c === "\n") {
            flushWord();
            events.push({ kind: "sep", text: "\n" });
            i++;
            continue;
        }
        if (c === ">" || c === "<") {
            // redirect: consume the operator and the following word
            flushWord();
            const opStart = i;
            let op = c;
            i++;
            while (i < n && (cmd[i] === ">" || cmd[i] === "<")) { op += cmd[i]; i++; }
            // merge a directly-preceding file-descriptor word (e.g. `2>`, `5>out`)
            const lastEv = events[events.length - 1];
            if (opStart > 0 && /\d/.test(cmd[opStart - 1]) &&
                lastEv && lastEv.kind === "word" && /^\d{1,2}$/.test(lastEv.text)) {
                op = lastEv.text + op;
                events.pop();
            }
            // skip whitespace
            while (i < n && /\s/.test(cmd[i])) i++;
            let target = "";
            if (i < n && cmd[i] === "&" && (i + 1 >= n || /\d/.test(cmd[i + 1]))) {
                // file descriptor duplication: `>&1`, `2>&1`
                target = cmd[i];
                i++;
                while (i < n && /\d/.test(cmd[i])) { target += cmd[i]; i++; }
            } else {
                while (i < n && !/\s/.test(cmd[i]) && cmd[i] !== ";" && cmd[i] !== "&" && cmd[i] !== "|" && cmd[i] !== "\n") {
                    target += cmd[i];
                    i++;
                }
            }
            events.push({ kind: "redirect", text: op + (target ? " " + target : "") });
            // Heredoc: skip body lines until the line containing the delimiter
            if ((op === "<<" || op === "<<-") && target) {
                const delim = target;
                let lineEnd = cmd.indexOf("\n", i);
                i = lineEnd === -1 ? n : lineEnd + 1;
                while (i < n) {
                    const nextEnd = cmd.indexOf("\n", i);
                    const body = cmd.slice(i, nextEnd === -1 ? n : nextEnd);
                    if (body.trim() === delim) {
                        i = nextEnd === -1 ? n : nextEnd + 1;
                        break;
                    }
                    i = nextEnd === -1 ? n : nextEnd + 1;
                }
            }
            continue;
        }
        if (/\s/.test(c)) {
            flushWord();
            i++;
            continue;
        }
        // ordinary word character
        ensureWordStart();
        word += c;
        i++;
    }
    flushWord();
    return events;
}

// ---------------------------------------------------------------------------
// Segment construction
// ---------------------------------------------------------------------------

/**
 * Groups top-level events into segments.
 * @param {Array<object>} events
 * @returns {Array<object>}
 */
function buildSegments(events) {
    const segments = [];
    let current = {
        words: [],
        wordSpans: [],
        redirects: [],
        comments: [],
        substitutions: [],
        background: false,
        pipedToShell: false,
        heredoc: false,
        comment: false,
        text: ""
    };

    const pushCurrent = () => {
        if (current.words.length === 0 && current.redirects.length === 0 &&
            current.comments.length === 0 && current.substitutions.length === 0) {
            return;
        }
        const text = current.words.join(" ") +
            (current.redirects.length ? " " + current.redirects.join(" ") : "") +
            (current.comments.length ? " " + current.comments.join(" ") : "");
        segments.push({
            ...current,
            text: text.trim(),
            precedingSep: pendingSep
        });
        current = {
            words: [], wordSpans: [], redirects: [], comments: [], substitutions: [],
            background: false, pipedToShell: false, heredoc: false, comment: false, text: ""
        };
    };

    let pendingSep = null;
    for (const ev of events) {
        if (ev.kind === "word") {
            current.words.push(ev.text);
            current.wordSpans.push({ start: ev.start, end: ev.end });
            if (ev.quoted) current.hasQuotes = true;
        } else if (ev.kind === "substitution") {
            current.substitutions.push(ev);
            // A substitution that contains a shell program is a risk
            current.hasSubstitution = true;
        } else if (ev.kind === "redirect") {
            current.redirects.push(ev.text);
            if (ev.text.startsWith("<<") || ev.text.startsWith("<<<")) {
                current.heredoc = true;
            }
        } else if (ev.kind === "comment") {
            current.comments.push(ev.text);
            current.comment = true;
        } else if (ev.kind === "sep") {
            if (ev.text === "&") {
                current.background = true;
            }
            pushCurrent();
            pendingSep = ev.text;
        }
    }
    pushCurrent();

    // Mark piped-to-shell: a segment whose first word is a shell and that
    // follows a `|` separator.
    for (const seg of segments) {
        if (seg.precedingSep === "|" && seg.words.length > 0) {
            const first = seg.words[0].toLowerCase();
            if (["bash", "sh", "zsh", "dash", "ksh", "source", "."].includes(first)) {
                seg.pipedToShell = true;
            }
        }
    }

    return segments;
}

// ---------------------------------------------------------------------------
// Program extraction
// ---------------------------------------------------------------------------

const WRAPPER_PROGRAMS = new Set(["env", "sudo", "nohup", "nice", "ionice", "timeout", "exec", "command"]);

/**
 * Normalizes a program name to a lowercase basename, or null if it does not
 * look like a program (e.g. `:(){:` from a fork bomb).
 * @param {string} name
 * @returns {string|null}
 */
function sanitizeProgram(name) {
    const base = String(name || "").split("/").pop().toLowerCase();
    if (!base || !/^[a-zA-Z0-9._/:]+$/.test(base)) return null;
    return base;
}
const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash", "ksh", "source", "."]);

/**
 * Extracts the program name and arguments from a segment's words.
 * @param {string[]} words
 * @returns {{ program: string, args: string[] } | null}
 */
function extractProgramFromWords(words) {
    if (!words || words.length === 0) return null;
    let i = 0;
    // Skip leading env assignments (FOO=bar)
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
        i++;
    }
    if (i >= words.length) return null;
    const program = words[i];
    const args = words.slice(i + 1);
    return { program, args, programIndex: i };
}

/**
 * Recursively extracts program names from a command line.
 * @param {string} cmd
 * @returns {string[]}
 */
export function extractPrograms(cmd) {
    const seen = new Set();
    const result = [];
    const push = (name) => {
        const base = sanitizeProgram(name);
        if (!base || seen.has(base)) return;
        seen.add(base);
        result.push(base);
    };

    const processCmd = (line) => {
        const events = scanTopLevel(line);
        const segments = buildSegments(events);
        for (const seg of segments) {
            const extracted = extractProgramFromWords(seg.words);
            if (!extracted) continue;
            let { program, args } = extracted;

            // Skip wrappers (and their env-assignment / duration args),
            // but recurse into their target
            while (WRAPPER_PROGRAMS.has(program.toLowerCase())) {
                let k = 0;
                while (k < args.length &&
                    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[k]) || /^\d+(\.\d+)?[smh]?$/.test(args[k]))) {
                    k++;
                }
                const next = args[k];
                if (!next) break;
                program = next;
                args = args.slice(k + 1);
            }

            push(program);

            // Recurse into `sh -c "..."`, `bash -c "..."`, etc.
            if (SHELL_PROGRAMS.has(program.toLowerCase())) {
                const ci = args.findIndex(a => a === "-c");
                if (ci !== -1 && args[ci + 1]) {
                    processCmd(args[ci + 1]);
                }
            }

            // Recurse into `find ... -exec prog ... {} \;`
            if (program.toLowerCase() === "find") {
                for (let k = 0; k < args.length - 1; k++) {
                    if (args[k] === "-exec" || args[k] === "-exec+") {
                        push(args[k + 1]);
                    }
                }
            }

            // Recurse into `xargs prog ...`
            if (program.toLowerCase() === "xargs") {
                for (const a of args) {
                    if (!a.startsWith("-") && !/^\d+$/.test(a)) {
                        push(a);
                        break;
                    }
                }
            }

            // Recurse into substitutions
            for (const sub of seg.substitutions) {
                processCmd(sub.text);
            }
        }
    };

    processCmd(String(cmd || ""));
    return result;
}

// ---------------------------------------------------------------------------
// Public: parseCommandLine
// ---------------------------------------------------------------------------

/**
 * Parses a command line into segments, programs, warnings, and stats.
 * @param {string} cmd
 * @returns {{
 *   segments: Array<{
 *     text: string,
 *     words: string[],
 *     program: string|null,
 *     args: string[],
 *     background: boolean,
 *     pipedToShell: boolean,
 *     substitution: boolean,
 *     substitutions: Array<{ type: string, text: string }>,
 *     heredoc: boolean,
 *     comment: boolean,
 *     redirects: string[],
 *     risk: "safe"|"moderate"|"dangerous"|"unknown",
 *     riskReason: string
 *   }>,
 *   programs: string[],
 *   warnings: string[],
 *   stats: { segments: number, programs: number, warnings: number }
 * }}
 */
export function parseCommandLine(cmd) {
    const warnings = [];
    const line = String(cmd || "");
    const events = scanTopLevel(line);
    const segments = buildSegments(events);

    const parsedSegments = [];
    const allPrograms = new Set();
    const orderedPrograms = [];

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const extracted = extractProgramFromWords(seg.words);
        let program = extracted ? extracted.program : null;
        let args = extracted ? extracted.args : [];
        // Index of the program word within seg.words (used for highlighting).
        let programWordIndex = extracted ? extracted.programIndex : -1;

        // Skip wrappers (and their env-assignment / duration args)
        while (program && WRAPPER_PROGRAMS.has(program.toLowerCase())) {
            let k = 0;
            while (k < args.length &&
                (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[k]) || /^\d+(\.\d+)?[smh]?$/.test(args[k]))) {
                k++;
            }
            const next = args[k];
            if (!next) break;
            program = next;
            args = args.slice(k + 1);
            programWordIndex = programWordIndex + 1 + k;
        }

        // Normalize the program name; drop it if it is not a plausible
        // program (e.g. `:(){:` from a fork bomb).
        program = sanitizeProgram(program);

        // Piped-to-shell is computed precisely in buildSegments (first word
        // is a shell and the segment follows a `|` separator).
        const pipedToShell = seg.pipedToShell === true;

        const risk = program ? classifyProgram(program) : { category: "unknown", reason: "No program detected." };

        const segment = {
            text: seg.text,
            words: seg.words,
            wordSpans: seg.wordSpans,
            program,
            programWordIndex,
            args,
            background: seg.background,
            pipedToShell,
            substitution: seg.hasSubstitution || seg.substitutions.length > 0,
            substitutions: seg.substitutions,
            heredoc: seg.heredoc,
            comment: seg.comment,
            redirects: seg.redirects,
            risk: risk.category,
            riskReason: risk.reason
        };
        parsedSegments.push(segment);

        const addProg = (p) => {
            const base = sanitizeProgram(p);
            if (base && !allPrograms.has(base)) {
                allPrograms.add(base);
                orderedPrograms.push(base);
            }
        };
        if (program) addProg(program);

        // Recurse into `find -exec target`, `xargs target`, `shell -c body`
        // and inline substitutions (preserves first-occurrence order).
        if (program === "find") {
            for (let k = 0; k < args.length - 1; k++) {
                if (args[k] === "-exec" || args[k] === "-exec+") {
                    addProg(args[k + 1]);
                }
            }
        }
        if (program === "xargs") {
            for (const a of args) {
                if (!a.startsWith("-") && !/^\d+$/.test(a)) {
                    addProg(a);
                    break;
                }
            }
        }
        if (program && SHELL_PROGRAMS.has(program) && program !== "source" && program !== ".") {
            const ci = args.findIndex(a => a === "-c");
            if (ci !== -1 && args[ci + 1]) {
                for (const p of extractPrograms(args[ci + 1])) addProg(p);
            }
        }
        for (const sub of seg.substitutions) {
            for (const p of extractPrograms(sub.text)) addProg(p);
        }

        // Warnings
        if (pipedToShell) {
            warnings.push(`Segment ${i + 1}: piped input to a shell (${program}) — classic curl|bash pattern.`);
        }
        if (seg.hasSubstitution) {
            warnings.push(`Segment ${i + 1}: contains command substitution — nested commands may execute.`);
        }
        if (seg.heredoc) {
            warnings.push(`Segment ${i + 1}: uses a heredoc — the body may contain additional commands.`);
        }
        if (seg.background) {
            warnings.push(`Segment ${i + 1}: runs in the background (&).`);
        }
        if (risk.category === "dangerous") {
            warnings.push(`Segment ${i + 1}: program '${program}' is classified as DANGEROUS — ${risk.reason}`);
        }
    }

    return {
        segments: parsedSegments,
        programs: orderedPrograms,
        warnings,
        stats: {
            segments: parsedSegments.length,
            programs: orderedPrograms.length,
            warnings: warnings.length
        }
    };
}

// ---------------------------------------------------------------------------
// Annotation (highlight spans for UI)
// ---------------------------------------------------------------------------

/**
 * Annotates a command line for display: returns the original string plus a
 * list of character-offset spans marking programs and their subcommands
 * (first arg).
 *
 * Top-level programs are located via segment `wordSpans`. Nested programs
 * (inside `$( )`, backticks, `sh -c`, `find -exec`, `xargs`) are located by
 * recursively parsing each substitution body and offsetting its spans into
 * the original command.
 *
 * @param {string} cmd
 * @returns {{ command: string, spans: Array<{start: number, end: number, kind: "program"|"subcommand", name: string}> }}
 *   Spans are sorted by `start` and non-overlapping.
 */
export function annotateCommand(cmd) {
    const command = String(cmd || "");
    const spans = [];

    const addSpan = (start, end, kind, name) => {
        if (start == null || end == null || end <= start || start < 0 || end > command.length) return;
        spans.push({ start, end, kind, name });
    };

    // `baseOffset` is the absolute position (in the original command) where the
    // string that produced `segments` begins. Segment wordSpans are 0-based
    // within that string, so absolute = baseOffset + span.
    const processSegments = (segments, baseOffset) => {
        for (const seg of segments) {
            const spansArr = seg.wordSpans || [];
            if (seg.program && seg.programWordIndex >= 0 && seg.programWordIndex < spansArr.length) {
                const ps = spansArr[seg.programWordIndex];
                if (ps) addSpan(baseOffset + ps.start, baseOffset + ps.end, "program", seg.program);
                const subIdx = seg.programWordIndex + 1;
                if (seg.args && seg.args.length > 0 && subIdx < spansArr.length) {
                    const ss = spansArr[subIdx];
                    if (ss) addSpan(baseOffset + ss.start, baseOffset + ss.end, "subcommand", seg.args[0]);
                }
            }
            // Recurse into substitutions. `sub.start` is 0-based within the
            // current string, so the body begins at baseOffset + sub.start +
            // delimLen. Re-parsing the body yields 0-based spans, so pass the
            // body's absolute start as the new baseOffset.
            for (const sub of (seg.substitutions || [])) {
                if (sub.start == null || sub.end == null) continue;
                const delimLen = sub.type === "dollar" ? 2 : 1; // `$(` or backtick
                const bodyStart = baseOffset + sub.start + delimLen;
                processSegments(parseCommandLine(sub.text).segments, bodyStart);
            }
        }
    };

    processSegments(parseCommandLine(command).segments, 0);

    // Sort and drop overlapping spans (keep the earliest-starting one).
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const result = [];
    let lastEnd = -1;
    for (const s of spans) {
        if (s.start >= lastEnd) {
            result.push(s);
            lastEnd = s.end;
        }
    }

    return { command, spans: result };
}

export default { parseCommandLine, extractPrograms, classifyProgram, annotateCommand };
