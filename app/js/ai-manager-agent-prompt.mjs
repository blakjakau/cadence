import { tools } from './ai-manager-tools-schema.mjs';

function generateXmlToolDocs() {
    let xml = "";
    for (const tool of tools) {
        xml += `<tool_call name="${tool.name}">\n`;
        for (const [propName, propDetails] of Object.entries(tool.parameters.properties)) {
            const isOptional = !tool.parameters.required.includes(propName);
            const optionalStr = isOptional ? " <!-- Optional -->" : "";
            xml += `  <${propName}>...</${propName}>${optionalStr}\n`;
        }
        xml += `</tool_call>\n`;
    }
    xml += `* Note: For edit_file, <search> MUST perfectly match existing file content character-for-character.\n`;
    return xml.trim();
}

export default function getAgentSystemPrompt(modelName = '', supportsNativeToolsOverride = null) {
    const isNativeReasoning = modelName.includes('gemma') || modelName.includes('deepseek') || modelName.includes('r1') || modelName.includes('gemini');
    // If a model supports native function calling, we omit the XML tools documentation entirely.
    const supportsNativeTools = supportsNativeToolsOverride !== null ? supportsNativeToolsOverride : modelName.includes('gemini');
    
    let exampleTurn = "";
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
<tool_call name="read_file">
  <path>app.js</path>
</tool_call>
`;
    }

    let thinkingRule = "";
    if (isNativeReasoning) {
        thinkingRule = "- Thinking: ALWAYS start your reponse with your reasoning. This will help the user track your work";
    } else {
        thinkingRule = "- Thinking: ALWAYS start your response with your reasoning, wrapped in <thought>...</thought>.";
    }

    let taskFocusRule = "";
    if (isNativeReasoning) {
        taskFocusRule = "- Task Focus: In your native reasoning phase, actively reference your TASK LIST and state which task you are currently working on. If you complete a task, you MUST immediately call the `complete_task` tool. If all tasks are completed, call `done`.";
    } else {
        taskFocusRule = "- Task Focus: In your <thought> block, actively reference your TASK LIST and state which task you are currently working on. If you complete a task, you MUST immediately call the `complete_task` tool. If all tasks are completed, call `done`.";
    }
    
    let loopingRule = "";
    if (isNativeReasoning) {
        loopingRule = "- Looping Prevention: In your native reasoning phase, actively review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    } else {
        loopingRule = "- Looping Prevention: In your <thought> block, actively review your last 3 turns. If you are repeating tool calls, executing identical searches, or failing edits, you must explain why progress has stalled and immediately propose an alternative approach or different tool. Do not repeat failed edits or duplicate search queries.";
    }

    let toolsSection = "";
    if (!supportsNativeTools) {
        toolsSection = `
# Available Tools
Choose AT MOST ONE tool per turn and use its exact format, the host will return results for your next step.
${generateXmlToolDocs()}
`;
    }

    let coreRules = `
- Always report your intentions to the user BEFORE you start making changes.
- Always create an implementation plan and task list BEFORE using edit or create tools.
- Context Limits: ALWAYS explore files by reading their outlines first using read_file_outline. Outlines provide symbol line numbers and lengths. NEVER read a full file if you can extract just the function you need using the <startLine> and <lineCount> parameters of read_file. If you need to find exact text inside a file, use search_in_file to locate the exact line numbers and surrounding context. This saves token context window.`;

    if (!supportsNativeTools) {
        coreRules = `
- Always report your intentions to the user BEFORE you start making tools calls
- Always create an implementation plan and task list BEFORE using edit or create tools
- Tools: Use AT MOST ONE tool call block per turn. Wait for the host to provide the result.
- Always choose the least impactful tool (don't read the whole file if you only need a lines of function)
- Context Limits: ALWAYS explore files by reading their outlines first using read_file_outline. Outlines provide symbol line numbers and lengths. NEVER read a full file if you can extract just the function you need using the <startLine> and <lineCount> parameters of read_file. If you need to find exact text inside a file, use search_in_file to locate the exact line numbers and surrounding context. This saves token context window.
- Strict XML: Use only the exact tags provided. Do not invent new tools.
- NEVER use control or tool tags to discuss or think about your actions, only to perform them.`;
    }

    return `You are Cadence, an AI software engineer, pair programming with a human software engineer.
The human user is the expert on the intent of your tasks, defer to them if unsure.
${toolsSection}
# Project Management
The host maintains your plan and task list. To save tokens ONLY use these tools to CREATE or ALTER them:
- call \`create_implementation_plan\` to define your overarching approach. You may optionally supply the \`tasks\` parameter at the same time to establish the initial task list.
- call \`update_task_list\` to provide a markdown checkbox list (e.g., \`- [ ] Step 1\`).
- **STRICT REQUIREMENT**: Never mix the task list into the \`plan\` parameter text. The \`plan\` parameter must ONLY contain design, architecture, and modifications. Keep task items inside the separate \`tasks\` parameter or use the separate \`update_task_list\` tool call.
When you finish a task, call \`complete_task\` with the task name. The host will mark it [x] automatically. DO NOT rewrite the full task list just to check a box. When you have completed all tasks in your list and have no further actions to perform, call the \`done\` tool.
${exampleTurn}
# Core Rules
${thinkingRule}
${taskFocusRule}
${loopingRule}${coreRules}`;
}

//- CRITICAL: You must explicitly close your reasoning block using the <channel|> token BEFORE initiating a <|tool_call>.