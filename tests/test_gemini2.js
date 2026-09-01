const msg = {
    role: 'model',
    content: `<thought>\nthis is a thought\n</thought>\n<tool_call name="search_files">\n  <query>CodeAgent</query>\n</tool_call>`,
    thoughtSignature: 'some_sig'
};
const messages = [msg];

function _toGeminiContents(messages) {
    const contents = [];
    for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'model') {
            if (msg.role === 'user' && msg.content.startsWith('[Tool Response: ')) {
                continue;
            }
            
            if (msg.role === 'model' && msg.content.includes('<tool_call')) {
                const toolCallIdx = msg.content.indexOf('<tool_call');
                if (toolCallIdx !== -1) {
                    const toolCallMatch = msg.content.substring(toolCallIdx).match(/<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/i);
                    if (toolCallMatch) {
                        const toolName = toolCallMatch[1];
                        const toolArgsContent = toolCallMatch[2];
                        const args = {};
                        const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
                        let tagMatch;
                        while ((tagMatch = tagRegex.exec(toolArgsContent)) !== null) {
                            const key = tagMatch[1];
                            let val = tagMatch[2].trim();
                            args[key] = val;
                        }

                        const parts = [];
                        const prefixText = msg.content.substring(0, toolCallIdx).trim();
                        if (prefixText) {
                            parts.push({ text: prefixText });
                        }

                        const functionCallPart = {
                            functionCall: {
                                name: toolName,
                                args: args
                            }
                        };

                        if (msg.thoughtSignature) {
                            functionCallPart.thoughtSignature = msg.thoughtSignature;
                        }

                        parts.push(functionCallPart);

                        contents.push({
                            role: 'model',
                            parts: parts
                        });
                        continue;
                    }
                }
            }

            contents.push({ role: msg.role, parts: [{ text: msg.content }] });
        }
    }
    return contents;
}

console.log(JSON.stringify(_toGeminiContents(messages), null, 2));
