import { tools } from './ai-manager-tools-schema.mjs';

function generateXmlToolDocs(planningMode = false, compact = false) {
    let xml = "";
    for (const tool of tools) {
        if (planningMode && (tool.name === "create_file" || tool.name === "edit_file")) {
            continue;
        }
        if (compact) {
            const params = Object.keys(tool.parameters.properties || {}).map(p => {
                const req = tool.parameters.required?.includes(p);
                return `${p}${req ? '' : '?'}`;
            }).join(", ");
            xml += `<tool_call name="${tool.name}">[${params}]</tool_call>\n`;
        } else {
            xml += `<tool_call name="${tool.name}">\n`;
            for (const [propName, propDetails] of Object.entries(tool.parameters.properties)) {
                const isOptional = !tool.parameters.required.includes(propName);
                const optionalStr = isOptional ? " <!-- Optional -->" : "";
                xml += `  <${propName}>...</${propName}>${optionalStr}\n`;
            }
            xml += `</tool_call>\n`;
        }
    }
    if (!planningMode && !compact) {
        xml += `* Note: For edit_file, <search> MUST perfectly match existing file content character-for-character.\n`;
    }
    return xml.trim();
}

export function getAgentDirectives(features = {}) {
    const hasPlan = !!features.hasPlan;
    const hasTasks = !!features.hasTasks;
    const hasAcceptedPlan = !!features.hasAcceptedPlan;
    const hasCompletedAllTasks = !!features.hasCompletedAllTasks;

    const directives = [];
    if (!hasPlan) {
        // directives.push("- Use `list_files`, `find_file`, `search_files`, or `read_file_outline` to analyze the project codebase.");
        // directives.push("- Use `create_implementation_plan` to outline your strategy and architectural changes (do NOT include a task list here).");
        directives.push("- Work toward the user's objectives. Use sub-agents (`create_sub_agent`) to explore, analyze, and locate code implementations to keep your own context clear and allow asynchronous tasks.");
    } else {
        if (!hasAcceptedPlan) {
            directives.push("- Address the user's feedback to update the implementation plan.");
        }
        if (!hasTasks) {
            directives.push("- Use `create_implementation_plan` to define your task list by supplying the optional `tasks` parameter, or call `update_task_list` to list implementation tasks based on the plan.");
        } else if (!hasCompletedAllTasks) {
            directives.push("- Work on the tasks in your task checklist one by one, calling `complete_task` as you finish each task.");
        } else {
            // directives.push("- All tasks are marked as complete. Review your changes with the user and call the `done` tool to signal task completion.");
        }
    }

    if (directives.length > 0) {
        return `# Current Directives\n${directives.join('\n')}`;
    }
    return "";
}

