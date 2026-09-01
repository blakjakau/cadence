const messages = [
    {
        role: "user",
        type: "user",
        content: "Search for files"
    },
    {
        role: "model",
        type: "model",
        content: "<thought>Checking files</thought><tool_call name=\"search_files\">\n  <query>CodeAgent</query>\n</tool_call>",
        thoughtSignature: "sig_abc_123",
        toolCalls: [
            {
                functionCall: { name: "search_files", args: { query: "CodeAgent" } },
                thoughtSignature: "sig_abc_123"
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
    const preprocessed = [];
    for (const msg of messages) {
        if (msg.type === 'file_context') {
            preprocessed.push(msg);
            continue;
        }
        
        const role = msg.role === 'model' ? 'model' : 'user';
        const last = preprocessed.length > 0 ? preprocessed[preprocessed.length - 1] : null;
        
        if (last && last.role === role && last.type !== 'file_context') {
            last.content = (last.content || '') + '\n\n' + (msg.content || '');
            if (msg.toolCalls) {
                last.toolCalls = (last.toolCalls || []).concat(msg.toolCalls);
            }
            const sig = msg.thoughtSignature || msg.thought_signature;
            if (sig) {
                last.thoughtSignature = sig;
            }
        } else {
            preprocessed.push({
                ...msg,
                role: role
            });
        }
    }

    const contents = [];
    for (const msg of preprocessed) {
        if (msg.role === 'user' || msg.role === 'model') {
            const contentStr = typeof msg.content === 'string' ? msg.content : '';
            const hasToolResponse = msg.role === 'user' && (msg.type === 'tool_response' || contentStr.includes('[Tool Response: '));
            
            if (hasToolResponse) {
                const parts = [];
                const regex = /\[Tool Response: ([^\]]+)\]\n\n/g;
                let match;
                const matches = [];
                
                while ((match = regex.exec(contentStr)) !== null) {
                    matches.push({
                        toolName: match[1].split(' ')[0],
                        index: match.index,
                        contentStart: regex.lastIndex
                    });
                }
                
                if (matches.length > 0) {
                    if (matches[0].index > 0) {
                        const leadingText = contentStr.substring(0, matches[0].index).trim();
                        if (leadingText) {
                            parts.push({ text: leadingText });
                        }
                    }

                    for (let i = 0; i < matches.length; i++) {
                        const current = matches[i];
                        const next = matches[i + 1];
                        let sectionContent = next ? contentStr.substring(current.contentStart, next.index) : contentStr.substring(current.contentStart);
                        
                        sectionContent = sectionContent.replace(/\n\n---\n\n$/, '').trim();
                        
                        parts.push({
                            functionResponse: {
                                name: current.toolName,
                                response: { result: sectionContent }
                            }
                        });
                    }
                } else if (contentStr.trim()) {
                    parts.push({ text: contentStr.trim() });
                }

                if (parts.length > 0) {
                    contents.push({
                        role: 'user',
                        parts: parts
                    });
                    continue;
                }
            }
            
            if (msg.role === 'model') {
                let toolCalls = msg.toolCalls;
                if ((!toolCalls || toolCalls.length === 0) && contentStr.includes('<tool_call')) {
                    const parsed = [];
                    const toolCallRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
                    let tcMatch;
                    while ((tcMatch = toolCallRegex.exec(contentStr)) !== null) {
                        const toolName = tcMatch[1];
                        const toolArgsContent = tcMatch[2];
                        let args = {};
                        try {
                            args = JSON.parse(toolArgsContent.trim());
                        } catch (e) {
                            const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
                            let tagMatch;
                            while ((tagMatch = tagRegex.exec(toolArgsContent)) !== null) {
                                args[tagMatch[1]] = tagMatch[2].trim();
                            }
                        }
                        const sig = msg.thoughtSignature || msg.thought_signature;
                        parsed.push({
                            id: `call_${crypto.randomUUID()}`,
                            name: toolName,
                            args: args,
                            ...(sig ? { thoughtSignature: sig } : {})
                        });
                    }
                    if (parsed.length > 0) {
                        toolCalls = parsed;
                    }
                }

                if (toolCalls && toolCalls.length > 0) {
                    const parts = [];
                    
                    let textPart = contentStr;
                    const toolCallIdx = contentStr.indexOf('<tool_call');
                    if (toolCallIdx !== -1) {
                        textPart = contentStr.substring(0, toolCallIdx).trim();
                    }
                    if (textPart) {
                        parts.push({ text: textPart });
                    }

                    for (const rawCall of toolCalls) {
                        const callObj = rawCall.functionCall || rawCall;
                        let args = callObj.args || callObj.arguments || {};
                        if (typeof args === 'string') {
                            try {
                                args = JSON.parse(args);
                            } catch (e) {
                                console.error("[Gemini] Failed to parse tool call arguments as JSON:", args, e);
                                args = {};
                            }
                        }
                        const functionCallPart = {
                            functionCall: {
                                name: callObj.name || rawCall.name,
                                args: args
                            }
                        };
                        const sig = rawCall.thoughtSignature || rawCall.thought_signature || callObj.thoughtSignature || callObj.thought_signature || msg.thoughtSignature || msg.thought_signature;
                        if (sig) {
                            functionCallPart.thoughtSignature = sig;
                        }
                        parts.push(functionCallPart);
                    }

                    contents.push({
                        role: 'model',
                        parts: parts
                    });
                    continue;
                }
            }

            contents.push({ role: msg.role, parts: [{ text: contentStr }] });
        } else if (msg.type === 'file_context') {
            const fileContent = `--- File: ${msg.filename || msg.id} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``;
            if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
                contents[contents.length - 1].parts.push({ text: fileContent });
            } else {
                contents.push({ role: 'user', parts: [{ text: fileContent }] });
            }
        }
    }
    return contents;
}

const prepared = prepareMessagesForAI(messages);
const geminiContents = _toGeminiContents(prepared);

console.log(JSON.stringify(geminiContents, null, 2));
