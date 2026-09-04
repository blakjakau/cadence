import { Block, Button, Icon } from "./elements.mjs"
import DiffHandler from "./tools/diff-handler.mjs"
import hljs from "./tools/highlightjs.mjs"
import workspaceClient from "./workspace-client.mjs"

export default class AIManagerMessageRenderer {
    constructor(aiManager) {
        this.aiManager = aiManager;
    }

    _escapeHtml(text) {
        if (!text) return "";
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    formatByteSize(bytes, short = false) {
        if (!bytes || bytes <= 0) return short ? "0B" : "0 bytes";
        if (bytes > 1000) {
            const kb = (bytes / 1024).toFixed(1);
            return short ? `${kb}KB` : `${kb} KB`;
        }
        return short ? `${bytes}B` : `${bytes.toLocaleString()} bytes`;
    }

    parseToolArgs(toolArgs) {
        if (!toolArgs) return {};
        const args = {};
        const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(toolArgs)) !== null) {
            const key = tagMatch[1];
            let val = tagMatch[2];
            if (key !== 'search' && key !== 'replace' && key !== 'content' && key !== 'plan' && key !== 'tasks') {
                val = val.trim();
            }
            args[key] = val;
        }

        // Parse nested <edit> tags inside <edits> or standalone <edit> tags
        if (toolArgs.includes("<edit>") || toolArgs.includes("<edits>")) {
            const edits = [];
            const editRegex = /<edit>([\s\S]*?)<\/edit>/g;
            let editMatch;
            while ((editMatch = editRegex.exec(toolArgs)) !== null) {
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
            // Check unclosed streaming edit tag
            const lastEditIdx = toolArgs.lastIndexOf("<edit>");
            if (lastEditIdx !== -1) {
                const afterLastEdit = toolArgs.substring(lastEditIdx + 6);
                if (!afterLastEdit.includes("</edit>")) {
                    const searchMatch = afterLastEdit.match(/<search>([\s\S]*?)(?:<\/search>|$)/);
                    const replaceMatch = afterLastEdit.match(/<replace>([\s\S]*?)(?:<\/replace>|$)/);
                    if (searchMatch || replaceMatch) {
                        edits.push({
                            search: searchMatch ? searchMatch[1] : "",
                            replace: replaceMatch ? replaceMatch[1] : ""
                        });
                    }
                }
            }
            if (edits.length > 0) {
                args.edits = edits;
            }
        }

        // Parse unclosed tags at the end of the streaming tool args
        const openTags = ['path', 'query', 'search', 'replace', 'content', 'plan', 'tasks', 'taskName', 'startLine', 'lineCount', 'startline', 'linecount', 'result', 'command', 'cwd', 'dir', 'url'];
        for (const tag of openTags) {
            if (args[tag] === undefined) {
                const tagStartStr = `<${tag}>`;
                const idx = toolArgs.lastIndexOf(tagStartStr);
                if (idx !== -1) {
                    const tagEndStr = `</${tag}>`;
                    const endIdx = toolArgs.indexOf(tagEndStr, idx + tagStartStr.length);
                    if (endIdx === -1) {
                        let val = toolArgs.substring(idx + tagStartStr.length);
                        if (tag !== 'search' && tag !== 'replace' && tag !== 'content' && tag !== 'plan' && tag !== 'tasks') {
                            val = val.trim();
                        }
                        args[tag] = val;
                    }
                }
            }
        }
        return args;
    }

    addCodeBlockButtons(responseBlock, messageObject = null) {
        const preElements = responseBlock.querySelectorAll("pre")
        preElements.forEach((pre, index) => {
            if (pre.querySelector('.code-buttons')) {
                return;
            }

            const codeElement = pre.querySelector("code")
            const isDiff = codeElement && codeElement.classList.contains('language-diff');

            const buttonContainer = new Block()

            if (messageObject && !Array.isArray(messageObject.diffStatuses)) {
                messageObject.diffStatuses = [];
            }
            buttonContainer.classList.add("code-buttons")

            if (!isDiff) {
                const copyButton = new Button()
                copyButton.classList.add("code-button")
                copyButton.icon = "content_copy"
                copyButton.title = "Copy code"
                copyButton.on("click", () => {
                    const code = codeElement ? codeElement.innerText : pre.innerText;
                    navigator.clipboard.writeText(code)
                    copyButton.icon = "done"
                    setTimeout(() => {
                        copyButton.icon = "content_copy"
                    }, 1000)
                })
                buttonContainer.append(copyButton);

                const insertButton = new Button()
                insertButton.classList.add("code-button")
                insertButton.icon = "input"
                insertButton.title = "Insert into editor"
                insertButton.on("click", () => {
                    const code = codeElement ? codeElement.innerText : pre.innerText;
                    const event = new CustomEvent("insert-snippet", { detail: code })
                    window.dispatchEvent(event)
                    insertButton.icon = "done"
                    setTimeout(() => {
                        insertButton.icon = "input"
                    }, 1000)
                })
                buttonContainer.append(insertButton);
            }

            const expandCollapseButton = new Button();
            expandCollapseButton.classList.add("code-button", "expand-collapse-button");

            const codeContent = codeElement ? codeElement.innerText : pre.innerText;
            const lineCount = codeContent.split('\n').length;
            const codeLanguage = codeElement ? Array.from(codeElement.classList).find(cls => cls.startsWith('language-'))?.substring(9) : '';

            if (lineCount < 30) {
                pre.setAttribute("expanded", "");
                expandCollapseButton.style.display = "none";
            } else if (codeLanguage === "diff") {
                pre.setAttribute("expanded", "");
                expandCollapseButton.icon = "unfold_less";
                expandCollapseButton.title = "Collapse code block";
            } else {
                pre.setAttribute("collapsed", "");
                expandCollapseButton.icon = "unfold_more";
                expandCollapseButton.title = "Expand code block";
            }

            expandCollapseButton.on("click", () => {
                if (pre.hasAttribute("collapsed")) {
                    pre.removeAttribute("collapsed");
                    expandCollapseButton.icon = "unfold_more";
                    expandCollapseButton.title = "Expand code block";
                } else if (!pre.hasAttribute("expanded")) {
                    pre.setAttribute("expanded", "");
                    expandCollapseButton.icon = "unfold_less";
                    expandCollapseButton.title = "Collapse code block";
                } else {
                    pre.removeAttribute("expanded");
                    pre.setAttribute("collapsed", "");
                    expandCollapseButton.icon = "unfold_more";
                    expandCollapseButton.title = "Expand code block";
                }
            });
            buttonContainer.append(expandCollapseButton)

            if (isDiff) {
                const originalDiffString = codeElement.textContent;

                const highlightLang = this.inferLanguageFromDiff(originalDiffString);

                const renderedDiffHtml = DiffHandler.renderStateless(originalDiffString, 'html', highlightLang, hljs);
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedDiffHtml;
                const newPreContent = tempDiv.querySelector('.diff-output')?.innerHTML || '';

                if (newPreContent) {
                    pre.innerHTML = newPreContent;
                    pre.classList.add('diff-output');
                    pre.dataset.originalDiffContent = originalDiffString;
                } else {
                    console.warn("DiffHandler.renderStateless returned unexpected output for diff block.");
                }

                const applyDiffButton = new Button();
                applyDiffButton.classList.add("code-button");

                if (messageObject && messageObject.diffStatuses && messageObject.diffStatuses[index]) {
                    applyDiffButton.icon = "done";
                    applyDiffButton.title = "Diff applied successfully!";

                    pre.removeAttribute("expanded");
                    pre.setAttribute("collapsed", "");
                    expandCollapseButton.icon = "unfold_more";
                    expandCollapseButton.title = "Expand code block";

                } else {
                    applyDiffButton.icon = "merge";
                    applyDiffButton.title = "Apply diff to file";
                }

                applyDiffButton.on("click", async () => {
                    const rawDiff = pre.dataset.originalDiffContent;
                    if (!rawDiff) {
                        alert("Error: Could not retrieve original diff content to apply.");
                        return;
                    }

                    const targetPathMatch = rawDiff.match(/^\+\+\+ b\/(.+)$/m) || rawDiff.match(/^\+\+\+ (.+)$/m);
                    if (!targetPathMatch || !targetPathMatch[1]) {
                        alert("Error: Could not determine target file path from diff header. Ensure the diff starts with '+++ b/filename'.");
                        return;
                    }
                    const targetPath = targetPathMatch[1];

                    let originalContentFromContext = null;
                    const normalizedTargetPath = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;

                    let exactMatch = null;
                    let partialMatches = [];

                    for (let i = this.aiManager.activeSession.messages.length - 1; i >= 0; i--) {
                        const msg = this.aiManager.activeSession.messages[i];
                        if (msg.type === "file_context" && msg.id) {
                            const normalizedMsgId = msg.id.startsWith('/') ? msg.id.substring(1) : msg.id;
                            if (normalizedMsgId === normalizedTargetPath) {
                                exactMatch = msg.content;
                                break;
                            }
                            if (normalizedMsgId.endsWith(normalizedTargetPath)) {
                                partialMatches.push(msg.content);
                            }
                        }
                    }

                    if (exactMatch) {
                        originalContentFromContext = exactMatch;
                    } else if (partialMatches.length > 0) {
                        originalContentFromContext = partialMatches[0];
                    }

                    if (!originalContentFromContext) {
                        alert(`Error: The original content for "${targetPath}" was not found in this chat session's context history. Cannot apply diff.`);
                        return;
                    }

                    let tabToUpdate = await this.aiManager.ai._getTabSessionByPath(targetPath);
                    if (!tabToUpdate && !targetPath.startsWith('/')) {
                        tabToUpdate = await this.aiManager.ai._getTabSessionByPath(`/${targetPath}`);
                    }

                    if (!tabToUpdate) {
                        alert(`Error: File "${targetPath}" is not currently open in the editor. Please open the file to apply the diff.`);
                        return;
                    }

                    const newFileContentFromDiff = DiffHandler.applyAIResponseDiff(originalContentFromContext, rawDiff);

                    if (newFileContentFromDiff === null) {
                        alert(`Failed to apply diff to "${targetPath}". There might be a content mismatch with the file as it was originally sent to AI. Please review the diff manually.`);
                        console.error("Diff application failed:", { originalContentFromContext, rawDiff });
                        applyDiffButton.classList.remove("diff-apply-success");
                        applyDiffButton.classList.add("diff-apply-failed");
                    } else {

                        const session = tabToUpdate.config.session;
                        const doc = session.getDocument();
                        const lastRow = doc.getLength() - 1;
                        const lastCol = doc.getLine(lastRow).length;
                        const fullRange = new window.ace.Range(0, 0, lastRow, lastCol);
                        session.replace(fullRange, newFileContentFromDiff);

                        applyDiffButton.classList.remove("diff-apply-failed");
                        applyDiffButton.classList.add("diff-apply-success");
                        applyDiffButton.icon = "done";
                        applyDiffButton.title = "Diff applied successfully!";
                        if (messageObject) {
                            messageObject.diffStatuses[index] = true;
                            await workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
                        }
                        this.aiManager.historyManager.addMessage({
                            type: "system_message",
                            content: `Diff successfully applied to **${targetPath}**. Remember to save the file.`,
                            timestamp: Date.now(),
                        }, false);
                    }
                });
                buttonContainer.append(applyDiffButton);
            }

            pre.prepend(buttonContainer)
        })
    }