export default function getAgentSystemPrompt(modelName = '', features = {}) {
    // True native reasoning models like DeepSeek R1 or Gemini Flash Thinking
    // True native reasoning models like DeepSeek R1 or Gemini Flash Thinking
    const isNativeReasoning = features.isNativeReasoning;
    
    // Unpack features
    
    // Unpack features
    const supportsNativeTools = features.supportsJSONTools !== undefined ? features.supportsJSONTools : modelName.includes('gemini');
    const planningMode = !!features.planningMode;

    let exampleTurn = "";
    if (supportsNativeTools) {
        if (isNativeReasoning) {
            exampleTurn = `
# Example Turn
I am reading app.js to locate the issue.
`;
        } else {
            exampleTurn = `
# Example Turn
<thought>
I need to check app.js to understand the bug before editing.
</thought>
I am reading app.js to locate the issue.
`;
        }
    } else {
        if (isNativeReasoning) {
            exampleTurn = `
# Example Turn
I am reading app.js to locate the issue.
<tool_call name="read_file">
  <path>app.js</path>
</tool_call>
`;
        } else {
            exampleTurn = `
# Example Turn
<thought>
I need to check app.js to understand the bug before editing.
</thought>
I am reading app.js to locate the issue.
<tool_call name="read_file">
  <path>app.js</path>
</tool_call>
`;
        }
    }

    let thinkingRule = "";
    if (isNativeReasoning) {
        thinkingRule = `- Thinking: Leverage your thinking/reasoning capability to analyze the task before making tool calls.`;
    } else {
        thinkingRule = "- Thinking: ALWAYS start your response with your reasoning, wrapped in <thought>...</thought> blocks. Explain your logic before calling tools.";
    }

    let taskFocusRule = "";
    if (isNativeReasoning) {
        taskFocusRule = "- Task Focus: Actively reference your TASK LIST and state which task you are currently working on. If you complete a task, you MUST immediately call the `complete_task` tool. If all tasks are completed, call `done`.";
    } else {
        taskFocusRule = "- Task Focus: In your <thought> block, actively reference your TASK LIST and state which task you are currently working on. If you complete a task, you MUST immediately call the `complete_task` tool. If all tasks are completed, call `done`.";
    }
    
    let loopingRule = "";
    if (isNativeReasoning) {
        loopingRule = "- Looping Prevention: Review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    } else {
        loopingRule = "- Looping Prevention: In your <thought> block, actively review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    }

    let toolsSection = "";
    const isSmallContext = (features.maxContextTokens && features.maxContextTokens <= 16384) || features.isLocalModel;
    if (!supportsNativeTools) {
        toolsSection = `
# Available Tools
Choose AT MOST ONE tool per turn and use its exact format, the host will return results for your next step.
${generateXmlToolDocs(planningMode, isSmallContext)}
`;
    }

    let coreRules = "";
    if (!supportsNativeTools) {
        coreRules = `
- Tools: Use ONE tool call block per turn. Wait for the host to provide the result.
- ALWAYS choose the least impactful tool (don't read the whole file if you only need the lines of function)
- ALWAYS make the smallest atomic edits when using \`edit_file\`
- Context Limits: ALWAYS explore files by reading their outlines first using read_file_outline. Outlines provide symbol line numbers and lengths. NEVER read a full file if you can extract just the function you need using the <startLine> and <lineCount> parameters of read_file. If you need to find exact text inside a file, use search_in_file to locate the exact line numbers and surrounding context. This saves context tokens.
- Line Numbers & Counts: When specifying line numbers (e.g. in \`read_file\`, \`edit_remove_lines\`, or \`refactor_copy_lines\`), remember that files are strictly 1-indexed. The first line of a file is line 1. Be extremely careful to calculate line offsets accurately to avoid off-by-one errors.
- Strict XML: Use only the exact tags provided. Do not invent new tools.
- NEVER include code in your conversational output or reasoning
- NEVER use control or tool tags to discuss or think about your actions, only to perform them.`;
    } else {
        coreRules = `
- AWALYS call EXACTLY ONE tool per turn
- AWALYS consider the most appropriate / efficient tool choices for the task
- For information that is temporaly variant (technology, pricing, current events), treat your internal knowledge as potentially obsolete. Prioritize using \`research\` to validate facts against the the current date (${new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', }).format(new Date())})
- Context Limits **STRICT REQUIREMENT**: 
	Conserve context size by
	Explore files by reading their outlines with \`read_file_outline\` and \`search_in_file\`
	Use outline symbols and searched line numbers to read targetted file sections
	Use \`edit_file\` for code changes in small blocks, the system accumulates them for user review and rollback (if needed)
	NEVER read a whole file if you can just read part of it
	
`;
    }

    const projectManagementSection = `
# Project Management & Orchestration
The host maintains your plan and task list. To save tokens ONLY use these tools to CREATE or ALTER them:
- Call \`create_implementation_plan\` to define your overarching approach. You may optionally supply the \`tasks\` parameter at the same time to establish the initial task list.
- Call \`update_task_list\` to provide a markdown checkbox list (e.g., \`- [ ] Step 1\`).
- When you finish a task, call \`complete_task\` with the task name. The host will mark it [x] automatically. DO NOT rewrite the full task list just to check a box. 
- When you have completed all tasks in your list and have no further actions to perform, call the \`done\` tool.
- Call \`create_sub_agent\` to delegate discrete tasks—such as exploring, analyzing, or locating specific code implementations—to specialized sub-agents. This keeps your main context window clean, saves tokens, and allows independent tasks to run concurrently.
- If you're not sure, ask the user questions, or delegate exploratory tasks to sub-agents.
- Avoid rambling or repetitive content outputs`;

    return `You are Cadence, an AI software engineer, pair programming with a human software engineer.
The human user is the expert on the intent of your tasks, defer to them if unsure.
${toolsSection}
${exampleTurn}
# Core Rules
${thinkingRule}
${taskFocusRule}
${loopingRule}
${coreRules}
${projectManagementSection}`;
}

// - ALWAYS choose the least impactful tool (don't read the whole file if you only need the lines of function)
// - ALWAYS make the smallest atomic edits when using \`edit_file\`