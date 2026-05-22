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

    renderResponseContent(content, message = null) {
        if (!content) return "";

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

        const parsed = this.parseBlocks(content);
        const rangesToRemove = [];

        if (parsed.planBlock) {
            const planText = content.substring(parsed.planBlock.contentStartIdx, parsed.planBlock.contentEndIdx).trim();
            if (planText && this.aiManager.activeSession && this.aiManager.activeSession.implementationPlan !== planText) {
                this.aiManager.activeSession.implementationPlan = planText;
                this.aiManager._updateAgentProgressPanel();
                if (this.aiManager.historyManager && typeof this.aiManager.historyManager.updateImplementationPlanTrigger === 'function') {
                    this.aiManager.historyManager.updateImplementationPlanTrigger();
                }
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
            const tasksText = content.substring(parsed.taskListBlock.contentStartIdx, parsed.taskListBlock.contentEndIdx).trim();
            if (tasksText && this.aiManager.activeSession && this.aiManager.activeSession.taskList !== tasksText) {
                this.aiManager.activeSession.taskList = tasksText;
                this.aiManager._updateAgentProgressPanel();
                workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
            }
            rangesToRemove.push({ startIdx: parsed.taskListBlock.startIdx, endIdx: parsed.taskListBlock.endIdx });
        }

        let taskListUpdated = false;
        for (const block of parsed.completeTaskBlocks) {
            const taskText = content.substring(block.contentStartIdx, block.contentEndIdx).trim();
            if (taskText && this.aiManager.activeSession && this.aiManager.activeSession.taskList) {
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

        if (taskListUpdated) {
            this.aiManager._updateAgentProgressPanel();
            workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
        }

        let thinkHtml = "";
        if (parsed.thoughtBlock) {
            const thinkContent = content.substring(parsed.thoughtBlock.contentStartIdx, parsed.thoughtBlock.contentEndIdx).trim();
            const isClosed = parsed.thoughtBlock.closed;
            thinkHtml = `
                <div class="thought-block" ${isClosed ? "" : "expanded"}>
                    <div class="thought-header" onclick="this.parentElement.hasAttribute('expanded') ? this.parentElement.removeAttribute('expanded') : this.parentElement.setAttribute('expanded', '')">
                        <ui-icon>chevron_right</ui-icon>
                        <span>${isClosed ? "Thought Process" : "Thinking..."}</span>
                    </div>
                    <div class="thought-content">
                        ${this.aiManager.md.render(thinkContent)}
                    </div>
                </div>
            `;
            rangesToRemove.push({ startIdx: parsed.thoughtBlock.startIdx, endIdx: parsed.thoughtBlock.endIdx });
        }

        const mainContent = this.removeRanges(content, rangesToRemove);
        let finalHtml = thinkHtml;

        const finalParsed = this.parseBlocks(mainContent);
        if (finalParsed.toolCallBlocks.length > 0) {
            const tc = finalParsed.toolCallBlocks[0];
            const toolName = tc.name;
            const toolArgs = mainContent.substring(tc.contentStartIdx, tc.contentEndIdx);
            const isClosed = tc.closed;

            const args = {};
            const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
            let tagMatch;
            while ((tagMatch = tagRegex.exec(toolArgs)) !== null) {
                const key = tagMatch[1];
                let val = tagMatch[2];
                if (key !== 'search' && key !== 'replace' && key !== 'content') {
                    val = val.trim();
                }
                args[key] = val;
            }

            let icon = "extension";
            if (toolName.includes("read")) icon = "find_in_page";
            else if (toolName.includes("list")) icon = "folder_open";
            else if (toolName.includes("search")) icon = "search";
            else if (toolName.includes("edit")) icon = "edit";
            else if (toolName.includes("create")) icon = "create_new_folder";
            else if (toolName.includes("open")) icon = "launch";

            let label = `<code>${toolName}</code>`;
            const fileActions = ["edit_file", "read_file", "create_file", "find_file", "open_file"];
            if (args.path) {
                if (fileActions.includes(toolName)) {
                    const shortFile = args.path.split('/').pop() || args.path;
                    label = `<code>${toolName}:</code> <ui-filechip filename="${this._escapeHtml(shortFile)}" path="${this._escapeHtml(args.path)}"></ui-filechip>`;
                } else {
                    label = `<code>${toolName}:</code> <span class="tool-call-path" title="${this._escapeHtml(args.path)}">${this._escapeHtml(args.path)}</span>`;
                }
            } else if (args.query) {
                label = `<code>${toolName}:</code> <span class="tool-call-query">"${this._escapeHtml(args.query)}"</span>`;
            }

            const badgeClass = isClosed ? (isFailed ? 'failed' : 'invoked') : 'preparing';
            const badgeText = isClosed ? (isFailed ? 'Failed' : 'Invoked') : 'Preparing...';

            const toolCardHtml = `
                <div class="tool-call-block compact">
                    <div class="tool-call-header compact">
                        <ui-icon>${icon}</ui-icon>
                        <span class="tool-call-title compact">${label}</span>
                        <span class="tool-call-status-badge compact ${badgeClass}">${badgeText}</span>
                    </div>
                </div>
            `;

            const beforeText = mainContent.substring(0, tc.startIdx) || "";
            const afterText = mainContent.substring(tc.endIdx) || "";

            if (beforeText.trim()) {
                finalHtml += this.aiManager.md.render(beforeText);
            }
            finalHtml += toolCardHtml;
            if (afterText.trim()) {
                finalHtml += this.aiManager.md.render(afterText);
            }
        } else {
            if (mainContent.trim()) {
                finalHtml += this.aiManager.md.render(mainContent);
            }
        }

        return finalHtml;
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

    parseBlocks(content) {
        if (!content) return { thoughtBlock: null, planBlock: null, taskListBlock: null, completeTaskBlocks: [], toolCallBlocks: [] };
        let inCodeBlock = false;
        let inInlineCode = false;

        let thoughtBlock = null;
        let planBlock = null;
        let taskListBlock = null;
        const completeTaskBlocks = [];
        const toolCallBlocks = [];

        let activeBlock = null; 

        let i = 0;
        const len = content.length;

        while (i < len) {
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

            if (activeBlock) {
                if (activeBlock.type === 'thought') {
                    if (activeBlock.subType === 'thought' && content.startsWith("</thought>", i)) {
                        activeBlock.endIdx = i + 10;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 10;
                        continue;
                    }
                    if (activeBlock.subType === 'think' && content.startsWith("</think>", i)) {
                        activeBlock.endIdx = i + 8;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 8;
                        continue;
                    }
                    if (activeBlock.subType === 'channel' && content.startsWith("\\n", i)) {
                        activeBlock.endIdx = i + 1;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 1;
                        continue;
                    }
                } else if (activeBlock.type === 'plan') {
                    if (content.startsWith("</implementation_plan>", i)) {
                        activeBlock.endIdx = i + 22;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 22;
                        continue;
                    }
                } else if (activeBlock.type === 'taskList') {
                    if (content.startsWith("</task_list>", i)) {
                        activeBlock.endIdx = i + 12;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 12;
                        continue;
                    }
                } else if (activeBlock.type === 'completeTask') {
                    if (content.startsWith("</complete_task>", i)) {
                        activeBlock.endIdx = i + 16;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 16;
                        continue;
                    }
                } else if (activeBlock.type === 'toolCall') {
                    if (content.startsWith("</tool_call>", i)) {
                        activeBlock.endIdx = i + 12;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        i += 12;
                        continue;
                    }
                }
                i++;
                continue;
            }

            if (!thoughtBlock) {
                if (content.startsWith("<thought>", i)) {
                    thoughtBlock = { type: 'thought', subType: 'thought', startIdx: i, contentStartIdx: i + 9, closed: false };
                    activeBlock = thoughtBlock;
                    i += 9;
                    continue;
                }
                if (content.startsWith("<think>", i)) {
                    thoughtBlock = { type: 'thought', subType: 'think', startIdx: i, contentStartIdx: i + 7, closed: false };
                    activeBlock = thoughtBlock;
                    i += 7;
                    continue;
                }
                if (content.startsWith("<|channel>thought <channel|>", i)) {
                    thoughtBlock = { type: 'thought', subType: 'channel', startIdx: i, contentStartIdx: i + 28, closed: false };
                    activeBlock = thoughtBlock;
                    i += 28;
                    continue;
                }
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
            thoughtBlock,
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
}
