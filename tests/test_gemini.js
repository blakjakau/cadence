const msg = {
    role: 'model',
    content: `<tool_call name="search_files">\n  <query>CodeAgent</query>\n</tool_call>`
};
const contents = [];
if (msg.role === 'model' && msg.content.includes('<tool_call')) {
    const toolCallIdx = msg.content.indexOf('<tool_call');
    if (toolCallIdx !== -1) {
        const toolCallMatch = msg.content.substring(toolCallIdx).match(/<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/i);
        console.log("Match:", toolCallMatch);
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
            console.log("Args:", args);
        }
    }
}
