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
	//"validate_syntax",
	"run_command",
	//"query",
	"sub_agent_complete",
	"query_parent",
	// "web_search",
	"research",
	"web_fetch",
	"checkpoint",
	"rollback_file",
	//"rollback_cycle",
	"scratchpad_write",
	"scratchpad_clear",
]

export const tools = [
	{
		name: "run_command",
		description:
			"Run a shell command (defaults to project root).",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The shell command to run." },
				cwd: {
					type: "string",
					description: "Working directory (if not root) relative to root",
				},
				timeoutMs: { type: "number", description: "Timeout in ms before terminating (default: 60000)." },
			},
			required: ["command"],
		},
	},
	// {
	// 	name: "validate_syntax",
	// 	description:
	// 		"Validate JS/JSON/HTML/CSS/Go syntax without writing to disk. Accepts full `content` or a `search`/`replace` pair for simulated edits. Returns 'Valid syntax' or line/column SyntaxError details.",
	// 	parameters: {
	// 		type: "object",
	// 		properties: {
	// 			path: { type: "string", description: "Path or filename (for extension detection)." },
	// 			content: { type: "string", description: "Full unsaved file content to validate." },
	// 			search: { type: "string", description: "Search text for simulated patch validation." },
	// 			replace: { type: "string", description: "Replacement text for simulated patch validation." },
	// 		},
	// 		required: ["path"],
	// 	},
	// },
	{
		name: "list_files",
		description: "List files and directories in a path.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path to list." },
			},
			required: ["path"],
		},
	},
	{
		name: "search_files",
		description: "Search for an exact string across project files, optionally within a path.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Exact text to search for." },
				path: { type: "string", description: "Folder to restrict the search to." },
			},
			required: ["query"],
		},
	},
	{
		name: "find_file",
		description: "Find files by partial path or filename.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Partial path or filename." },
			},
			required: ["path"],
		},
	},
	{
		name: "read_file",
		description: "Read a file's contents. Use startLine/lineCount for specific portions (always prefered).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to read." },
				startLine: { type: "number", description: "Starting line (1-indexed)." },
				lineCount: { type: "number", description: "Number of lines to read." },
			},
			required: ["path"],
		},
	},
	{
		name: "read_file_outline",
		description: "Read a file's outline: symbols, classes, and function definitions with line numbers.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to outline." },
			},
			required: ["path"],
		},
	},
	{
		name: "search_in_file",
		description: "Search for an exact string in a file (case-insensitive).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to search." },
				query: { type: "string", description: "Exact text to search for." },
			},
			required: ["path", "query"],
		},
	},
	// {
	// 	name: "read_symbol",
	// 	description: "Find and read a symbol's definition (class, function, variable) across the project.",
	// 	parameters: {
	// 		type: "object",
	// 		properties: {
	// 			query: { type: "string", description: "Symbol name to read." },
	// 		},
	// 		required: ["query"],
	// 	},
	// },
	{
		name: "create_file",
		description:
			"Create a NEW file. Fails if it already exists (use `edit_file`). Set `overwrite: true` to replace.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path of the new file." },
				content: { type: "string", description: "Initial file content." },
				overwrite: { type: "boolean", description: "Set true to overwrite an existing file." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "open_file",
		description: "Open a file in the workspace editor for user review.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to open." },
			},
			required: ["path"],
		},
	},
	{
		name: "edit_file",
		description:
			"Replace exact text in a file. Provide one `search`/`replace` pair or an `edits` array for multiple changes. `search` must match character-for-character. Automatically validates supported code files via (via node or go psrser)",
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
							replace: { type: "string", description: "Replacement text." },
						},
						required: ["search", "replace"],
					},
				},
			},
			required: ["path"],
		},
	},
	{
		name: "create_implementation_plan",
		description:
			"Create a structured implementation plan and optional initial task list for complex changes or when planning mode is enabled.",
		parameters: {
			type: "object",
			properties: {
				plan: { type: "string", description: "Implementation plan as markdown." },
				tasks: { type: "string", description: "Task list as markdown checkboxes (e.g. '- [ ] Task 1')." },
			},
			required: ["plan"],
		},
	},
	{
		name: "update_task_list",
		description: "Create or update the task list.",
		parameters: {
			type: "object",
			properties: {
				tasks: { type: "string", description: "Task list as markdown checkboxes (e.g. '- [ ] Task 1')." },
			},
			required: ["tasks"],
		},
	},
	{
		name: "complete_task",
		description: "Mark a task as complete.",
		parameters: {
			type: "object",
			properties: {
				taskName: { type: "string", description: "Name or description of the completed task." },
			},
			required: ["taskName"],
		},
	},
	{
		name: "scratchpad_write",
		description:
			"Write or update concise notes in the session scratchpad. Kept evergreen in context across turns to retain important discoveries (max 4KB, Markdown format recommended). Use `mode: 'append'` to add new notes to existing scratchpad content.",
		parameters: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "Markdown notes or discoveries to keep in the scratchpad (max 4096 bytes total).",
				},
				mode: {
					type: "string",
					enum: ["replace", "append"],
					description: "Whether to 'replace' (default) the entire scratchpad or 'append' new content to current notes.",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "scratchpad_clear",
		description: "Clear all notes from the session scratchpad.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "done",
		description: "Signal all tasks are complete and no more tools will be called.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "create_sub_agent",
		description: "Spawns a sub-agent with a clean context and limited toolset.",
		parameters: {
			type: "object",
			properties: {
				objective: { type: "string", description: "The task/objective for the sub-agent." },
				size: {
					type: "string",
					enum: ["tiny", "small", "medium"],
					description: "Suggested size/capability of the model for this task.",
				},
				create_another: {
					type: "boolean",
					description:
						"If true, continue creating more sub-agents this turn. If false, wait for all sub-agents to complete.",
				},
			},
			required: ["objective", "size", "create_another"],
		},
	},
	{
		name: "query",
		description:
			"Ask the user a question and wait for a response. Use for clarifications or decisions you cannot determine from the codebase.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question to ask the user." },
			},
			required: ["question"],
		},
	},
	{
		name: "sub_agent_complete",
		description: "Signal sub-agent completion and return a result/summary to the parent.",
		parameters: {
			type: "object",
			properties: {
				result: { type: "string", description: "Detailed result or summary of the work completed." },
			},
			required: ["result"],
		},
	},
	{
		name: "query_sub_agent",
		description: "Send a new prompt, question, or follow-up to a previously spawned sub-agent.",
		parameters: {
			type: "object",
			properties: {
				subSessionId: { type: "string", description: "Session ID of the target sub-agent." },
				prompt: { type: "string", description: "Question or instruction to send." },
			},
			required: ["subSessionId", "prompt"],
		},
	},
	{
		name: "query_parent",
		description:
			"Ask your parent agent a question or request clarification. Pauses your loop and alerts the parent.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Question or information requested from the parent." },
			},
			required: ["prompt"],
		},
	},
	{
		name: "research",
		description: "Web research (Tavily) for current/real-time info, docs, versions, prices.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The research query to perform." },
			},
			required: ["query"],
		},
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
		description:
			"Fetch a web URL. Set `no_summary: true` to return full content without AI summarisation. Use `startLine` and `lineCount` to read specific portions. Use `grep` to search within the page lines and locate relevant line numbers.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "The URL to fetch." },
				no_summary: {
					type: "boolean",
					description:
						"If true, return full content without AI summarisation (ideal for remote code or exact text).",
				},
				startLine: { type: "number", description: "Starting line (1-indexed) to read from the content." },
				lineCount: { type: "number", description: "Number of lines to read." },
				grep: {
					type: "string",
					description: "Search query to find matching lines and line numbers in the fetched content with surrounding context.",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "checkpoint",
		description: "Snapshot all files changed this task. Call after a verified sub-step before risky edits.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short label, e.g. 'auth-middleware-complete'." },
			},
			required: ["name"],
		},
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
					description:
						"Revert to cycle start ('cycle_start', default) or the last checkpoint ('last_checkpoint').",
				},
			},
			required: ["path"],
		},
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
					description:
						"Revert to cycle start ('cycle_start', default) or the last checkpoint ('last_checkpoint').",
				},
			},
		},
	},
	{
		name: "cull_history",
		description:
			"Cull the conversation from visible dialogue turn `idx` (0-based, in the order the model sees the turns) through the end. Evergreen plan/tasks, the scratchpad, and [SYSTEM] directives are never culled; an automatic prune safety net still runs as a backstop.",
		parameters: {
			type: "object",
			properties: {
				idx: {
					type: "integer",
					minimum: 0,
					description:
						"0-based index of the visible dialogue turn to keep as the new context head. NOT a raw message id.",
				},
			},
			required: ["idx"],
		},
	},
]

/**
 * Resolve the tool set to send for a given session type.
 * - Sub-agent sessions get the reduced subAgentToolsList set (no orchestration tools).
 * - Chat-only sessions (supportsJSONTools === false) get no tools.
 * - Main agent sessions get the full set.
 * - `cull_history` is a main-agent-only, opt-in tool: it is only served to the primary agent
 *   when the `modelLeadPruning` setting is enabled; sub-agents and chat-only sessions never receive it.
 */
export function getToolsForSession(isSubAgent, supportsJSONTools, modelLeadPruning = false) {
	if (supportsJSONTools === false) return []
	if (isSubAgent) return tools.filter((t) => subAgentToolsList.includes(t.name))
	if (!modelLeadPruning) {
		// Gate: hide cull_history from the main agent unless the user opted in.
		return tools.filter((t) => t.name !== "cull_history")
	}
	return tools
}