    /**
     * Escapes faux XML tags (e.g. <thought>, <tool_call>, etc.) outside markdown code blocks and inline backticks
     * so they are rendered as plain visible text rather than swallowed or parsed as HTML nodes.
     * @param {string} text 
     * @returns {string}
     */
    escapeFauxTags(text) {
        if (!text || typeof text !== 'string') return text || "";
        if (!text.includes("<")) return text;

        const regex = /<\/?(?:thought|think|thinking|tool_call(?:\s+[^>]*)?|implementation_plan|task_list|complete_task)>|<\|channel\>thought|<channel\|>|<\|channel\|>/gi;

        let result = "";
        let i = 0;
        let inCodeBlock = false;
        let inInlineCode = false;
        const len = text.length;

        while (i < len) {
            if (text.startsWith("```", i)) {
                inCodeBlock = !inCodeBlock;
                result += "```";
                i += 3;
                continue;
            }
            if (text.startsWith("`", i) && !inCodeBlock) {
                inInlineCode = !inInlineCode;
                result += "`";
                i += 1;
                continue;
            }

            if (inCodeBlock || inInlineCode) {
                result += text[i];
                i++;
                continue;
            }

            if (text[i] === '<') {
                regex.lastIndex = i;
                const match = regex.exec(text);
                if (match && match.index === i) {
                    const tag = match[0];
                    const escaped = tag.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    result += escaped;
                    i += tag.length;
                    continue;
                }
            }

            result += text[i];
            i++;
        }

        return result;
    }

    /**
     * Checks if XML tag parsing should be bypassed (e.g. for known reasoning / native tool models).
     * @param {Object|null} message 
     * @param {Object|null} session 
     * @param {boolean|null} explicitSkip 
     * @returns {boolean}
     */
    shouldSkipXmlParsing(message = null, session = null, explicitSkip = null) {
        if (explicitSkip !== null && explicitSkip !== undefined) return explicitSkip;
        if (message && (message.thought !== undefined || message.thoughtSignature || message.isThinking)) return true;
        const targetSession = session || (message?.sessionId ? this.aiManager.sessions?.get?.(message.sessionId) : null) || this.aiManager.activeSession;
        return this.aiManager.isKnownReasoningModel ? this.aiManager.isKnownReasoningModel(targetSession) : false;
    }

    /**
     * Extracts thought and clean body text from raw content and structured message,
     * seamlessly handling both closed tags and actively streaming unclosed thought tags.
     * @param {string} content 
     * @param {Object|null} message 
     * @param {boolean|null} skipXml 
     * @returns {{ thinkContent: string, bodyContent: string, isClosed: boolean }}
     */
    extractThoughtAndBody(content, message = null, skipXml = null) {
        let thinkContent = (message?.thought || "").trim();
        let bodyContent = content || "";
        const shouldSkip = this.shouldSkipXmlParsing(message, null, skipXml);

        if (shouldSkip) {
            const isClosed = message?.isThinking ? false : true;
            return { thinkContent, bodyContent, isClosed };
        }

        let isClosed = true;

        if (bodyContent) {
            // Check if content begins with a thought block (closed or unclosed/streaming)
            const openMatch = bodyContent.match(/^(?:\s*<(?:thought|think|thinking)>|\s*<\|channel\>thought\n)/i);
            if (openMatch) {
                const openTag = openMatch[0];
                const contentStart = openMatch.index + openTag.length;
                const closeMatch = bodyContent.match(/<\/(?:thought|think|thinking)>|<\|channel\>/i);
                if (closeMatch) {
                    // Closed thought block
                    if (!thinkContent) {
                        thinkContent = bodyContent.substring(contentStart, closeMatch.index).trim();
                    }
                    bodyContent = bodyContent.substring(closeMatch.index + closeMatch[0].length).trim();
                    isClosed = true;
                } else {
                    // Unclosed thought block (actively streaming thinking)
                    if (!thinkContent) {
                        thinkContent = bodyContent.substring(contentStart).trim();
                    }
                    bodyContent = "";
                    isClosed = false;
                }
            } else {
                // If thought tags are present inside bodyContent
                if (/<(?:thought|think|thinking)>[\s\S]*?<\/(?:thought|think|thinking)>/i.test(bodyContent)) {
                    if (!thinkContent) {
                        const m = bodyContent.match(/<(?:thought|think|thinking)>([\s\S]*?)<\/(?:thought|think|thinking)>/i);
                        if (m) thinkContent = m[1].trim();
                    }
                    bodyContent = bodyContent.replace(/<(?:thought|think|thinking)>[\s\S]*?<\/(?:thought|think|thinking)>/gi, '').trim();
                }
                if (/<\|channel\>thought\n[\s\S]*?(?:<\|channel\>|$)/i.test(bodyContent)) {
                    if (!thinkContent) {
                        const m = bodyContent.match(/<\|channel\>thought\n([\s\S]*?)(?:<\|channel\>|$)/i);
                        if (m) thinkContent = m[1].trim();
                    }
                    bodyContent = bodyContent.replace(/<\|channel\>thought\n[\s\S]*?(?:<\|channel\>|$)/gi, '').trim();
                }
            }
        }

        return { thinkContent, bodyContent, isClosed };
    }

    renderResponseContent(content, message = null, isNew = false, skipXml = null) {
        if (!content && (!message || (!message.toolCalls && !message.thought))) return "";

        let isFailed = false;
        if (message && this.aiManager.activeSession && this.aiManager.activeSession.messages) {
            const index = this.aiManager.activeSession.messages.findIndex(m => m.id === message.id);
            if (index !== -1 && index + 1 < this.aiManager.activeSession.messages.length) {
                const nextMessage = this.aiManager.activeSession.messages[index + 1];
                if (nextMessage && nextMessage.type === "tool_response") {
                    const responseContent = nextMessage.content || "";
                    const prefixMatch = responseContent.match(/^\[Tool Response: [^\]]+\]\s*\n\s*/i);
                    if (prefixMatch) {
                        const toolResultText = responseContent.substring(prefixMatch[0].length).trim();
                        if (toolResultText.toLowerCase().startsWith("error")) {
                            isFailed = true;
                        }
                    }
                }
            }
        }

        const shouldSkip = this.shouldSkipXmlParsing(message, null, skipXml);
        const { thinkContent, bodyContent, isClosed } = this.extractThoughtAndBody(content, message, shouldSkip);
        let rawContent = bodyContent;

        const parsed = this.parseBlocks(rawContent, shouldSkip);
        const rangesToRemove = [];

