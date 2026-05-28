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
        description: "Search for an exact string within a specific file.",
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
        name: "create_file",
        description: "Create a new file with the specified content.",
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
        name: "edit_file",
        description: "Replace exact text in a file. The search text MUST perfectly match existing file content character-for-character.",
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
