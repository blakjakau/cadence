export const subAgentToolsList = [
    "list_files",
    "read_file",
    "read_file_outline",
    "read_symbol",
    "search_files",
    "search_in_file",
    "edit_file",
    // "edit_remove_lines",
    // "refactor_copy_lines",
    "create_file",
    "validate_syntax",
    "run_command",
    "query",
    "sub_agent_complete",
    "query_parent",
    // "web_search",
    "research",
    "web_fetch",
    "checkpoint",
    "rollback_file",
    "rollback_cycle"
];

export const tools = [
    {
        name: "run_command",
        description: "Run a shell command. Use `cwd` for multi-root workspaces. Requires user approval unless whitelisted.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: "Working directory: root folder name, relative, or absolute path." },
                timeoutMs: { type: "number", description: "Timeout in ms before terminating (default: 60000)." }
            },
            required: ["command"]
        }
    },
    {
        name: "validate_syntax",
        description: "Validate JS/JSON/HTML/CSS syntax without writing to disk. Accepts full `content` or a `search`/`replace` pair for simulated edits. Returns 'Valid syntax' or line/column SyntaxError details.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path or filename (for extension detection)." },
                content: { type: "string", description: "Full unsaved file content to validate." },
                search: { type: "string", description: "Search text for simulated patch validation." },
                replace: { type: "string", description: "Replacement text for simulated patch validation." }
            },
            required: ["path"]
        }
    },
    {
        name: "list_files",
        description: "List files and directories in a path.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Directory path to list." }
            },
            required: ["path"]
        }
    },
    {
        name: "search_files",
        description: "Search for an exact string across project files, optionally within a path.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Exact text to search for." },
                path: { type: "string", description: "Folder to restrict the search to." }
            },
            required: ["query"]
        }
    },
    {
        name: "find_file",
        description: "Find files by partial path or filename.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Partial path or filename." }
            },
            required: ["path"]
        }
    },
    {
        name: "read_file",
        description: "Read a file's contents. Use startLine/lineCount for specific portions.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to read." },
                startLine: { type: "number", description: "Starting line (1-indexed)." },
                lineCount: { type: "number", description: "Number of lines to read." }
            },
            required: ["path"]
        }
    },
    {
        name: "read_file_outline",
        description: "Read a file's outline: symbols, classes, and function definitions with line numbers.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to outline." }
            },
            required: ["path"]
        }
    },
    {
        name: "search_in_file",
        description: "Search for an exact string in a file (case-insensitive).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to search." },
                query: { type: "string", description: "Exact text to search for." }
            },
            required: ["path", "query"]
        }
    },
    {
        name: "read_symbol",
        description: "Find and read a symbol's definition (class, function, variable) across the project.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Symbol name to read." }
            },
            required: ["query"]
        }
    },
    {
        name: "create_file",
        description: "Create a NEW file. Fails if it already exists (use `edit_file`). Set `overwrite: true` to replace.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path of the new file." },
                content: { type: "string", description: "Initial file content." },
                overwrite: { type: "boolean", description: "Set true to overwrite an existing file." }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "open_file",
        description: "Open a file in the workspace editor for the user.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to open." }
            },
            required: ["path"]
        }
    },
    {
        name: "edit_file",
        description: "Replace exact text in a file. Provide one `search`/`replace` pair or an `edits` array for multiple changes. `search` must match character-for-character.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to edit." },
                search: { type: "string", description: "Exact text to replace (single edit)." },
                replace: { type: "string", description: "Replacement text (single edit)." },
                edits: {
                    type: "array",
                    description: "Sequential search/replace pairs applied in one call.",
                    items: {
                        type: "object",
                        properties: {
                            search: { type: "string", description: "Exact text to replace." },
                            replace: { type: "string", description: "Replacement text." }
                        },
                        required: ["search", "replace"]
                    }
                }
            },
            required: ["path"]
        }
    },
    // {
    //     name: "refactor_copy_lines",
    //     description: "Copy a range of lines from a source file and insert them into a destination file. If destination file does not exist, it will be created.",
    //     parameters: {
    //         type: "object",
    //         properties: {
    //             source: { type: "string", description: "The path of the source file to copy from." },
    //             startLine: { type: "number", description: "The starting line number (1-indexed) in the source file." },
    //             lineCount: { type: "number", description: "The number of lines to copy." },
    //             destination: { type: "string", description: "The path of the destination file to insert into. Can be a new or existing file." },
    //             insertAt: { type: "number", description: "The line number (1-indexed) in the destination file where the lines should be inserted." },
    //             startAnchor: { type: "string", description: "Optional. The exact line text expected at startLine in the source file for auto-alignment." },
    //             endAnchor: { type: "string", description: "Optional. The exact line text expected at startLine+lineCount in the source file auto-alignment." },
    //             removeFromSource: { type: "boolean", description: "Optional. If true, remove the copied lines from the source file." }
    //         },
    //         required: ["source", "startLine", "lineCount", "destination", "insertAt"]
    //     }
    // },
    
    // {
    //     name: "edit_remove_lines",
    //     description: "Remove lines from a file, you must provide either the exact text to remove OR the startLine and lineCount to remove.",
    //     parameters: {
    //         type: "object",
    //         properties: {
    //             path: { type: "string", description: "The path of the file to edit." },
    //             search: { type: "string", description: "The exact lines of text to remove." },
    //             startLine: { type: "number", description: "The starting line number (1-indexed) of the lines to remove." },
    //             lineCount: { type: "number", description: "The number of lines to remove." },
    //             startAnchor: { type: "string", description: "Optional. Required if startLine and lineCount are provided. The exact line text expected at startLine for auto-alignment." },
    //             endAnchor: { type: "string", description: "Optional. Required if startLine and lineCount are provided. The exact line text expected at startLine+lineCount for auto-alignment." }
    //         },
    //         required: ["path"]
    //     }
    // },
    {
        name: "create_implementation_plan",
        description: "Create a structured implementation plan and optional initial task list for complex changes or when planning mode is enabled.",
        parameters: {
            type: "object",
            properties: {
                plan: { type: "string", description: "Implementation plan as markdown." },
                tasks: { type: "string", description: "Task list as markdown checkboxes (e.g. '- [ ] Task 1')." }
            },
            required: ["plan"]
        }
    },
    {
        name: "update_task_list",
        description: "Create or update the task list.",
        parameters: {
            type: "object",
            properties: {
                tasks: { type: "string", description: "Task list as markdown checkboxes (e.g. '- [ ] Task 1')." }
            },
            required: ["tasks"]
        }
    },
    {
        name: "complete_task",
        description: "Mark a task as complete.",
        parameters: {
            type: "object",
            properties: {
                taskName: { type: "string", description: "Name or description of the completed task." }
            },
            required: ["taskName"]
        }
    },
    {
        name: "done",
        description: "Signal all tasks are complete and no more tools will be called.",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "create_sub_agent",
        description: "Spawns a sub-agent with a clean context and limited toolset.",
        parameters: {
            type: "object",
            properties: {
                objective: { type: "string", description: "The task/objective for the sub-agent." },
                size: { type: "string", enum: ["tiny", "small", "medium"], description: "Suggested size/capability of the model for this task." },
                create_another: { type: "boolean", description: "If true, continue creating more sub-agents this turn. If false, wait for all sub-agents to complete." }
            },
            required: ["objective", "size", "create_another"]
        }
    },
    {
        name: "query",
        description: "Ask the user a question and wait for a response. Use for clarifications or decisions you cannot determine from the codebase.",
        parameters: {
            type: "object",
            properties: {
                question: { type: "string", description: "The question to ask the user." }
            },
            required: ["question"]
        }
    },
    {
        name: "sub_agent_complete",
        description: "Signal sub-agent completion and return a result/summary to the parent.",
        parameters: {
            type: "object",
            properties: {
                result: { type: "string", description: "Detailed result or summary of the work completed." }
            },
            required: ["result"]
        }
    },
    {
        name: "query_sub_agent",
        description: "Send a new prompt, question, or follow-up to a previously spawned sub-agent.",
        parameters: {
            type: "object",
            properties: {
                subSessionId: { type: "string", description: "Session ID of the target sub-agent." },
                prompt: { type: "string", description: "Question or instruction to send." }
            },
            required: ["subSessionId", "prompt"]
        }
    },
    {
        name: "query_parent",
        description: "Ask your parent agent a question or request clarification. Pauses your loop and alerts the parent.",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "Question or information requested from the parent." }
            },
            required: ["prompt"]
        }
    },
    {
        name: "research",
        description: "Web research (Tavily) for current/real-time info, docs, versions, prices.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The research query to perform." }
            },
            required: ["query"]
        }
    },
    // {
    //     name: "web_search",
    //     description: "Search the web for information using a query. Returns a clean list of search result titles, URLs, and snippets.",
    //     parameters: {
    //         type: "object",
    //         properties: {
    //             query: { type: "string", description: "The search query to lookup." }
    //         },
    //         required: ["query"]
    //     }
    // },
    {
        name: "web_fetch",
        description: "Fetch a web URL. Returns a cleaned-up text summary of the page.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to fetch." }
            },
            required: ["url"]
        }
    },
    {
        name: "checkpoint",
        description: "Snapshot all files changed this task. Call after a verified sub-step before risky edits.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Short label, e.g. 'auth-middleware-complete'." }
            },
            required: ["name"]
        }
    },
    {
        name: "rollback_file",
        description: "Revert a file to `cycle_start` or `last_checkpoint`.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to rollback." },
                target: {
                    type: "string",
                    enum: ["cycle_start", "last_checkpoint"],
                    description: "Revert to cycle start ('cycle_start', default) or the last checkpoint ('last_checkpoint')."
                }
            },
            required: ["path"]
        }
    },
    {
        name: "rollback_cycle",
        description: "Revert all files changed this cycle to `cycle_start` or `last_checkpoint`.",
        parameters: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["cycle_start", "last_checkpoint"],
                    description: "Revert to cycle start ('cycle_start', default) or the last checkpoint ('last_checkpoint')."
                }
            }
        }
    }
];

/**
 * Resolve the tool set to send for a given session type.
 * - Sub-agent sessions get the reduced subAgentToolsList set (no orchestration tools).
 * - Chat-only sessions (supportsJSONTools === false) get no tools.
 * - Main agent sessions get the full set.
 */
export function getToolsForSession(isSubAgent, supportsJSONTools) {
    if (supportsJSONTools === false) return [];
    if (isSubAgent) return tools.filter(t => subAgentToolsList.includes(t.name));
    return tools;
}
