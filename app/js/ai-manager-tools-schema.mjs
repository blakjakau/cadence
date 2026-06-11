export const tools = [
    {
        name: "list_files",
        description: "List the files and directories inside a given directory path.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The absolute or relative directory path to list." }
            },
            required: ["path"]
        }
    },
    {
        name: "search_files",
        description: "Search for an exact string across all files in the project.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The exact text query to search for." }
            },
            required: ["query"]
        }
    },
    {
        name: "find_file",
        description: "Search for a file path or filename within the project.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The partial path or filename to search for." }
            },
            required: ["path"]
        }
    },
    {
        name: "read_file",
        description: "Read the contents of a file. Use startLine and lineCount to read specific portions.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to read." },
                startLine: { type: "number", description: "Optional. The starting line number (1-indexed)." },
                lineCount: { type: "number", description: "Optional. The number of lines to read." }
            },
            required: ["path"]
        }
    },
    {
        name: "read_file_outline",
        description: "Read an outline of a file showing symbols, classes, and function definitions with line numbers.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to outline." }
            },
            required: ["path"]
        }
    },
    {
        name: "search_in_file",
        description: "Search for an exact string within a specific file (case-insensitive).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to search." },
                query: { type: "string", description: "The exact text query to search for." }
            },
            required: ["path", "query"]
        }
    },
    {
        name: "read_symbol",
        description: "Find and read the definition of a specific symbol (class, function, variable) across the project.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The name of the symbol to read." }
            },
            required: ["query"]
        }
    },
    {
        name: "create_file",
        description: "Create a new file with the specified content. Parent folders in the path will automatically be created if they do not exist. CRITICAL: Do NOT use this tool if you are copying, moving, or refactoring existing code from another file; use 'refactor_copy_lines' instead.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path where the new file should be created." },
                content: { type: "string", description: "The content of the new file." }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "open_file",
        description: "Open a file in the workspace editor for the user to view.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to open." }
            },
            required: ["path"]
        }
    },
    {
        name: "edit_file",
        description: "Replace exact text in a file. The search text MUST perfectly match existing file content character-for-character. Perform edits in smallest logical blocks. CRITICAL: Do NOT use this tool if you are copying, moving, or refactoring existing code from another file; use 'refactor_copy_lines' instead.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to edit." },
                search: { type: "string", description: "The exact lines of text to replace." },
                replace: { type: "string", description: "The new lines of text to insert." }
            },
            required: ["path", "search", "replace"]
        }
    },
    {
        name: "refactor_copy_lines",
        description: "Copy a range of lines from a source file and insert them into a destination file. If destination file does not exist, it will be created.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "The path of the source file to copy from." },
                startLine: { type: "number", description: "The starting line number (1-indexed) in the source file." },
                lineCount: { type: "number", description: "The number of lines to copy." },
                destination: { type: "string", description: "The path of the destination file to insert into. Can be a new or existing file." },
                insertAt: { type: "number", description: "The line number (1-indexed) in the destination file where the lines should be inserted." },
                startAnchor: { type: "string", description: "Required. The exact line text expected at startLine in the source file for auto-alignment." },
                endAnchor: { type: "string", description: "Required. The exact line text expected at startLine+lineCount in the source file auto-alignment." },
                removeFromSource: { type: "boolean", description: "Optional. If true, remove the copied lines from the source file." }
            },
            required: ["source", "startLine", "lineCount", "destination", "insertAt", "startAnchor", "endAnchor"]
        }
    },
    {
        name: "edit_remove_lines",
        description: "Remove lines from a file, you must provide either the exact text to remove OR the startLine and lineCount to remove.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The path of the file to edit." },
                search: { type: "string", description: "The exact lines of text to remove." },
                startLine: { type: "number", description: "The starting line number (1-indexed) of the lines to remove." },
                lineCount: { type: "number", description: "The number of lines to remove." },
                startAnchor: { type: "string", description: "Optional. Required if startLine and lineCount are provided. The exact line text expected at startLine for auto-alignment." },
                endAnchor: { type: "string", description: "Optional. Required if startLine and lineCount are provided. The exact line text expected at startLine+lineCount for auto-alignment." }
            },
            required: ["path"]
        }
    },
    {
        name: "create_implementation_plan",
        description: "Create a detailed implementation plan before modifying code.",
        parameters: {
            type: "object",
            properties: {
                plan: { type: "string", description: "The detailed implementation plan formatted as markdown." },
                tasks: { type: "string", description: "Optional. The task list formatted as markdown checkboxes (e.g. '- [ ] Task 1') to create or update at the same time." }
            },
            required: ["plan"]
        }
    },
    {
        name: "update_task_list",
        description: "Create or update the task list to track progress.",
        parameters: {
            type: "object",
            properties: {
                tasks: { type: "string", description: "The task list formatted as markdown checkboxes (e.g. '- [ ] Task 1')." }
            },
            required: ["tasks"]
        }
    },
    {
        name: "complete_task",
        description: "Mark a specific task from your task list as complete.",
        parameters: {
            type: "object",
            properties: {
                taskName: { type: "string", description: "The name or description of the task you just completed." }
            },
            required: ["taskName"]
        }
    },
    {
        name: "done",
        description: "Signal that you have completed all tasks and do not intend to call any more tools.",
        parameters: {
            type: "object",
            properties: {}
        }
    }
];
