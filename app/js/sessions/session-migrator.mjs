// sessions/session-migrator.mjs
// Handles JIT migrations of AI session data structures and chat history.

export const CURRENT_SESSION_VERSION = 2;

export class SessionMigrator {
    /**
     * Migrates a session object to the latest version.
     * Returns { session, modified: boolean }.
     * @param {Object} session 
     * @returns {{ session: Object, modified: boolean }}
     */
    static migrate(session) {
        if (!session) return { session, modified: false };

        let modified = false;
        const currentVersion = session.version || 1;

        if (currentVersion < 2) {
            session = this.migrateV1ToV2(session);
            session.version = 2;
            modified = true;
        }

        return { session, modified };
    }

    /**
     * Migration from Version 1 (mixed XML/JSON in chat history) to Version 2 (standardized JSON).
     * @param {Object} session 
     * @returns {Object}
     */
    static migrateV1ToV2(session) {
        if (!session.messages || !Array.isArray(session.messages)) {
            session.messages = [];
            return session;
        }

        const migratedMessages = session.messages.map(msg => {
            if (!msg) return msg;

            // Only model and assistant messages had XML thoughts/tool calls
            if (msg.role === 'model' || msg.type === 'model' || msg.role === 'assistant') {
                let content = msg.content || "";
                let toolCalls = Array.isArray(msg.toolCalls) ? [...msg.toolCalls] : [];
                let thought = msg.thought || "";

                // 1. Extract thought from XML tags if not already in msg.thought
                if (!thought && content) {
                    const thoughtMatch = content.match(/<(?:thought|think)>([\s\S]*?)<\/(?:thought|think)>/i)
                        || content.match(/<\|channel\>thought\n([\s\S]*?)(?:<\|channel\>|$)/i);
                    if (thoughtMatch) {
                        thought = thoughtMatch[1].trim();
                    }
                }

                // Strip thought XML tags from content
                if (content) {
                    content = content
                        .replace(/<(?:thought|think)>[\s\S]*?<\/(?:thought|think)>/gi, '')
                        .replace(/<\|channel\>thought\n[\s\S]*?(?:<\|channel\>|$)/gi, '');
                }

                // 2. Extract tool calls from XML if toolCalls array is empty
                if (toolCalls.length === 0 && content && content.includes('<tool_call')) {
                    const extractedCalls = this._parseXmlToolCalls(content);
                    if (extractedCalls.length > 0) {
                        toolCalls = extractedCalls;
                    }
                }

                // 3. Strip all <tool_call> and loose XML tool tags from content
                if (content) {
                    content = content
                        .replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '')
                        .replace(/<tool_call[\s\S]*?>/gi, '')
                        .replace(/<\/tool_call>/gi, '')
                        .trim();
                }

                // Normalize toolCalls format to standard { id, name, args }
                const normalizedToolCalls = toolCalls.map(tc => {
                    const callObj = tc.functionCall || tc;
                    let args = callObj.args || callObj.arguments || {};
                    if (typeof args === 'string') {
                        try {
                            args = JSON.parse(args);
                        } catch (e) {
                            args = {};
                        }
                    }
                    return {
                        id: tc.id || `call_${crypto.randomUUID()}`,
                        name: callObj.name || tc.name || "",
                        args: args,
                        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {})
                    };
                }).filter(tc => tc.name);

                return {
                    ...msg,
                    content: content,
                    ...(thought ? { thought } : {}),
                    ...(normalizedToolCalls.length > 0 ? { toolCalls: normalizedToolCalls } : {})
                };
            }

            return msg;
        });

        session.messages = migratedMessages;
        return session;
    }

    /**
     * Parses legacy XML tool calls from string content.
     * @param {string} content 
     * @returns {Array<Object>}
     */
    static _parseXmlToolCalls(content) {
        const calls = [];
        const regex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
        let match;

        while ((match = regex.exec(content)) !== null) {
            const name = match[1];
            const inner = match[2];
            const args = {};

            const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
            let tagMatch;
            while ((tagMatch = tagRegex.exec(inner)) !== null) {
                const key = tagMatch[1];
                let val = tagMatch[2];
                if (key !== 'search' && key !== 'replace' && key !== 'content' && key !== 'plan' && key !== 'tasks') {
                    val = val.trim();
                }
                args[key] = val;
            }

            // Handle nested <edit> tags
            if (inner.includes("<edit>") || inner.includes("<edits>")) {
                const edits = [];
                const editRegex = /<edit>([\s\S]*?)<\/edit>/g;
                let editMatch;
                while ((editMatch = editRegex.exec(inner)) !== null) {
                    const editBlock = editMatch[1];
                    const searchMatch = editBlock.match(/<search>([\s\S]*?)<\/search>/);
                    const replaceMatch = editBlock.match(/<replace>([\s\S]*?)<\/replace>/);
                    if (searchMatch || replaceMatch) {
                        edits.push({
                            search: searchMatch ? searchMatch[1] : "",
                            replace: replaceMatch ? replaceMatch[1] : ""
                        });
                    }
                }
                if (edits.length > 0) {
                    args.edits = edits;
                }
            }

            calls.push({
                id: `call_${crypto.randomUUID()}`,
                name: name,
                args: args
            });
        }

        return calls;
    }
}

export default SessionMigrator;
