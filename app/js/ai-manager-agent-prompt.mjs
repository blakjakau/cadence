import { tools } from './ai-manager-tools-schema.mjs';

function generateXmlToolDocs(planningMode = false) {
    let xml = "";
    for (const tool of tools) {
        if (planningMode && (tool.name === "create_file" || tool.name === "edit_file")) {
            continue;
        }
        xml += `<tool_call name="${tool.name}">\n`;
        for (const [propName, propDetails] of Object.entries(tool.parameters.properties)) {
            const isOptional = !tool.parameters.required.includes(propName);
            const optionalStr = isOptional ? " <!-- Optional -->" : "";
            xml += `  <${propName}>...</${propName}>${optionalStr}\n`;
        }
        xml += `</tool_call>\n`;
    }
    if (!planningMode) {
        xml += `* Note: For edit_file, <search> MUST perfectly match existing file content character-for-character.\n`;
    }
    return xml.trim();
}

export default function getAgentSystemPrompt(modelName = '', features = {}) {
    // True native reasoning models like DeepSeek R1 or Gemini Flash Thinking
    const isNativeReasoning = modelName.includes('r1') || modelName.includes('thinking') || modelName.includes('gemma-4');
    
    // Unpack features
    const supportsNativeTools = features.supportsJSONTools !== undefined ? features.supportsJSONTools : modelName.includes('gemini');
    const hasPlan = !!features.hasPlan;
    const hasTasks = !!features.hasTasks;
    const hasAcceptedPlan = !!features.hasAcceptedPlan;
    const hasCompletedAllTasks = !!features.hasCompletedAllTasks;
    const planningMode = !!features.planningMode;

    const directives = [];
    if (!hasPlan) {
        directives.push("- Use `list_files`, `find_file`, `search_files`, or `read_file_outline` to analyze the project codebase.");
        directives.push("- Use `create_implementation_plan` to outline your strategy and architectural changes (do NOT include a task list here).");
    } else {
        if (!hasAcceptedPlan) {
            directives.push("- Address the user's feedback to update the implementation plan.");
        }
        if (!hasTasks) {
            directives.push("- Use `create_implementation_plan` to define your task list by supplying the optional `tasks` parameter, or call `update_task_list` to list implementation tasks based on the plan.");
        } else if (!hasCompletedAllTasks) {
            directives.push("- Work on the tasks in your task checklist one by one, calling `complete_task` as you finish each task.");
        } else {
            directives.push("- All tasks are marked as complete. Review your changes with the user and call the `done` tool to signal task completion.");
        }
    }

    let dynamicDirectivesSection = "";
    if (directives.length > 0) {
        dynamicDirectivesSection = `\n\n# Current Directives\n${directives.join('\n')}`;
    }
    
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
        thinkingRule = "- Thinking: Leverage your native thinking/reasoning capability to analyze the task before making tool calls.";
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
        loopingRule = "- Looping Prevention: Actively review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    } else {
        loopingRule = "- Looping Prevention: In your <thought> block, actively review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    }

    let toolsSection = "";
    if (!supportsNativeTools) {
        toolsSection = `
# Available Tools
Choose AT MOST ONE tool per turn and use its exact format, the host will return results for your next step.
${generateXmlToolDocs(planningMode)}
`;
    }

    let coreRules = "";
    if (!supportsNativeTools) {
        coreRules = `
- Tools: Use AT MOST ONE tool call block per turn. Wait for the host to provide the result.
- Always choose the least impactful tool (don't read the whole file if you only need a lines of function)
- Context Limits: ALWAYS explore files by reading their outlines first using read_file_outline. Outlines provide symbol line numbers and lengths. NEVER read a full file if you can extract just the function you need using the <startLine> and <lineCount> parameters of read_file. If you need to find exact text inside a file, use search_in_file to locate the exact line numbers and surrounding context. This saves token context window.
- Strict XML: Use only the exact tags provided. Do not invent new tools.
- NEVER use control or tool tags to discuss or think about your actions, only to perform them.`;
    } else {
        coreRules = `
- Ensure an implementation plan and task list are created BEFORE using 'edit' and 'create' tools
- ALWAYS report your intentions to the user BEFORE you start making tools calls
- NEVER include large chunks of code in your conversational output
- Context Limits: Explore files by reading their outlines with read_file_outline and search_in_file
	Outlines provide symbols with line numbers and lengths. 
	You can find text in a file using 'search_in_file' to locate the exact line number
	NEVER read a whole file, when you only need part of it.
`;
    }

    const projectManagementSection = `
# Project Management & Orchestration
The host maintains your plan and task list. To save tokens ONLY use these tools to CREATE or ALTER them:
- Call \`create_implementation_plan\` to define your overarching approach. You may optionally supply the \`tasks\` parameter at the same time to establish the initial task list.
- Call \`update_task_list\` to provide a markdown checkbox list (e.g., \`- [ ] Step 1\`).
- **STRICT REQUIREMENT**: Never mix the task list into the \`plan\` parameter text. The \`plan\` parameter must ONLY contain design, architecture, and modifications. Keep task items inside the separate \`tasks\` parameter or use the separate \`update_task_list\` tool call.
- When you finish a task, call \`complete_task\` with the task name. The host will mark it [x] automatically. DO NOT rewrite the full task list just to check a box. 
- When you have completed all tasks in your list and have no further actions to perform, call the \`done\` tool.`;

    return `You are Cadence, an AI software engineer, pair programming with a human software engineer.
The human user is the expert on the intent of your tasks, defer to them if unsure.
${toolsSection}
${exampleTurn}
# Core Rules
${thinkingRule}
${taskFocusRule}
${loopingRule}
${coreRules}
${projectManagementSection}
${dynamicDirectivesSection}`;
}