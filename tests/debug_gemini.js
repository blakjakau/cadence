const messages = [
    {
        role: "user",
        type: "user",
        content: "Search for files"
    },
    {
        role: "model",
        type: "model",
        content: "<tool_call name=\"search_files\">\n  <query>CodeAgent</query>\n</tool_call>",
        toolCalls: [
            {
                functionCall: { name: "search_files", args: { query: "CodeAgent" } }
            }
        ]
    },
    {
        role: "user",
        type: "tool_response",
        content: "[Tool Response: search_files]\n\nFound it"
    }
];

function prepareMessagesForAI(messages) {
    let chatHistory = messages.map(msg => ({ ...msg }));
    chatHistory = chatHistory.map(msg => {
        if (msg.content) {
            let newContent = msg.content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
            return {
                ...msg,
                content: newContent.trim()
            };
        }
        return msg;
    }).filter(msg => msg.content && msg.content.trim() !== "");
    return chatHistory;
}

function _toGeminiContents(messages) {
    const contents = [];
    for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'model') {
            if (msg.role === 'user' && msg.content.startsWith('[Tool Response: ')) {
                const match = msg.content.match(/\[Tool Response: ([^\]]+)\]\n\n([\s\S]*)/);
                if (match) {
                    const toolName = match[1];
                    const toolResponse = match[2];
                    contents.push({
                        role: 'function',
                        parts: [{
                            functionResponse: {
                                name: toolName,
                                response: { result: toolResponse }
                            }
                        }]
                    });
                    continue;
                }
            }
            
            if (msg.role === 'model') {
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    const parts = [];
                    let textPart = msg.content;
                    const toolCallIdx = msg.content.indexOf('<tool_call');
                    if (toolCallIdx !== -1) {
                        textPart = msg.content.substring(0, toolCallIdx).trim();
                    }
                    if (textPart) {
                        parts.push({ text: textPart });
                    }
                    for (const rawCall of msg.toolCalls) {
                        const functionCallPart = {
                            functionCall: rawCall.functionCall || rawCall
                        };
                        parts.push(functionCallPart);
                    }
                    contents.push({
                        role: 'model',
                        parts: parts
                    });
                    continue;
                }
            }

            contents.push({ role: msg.role, parts: [{ text: msg.content }] });
        }
    }
    return contents;
}

const prepared = prepareMessagesForAI(messages);
const geminiContents = _toGeminiContents(prepared);

console.log(JSON.stringify(geminiContents, null, 2));