        if (parsed.planBlock) {
            const planText = rawContent.substring(parsed.planBlock.contentStartIdx, parsed.planBlock.contentEndIdx).trim();
            if (isNew && planText && this.aiManager.activeSession && this.aiManager.activeSession.implementationPlan !== planText) {
                this.aiManager.activeSession.implementationPlan = planText;

                workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);

                if (window.ui.openPlanAndTaskList) {
                    const isOpen = (window.ui.leftTabs?.tabs?.some(t => t.config?.path === "plan_tasks")) ||
                        (window.ui.rightTabs?.tabs?.some(t => t.config?.path === "plan_tasks"));
                    if (!isOpen) {
                        window.ui.openPlanAndTaskList();
                    }
                }
            }
            rangesToRemove.push({ startIdx: parsed.planBlock.startIdx, endIdx: parsed.planBlock.endIdx });
        }

        if (parsed.taskListBlock) {
            const tasksText = rawContent.substring(parsed.taskListBlock.contentStartIdx, parsed.taskListBlock.contentEndIdx).trim();
            const formattedTasks = this.formatTaskList(tasksText);
            if (isNew && formattedTasks && this.aiManager.activeSession && this.aiManager.activeSession.taskList !== formattedTasks) {
                this.aiManager.activeSession.taskList = formattedTasks;
                this.aiManager._updateAgentProgressPanel();
                workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
            }
            rangesToRemove.push({ startIdx: parsed.taskListBlock.startIdx, endIdx: parsed.taskListBlock.endIdx });
        }

        let taskListUpdated = false;
        for (const block of parsed.completeTaskBlocks) {
            const taskText = rawContent.substring(block.contentStartIdx, block.contentEndIdx).trim();
            if (isNew && taskText && this.aiManager.activeSession && this.aiManager.activeSession.taskList) {
                const escapedTaskText = taskText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const checkboxRegex = new RegExp(`([\\-*]\\s*\\[\\s*\\]\\s*)${escapedTaskText}`, 'i');
                if (checkboxRegex.test(this.aiManager.activeSession.taskList)) {
                    this.aiManager.activeSession.taskList = this.aiManager.activeSession.taskList.replace(checkboxRegex, (match, bulletGroup) => {
                        return bulletGroup.replace(/\[\s*\]/, '[x]') + taskText;
                    });
                    taskListUpdated = true;
                }
            }
            rangesToRemove.push({ startIdx: block.startIdx, endIdx: block.endIdx });
        }

        if (isNew && taskListUpdated) {
            this.aiManager._updateAgentProgressPanel();
            workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
        }

        let thinkHtml = "";
        let thoughtSeconds = null;
        if (message && message.thoughtDurationMs !== undefined) {
            thoughtSeconds = (message.thoughtDurationMs / 1000).toFixed(1);
        }

        if (thinkContent) {
            let thinkLabel = "Thinking...";
            if (isClosed) {
                const firstLine = thinkContent.split('\n').map(l => l.trim()).find(l => l.length > 0) || "Thought Process";
                thinkLabel = this._escapeHtml(thoughtSeconds ? `${firstLine} (${thoughtSeconds}s)` : firstLine);
            }
            const thinkSegments = this.segmentThoughtContent(thinkContent);
            const thinkSegmentsHtml = thinkSegments.map(seg => `<div class="thought-segment">${this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(seg) : seg)}</div>`).join('');
            thinkHtml = `
                <div class="thought-block" ${isClosed ? "" : "expanded"}>
                    <div class="thought-header" onclick="this.parentElement.dataset.userToggled = 'true'; this.parentElement.hasAttribute('expanded') ? this.parentElement.removeAttribute('expanded') : this.parentElement.setAttribute('expanded', '')">
                        <ui-icon>chevron_right</ui-icon>
                        <span class="thought-label" title="${thinkLabel}">${thinkLabel}</span>
                    </div>
                    <div class="thought-content">
                        ${thinkSegmentsHtml}
                    </div>
                </div>
            `;
        }

        const mainContent = this.removeRanges(rawContent, rangesToRemove);
        let finalHtml = thinkHtml;
        const finalParsed = this.parseBlocks(mainContent, shouldSkip);

        // 1. If message has structured JSON toolCalls, prioritize rendering them and strip any XML blocks from content
        if (message && message.toolCalls && message.toolCalls.length > 0) {
            // Strip any leftover XML tool tags from mainContent if XML parsing is active
            const cleanContent = shouldSkip ? mainContent : mainContent
                .replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '')
                .replace(/<tool_call[\s\S]*?>/gi, '')
                .replace(/<\/tool_call>/gi, '')
                .trim();
            if (cleanContent) {
                finalHtml += this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(cleanContent) : cleanContent);
            }
            for (let tcIdx = 0; tcIdx < message.toolCalls.length; tcIdx++) {
                const tc = message.toolCalls[tcIdx];
                const callObj = tc.functionCall || tc;
                const toolName = callObj.name || tc.name || "";
                let args = callObj.args || callObj.arguments || {};
                if (typeof args === 'string') {
                    try { args = JSON.parse(args); } catch(e) { args = {}; }
                }

                finalHtml += this._renderSingleToolCallCard(toolName, args, tc, tcIdx, message);
            }
        } else if (finalParsed.toolCallBlocks.length > 0) {
            // 2. Fallback for legacy XML tool call blocks in content (e.g. during streaming or unmigrated turns)
            let lastIdx = 0;
            for (const tc of finalParsed.toolCallBlocks) {
                const toolName = tc.name;
                const toolArgs = mainContent.substring(tc.contentStartIdx, tc.contentEndIdx);
                const isClosed = tc.closed;
                const args = this.parseToolArgs(toolArgs);

                const beforeText = mainContent.substring(lastIdx, tc.startIdx);
                if (beforeText.trim()) {
                    finalHtml += this.aiManager.md.render(beforeText);
                }
                lastIdx = tc.endIdx;

                if (toolName === "create_implementation_plan" || toolName === "update_task_list" || toolName === "complete_task") {
                    continue;
                }

                let icon = "extension";
                if (toolName.includes("read")) icon = "find_in_page";
                else if (toolName.includes("list")) icon = "folder_open";
                else if (toolName.includes("search")) icon = "search";
                else if (toolName.includes("edit")) icon = "edit";
                else if (toolName.includes("create")) icon = "create_new_folder";
                else if (toolName.includes("open")) icon = "launch";
                else if (toolName.includes("fetch") || toolName.includes("web")) icon = "language";
                else if (toolName === "query") icon = "help";

                let label = `<code>${toolName}</code>`;
                const fileActions = ["edit_file", "read_file", "create_file", "find_file", "open_file", "search_in_file"];
                if (args.url) {
                    const rawUrl = args.url.trim();
                    const displayUrl = rawUrl.length > 55 ? rawUrl.substring(0, 55) + "..." : rawUrl;
                    label = `<code>${toolName}:</code> <a href="${this._escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer" class="tool-call-link" title="${this._escapeHtml(rawUrl)}">${this._escapeHtml(displayUrl)}</a>`;
                } else if (args.path) {
                    if (fileActions.includes(toolName)) {
                        const shortFile = args.path.split('/').pop() || args.path;
                        let fileChipHtml = `<ui-filechip filename="${this._escapeHtml(shortFile)}" path="${this._escapeHtml(args.path)}"></ui-filechip>`;
                        if (toolName === "read_file") {
                            const start = parseInt(args.startLine ?? args.startline ?? args.start_line ?? args.start, 10);
                            const count = parseInt(args.lineCount ?? args.linecount ?? args.line_count ?? args.count, 10);
                            const end = parseInt(args.endLine ?? args.endline ?? args.end_line ?? args.end, 10);
                            if (!isNaN(start) && !isNaN(end)) {
                                fileChipHtml += ` #L${start}-${end}`;
                            } else if (!isNaN(start) && !isNaN(count)) {
                                const calculatedEnd = start + count - 1;
                                fileChipHtml += calculatedEnd > start ? ` #L${start}-${calculatedEnd}` : ` #L${start}`;
                            } else if (!isNaN(start)) {
                                fileChipHtml += ` #L${start}`;
                            } else if (!isNaN(count) && count > 0) {
                                fileChipHtml += ` #L1-${count}`;
                            }
                        } else if (toolName === "search_in_file") {
                            const queryText = args.query || "";
                            const truncatedQuery = queryText.length > 20 ? queryText.substring(0, 20) + "..." : queryText;
                            if (truncatedQuery) fileChipHtml += ` <span class="tool-call-query">"${this._escapeHtml(truncatedQuery)}"</span>`;
                        } else if (toolName === "edit_file") {
                            let searchLines = 0, replaceLines = 0, replaceBytes = 0;
                            if (Array.isArray(args.edits) && args.edits.length > 0) {
                                for (const ed of args.edits) {
                                    if (ed.search) searchLines += ed.search.split('\n').length;
                                    if (ed.replace) {
                                        replaceLines += ed.replace.split('\n').length;
                                        replaceBytes += (new TextEncoder().encode(ed.replace)).length;
                                    }
                                }
                            } else {
                                searchLines = (args.search && args.search.length > 0) ? args.search.split('\n').length : 0;
                                replaceLines = (args.replace && args.replace.length > 0) ? args.replace.split('\n').length : 0;
                                replaceBytes = (new TextEncoder().encode(args.replace || "")).length;
                            }
                            const editsBadge = (Array.isArray(args.edits) && args.edits.length > 1) ? `<span class="tool-call-edits-count">${args.edits.length} edits</span> ` : "";
                            fileChipHtml += ` ${editsBadge}<span class="tool-call-bytes">${this.formatByteSize(replaceBytes)}</span> <span class="tool-call-lines-badge">[<span style="color: var(--color-success, #2ea44f);">+${replaceLines}</span> <span style="color: var(--color-error, #cf222e);">${searchLines > 0 ? `-${searchLines}` : '-0'}</span>]</span>`;
                        } else if (toolName === "create_file") {
                            const contentLines = (args.content && args.content.length > 0) ? args.content.split('\n').length : 0;
                            const contentBytes = (new TextEncoder().encode(args.content || "")).length;
                            fileChipHtml += ` <span class="tool-call-bytes">${this.formatByteSize(contentBytes)}</span> <span class="tool-call-lines-badge">[<span style="color: var(--color-success, #2ea44f);">+${contentLines}</span>]</span>`;
                        }
                        label = `<code>${toolName}:</code> ${fileChipHtml}`;
                    } else {
                        label = `<code>${toolName}:</code> <span class="tool-call-path" title="${this._escapeHtml(args.path)}">${this._escapeHtml(args.path)}</span>`;
                    }
                } else if (args.command) {
                    const truncatedCmd = args.command.length > 50 ? args.command.substring(0, 50) + "..." : args.command;
                    const cwdVal = args.cwd || args.dir;
                    const cwdInfo = cwdVal ? ` <span class="tool-call-cwd" style="opacity:0.8; font-size:0.9em;">(in <code>${this._escapeHtml(cwdVal.split('/').filter(Boolean).pop() || cwdVal)}</code>)</span>` : '';
                    label = `<code>${toolName}:</code> <span class="tool-call-query"><code>$ ${this._escapeHtml(truncatedCmd)}</code></span>${cwdInfo}`;
                } else if (args.query) {
                    label = `<code>${toolName}:</code> <span class="tool-call-query">"${this._escapeHtml(args.query)}"</span>`;
                } else if (args.question) {
                    const truncated = args.question.length > 60 ? args.question.substring(0, 60) + "..." : args.question;
                    label = `<code>${toolName}:</code> <span class="tool-call-query">"${this._escapeHtml(truncated)}"</span>`;
                }

                let expanderHtml = "";
                if (toolName === "create_file" || toolName === "edit_file") {
                    let newContent = "";
                    if (toolName === "create_file") {
                        newContent = args.content || "";
                    } else if (Array.isArray(args.edits) && args.edits.length > 0) {
                        const lastEdit = args.edits[args.edits.length - 1];
                        newContent = lastEdit.replace || "";
                    } else {
                        newContent = args.replace || "";
                    }
                    if (newContent.length > 0) {
                        const allLines = newContent.split('\n');
                        const last5Lines = allLines.slice(-5);
                        const previewText = last5Lines.join('\n');
                        expanderHtml = `
                            <details class="tool-call-preview-expander" open ontoggle="this.dataset.userToggled = 'true'">
                                <summary class="tool-call-preview-summary">
                                    <ui-icon>expand_more</ui-icon>
                                    <span>Preview (last ${last5Lines.length} lines)</span>
                                </summary>
                                <pre class="tool-call-preview-code"><code>${this._escapeHtml(previewText)}</code></pre>
                            </details>
                        `;
                    }
                }

                let badgeClass = isClosed ? 'invoked' : 'preparing';
                let badgeText = isClosed ? 'Invoked' : 'Preparing...';

                finalHtml += `
                    <div class="tool-call-block compact">
                        <div class="tool-call-header compact">
                            <ui-icon>${icon}</ui-icon>
                            <span class="tool-call-title compact">${label}</span>
                            <span class="tool-call-status-badge compact ${badgeClass}">${badgeText}</span>
                        </div>
                        ${expanderHtml}
                    </div>
                `;
            }
            const remainingText = mainContent.substring(lastIdx);
            if (remainingText.trim()) {
                finalHtml += this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(remainingText) : remainingText);
            }
        } else {
            if (mainContent.trim()) {
                finalHtml += this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(mainContent) : mainContent);
            }
        }

        return finalHtml;
    }

    _renderSingleToolCallCard(toolName, args, tc, tcIdx = 0, message = null) {
        let tcFailed = tc?.status === "failed";
        let toolResultDetail = "";
        if (this.aiManager.activeSession && this.aiManager.activeSession.messages && message) {
            const index = this.aiManager.activeSession.messages.findIndex(m => m.id === message.id);
            if (index !== -1 && index + 1 < this.aiManager.activeSession.messages.length) {
                const nextMessage = this.aiManager.activeSession.messages[index + 1];
                if (nextMessage && nextMessage.type === "tool_response") {
                    const responseContent = nextMessage.content || "";
                    const sections = responseContent.split(/\n\n---\n\n/);
                    const section = sections[tcIdx] !== undefined ? sections[tcIdx] : responseContent;
                    const prefixMatch = section.match(/^\[Tool Response: [^\]]+\]\s*\n\s*/i);
                    const resultText = prefixMatch ? section.substring(prefixMatch[0].length).trim() : section.trim();
                    toolResultDetail = resultText;
                    if (!tc?.status && (resultText.toLowerCase().startsWith("error") || resultText.toLowerCase().includes("user rejected") || resultText.toLowerCase().includes("failed validation"))) {
                        tcFailed = true;
                    }
                }
            }
        }

        // Project management tools
        if (toolName === "create_implementation_plan" || toolName === "update_task_list" || toolName === "complete_task") {
            if (toolName === "create_implementation_plan") {
                const messages = this.aiManager.activeSession?.messages || [];
                const status = message ? message.planStatus : (messages.find(m => m.id === message?.id)?.planStatus);
                let isPending = !status || status === "pending";
                let cardBg = "color-mix(in srgb, var(--theme) 8%, transparent)";
                let cardBorder = "1px solid color-mix(in srgb, var(--theme) 25%, transparent)";
                let cardColor = "var(--theme)";
                let iconName = "assignment";
                let titleText = "Implementation Plan Proposed";

                if (status === "accepted") {
                    cardBg = "rgba(45, 164, 78, 0.1)";
                    cardBorder = "1px solid rgba(45, 164, 78, 0.25)";
                    cardColor = "#2da44e";
                    iconName = "check_circle";
                    titleText = "Implementation Plan Accepted";
                } else if (status === "rejected") {
                    cardBg = "rgba(244, 67, 54, 0.08)";
                    cardBorder = "1px solid rgba(244, 67, 54, 0.25)";
                    cardColor = "var(--error-color, #f44336)";
                    iconName = "cancel";
                    titleText = "Implementation Plan Refined / Rejected";
                }

                let planHtml = `
                <div class="inline-implementation-plan-card" style="display: flex; flex-direction: column; gap: 8px; margin: 10px 0; background: ${cardBg}; border: ${cardBorder}; border-radius: var(--radius); padding: 12px; transition: all 0.2s ease;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div class="banner-left" style="display: flex; align-items: center; gap: 8px; color: ${cardColor};">
                            <ui-icon style="color: ${cardColor}; font-size: 20px;">${iconName}</ui-icon>
                            <span style="font-weight: 600; font-size: 13px;">${titleText}</span>
                        </div>
                        <button class="open-plan-btn" style="display: flex; align-items: center; gap: 4px; background: transparent; border: 1px solid ${cardColor}; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: ${cardColor}; font-weight: 600; font-size: 11px; transition: all 0.2s;" onclick="if(window.ui && window.ui.openPlanAndTaskList) window.ui.openPlanAndTaskList();" onmouseover="this.style.background='color-mix(in srgb, ${cardColor} 8%, transparent)'" onmouseout="this.style.background='transparent'">
                            <span>View Plan</span><ui-icon style="font-size: 14px;">open_in_new</ui-icon>
                        </button>
                    </div>
                `;
                if (isPending) {
                    planHtml += `
                    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                        <textarea placeholder="Optional prompt/clarification for the agent..." style="width: 100%; min-height: 60px; padding: 8px; resize: vertical; background-color: var(--bg-body); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: var(--radius); font-family: inherit; box-sizing: border-box;"></textarea>
                        <div class="banner-actions" style="display: flex; justify-content: flex-end; gap: 8px;">
                            <button class="reject-plan-btn" style="display: flex; align-items: center; gap: 4px; background: transparent; color: var(--error-color, #f44336); border: 1px solid color-mix(in srgb, var(--error-color, #f44336) 50%, transparent); padding: 6px 12px; border-radius: 4px; cursor: pointer;" onclick="const comment = this.parentElement.previousElementSibling.value.trim(); if(window.ui && window.ui.aiManager) window.ui.aiManager.proceedWithImplementationPlan(comment, false);">
                                <ui-icon style="font-size: 16px;">close</ui-icon><span>Reject / Refine</span>
                            </button>
                            <button class="proceed-plan-btn" style="display: flex; align-items: center; gap: 4px; background: color-mix(in srgb, var(--theme) 15%, transparent); color: var(--text-primary); border: 1px solid var(--theme); padding: 6px 12px; border-radius: 4px; cursor: pointer;" onclick="const comment = this.parentElement.previousElementSibling.value.trim(); if(window.ui && window.ui.aiManager) window.ui.aiManager.proceedWithImplementationPlan(comment, true);">
                                <ui-icon style="font-size: 16px;">check</ui-icon><span>Accept Plan</span>
                            </button>
                        </div>
                    </div>
                    `;
                }
                planHtml += `</div>`;
                return planHtml;
            }
            return "";
        }

        let icon = "extension";
        if (toolName.includes("read")) icon = "find_in_page";
        else if (toolName.includes("list")) icon = "folder_open";
        else if (toolName.includes("search")) icon = "search";
        else if (toolName.includes("edit")) icon = "edit";
        else if (toolName.includes("create")) icon = "create_new_folder";
        else if (toolName.includes("open")) icon = "launch";
        else if (toolName.includes("fetch") || toolName.includes("web")) icon = "language";
        else if (toolName === "query") icon = "help";

        let label = `<code>${toolName}</code>`;
        const fileActions = ["edit_file", "read_file", "create_file", "find_file", "open_file", "search_in_file"];
        if (args.url) {
            const rawUrl = (args.url || "").trim();
            const displayUrl = rawUrl.length > 55 ? rawUrl.substring(0, 55) + "..." : rawUrl;
            label = `<code>${toolName}:</code> <a href="${this._escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer" class="tool-call-link" title="${this._escapeHtml(rawUrl)}">${this._escapeHtml(displayUrl)}</a>`;
        } else if (args.path) {
            if (fileActions.includes(toolName)) {
                const shortFile = args.path.split('/').pop() || args.path;
                let fileChipHtml = `<ui-filechip filename="${this._escapeHtml(shortFile)}" path="${this._escapeHtml(args.path)}"></ui-filechip>`;
                if (toolName === "read_file") {
                    const start = parseInt(args.startLine ?? args.startline ?? args.start_line ?? args.start, 10);
                    const count = parseInt(args.lineCount ?? args.linecount ?? args.line_count ?? args.count, 10);
                    const end = parseInt(args.endLine ?? args.endline ?? args.end_line ?? args.end, 10);
                    if (!isNaN(start) && !isNaN(end)) {
                        fileChipHtml += ` #L${start}-${end}`;
                    } else if (!isNaN(start) && !isNaN(count)) {
                        const calculatedEnd = start + count - 1;
                        fileChipHtml += calculatedEnd > start ? ` #L${start}-${calculatedEnd}` : ` #L${start}`;
                    } else if (!isNaN(start)) {
                        fileChipHtml += ` #L${start}`;
                    } else if (!isNaN(count) && count > 0) {
                        fileChipHtml += ` #L1-${count}`;
                    }
                } else if (toolName === "search_in_file") {
                    const queryText = args.query || "";
                    const truncatedQuery = queryText.length > 20 ? queryText.substring(0, 20) + "..." : queryText;
                    if (truncatedQuery) fileChipHtml += ` <span class="tool-call-query">"${this._escapeHtml(truncatedQuery)}"</span>`;
                } else if (toolName === "edit_file") {
                    let searchLines = 0, replaceLines = 0, replaceBytes = 0;
                    if (Array.isArray(args.edits) && args.edits.length > 0) {
                        for (const ed of args.edits) {
                            if (ed.search) searchLines += ed.search.split('\n').length;
                            if (ed.replace) {
                                replaceLines += ed.replace.split('\n').length;
                                replaceBytes += ed.replace.length;
                            }
                        }
                    } else {
                        searchLines = (args.search && args.search.length > 0) ? args.search.split('\n').length : 0;
                        replaceLines = (args.replace && args.replace.length > 0) ? args.replace.split('\n').length : 0;
                        replaceBytes = (args.replace || "").length;
                    }
                    const editsBadge = (Array.isArray(args.edits) && args.edits.length > 1) ? `<span class="tool-call-edits-count">${args.edits.length} edits</span> ` : "";
                    fileChipHtml += ` ${editsBadge}<span class="tool-call-bytes">${this.formatByteSize(replaceBytes)}</span> <span class="tool-call-lines-badge">[<span style="color: var(--color-success, #2ea44f);">+${replaceLines}</span> <span style="color: var(--color-error, #cf222e);">${searchLines > 0 ? `-${searchLines}` : '-0'}</span>]</span>`;
                } else if (toolName === "create_file") {
                    const contentLines = (args.content && args.content.length > 0) ? args.content.split('\n').length : 0;
                    const contentBytes = (args.content || "").length;
                    fileChipHtml += ` <span class="tool-call-bytes">${this.formatByteSize(contentBytes)}</span> <span class="tool-call-lines-badge">[<span style="color: var(--color-success, #2ea44f);">+${contentLines}</span>]</span>`;
                }
                label = `<code>${toolName}:</code> ${fileChipHtml}`;
            } else {
                label = `<code>${toolName}:</code> <span class="tool-call-path" title="${this._escapeHtml(args.path)}">${this._escapeHtml(args.path)}</span>`;
            }
        } else if (args.command) {
            const truncatedCmd = args.command.length > 50 ? args.command.substring(0, 50) + "..." : args.command;
            const cwdVal = args.cwd || args.dir;
            const cwdInfo = cwdVal ? ` <span class="tool-call-cwd" style="opacity:0.8; font-size:0.9em;">(in <code>${this._escapeHtml(cwdVal.split('/').filter(Boolean).pop() || cwdVal)}</code>)</span>` : '';
            label = `<code>${toolName}:</code> <span class="tool-call-query"><code>$ ${this._escapeHtml(truncatedCmd)}</code></span>${cwdInfo}`;
        } else if (args.query) {
            label = `<code>${toolName}:</code> <span class="tool-call-query">"${this._escapeHtml(args.query)}"</span>`;
        } else if (args.question) {
            const truncated = args.question.length > 60 ? args.question.substring(0, 60) + "..." : args.question;
            label = `<code>${toolName}:</code> <span class="tool-call-query">"${this._escapeHtml(truncated)}"</span>`;
        }

        let badgeClass = tcFailed ? 'failed' : 'invoked';
        let badgeText = tcFailed ? 'Failed' : 'Invoked';
        if (toolName === "sub_agent_complete") {
            badgeText = tcFailed ? 'Failed' : 'Completed';
        } else if (toolName === "query") {
            badgeText = tcFailed ? 'Failed' : 'Answered';
        }

        let expanderHtml = "";
        if (tcFailed && toolResultDetail) {
            expanderHtml = `
                <details class="tool-call-preview-expander" ontoggle="this.dataset.userToggled = 'true'">
                    <summary class="tool-call-preview-summary">
                        <ui-icon>expand_more</ui-icon>
                        <span>Error Details</span>
                    </summary>
                    <pre class="tool-call-preview-code"><code>${this._escapeHtml(toolResultDetail)}</code></pre>
                </details>
            `;
        } else if (toolName === "create_file" || toolName === "edit_file") {
            let newContent = "";
            if (toolName === "create_file") {
                newContent = args.content || "";
            } else if (Array.isArray(args.edits) && args.edits.length > 0) {
                const lastEdit = args.edits[args.edits.length - 1];
                newContent = lastEdit?.replace || "";
            } else {
                newContent = args.replace || "";
            }
            if (newContent.length > 0) {
                const allLines = newContent.split('\n');
                const last5Lines = allLines.slice(-5);
                const previewText = last5Lines.join('\n');
                expanderHtml = `
                    <details class="tool-call-preview-expander" open ontoggle="this.dataset.userToggled = 'true'">
                        <summary class="tool-call-preview-summary">
                            <ui-icon>expand_more</ui-icon>
                            <span>Preview (last ${last5Lines.length} lines)</span>
                        </summary>
                        <pre class="tool-call-preview-code"><code>${this._escapeHtml(previewText)}</code></pre>
                    </details>
                `;
            }
        }

        if (toolName === "sub_agent_complete") {
            const resultText = args.result || "";
            const renderedResult = resultText.trim() ? this.aiManager.md.render(resultText) : "";
            return `
                <div class="tool-call-block sub-agent-complete-card">
                    <div class="tool-call-header">
                        <ui-icon>check_circle</ui-icon>
                        <span class="tool-call-title">Sub-Agent Task Completed</span>
                        <span class="tool-call-status-badge ${badgeClass}">${badgeText}</span>
                    </div>
                    <div class="tool-call-body">
                        <div class="sub-agent-result-label">Result:</div>
                        <div class="sub-agent-result-text">${renderedResult}</div>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="tool-call-block compact">
                    <div class="tool-call-header compact">
                        <ui-icon>${icon}</ui-icon>
                        <span class="tool-call-title compact">${label}</span>
                        <span class="tool-call-status-badge compact ${badgeClass}">${badgeText}</span>
                    </div>
                    ${expanderHtml}
                </div>
            `;
        }
    }

    getModelTurnSummary(content, message = null, skipXml = null) {
        let thoughtSeconds = null;
        if (message && message.thoughtDurationMs !== undefined) {
            thoughtSeconds = (message.thoughtDurationMs / 1000).toFixed(1);
        }

        const shouldSkip = this.shouldSkipXmlParsing(message, null, skipXml);
        const { thinkContent, bodyContent, isClosed } = this.extractThoughtAndBody(content, message, shouldSkip);
        if (!isClosed) {
            return "Thinking...";
        }

        const parsed = this.parseBlocks(bodyContent || "", shouldSkip);
        
        // 1. Gather all tool calls (from message.toolCalls or parsed.toolCallBlocks)
        const toolCallsList = [];
        if (message && message.toolCalls && message.toolCalls.length > 0) {
            for (const tc of message.toolCalls) {
                const callObj = tc.functionCall || tc;
                const name = callObj.name || tc.name || "";
                let rawArgs = callObj.args || callObj.arguments || {};
                let args = typeof rawArgs === 'string' ? (JSON.parse(rawArgs) || {}) : rawArgs;
                toolCallsList.push({ name, args, status: tc.status });
            }
        } else if (parsed.toolCallBlocks && parsed.toolCallBlocks.length > 0) {
            for (const tc of parsed.toolCallBlocks) {
                const name = tc.name;
                const toolArgs = bodyContent.substring(tc.contentStartIdx, tc.contentEndIdx);
                const args = this.parseToolArgs(toolArgs);
                toolCallsList.push({ name, args, closed: tc.closed });
            }
        }

        // 2. Resolve status for each tool call from following tool_response messages if not already on the tool call
        if (toolCallsList.length > 0 && message && this.aiManager.activeSession && this.aiManager.activeSession.messages) {
            const index = this.aiManager.activeSession.messages.findIndex(m => m.id === message.id);
            if (index !== -1 && index + 1 < this.aiManager.activeSession.messages.length) {
                const nextMessage = this.aiManager.activeSession.messages[index + 1];
                if (nextMessage && nextMessage.type === "tool_response") {
                    const responseContent = nextMessage.content || "";
                    // Check individual tool response sections if accumulated
                    const sections = responseContent.split(/\n\n---\n\n/);
                    for (let i = 0; i < toolCallsList.length; i++) {
                        if (!toolCallsList[i].status) {
                            const section = sections[i] !== undefined ? sections[i] : responseContent;
                            const prefixMatch = section.match(/^\[Tool Response: [^\]]+\]\s*\n\s*/i);
                            const resultText = prefixMatch ? section.substring(prefixMatch[0].length).trim() : section.trim();
                            if (resultText.toLowerCase().startsWith("error") || resultText.toLowerCase().includes("user rejected") || resultText.toLowerCase().includes("failed validation")) {
                                toolCallsList[i].status = "failed";
                            } else {
                                toolCallsList[i].status = "success";
                            }
                        }
                    }
                }
            }
        }

        // Helper to format concise details for a tool call
        const getToolDetails = (toolName, args) => {
            if (!args) return "";
            if (args.url) {
                const rawUrl = (args.url || '').trim();
                return rawUrl.length > 30 ? rawUrl.substring(0, 30) + "..." : rawUrl;
            } else if (args.command) {
                const shortCmd = args.command.length > 30 ? args.command.substring(0, 30) + "..." : args.command;
                const cwdVal = args.cwd || args.dir;
                const cwdInfo = cwdVal ? ` (in ${this._escapeHtml(cwdVal.split('/').filter(Boolean).pop() || cwdVal)})` : '';
                return `$ ${this._escapeHtml(shortCmd)}${cwdInfo}`;
            } else if (args.path) {
                const shortFile = args.path.split('/').pop() || args.path;
                let details = shortFile;
                if (toolName === "read_file") {
                    const start = parseInt(args.startLine ?? args.startline ?? args.start_line ?? args.start, 10);
                    const count = parseInt(args.lineCount ?? args.linecount ?? args.line_count ?? args.count, 10);
                    const end = parseInt(args.endLine ?? args.endline ?? args.end_line ?? args.end, 10);
                    if (!isNaN(start) && !isNaN(end)) {
                        details += ` #L${start}-${end}`;
                    } else if (!isNaN(start) && !isNaN(count)) {
                        const calculatedEnd = start + count - 1;
                        details += calculatedEnd > start ? ` #L${start}-${calculatedEnd}` : ` #L${start}`;
                    } else if (!isNaN(start)) {
                        details += ` #L${start}`;
                    } else if (!isNaN(count) && count > 0) {
                        details += ` #L1-${count}`;
                    }
                } else if (toolName === "edit_file" && (args.edits || args.search !== undefined || args.replace !== undefined)) {
                    let searchLines = 0, replaceLines = 0, replaceBytes = 0;
                    if (Array.isArray(args.edits) && args.edits.length > 0) {
                        for (const ed of args.edits) {
                            if (ed.search) searchLines += ed.search.split('\n').length;
                            if (ed.replace) {
                                replaceLines += ed.replace.split('\n').length;
                                replaceBytes += (new TextEncoder().encode(ed.replace)).length;
                            }
                        }
                    } else {
                        searchLines = (args.search && args.search.length > 0) ? args.search.split('\n').length : 0;
                        replaceLines = (args.replace && args.replace.length > 0) ? args.replace.split('\n').length : 0;
                        replaceBytes = (new TextEncoder().encode(args.replace || "")).length;
                    }
                    const editCountStr = (Array.isArray(args.edits) && args.edits.length > 1) ? ` (${args.edits.length} edits)` : "";
                    details += `${editCountStr} (+${replaceLines} -${searchLines}, ${this.formatByteSize(replaceBytes, true)})`;
                } else if (toolName === "create_file" && args.content !== undefined) {
                    const contentLines = (args.content && args.content.length > 0) ? args.content.split('\n').length : 0;
                    const contentBytes = (new TextEncoder().encode(args.content || "")).length;
                    details += ` (+${contentLines}, ${this.formatByteSize(contentBytes, true)})`;
                }
                return details;
            } else if (args.query) {
                const shortQuery = args.query.length > 25 ? args.query.substring(0, 25) + "..." : args.query;
                return `"${this._escapeHtml(shortQuery)}"`;
            }
            return "";
        };

        let toolSummary = "";
        if (toolCallsList.length > 0) {
            const formattedCalls = toolCallsList.map(tc => {
                const statusClass = tc.status === "success" ? "success" : (tc.status === "failed" ? "failed" : "pending");
                const details = getToolDetails(tc.name, tc.args);
                const detailsHtml = details ? ` <span style="opacity:0.85;">${details}</span>` : "";
                return `<code class="turn-tool-chip ${statusClass}">${tc.name}</code>${detailsHtml}`;
            });
            toolSummary = formattedCalls.join(", ");
        }

        // Calculate text words if no tool call, or in addition
        const rangesToRemove = [];
        if (parsed.toolCallBlocks) {
            parsed.toolCallBlocks.forEach(b => rangesToRemove.push({ startIdx: b.startIdx, endIdx: b.endIdx }));
        }
        const textOnly = this.removeRanges(bodyContent || "", rangesToRemove).trim();
        const wordCount = textOnly ? textOnly.split(/\s+/).filter(Boolean).length : 0;

        let prefix = thoughtSeconds ? `${thoughtSeconds}s: ` : "";
        if (toolSummary) {
            return `${prefix}${toolSummary}`;
        } else if (wordCount > 0) {
            return `${prefix}responded ${wordCount} words`;
        } else if (thoughtSeconds) {
            return `Thought ${thoughtSeconds}s`;
        }
        return `Model Response`;
    }

    getModelTurnTokens(content, message = null) {
        if (!message) return "";

        let outputTokens = 0;
        if (this.aiManager.activeAI) {
            let fullOutputText = content || message.content || "";
            if (message.thought && !fullOutputText.includes(message.thought)) {
                fullOutputText += "\n" + message.thought;
            }
            if (message.toolCalls && message.toolCalls.length > 0) {
                for (const tc of message.toolCalls) {
                    const callObj = tc.functionCall || tc;
                    const tcText = `${callObj.name || ""}: ${JSON.stringify(callObj.args || callObj.arguments || {})}`;
                    if (!fullOutputText.includes(tcText)) {
                        fullOutputText += "\n" + tcText;
                    }
                }
            }
            outputTokens = this.aiManager.activeAI.estimateTokens([{ role: 'assistant', content: fullOutputText }]);
        } else if (typeof message.tokenCount === 'number') {
            outputTokens = message.tokenCount;
        }

        let inputTokens = null;
        if (this.aiManager.activeSession && this.aiManager.activeSession.messages) {
            const index = this.aiManager.activeSession.messages.findIndex(m => m.id === message.id);
            if (index !== -1 && index + 1 < this.aiManager.activeSession.messages.length) {
                const nextMessage = this.aiManager.activeSession.messages[index + 1];
                if (nextMessage && nextMessage.type === "tool_response") {
                    if (typeof nextMessage.tokenCount === 'number') {
                        inputTokens = nextMessage.tokenCount;
                    } else if (this.aiManager.activeAI) {
                        inputTokens = this.aiManager.activeAI.estimateTokens([nextMessage]);
                    }
                }
            }
        }

        const getTokenColorClass = (tokens) => {
            if (tokens >= 3000) return "tag-red";
            if (tokens >= 2000) return "tag-orange";
            if (tokens >= 1000) return "tag-yellow";
            return "tag-blue";
        };

        const outClass = getTokenColorClass(outputTokens);
        const outTag = `<span class="token-count-tag ${outClass}" title="Output tokens: ${outputTokens}">${outputTokens}</span>`;

        if (inputTokens !== null) {
            const inClass = getTokenColorClass(inputTokens);
            const inTag = `<span class="token-count-tag ${inClass}" title="Tool result input tokens: ${inputTokens}">${inputTokens}</span>`;
            return `${inTag}<span class="turn-tokens-sep">|</span>${outTag}`;
        }

        return outTag;
    }

    inferLanguageFromDiff(diffContent) {
        if (!window.ace_modes) {
            console.warn("AIManager: window.ace_modes is not available. Cannot infer language for diff highlighting.");
            return null;
        }

        const filenameMatch = diffContent.match(/^\+\+\+\s(?:b\/)?(.+?)(?:\t.*)?$/m);
        if (!filenameMatch || !filenameMatch[1]) {
            return null;
        }
        const filename = filenameMatch[1];

        for (const lang in window.ace_modes) {
            const mode = window.ace_modes[lang];
            if (mode && mode.extRe instanceof RegExp) {
                mode.extRe.lastIndex = 0;
                if (mode.extRe.test(filename)) {
                    return lang;
                }
            }
        }

        return null;
    }

    parseBlocks(content, skipXml = false) {
        if (!content || skipXml) return { planBlock: null, taskListBlock: null, completeTaskBlocks: [], toolCallBlocks: [] };
        let inCodeBlock = false;
        let inInlineCode = false;

        let planBlock = null;
        let taskListBlock = null;
        const completeTaskBlocks = [];
        const toolCallBlocks = [];

        let activeBlock = null; 

        let i = 0;
        const len = content.length;

        while (i < len) {
            if (activeBlock) {
                if (activeBlock.type === 'plan') {
                    if (content.startsWith("</implementation_plan>", i)) {
                        activeBlock.endIdx = i + 22;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 22;
                        continue;
                    }
                } else if (activeBlock.type === 'taskList') {
                    if (content.startsWith("</task_list>", i)) {
                        activeBlock.endIdx = i + 12;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 12;
                        continue;
                    }
                } else if (activeBlock.type === 'completeTask') {
                    if (content.startsWith("</complete_task>", i)) {
                        activeBlock.endIdx = i + 16;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 16;
                        continue;
                    }
                } else if (activeBlock.type === 'toolCall') {
                    if (content.startsWith("</tool_call>", i)) {
                        activeBlock.endIdx = i + 12;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 12;
                        continue;
                    }
                }
            }

            if (content.startsWith("```", i)) {
                inCodeBlock = !inCodeBlock;
                i += 3;
                continue;
            }
            if (content.startsWith("`", i) && !inCodeBlock) {
                inInlineCode = !inInlineCode;
                i += 1;
                continue;
            }

            if (inCodeBlock || inInlineCode) {
                i++;
                continue;
            }

            if (!planBlock) {
                if (content.startsWith("<implementation_plan>", i)) {
                    planBlock = { type: 'plan', startIdx: i, contentStartIdx: i + 21, closed: false };
                    activeBlock = planBlock;
                    i += 21;
                    continue;
                }
            }

            if (!taskListBlock) {
                if (content.startsWith("<task_list>", i)) {
                    taskListBlock = { type: 'taskList', startIdx: i, contentStartIdx: i + 11, closed: false };
                    activeBlock = taskListBlock;
                    i += 11;
                    continue;
                }
            }

            if (content.startsWith("<complete_task>", i)) {
                const block = { type: 'completeTask', startIdx: i, contentStartIdx: i + 15, closed: false };
                completeTaskBlocks.push(block);
                activeBlock = block;
                i += 15;
                continue;
            }

            if (content.startsWith("<tool_call", i)) {
                const startTagEnd = content.indexOf(">", i);
                if (startTagEnd !== -1) {
                    const startTag = content.substring(i, startTagEnd + 1);
                    const nameMatch = startTag.match(/name=["']([^"']+)["']/i);
                    const toolName = nameMatch ? nameMatch[1] : "";
                    const block = {
                        type: 'toolCall',
                        startIdx: i,
                        contentStartIdx: startTagEnd + 1,
                        closed: false,
                        name: toolName,
                        startTag: startTag
                    };
                    toolCallBlocks.push(block);
                    activeBlock = block;
                    i = startTagEnd + 1;
                    continue;
                }
            }

            i++;
        }

        if (activeBlock) {
            activeBlock.endIdx = len;
            activeBlock.contentEndIdx = len;
        }

        return {
            planBlock,
            taskListBlock,
            completeTaskBlocks,
            toolCallBlocks
        };
    }

    removeRanges(str, ranges) {
        const sorted = [...ranges].filter(r => r !== null && r !== undefined).sort((a, b) => b.startIdx - a.startIdx);
        let result = str;
        for (const r of sorted) {
            result = result.substring(0, r.startIdx) + result.substring(r.endIdx);
        }
        return result;
    }

    formatTaskList(tasks) {
        if (!tasks) return "";

        // 1. If it's already an array, convert it to markdown checklist.
        if (Array.isArray(tasks)) {
            return tasks.map(t => {
                const trimmed = String(t).trim();
                // Check if it already starts with checkbox bullet
                if (/^[-*]\s*\[[ xX]\]/.test(trimmed)) {
                    return trimmed;
                }
                // Check if it starts with bullet without checkbox
                if (/^[-*]\s+/.test(trimmed)) {
                    return trimmed.replace(/^([-*])\s+/, '$1 [ ] ');
                }
                return `- [ ] ${trimmed}`;
            }).join('\n');
        }

        // 2. If it's a string, see if it is a JSON array
        if (typeof tasks === 'string') {
            const trimmedTasks = tasks.trim();
            if (trimmedTasks.startsWith('[') && trimmedTasks.endsWith(']')) {
                try {
                    const parsed = JSON.parse(trimmedTasks);
                    if (Array.isArray(parsed)) {
                        return this.formatTaskList(parsed);
                    }
                } catch (e) {
                    // Not valid JSON, ignore and proceed
                }
            }

            // If it already has checkboxes, return it as-is
            if (trimmedTasks.includes('- [ ]') || trimmedTasks.includes('- [x]') || trimmedTasks.includes('- [X]') ||
                trimmedTasks.includes('* [ ]') || trimmedTasks.includes('* [x]') || trimmedTasks.includes('* [X]')) {
                return tasks;
            }

            // If it has bullet points without checkboxes, format them
            if (/^[-*]\s+/m.test(trimmedTasks)) {
                const lines = tasks.split('\n');
                return lines.map(line => {
                    const trimmedLine = line.trim();
                    if (/^[-*]\s+/.test(trimmedLine)) {
                        return trimmedLine.replace(/^([-*])\s+/, '$1 [ ] ');
                    }
                    if (trimmedLine.length > 0) {
                        return `- [ ] ${trimmedLine}`;
                    }
                    return line;
                }).join('\n');
            }

            // If it's just a multi-line string without bullets or checkboxes, turn it into checklist
            if (trimmedTasks.includes('\n')) {
                const lines = tasks.split('\n');
                return lines.map(line => {
                    const trimmedLine = line.trim();
                    if (trimmedLine.length > 0) {
                        return `- [ ] ${trimmedLine}`;
                    }
                    return line;
                }).join('\n');
            }
            
            // If it is a single-line string with no checkboxes/bullets, wrap it in checklist format
            if (trimmedTasks.length > 0) {
                return `- [ ] ${trimmedTasks}`;
            }
        }

        return tasks;
    }

    /**
     * Segments thought/reasoning text by code block boundaries and paragraph length limits
     * to avoid massive markdown re-renders during long thinking output.
     * @param {string} thinkContent 
     * @param {number} maxChunkLen 
     * @returns {string[]}
     */
    segmentThoughtContent(thinkContent, maxChunkLen = 3200) {
        if (!thinkContent) return [""];
        const segments = [];
        let currentStart = 0;
        let inCodeBlock = false;
        let i = 0;
        const len = thinkContent.length;

        while (i < len) {
            if (thinkContent.startsWith("```", i)) {
                if (inCodeBlock) {
                    i += 3;
                    if (thinkContent.startsWith("\n", i)) i++;
                    segments.push(thinkContent.substring(currentStart, i));
                    currentStart = i;
                    inCodeBlock = false;
                    continue;
                } else {
                    if (i > currentStart) {
                        segments.push(thinkContent.substring(currentStart, i));
                        currentStart = i;
                    }
                    inCodeBlock = true;
                    i += 3;
                    continue;
                }
            }

            if (!inCodeBlock) {
                const currentSegmentLength = i - currentStart;
                if (currentSegmentLength >= maxChunkLen && thinkContent[i] === '\n') {
                    i++;
                    segments.push(thinkContent.substring(currentStart, i));
                    currentStart = i;
                    continue;
                }
            }

            i++;
        }

        if (currentStart < len) {
            segments.push(thinkContent.substring(currentStart));
        }
        if (segments.length === 0) {
            segments.push("");
        }
        return segments;
    }

    /**
     * Renders a response segment incrementally into a container element,
     * maintaining internal thought segmentation without full element rebuilds.
     * @param {HTMLElement} containerDiv 
     * @param {string} content 
     * @param {Object} message 
     * @param {boolean} isNew 
     */
    renderResponseSegment(containerDiv, content, message, isNew = false, skipXml = null) {
        if (!containerDiv) return;

        const shouldSkip = this.shouldSkipXmlParsing(message, null, skipXml);
        const { thinkContent, bodyContent, isClosed } = this.extractThoughtAndBody(content, message, shouldSkip);

        if (thinkContent || (message && message.isThinking)) {
            let thoughtSeconds = null;
            if (message && message.thoughtDurationMs !== undefined) {
                thoughtSeconds = (message.thoughtDurationMs / 1000).toFixed(1);
            }
            const thinkLabel = isClosed ? (thoughtSeconds ? `Thought Process (${thoughtSeconds}s)` : "Thought Process") : "Thinking...";
            const thinkSegments = this.segmentThoughtContent(thinkContent);

            let thoughtBlockEl = containerDiv.querySelector('.thought-block');
            if (!thoughtBlockEl) {
                containerDiv.innerHTML = "";
                thoughtBlockEl = document.createElement("div");
                thoughtBlockEl.className = "thought-block";
                if (!isClosed) {
                    thoughtBlockEl.setAttribute("expanded", "");
                }
                const thinkSegmentsHtml = thinkSegments.map(seg => `<div class="thought-segment">${this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(seg) : seg)}</div>`).join('');
                thoughtBlockEl.innerHTML = `
                    <div class="thought-header" onclick="this.parentElement.dataset.userToggled = 'true'; this.parentElement.hasAttribute('expanded') ? this.parentElement.removeAttribute('expanded') : this.parentElement.setAttribute('expanded', '')">
                        <ui-icon>chevron_right</ui-icon>
                        <span class="thought-label" title="${this._escapeHtml(thinkLabel)}">${this._escapeHtml(thinkLabel)}</span>
                    </div>
                    <div class="thought-content">
                        ${thinkSegmentsHtml}
                    </div>
                `;
                containerDiv.appendChild(thoughtBlockEl);
                const tc = thoughtBlockEl.querySelector('.thought-content');
                if (tc) {
                    tc.finalizedCount = Math.max(0, thinkSegments.length - 1);
                    tc.activeSegmentDiv = tc.lastElementChild;
                }
            } else {
                // Update existing thought block incrementally
                const headerSpan = thoughtBlockEl.querySelector('.thought-header span');
                if (headerSpan && headerSpan.textContent !== thinkLabel) {
                    headerSpan.textContent = thinkLabel;
                    headerSpan.title = thinkLabel;
                }

                if (isClosed && !thoughtBlockEl.dataset.userToggled) {
                    thoughtBlockEl.removeAttribute('expanded');
                }

                const tc = thoughtBlockEl.querySelector('.thought-content');
                if (tc) {
                    tc.finalizedCount = tc.finalizedCount || 0;
                    while (thinkSegments.length > tc.finalizedCount + 1) {
                        const finalizedText = thinkSegments[tc.finalizedCount];
                        if (tc.activeSegmentDiv) {
                            tc.activeSegmentDiv.innerHTML = this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(finalizedText) : finalizedText);
                        } else {
                            const newDiv = document.createElement("div");
                            newDiv.className = "thought-segment";
                            newDiv.innerHTML = this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(finalizedText) : finalizedText);
                            tc.append(newDiv);
                        }
                        tc.finalizedCount++;
                        tc.activeSegmentDiv = document.createElement("div");
                        tc.activeSegmentDiv.className = "thought-segment";
                        tc.append(tc.activeSegmentDiv);
                    }

                    if (!tc.activeSegmentDiv) {
                        tc.activeSegmentDiv = document.createElement("div");
                        tc.activeSegmentDiv.className = "thought-segment";
                        tc.append(tc.activeSegmentDiv);
                    }

                    const activeText = thinkSegments[thinkSegments.length - 1];
                    tc.activeSegmentDiv.innerHTML = this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(activeText) : activeText);
                }
            }

            // Render non-thought body content and tool cards into bodyWrapper ONLY IF thought block is closed or tool calls exist or bodyContent has length
            if (isClosed || (message && message.toolCalls && message.toolCalls.length > 0) || bodyContent.length > 0) {
                let bodyWrapper = containerDiv.querySelector('.segment-body-wrapper');
                if (!bodyWrapper) {
                    bodyWrapper = document.createElement("div");
                    bodyWrapper.className = "segment-body-wrapper";
                    containerDiv.appendChild(bodyWrapper);
                }
                const currentBodySig = `${bodyContent.length}_${(message?.toolCalls || []).map(tc => `${tc.name || tc.functionCall?.name}:${JSON.stringify(tc.args || tc.functionCall?.args || '').length}`).join(';')}`;
                if (bodyWrapper.dataset.renderSig !== currentBodySig) {
                    bodyWrapper.dataset.renderSig = currentBodySig;
                    let bodyHtml = "";
                    if (message && message.toolCalls && message.toolCalls.length > 0) {
                        const cleanContent = shouldSkip ? bodyContent : bodyContent
                            .replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '')
                            .replace(/<tool_call[\s\S]*?>/gi, '')
                            .replace(/<\/tool_call>/gi, '')
                            .trim();
                        if (cleanContent) {
                            bodyHtml += this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(cleanContent) : cleanContent);
                        }
                        for (let tcIdx = 0; tcIdx < message.toolCalls.length; tcIdx++) {
                            const tc = message.toolCalls[tcIdx];
                            const callObj = tc.functionCall || tc;
                            const toolName = callObj.name || tc.name || "";
                            let args = callObj.args || callObj.arguments || {};
                            if (typeof args === 'string') {
                                try { args = JSON.parse(args); } catch(e) { args = {}; }
                            }
                            bodyHtml += this._renderSingleToolCallCard(toolName, args, tc, tcIdx, message);
                        }
                    } else if (bodyContent.length > 0) {
                        bodyHtml = this.aiManager.md.render(shouldSkip ? this.escapeFauxTags(bodyContent) : bodyContent);
                    }
                    bodyWrapper.innerHTML = bodyHtml;
                }
            }
        } else {
            const currentContentSig = `${bodyContent.length}_${(message?.toolCalls || []).map(tc => `${tc.name || tc.functionCall?.name}:${JSON.stringify(tc.args || tc.functionCall?.args || '').length}`).join(';')}`;
            if (containerDiv.dataset.renderSig !== currentContentSig) {
                containerDiv.dataset.renderSig = currentContentSig;
                containerDiv.innerHTML = this.renderResponseContent(bodyContent, message, isNew, shouldSkip);
            }
        }
    }

    segmentContent(content, skipXml = false) {
        if (!content) return [""];
        const segments = [];
        let currentStart = 0;
        let inCodeBlock = false;
        let inXmlBlock = false;
        let activeXmlTag = "";
        
        let i = 0;
        const len = content.length;
        
        while (i < len) {
            if (!inCodeBlock && !skipXml) {
                if (!inXmlBlock) {
                    for (const tag of ["tool_call", "implementation_plan", "task_list", "complete_task"]) {
                        if (content.startsWith(`<${tag}`, i)) {
                            inXmlBlock = true;
                            activeXmlTag = tag;
                            break;
                        }
                    }
                } else {
                    if (content.startsWith(`</${activeXmlTag}>`, i)) {
                        i += activeXmlTag.length + 3;
                        inXmlBlock = false;
                        activeXmlTag = "";
                        continue;
                    }
                }
            }

            if (!inCodeBlock && !inXmlBlock && !skipXml) {
                for (const closeTag of ["</thought>", "</think>", "</thinking>", "<|channel>"]) {
                    if (content.startsWith(closeTag, i)) {
                        const endIdx = i + closeTag.length;
                        segments.push(content.substring(currentStart, endIdx));
                        currentStart = endIdx;
                        i = endIdx;
                        break;
                    }
                }
            }

            if (!inXmlBlock && content.startsWith("```", i)) {
                if (inCodeBlock) {
                    i += 3;
                    if (content.startsWith("\n", i)) i++;
                    segments.push(content.substring(currentStart, i));
                    currentStart = i;
                    inCodeBlock = false;
                    continue;
                } else {
                    if (i > currentStart) {
                        segments.push(content.substring(currentStart, i));
                        currentStart = i;
                    }
                    inCodeBlock = true;
                    i += 3;
                    continue;
                }
            }

            if (!inCodeBlock && !inXmlBlock) {
                const currentSegmentLength = i - currentStart;
                if (currentSegmentLength >= 3200 && content[i] === '\n') {
                    i++;
                    segments.push(content.substring(currentStart, i));
                    currentStart = i;
                    continue;
                }
            }

            i++;
        }

        if (currentStart < len) {
            segments.push(content.substring(currentStart));
        }
        if (segments.length === 0) {
            segments.push("");
        }
        return segments;
    }
}

