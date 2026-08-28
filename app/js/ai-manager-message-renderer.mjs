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

    renderResponseContent(content, message = null, isNew = false) {
        if (!content) return "";

        if (message && message.toolCalls && message.toolCalls.length > 0) {
            if (!content.includes("<tool_call")) {
                let xmlAppend = "";
                for (const tc of message.toolCalls) {
                    const callObj = tc.functionCall || tc;
                    xmlAppend += `\n<tool_call name="${callObj.name}">\n`;
                    const args = callObj.args || callObj.arguments || {};
                    let argsObj = {};
                    try {
                        argsObj = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        console.error("[Renderer] Failed to parse tool call args:", args, e);
                        argsObj = {};
                    }
                    for (const [k, v] of Object.entries(argsObj)) {
                        const stringValue = typeof v === 'object' ? JSON.stringify(v) : v;
                        xmlAppend += `  <${k}>${stringValue}</${k}>\n`;
                    }
                    xmlAppend += `</tool_call>\n`;
                }
                content += xmlAppend;
            }
        }

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
            const tasksText = content.substring(parsed.taskListBlock.contentStartIdx, parsed.taskListBlock.contentEndIdx).trim();
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
            const taskText = content.substring(block.contentStartIdx, block.contentEndIdx).trim();
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

        if (parsed.thoughtBlock) {
            const thinkContent = content.substring(parsed.thoughtBlock.contentStartIdx, parsed.thoughtBlock.contentEndIdx).trim();
            const isClosed = parsed.thoughtBlock.closed;
            const thinkLabel = isClosed ? (thoughtSeconds ? `Thought Process (${thoughtSeconds}s)` : "Thought Process") : "Thinking...";
            const thinkSegments = this.segmentThoughtContent(thinkContent);
            const thinkSegmentsHtml = thinkSegments.map(seg => `<div class="thought-segment">${this.aiManager.md.render(seg)}</div>`).join('');
            thinkHtml = `
                <div class="thought-block" ${isClosed ? "" : "expanded"}>
                    <div class="thought-header" onclick="this.parentElement.hasAttribute('expanded') ? this.parentElement.removeAttribute('expanded') : this.parentElement.setAttribute('expanded', '')">
                        <ui-icon>chevron_right</ui-icon>
                        <span>${thinkLabel}</span>
                    </div>
                    <div class="thought-content">
                        ${thinkSegmentsHtml}
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

            const args = this.parseToolArgs(toolArgs);

            // Handle Project Management Tools
            if (toolName === "create_implementation_plan" || toolName === "update_task_list" || toolName === "complete_task") {
                if (toolName === "create_implementation_plan" && args.plan) {
                    let planChanged = false;
                    let tasksChanged = false;

                    if (isNew && this.aiManager.activeSession && this.aiManager.activeSession.implementationPlan !== args.plan) {
                        this.aiManager.activeSession.implementationPlan = args.plan;
                        planChanged = true;
                    }

                    const formattedTasks = this.formatTaskList(args.tasks);
                    if (isNew && formattedTasks && this.aiManager.activeSession && this.aiManager.activeSession.taskList !== formattedTasks) {
                        this.aiManager.activeSession.taskList = formattedTasks;
                        tasksChanged = true;
                    }

                    if (planChanged || tasksChanged) {
                        this.aiManager._updateAgentProgressPanel();
                        workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
        
                        if (window.ui.openPlanAndTaskList) {
                            const isOpen = (window.ui.leftTabs?.tabs?.some(t => t.config?.path === "plan_tasks")) ||
                                (window.ui.rightTabs?.tabs?.some(t => t.config?.path === "plan_tasks"));
                            if (!isOpen) {
                                window.ui.openPlanAndTaskList();
                            }
                        }
                    }
                } else if (toolName === "update_task_list" && args.tasks) {
                    const formattedTasks = this.formatTaskList(args.tasks);
                    if (isNew && this.aiManager.activeSession && this.aiManager.activeSession.taskList !== formattedTasks) {
                        this.aiManager.activeSession.taskList = formattedTasks;
                        this.aiManager._updateAgentProgressPanel();
                        workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
                    }
                } else if (toolName === "complete_task" && args.taskName) {
                    if (isNew && this.aiManager.activeSession && this.aiManager.activeSession.taskList) {
                        const escapedTaskText = args.taskName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                        const checkboxRegex = new RegExp(`([\\-*]\\s*\\[\\s*\\]\\s*)${escapedTaskText}`, 'i');
                        if (checkboxRegex.test(this.aiManager.activeSession.taskList)) {
                            this.aiManager.activeSession.taskList = this.aiManager.activeSession.taskList.replace(checkboxRegex, (match, bulletGroup) => {
                                return bulletGroup.replace(/\[\s*\]/, '[x]') + args.taskName;
                            });
                            this.aiManager._updateAgentProgressPanel();
                            workspaceClient.setSession(this.aiManager.activeSession.id, this.aiManager.activeSession);
                        }
                    }
                }

                const beforeText = mainContent.substring(0, tc.startIdx) || "";
                const afterText = mainContent.substring(tc.endIdx) || "";
                if (beforeText.trim()) finalHtml += this.aiManager.md.render(beforeText);
                
                if (toolName === "create_implementation_plan") {
                    const messages = this.aiManager.activeSession?.messages || [];
                    let isPending = false;
                    
                    if (message) {
                        isPending = !message.planStatus || message.planStatus === "pending";
                    } else {
                        // Fallback: find the message in activeSession by content match
                        const matchingMsg = messages.find(m => m.type === "model" && m.content === content);
                        if (matchingMsg) {
                            isPending = !matchingMsg.planStatus || matchingMsg.planStatus === "pending";
                        } else {
                            // During active streaming before finalizing
                            isPending = false;
                        }
                    }

                    console.log("[Plan Render Debug] isPending calculation:", {
                        isProcessing: this.aiManager._isProcessing,
                        messageId: message?.id,
                        planStatus: message ? message.planStatus : (messages.find(m => m.type === "model" && m.content === content)?.planStatus),
                        isPending,
                        messagesCount: messages.length
                    });

                    const status = message ? message.planStatus : (messages.find(m => m.type === "model" && m.content === content)?.planStatus);
                    let cardBg = "color-mix(in srgb, var(--theme) 8%, transparent)";
                    let cardBorder = "1px solid color-mix(in srgb, var(--theme) 25%, transparent)";
                    let cardColor = "var(--theme)";
                    let iconName = "assignment";
                    let titleText = "Implementation Plan Proposed";

                    if (status === "accepted") {
                        cardBg = "rgba(45, 164, 78, 0.1)"; // translucent green (the current implementation green)
                        cardBorder = "1px solid rgba(45, 164, 78, 0.25)";
                        cardColor = "#2da44e";
                        iconName = "check_circle";
                        titleText = "Implementation Plan Accepted";
                    } else if (status === "rejected") {
                        cardBg = "rgba(244, 67, 54, 0.08)"; // translucent red/orange
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
                    finalHtml += planHtml;
                }

                if (afterText.trim()) finalHtml += this.aiManager.md.render(afterText);
                return finalHtml;
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
                        const start = parseInt(args.startLine || args.startline, 10);
                        const count = parseInt(args.lineCount || args.linecount, 10);
                        if (!isNaN(start) && !isNaN(count)) {
                            fileChipHtml += ` #L${start}-${start + count}`;
                        }
                    } else if (toolName === "search_in_file") {
                        const queryText = args.query || "";
                        const truncatedQuery = queryText.length > 20 ? queryText.substring(0, 20) + "..." : queryText;
                        if (truncatedQuery) {
                            fileChipHtml += ` <span class="tool-call-query">"${this._escapeHtml(truncatedQuery)}"</span>`;
                        }
                    } else if (toolName === "edit_file") {
                        let searchLines = 0;
                        let replaceLines = 0;
                        let replaceBytes = 0;
                        if (Array.isArray(args.edits) && args.edits.length > 0) {
                            for (const ed of args.edits) {
                                const s = ed.search || "";
                                const r = ed.replace || "";
                                if (s) searchLines += s.split('\n').length;
                                if (r) {
                                    replaceLines += r.split('\n').length;
                                    replaceBytes += (new TextEncoder().encode(r)).length;
                                }
                            }
                        } else {
                            searchLines = (args.search && args.search.length > 0) ? args.search.split('\n').length : 0;
                            replaceLines = (args.replace && args.replace.length > 0) ? args.replace.split('\n').length : 0;
                            replaceBytes = (new TextEncoder().encode(args.replace || "")).length;
                        }
                        const editsBadge = (Array.isArray(args.edits) && args.edits.length > 1) ? `<span class="tool-call-edits-count">${args.edits.length} edits</span> ` : "";
                        const badgeClass = isClosed ? "tool-call-lines-badge" : "tool-call-lines-badge streaming";
                        fileChipHtml += ` ${editsBadge}<span class="tool-call-bytes">${this.formatByteSize(replaceBytes)}</span> <span class="${badgeClass}">[<span style="color: var(--color-success, #2ea44f);">+${replaceLines}</span> <span style="color: var(--color-error, #cf222e);">${searchLines > 0 ? `-${searchLines}` : '-0'}</span>]</span>`;
                    } else if (toolName === "create_file") {
                        const contentLines = (args.content && args.content.length > 0) ? args.content.split('\n').length : 0;
                        const contentBytes = (new TextEncoder().encode(args.content || "")).length;
                        const badgeClass = isClosed ? "tool-call-lines-badge" : "tool-call-lines-badge streaming";
                        fileChipHtml += ` <span class="tool-call-bytes">${this.formatByteSize(contentBytes)}</span> <span class="${badgeClass}">[<span style="color: var(--color-success, #2ea44f);">+${contentLines}</span>]</span>`;
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

            let badgeClass = isClosed ? (isFailed ? 'failed' : 'invoked') : 'preparing';
            let badgeText = isClosed ? (isFailed ? 'Failed' : 'Invoked') : 'Preparing...';
            if (toolName === "sub_agent_complete") {
                badgeText = isClosed ? (isFailed ? 'Failed' : 'Completed') : 'Reporting...';
            } else if (toolName === "query") {
                badgeText = isClosed ? (isFailed ? 'Failed' : 'Answered') : 'Waiting...';
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

            let toolCardHtml;
            if (toolName === "sub_agent_complete") {
                const resultText = args.result || "";
                const renderedResult = resultText.trim() ? this.aiManager.md.render(resultText) : "";
                toolCardHtml = `
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
                toolCardHtml = `
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

    getModelTurnSummary(content, message = null) {
        let thoughtSeconds = null;
        if (message && message.thoughtDurationMs !== undefined) {
            thoughtSeconds = (message.thoughtDurationMs / 1000).toFixed(1);
        }

        const parsed = this.parseBlocks(content || "");
        
        let toolSummary = "";
        if (parsed.toolCallBlocks && parsed.toolCallBlocks.length > 0) {
            const tc = parsed.toolCallBlocks[0];
            const toolName = tc.name;
            const toolArgs = content.substring(tc.contentStartIdx, tc.contentEndIdx);
            
            const args = this.parseToolArgs(toolArgs);

            if (args.url) {
                const rawUrl = args.url.trim();
                const shortUrl = rawUrl.length > 35 ? rawUrl.substring(0, 35) + "..." : rawUrl;
                toolSummary = `called <code>${toolName}</code> <span style="opacity:0.85;">${this._escapeHtml(shortUrl)}</span>`;
            } else if (args.command) {
                const shortCmd = args.command.length > 35 ? args.command.substring(0, 35) + "..." : args.command;
                const cwdVal = args.cwd || args.dir;
                const cwdInfo = cwdVal ? ` (in ${this._escapeHtml(cwdVal.split('/').filter(Boolean).pop() || cwdVal)})` : '';
                toolSummary = `called <code>${toolName}</code> <span style="opacity:0.85;">$ ${this._escapeHtml(shortCmd)}${cwdInfo}</span>`;
            } else if (args.path) {
                const shortFile = args.path.split('/').pop() || args.path;
                let details = shortFile;
                if (toolName === "edit_file" && (args.edits || args.search !== undefined || args.replace !== undefined)) {
                    let searchLines = 0;
                    let replaceLines = 0;
                    let replaceBytes = 0;
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
                toolSummary = `called <code>${toolName}</code> <span style="opacity:0.85;">${this._escapeHtml(details)}</span>`;
            } else if (args.query) {
                const shortQuery = args.query.length > 30 ? args.query.substring(0, 30) + "..." : args.query;
                toolSummary = `called <code>${toolName}</code> <span style="opacity:0.85;">"${this._escapeHtml(shortQuery)}"</span>`;
            } else {
                toolSummary = `called <code>${toolName}</code>`;
            }
        }

        // Calculate text words if no tool call, or in addition
        const rangesToRemove = [];
        if (parsed.thoughtBlock) {
            rangesToRemove.push({ startIdx: parsed.thoughtBlock.startIdx, endIdx: parsed.thoughtBlock.endIdx });
        }
        if (parsed.toolCallBlocks) {
            parsed.toolCallBlocks.forEach(b => rangesToRemove.push({ startIdx: b.startIdx, endIdx: b.endIdx }));
        }
        const textOnly = this.removeRanges(content || "", rangesToRemove).trim();
        const wordCount = textOnly ? textOnly.split(/\s+/).filter(Boolean).length : 0;

        let parts = [];
        if (thoughtSeconds) {
            parts.push(`Thought ${thoughtSeconds}s`);
        }
        if (toolSummary) {
            parts.push(toolSummary);
        } else if (wordCount > 0) {
            parts.push(`responded ${wordCount} words`);
        } else if (!thoughtSeconds) {
            parts.push(`Model Response`);
        }

        return parts.join(", ");
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
            if (activeBlock) {
                if (activeBlock.type === 'thought') {
                    if (activeBlock.subType === 'thought' && content.startsWith("</thought>", i)) {
                        activeBlock.endIdx = i + 10;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 10;
                        continue;
                    }
                    if (activeBlock.subType === 'think' && content.startsWith("</think>", i)) {
                        activeBlock.endIdx = i + 8;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 8;
                        continue;
                    }
                    if (activeBlock.subType === 'channel' && content.startsWith("<channel|>", i)) {
                        activeBlock.endIdx = i + 10;
                        activeBlock.contentEndIdx = i;
                        activeBlock.closed = true;
                        activeBlock = null;
                        inCodeBlock = false;
                        inInlineCode = false;
                        i += 10;
                        continue;
                    }
                } else if (activeBlock.type === 'plan') {
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
                if (content.startsWith("<|channel>thought", i)) {
                    thoughtBlock = { type: 'thought', subType: 'channel', startIdx: i, contentStartIdx: i + 17, closed: false };
                    activeBlock = thoughtBlock;
                    i += 17;
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
    renderResponseSegment(containerDiv, content, message, isNew = false) {
        if (!containerDiv) return;
        const parsed = this.parseBlocks(content);

        if (parsed.thoughtBlock) {
            const thinkContent = content.substring(parsed.thoughtBlock.contentStartIdx, parsed.thoughtBlock.contentEndIdx).trim();
            const isClosed = parsed.thoughtBlock.closed;
            let thoughtSeconds = null;
            if (message && message.thoughtDurationMs !== undefined) {
                thoughtSeconds = (message.thoughtDurationMs / 1000).toFixed(1);
            }
            const thinkLabel = isClosed ? (thoughtSeconds ? `Thought Process (${thoughtSeconds}s)` : "Thought Process") : "Thinking...";
            const thinkSegments = this.segmentThoughtContent(thinkContent);

            let thoughtBlockEl = containerDiv.querySelector('.thought-block');
            if (!thoughtBlockEl) {
                containerDiv.innerHTML = this.renderResponseContent(content, message, isNew);
                thoughtBlockEl = containerDiv.querySelector('.thought-block');
                if (thoughtBlockEl) {
                    const tc = thoughtBlockEl.querySelector('.thought-content');
                    if (tc) {
                        tc.finalizedCount = Math.max(0, thinkSegments.length - 1);
                        tc.activeSegmentDiv = tc.lastElementChild;
                    }
                }
                return;
            }

            // Update existing thought block incrementally
            const headerSpan = thoughtBlockEl.querySelector('.thought-header span');
            if (headerSpan && headerSpan.textContent !== thinkLabel) {
                headerSpan.textContent = thinkLabel;
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
                        tc.activeSegmentDiv.innerHTML = this.aiManager.md.render(finalizedText);
                    } else {
                        const newDiv = document.createElement("div");
                        newDiv.className = "thought-segment";
                        newDiv.innerHTML = this.aiManager.md.render(finalizedText);
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
                tc.activeSegmentDiv.innerHTML = this.aiManager.md.render(activeText);
            }

            // If thought block is closed and there is remaining content after it, re-render the whole container
            if (isClosed) {
                const afterThought = content.substring(parsed.thoughtBlock.endIdx).trim();
                if (afterThought.length > 0) {
                    containerDiv.innerHTML = this.renderResponseContent(content, message, isNew);
                }
            }
        } else {
            containerDiv.innerHTML = this.renderResponseContent(content, message, isNew);
        }
    }

    segmentContent(content) {
        if (!content) return [""];
        const segments = [];
        let currentStart = 0;
        let inCodeBlock = false;
        let inReasoning = false;
        let inXmlBlock = false;
        let activeXmlTag = "";
        
        let i = 0;
        const len = content.length;
        
        while (i < len) {
            if (!inCodeBlock) {
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

            if (!inCodeBlock && !inXmlBlock) {
                if (!inReasoning) {
                    if (content.startsWith("<thought>", i) || content.startsWith("<think>", i) || content.startsWith("<|channel>thought", i)) {
                        inReasoning = true;
                    }
                } else {
                    let endTagLen = 0;
                    if (content.startsWith("</thought>", i)) endTagLen = 10;
                    else if (content.startsWith("</think>", i)) endTagLen = 8;
                    else if (content.startsWith("<channel|>", i)) endTagLen = 10;
                    
                    if (endTagLen > 0) {
                        i += endTagLen;
                        segments.push(content.substring(currentStart, i));
                        currentStart = i;
                        inReasoning = false;
                        continue;
                    }
                }
            }

            if (!inReasoning && !inXmlBlock && content.startsWith("```", i)) {
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

            if (!inCodeBlock && !inReasoning && !inXmlBlock) {
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

