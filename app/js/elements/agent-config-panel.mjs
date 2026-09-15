import { Block } from './element.mjs';
import { Button } from './button.mjs';
import { UIAccordion } from './accordion.mjs';
import AIConnections from '../ai-connections.mjs';
import workspaceClient from '../workspace-client.mjs';
import { openCommandPolicyReviewModal } from '../util/command-policy-review.mjs';
import { getCapability, setCapability, commitCapabilities, clearTransient, investigateModel, probeChat, familyLabel, stateMeta, PROBE_PRESETS, guessFamilyFromUrl } from '../ai-probe.mjs';

function showUndoToast(message, undoCallback) {
	const toastEl = document.createElement('div');
	toastEl.className = "agent-undo-toast";
	toastEl.style.position = 'fixed';
	toastEl.style.bottom = '20px';
	toastEl.style.left = '50%';
	toastEl.style.transform = 'translateX(-50%)';
	toastEl.style.padding = '12px 24px';
	toastEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
	toastEl.style.zIndex = '99999';
	toastEl.style.opacity = '0';
	toastEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
	toastEl.style.display = 'flex';
	toastEl.style.alignItems = 'center';
	toastEl.style.gap = '16px';

	const textSpan = document.createElement('span');
	textSpan.textContent = message;
	toastEl.appendChild(textSpan);

	const undoBtn = document.createElement('button');
	undoBtn.textContent = 'Undo';
	undoBtn.style.padding = '4px 12px';
	undoBtn.style.cursor = 'pointer';
	undoBtn.onclick = () => {
		undoCallback();
		toastEl.style.opacity = '0';
		toastEl.style.transform = 'translateX(-50%)';
		setTimeout(() => toastEl.remove(), 300);
	};
	toastEl.appendChild(undoBtn);

	document.body.appendChild(toastEl);

	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			toastEl.style.opacity = '1';
			toastEl.style.transform = 'translateX(-50%) translateY(-10px)';
		});
	});

	setTimeout(() => {
		if (toastEl.parentNode) {
			toastEl.style.opacity = '0';
			toastEl.style.transform = 'translateX(-50%)';
			setTimeout(() => toastEl.remove(), 300);
		}
	}, 5000);
}

export class AgentConfigPanel extends Block {
	constructor() {
		super();
		this.classList.add("agent-config-view");
		this.telemetryIntervalId = null;

		this.container = document.createElement("div");
		this.container.className = "artifacts-accordion-container";
		this.appendChild(this.container);

		this._buildDefaultsAccordion();
		this._buildCustomisationAccordion();
		this._buildServiceKeysAccordion();
		this._buildConnectionsAccordion();
		this._buildTelemetryAccordion();
	}

	connectedCallback() {
		this.telemetryIntervalId = setInterval(() => {
			if (this.style.display !== "none") {
				this.updateTimedMetrics();
			}
		}, 5000);
	}

	disconnectedCallback() {
		if (this.telemetryIntervalId) {
			clearInterval(this.telemetryIntervalId);
			this.telemetryIntervalId = null;
		}
	}

	_buildDefaultsAccordion() {
		this.defaultsAccordion = new UIAccordion("defaults", "Session Defaults", "settings", "var(--theme)");
		const content = this.defaultsAccordion.content;
		content.className = "accordion-content settings-content-wrapper";

		const grid = document.createElement("div");
		grid.className = "settings-grid";
		content.appendChild(grid);

		const createToggleRow = (id, title, desc, key) => {
			const wrapper = document.createElement("div");
			wrapper.className = "toggle-row";

			const label = document.createElement("label");
			label.className = "switch";

			const input = document.createElement("input");
			input.type = "checkbox";
			input.id = id;
			if (key === "defaultAllowSubAgents" || key === "defaultAllowRunCommand" || key === "defaultPlanningMode" || key === "defaultAutoMilestones" || key === "defaultOpenEditsForReview") {
				input.checked = localStorage.getItem(key) !== "false";
			} else {
				input.checked = localStorage.getItem(key) === "true";
			}
			input.onchange = () => {
				localStorage.setItem(key, input.checked);
				if (window.ui?.aiManager) {
					if (key === "aiForgivenessMode") {
						window.ui.aiManager.config.defaultForgivenessMode = input.checked;
						window.ui.aiManager.forgivenessMode = input.checked;
					}
					if (key === "defaultOpenEditsForReview") {
						window.ui.aiManager.config.defaultOpenEditsForReview = input.checked;
						window.ui.aiManager.openEditsForReview = input.checked;
					}
					if (key === "defaultAgentMode") window.ui.aiManager.config.defaultAgentMode = input.checked;
					if (key === "defaultPlanningMode") window.ui.aiManager.config.defaultPlanningMode = input.checked;
					if (key === "defaultAllowSubAgents") window.ui.aiManager.config.defaultAllowSubAgents = input.checked;
					if (key === "defaultAllowRunCommand") window.ui.aiManager.config.defaultAllowRunCommand = input.checked;
					if (key === "defaultAutoMilestones") window.ui.aiManager.config.defaultAutoMilestones = input.checked;
					window.ui.aiManager._updatePromptAreaPlaceholder();
				}
			};

			const slider = document.createElement("span");
			slider.className = "slider round";

			label.appendChild(input);
			label.appendChild(slider);

			const meta = document.createElement("div");
			meta.className = "setting-meta";

			const titleSpan = document.createElement("span");
			titleSpan.className = "toggle-label";
			titleSpan.textContent = title;
			titleSpan.onclick = () => input.click();

			const descSpan = document.createElement("span");
			descSpan.className = "setting-desc";
			descSpan.textContent = desc;

			meta.appendChild(titleSpan);
			meta.appendChild(descSpan);

			wrapper.appendChild(label);
			wrapper.appendChild(meta);
			grid.appendChild(wrapper);

			return { input, wrapper };
		};

		createToggleRow("default-agent-mode", "Default Agent Mode", "Start new sessions in Agent Mode automatically.", "defaultAgentMode");
		createToggleRow("default-planning-mode", "Default Planning Mode", "Start new sessions with Planning Mode enabled.", "defaultPlanningMode");
		const forgivenessToggle = createToggleRow("default-forgiveness-mode", "Default Forgiveness Mode", "Commit edits immediately to disk (after validation checks)", "aiForgivenessMode");
		const openEditsToggle = createToggleRow("default-open-edits-for-review", "Default Open Edits for Review", "Open files in editor for diff review (optional in Forgiveness Mode).", "defaultOpenEditsForReview");
		createToggleRow("default-allow-sub-agents", "Default Allow Sub-Agents", "Start new sessions with sub-agents allowed.", "defaultAllowSubAgents");
		const runCommandRow = createToggleRow("default-allow-run-command", "Default Allow Terminal Commands", "Start new sessions with terminal commands allowed.", "defaultAllowRunCommand");
		{
			const cog = new Button();
			cog.className = "setting-cog-btn";
			cog.icon = "settings";
			cog.title = "Review command policies (global)";
			cog.onclick = (e) => {
				e.stopPropagation();
				openCommandPolicyReviewModal({
					title: "Command Policies",
					scope: "global",
					getPolicy: () => {
						const mgr = window.ui?.aiManager;
						if (mgr?.config?.commandPolicy) return mgr.config.commandPolicy;
						mgr.config.commandPolicy = { allow: [], block: [] };
						return mgr.config.commandPolicy;
					},
					onPersist: () => {
						const mgr = window.ui?.aiManager;
						if (mgr?.saveCommandPolicy) mgr.saveCommandPolicy(mgr.config.commandPolicy);
					}
				});
			};
			runCommandRow.wrapper.classList.add("has-cog");
			runCommandRow.wrapper.appendChild(cog);
		}
		createToggleRow("default-auto-milestones", "Default Auto-Milestones on 'done'", "Automatically freeze a checkpoint milestone when the agent finishes a cycle in new sessions.", "defaultAutoMilestones");
		createToggleRow("default-auto-rollback-on-failures", "Default Auto-Rollback on Edit Failures", "Automatically roll back a file when consecutive edits fail.", "defaultAutoRollbackOnFailures");

		const updateOpenEditsToggle = (isForgiveness) => {
			if (!isForgiveness) {
				openEditsToggle.input.disabled = true;
				openEditsToggle.input.checked = true;
				openEditsToggle.wrapper.classList.add("disabled-row");
				openEditsToggle.input.title = "Required in Permission Mode: Edits must be reviewed and applied manually.";
			} else {
				openEditsToggle.input.disabled = false;
				openEditsToggle.input.checked = localStorage.getItem("defaultOpenEditsForReview") !== "false";
				openEditsToggle.wrapper.classList.remove("disabled-row");
				openEditsToggle.input.title = "Open modified and newly created files in editor tabs for diff review.";
			}
		};
		updateOpenEditsToggle(forgivenessToggle.input.checked);

		const origForgivenessOnChange = forgivenessToggle.input.onchange;
		forgivenessToggle.input.onchange = () => {
			if (origForgivenessOnChange) origForgivenessOnChange();
			updateOpenEditsToggle(forgivenessToggle.input.checked);
		};

		const createNumberInputRow = (id, title, desc, key, defaultValue, min = 1, max = 10) => {
			const wrapper = document.createElement("div");
			wrapper.className = "toggle-row number-input-row";

			const input = document.createElement("input");
			input.type = "number";
			input.id = id;
			input.min = min;
			input.max = max;
			input.className = "setting-number-input";

			const stored = localStorage.getItem(key);
			input.value = stored !== null ? stored : defaultValue;
			input.onchange = () => {
				localStorage.setItem(key, input.value);
				if (window.ui?.aiManager) {
					window.ui.aiManager.config[key] = parseInt(input.value);
				}
			};

			const meta = document.createElement("div");
			meta.className = "setting-meta";

			const titleSpan = document.createElement("span");
			titleSpan.className = "toggle-label";
			titleSpan.textContent = title;

			const descSpan = document.createElement("span");
			descSpan.className = "setting-desc";
			descSpan.textContent = desc;

			meta.appendChild(titleSpan);
			meta.appendChild(descSpan);

			wrapper.appendChild(input);
			wrapper.appendChild(meta);
			grid.appendChild(wrapper);
		};

		createNumberInputRow("default-auto-rollback-threshold", "Auto-Rollback Failure Count", "Number of consecutive failed edits before rolling back the file (default 3).", "defaultAutoRollbackThreshold", "3", 1, 10);
		createNumberInputRow("default-max-prefill", "Max Context Pre-fill (%)", "Default upper threshold before context culling triggers (default 80).", "contextPrefillMaxPercentage", "80", 20, 100);
		createNumberInputRow("default-min-prefill", "Min Context Pre-fill (%)", "Default cull target when max pre-fill is triggered (default 40).", "contextPrefillMinPercentage", "40", 10, 100);
		createNumberInputRow("max-sub-agents", "Max Sub-Agents", "Maximum number of parallel sub-agents the main agent is permitted to spawn.", "maxSubAgents", "3", 1, 20);

		this.container.appendChild(this.defaultsAccordion);
	}

	_buildCustomisationAccordion() {
		this.customisationAccordion = new UIAccordion("customisation", "Chat Prompt Customisation", "edit", "#d19a66");
		this.customisationAccordion.content.className = "accordion-content settings-content-wrapper";
		this.container.appendChild(this.customisationAccordion);
		this.renderCustomisationAccordion();
	}

	_buildServiceKeysAccordion() {
		this.serviceKeysAccordion = new UIAccordion("service-keys", "Service Keys", "key", "#e67e22");
		const content = this.serviceKeysAccordion.content;
		content.className = "accordion-content settings-content-wrapper";
		this.container.appendChild(this.serviceKeysAccordion);

		const grid = document.createElement("div");
		grid.className = "settings-grid";
		content.appendChild(grid);

		// Tavily API Key with test-then-save flow
		const tavilyWrapper = document.createElement("div");
		tavilyWrapper.className = "field";
		const tavilyLabel = document.createElement("label");
		tavilyLabel.className = "field-label";
		tavilyLabel.textContent = "Tavily API Key";
		const tavilyControl = document.createElement("div");
		tavilyControl.className = "field-control";
		const tavilyInput = document.createElement("input");
		tavilyInput.type = "password";
		tavilyInput.id = "tavily-api-key";
		tavilyInput.value = localStorage.getItem("tavilyApiKey") || "";
		tavilyControl.appendChild(tavilyInput);
		const tavilyBtnRow = document.createElement("div");
		tavilyBtnRow.className = "field-suffix";
		const tavilyStatus = document.createElement("span");
		tavilyStatus.className = "field-desc";
		const tavilyTestBtn = new Button("Test");
		tavilyTestBtn.className = "theme-button secondary";
		tavilyBtnRow.appendChild(tavilyTestBtn);
		tavilyTestBtn.onclick = async () => {
			const val = tavilyInput.value.trim();
			if (!val) {
				tavilyStatus.textContent = "Enter a key first.";
				tavilyStatus.classList.remove("is-ok", "is-error");
				tavilyStatus.classList.add("is-muted");
				return;
			}
			tavilyTestBtn.disabled = true;
			tavilyTestBtn.text = "Testing\u2026";
			tavilyStatus.textContent = "";
			try {
				const res = await fetch("https://api.tavily.com/search", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						api_key: val,
						query: "test",
						max_results: 1,
						include_answer: false
					})
				});
				if (!res.ok) {
					const errBody = await res.text().catch(() => "");
					throw new Error(`API ${res.status}: ${errBody || res.statusText}`);
				}
				await res.json();
				localStorage.setItem("tavilyApiKey", val);
				tavilyTestBtn.text = "Saved";
				tavilyTestBtn.className = "theme-button primary";
				tavilyTestBtn.disabled = true;
				tavilyStatus.textContent = "Key verified and saved.";
				tavilyStatus.classList.remove("is-muted", "is-error");
				tavilyStatus.classList.add("is-ok");
			} catch (err) {
				tavilyStatus.textContent = `Failed: ${err.message}`;
				tavilyStatus.classList.remove("is-muted", "is-ok");
				tavilyStatus.classList.add("is-error");
				tavilyTestBtn.text = "Test";
				tavilyTestBtn.disabled = false;
				tavilyTestBtn.className = "theme-button secondary";
			}
		};
		tavilyStatus.classList.add("is-hint");
		tavilyWrapper.append(tavilyLabel, tavilyControl);
		tavilyWrapper.appendChild(tavilyBtnRow);
		tavilyWrapper.appendChild(tavilyStatus);
		grid.appendChild(tavilyWrapper);
	}

	renderCustomisationAccordion() {
		const content = this.customisationAccordion.content;
		content.innerHTML = "";

		const desc = document.createElement("p");
		desc.className = "panel-note";
		desc.innerHTML = `<b>Note:</b> These customisation choices adjust instructions and focus guidelines for standard chat mode turns. They do <b>NOT</b> apply to agent execution steps or planning mode instructions.`;
		content.appendChild(desc);

		const grid = document.createElement("div");
		grid.className = "settings-grid";
		grid.style.display = "flex";
		grid.style.flexDirection = "column";
		grid.style.gap = "12px";
		content.appendChild(grid);

		// Ensure we load the fresh configuration
		if (window.ui?.aiManager) {
			window.ui.aiManager._loadSystemPromptConfig();
		}

		const config = window.ui?.aiManager?.systemPromptConfig || {
			specialization: "JavaScript (ECMAScript), HTML, CSS, and Node.js",
			technologies: [],
			avoidedTechnologies: [],
			tone: ["warm", "playful", "cheeky"]
		};

		// Helper to save prompt config
		const saveConfig = () => {
			if (window.ui?.aiManager) {
				window.ui.aiManager.saveSystemPromptConfig(config, window.ui.aiManager.useWorkspaceSettings);
			}
		};

		// Focus selection dropdown
		const focusWrapper = document.createElement("div");
		focusWrapper.className = "field";
		const focusLabel = document.createElement("label");
		focusLabel.className = "field-label";
		focusLabel.textContent = "AI Focus";
		const focusControl = document.createElement("div");
		focusControl.className = "field-control";
		const select = document.createElement("select");
		select.className = "themed-select";

		const focusOptions = [
			"JavaScript (ECMAScript), HTML, CSS, and Node.js",
			"Web Frontend (HTML, CSS, JavaScript, etc)",
			"Web Backend (Node.js, PHP, etc)",
			"Full-Stack Web Development",
			"Embedded Systems",
			"Systems Architecture"
		];
		focusOptions.forEach(opt => {
			const option = document.createElement("option");
			option.value = opt;
			option.textContent = opt;
			if (config.specialization === opt) option.selected = true;
			select.appendChild(option);
		});
		select.onchange = () => {
			config.specialization = select.value;
			saveConfig();
		};
		focusControl.appendChild(select);
		focusWrapper.append(focusLabel, focusControl);
		grid.appendChild(focusWrapper);

		// Tech inputs
		const createTextInput = (labelText, value, onChange) => {
			const wrapper = document.createElement("div");
			wrapper.className = "field";
			const label = document.createElement("label");
			label.className = "field-label";
			label.textContent = labelText;
			const control = document.createElement("div");
			control.className = "field-control";
			const input = document.createElement("input");
			input.type = "text";
			input.value = value;
			input.onchange = () => {
				onChange(input.value);
				saveConfig();
			};
			control.appendChild(input);
			wrapper.append(label, control);
			grid.appendChild(wrapper);
			return { wrapper, input };
		};

		createTextInput("Preferred Technologies (comma-separated)", (config.technologies || []).join(", "), (val) => {
			config.technologies = val.split(",").map(t => t.trim()).filter(Boolean);
		});
		createTextInput("Avoid Technologies (comma-separated)", (config.avoidedTechnologies || []).join(", "), (val) => {
			config.avoidedTechnologies = val.split(",").map(t => t.trim()).filter(Boolean);
		});
		createTextInput("AI Tone (comma-separated)", (config.tone || []).join(", "), (val) => {
			config.tone = val.split(",").map(t => t.trim()).filter(Boolean);
		});
	}

	_buildConnectionsAccordion() {
		this.connectionsAccordion = new UIAccordion("connections-pool", "Connection Pool", "hub", "#2da44e", [{
			className: "icon-button",
			icon: "add",
			title: "Add connection",
			onClick: () => this.showConnectionModal()
		}]);
		const content = this.connectionsAccordion.content;
		content.className = "accordion-content settings-content-wrapper connections-pool-wrapper";

		this.connListContainer = document.createElement("div");
		this.connListContainer.className = "connections-list";
		this.connListContainer.style.display = "flex";
		this.connListContainer.style.flexDirection = "column";
		this.connListContainer.style.gap = "8px";
		content.appendChild(this.connListContainer);

		this.container.appendChild(this.connectionsAccordion);

		this.renderConnectionsList();
	}

	renderConnectionsList() {
		this.connListContainer.innerHTML = "";
		const connections = AIConnections.getConnections();
		const defaultId = AIConnections.defaultConnectionId;

		if (connections.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty-state";
			const icon = document.createElement("ui-icon");
			icon.textContent = "hub";
			const text = document.createElement("span");
			text.textContent = "No connections yet.";
			const cta = new Button("Add connection");
			cta.className = "variant-primary density-sm";
			cta.icon = "add";
			cta.onclick = () => this.showConnectionModal();
			empty.append(icon, text, cta);
			this.connListContainer.appendChild(empty);
			return;
		}

		connections.forEach(conn => {
			const item = document.createElement("div");
			item.className = "connection-item-row";
			item.style.display = "flex";
			item.style.justifyContent = "space-between";
			item.style.alignItems = "center";
			item.style.padding = "8px 12px";

			// Left details
			const left = document.createElement("div");
			left.style.display = "flex";
			left.style.alignItems = "center";
			left.style.gap = "8px";

			// 2-bar/3-bar drag handle
			const handle = document.createElement("ui-icon");
			handle.className = "conn-drag-handle";
			handle.textContent = "drag_handle";
			handle.style.cursor = "grab";
			handle.title = "Drag to reorder connection";
			left.appendChild(handle);

			// Setup drag events on the item row
			item.draggable = false;
			handle.addEventListener("mousedown", () => {
				item.draggable = true;
			});
			handle.addEventListener("mouseup", () => {
				item.draggable = false;
			});
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData("text/plain", conn.id);
				e.dataTransfer.effectAllowed = "move";
				item.style.opacity = "0.4";
			});
			item.addEventListener("dragend", () => {
				item.style.opacity = "";
				item.draggable = false;
				// Re-render to clear any drag states
				this.renderConnectionsList();
			});
			item.addEventListener("dragover", (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				item.classList.add("drag-over");
			});
			item.addEventListener("dragleave", () => {
				item.classList.remove("drag-over");
			});
			item.addEventListener("drop", (e) => {
				e.preventDefault();
				item.classList.remove("drag-over");
				const draggedId = e.dataTransfer.getData("text/plain");
				if (draggedId && draggedId !== conn.id) {
					const list = AIConnections.getConnections();
					const draggedIndex = list.findIndex(c => c.id === draggedId);
					const targetIndex = list.findIndex(c => c.id === conn.id);
					if (draggedIndex !== -1 && targetIndex !== -1) {
						// Remove and insert
						const [draggedItem] = list.splice(draggedIndex, 1);
						list.splice(targetIndex, 0, draggedItem);
						AIConnections.save(); // Automatically updates selector via event trigger
						this.renderConnectionsList();
					}
				}
			});

			const star = document.createElement("ui-icon");
			star.className = conn.id === defaultId ? "conn-star is-default" : "conn-star is-muted";
			star.style.cursor = "pointer";
			star.textContent = conn.id === defaultId ? "star" : "star_border";
			star.title = conn.id === defaultId ? "Default connection (starred)" : "Click to set as default connection";
			star.onclick = () => {
				AIConnections.setDefaultConnection(conn.id);
				this.renderConnectionsList();
			};

			const text = document.createElement("div");
			text.style.display = "flex";
			text.style.flexDirection = "column";

			const nameWrapper = document.createElement("div");
			nameWrapper.style.display = "flex";
			nameWrapper.style.alignItems = "center";
			nameWrapper.style.gap = "8px";

			const name = document.createElement("span");
			name.className = "conn-name";
			name.textContent = conn.name;
			nameWrapper.appendChild(name);

			const size = conn.size || "medium";
			const sizeChip = document.createElement("span");
			sizeChip.classList.add("conn-size-chip", `size-${size}`);
			sizeChip.textContent = size;
			nameWrapper.appendChild(sizeChip);

			const info = document.createElement("span");
			info.className = "conn-info";
			info.textContent = `${conn.provider} - ${conn.config?.model || 'No model selected'}`;

			text.appendChild(nameWrapper);
			text.appendChild(info);

			left.appendChild(star);
			left.appendChild(text);
			item.appendChild(left);

			// Right actions
			const right = document.createElement("div");
			right.style.display = "flex";
			right.style.alignItems = "center";
			right.style.gap = "6px";

			const inst = AIConnections.getInstance(conn.id);
			const tpsLabel = document.createElement("span");
			tpsLabel.className = "connection-tps-badge";
			tpsLabel.dataset.connId = conn.id;
			tpsLabel.style.padding = "2px 6px";
			tpsLabel.style.marginRight = "4px";
			tpsLabel.title = "Rolling 5-response average speed";
			if (inst && inst.averageTokensPerSec > 0) {
				tpsLabel.textContent = `${inst.averageTokensPerSec} t/s`;
				tpsLabel.style.display = "inline-flex";
			} else {
				tpsLabel.style.display = "none";
			}
			right.appendChild(tpsLabel);

			const editBtn = new Button("");
			editBtn.icon = "edit";
			editBtn.className = "icon-button secondary";
			editBtn.title = "Edit connection settings";
			editBtn.setAttribute("aria-label", "Edit connection settings");
			editBtn.onclick = () => this.showConnectionModal(conn);

			const copyBtn = new Button("");
			copyBtn.icon = "content_copy";
			copyBtn.className = "icon-button secondary";
			copyBtn.title = "Copy connection";
			copyBtn.setAttribute("aria-label", "Copy connection");
			copyBtn.onclick = () => {
				const newConn = JSON.parse(JSON.stringify(conn));
				newConn.id = `conn-${crypto.randomUUID()}`;
				newConn.name = `${newConn.name} Copy`;
				AIConnections.saveConnection(newConn);
				this.renderConnectionsList();
				if (window.modal && typeof window.modal.toast === "function") {
					window.modal.toast(`Copied connection as "${newConn.name}"`);
				}
			};

			const deleteBtn = new Button("");
			deleteBtn.icon = "delete";
			deleteBtn.className = "icon-button secondary danger";
			deleteBtn.title = "Delete connection";
			deleteBtn.setAttribute("aria-label", "Delete connection");
			deleteBtn.onclick = () => {
				const deleted = AIConnections.deleteConnection(conn.id);
				if (deleted) {
					showUndoToast(`Deleted connection "${deleted.name}"`, () => {
						AIConnections.saveConnection(deleted);
						this.renderConnectionsList();
					});
					this.renderConnectionsList();
				}
			};

			right.appendChild(editBtn);
			right.appendChild(copyBtn);
			right.appendChild(deleteBtn);
			item.appendChild(right);

			// Async status check for local connections on render/update
			if (conn.provider === "llamacpp" || conn.provider === "ollama") {
				AIConnections.testConnection(conn).then(() => {
					// Succeeded - ensure clean styling and save the dynamically fetched parameters
					if (item.style.opacity !== "0.4") { // Avoid overwriting drag opacity
						item.style.opacity = "";
					}
					info.textContent = `${conn.provider} - ${conn.config?.model || 'No model selected'}`;
					info.classList.remove("is-error");
					
					// Automatically persist the resolved model path and n_ctx window details
					AIConnections.save();
				}).catch(() => {
					// Failed - visually disable
					item.style.opacity = "0.5";
					info.textContent = `${conn.provider} - unavailable`;
					info.classList.add("is-error");
				});
			}

			this.connListContainer.appendChild(item);
		});
	}

	showConnectionModal(conn = null) {
		const isEdit = !!conn;
		const modalObj = window.modal;

		modalObj.snapshot(); // capture any modal below before replacing content
		modalObj.inner.innerHTML = "";
		modalObj.actionBar.innerHTML = "";

		const title = document.createElement("h1");
		title.textContent = isEdit ? `Edit Connection: ${conn.name}` : "Add Connection";
		modalObj.inner.appendChild(title);

		const form = document.createElement("div");
		form.style.display = "flex";
		form.style.flexDirection = "column";
		form.style.gap = "10px";
		form.style.marginTop = "12px";

		// Provider select
		const provRow = document.createElement("div");
		provRow.style.display = "flex";
		provRow.style.flexDirection = "column";
		provRow.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">Provider</label>`;
		const provSelect = document.createElement("select");
		provSelect.className = "themed-select";
		const providerLabels = {
			gemini: "Gemini",
			llamacpp: "Llama.cpp",
			ollama: "Ollama",
			claude: "Claude",
			openai: "OpenAI / OpenRouter (Generic)"
		};
		["gemini", "llamacpp", "ollama", "claude", "openai"].forEach(p => {
			const opt = document.createElement("option");
			opt.value = p;
			opt.textContent = providerLabels[p] || p.charAt(0).toUpperCase() + p.slice(1);
			if (conn && conn.provider === p) opt.selected = true;
			provSelect.appendChild(opt);
		});
		provRow.appendChild(provSelect);
		form.appendChild(provRow);

		// Name input
		const nameRow = document.createElement("div");
		nameRow.style.display = "flex";
		nameRow.style.flexDirection = "column";
		nameRow.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">Connection Name</label>`;
		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.className = "modal-text-input";
		nameInput.style.padding = "6px";
		nameInput.value = conn ? conn.name : "";
		nameRow.appendChild(nameInput);
		form.appendChild(nameRow);

		// Size dropdown
		const sizeRow = document.createElement("div");
		sizeRow.style.display = "flex";
		sizeRow.style.flexDirection = "column";
		sizeRow.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">Model Size / Capability Class</label>`;
		const sizeSelect = document.createElement("select");
		sizeSelect.className = "themed-select";
		[
			{ value: "tiny", label: "Tiny (Extremely fast, lowest cost, simple tasks)" },
			{ value: "small", label: "Small (Faster, lower cost, less capable)" },
			{ value: "medium", label: "Medium (Moderate cost, balanced capability)" },
			{ value: "large", label: "Large (Very capable, slower, higher cost)" },
			{ value: "ultra", label: "Ultra (Frontier capability, peak cost)" }
		].forEach(s => {
			const opt = document.createElement("option");
			opt.value = s.value;
			opt.textContent = s.label;
			if (conn && conn.size === s.value) opt.selected = true;
			else if (!conn && s.value === "medium") opt.selected = true;
			sizeSelect.appendChild(opt);
		});
		sizeRow.appendChild(sizeSelect);
		form.appendChild(sizeRow);

		// Provider specific container
		const specContainer = document.createElement("div");
		specContainer.style.display = "flex";
		specContainer.style.flexDirection = "column";
		specContainer.style.gap = "10px";
		form.appendChild(specContainer);

		// Model list dropdown container
		const modelContainer = document.createElement("div");
		modelContainer.style.display = "none";
		modelContainer.style.flexDirection = "column";
		modelContainer.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">Model Selection</label>`;
		const modelRow = document.createElement("div");
		modelRow.style.display = "flex";
		modelRow.style.alignItems = "center";
		modelRow.style.gap = "6px";
		const datalistId = `cadence-model-options-${crypto.randomUUID()}`;
		const modelSelect = document.createElement("input");
		modelSelect.type = "text";
		modelSelect.className = "themed-select";
		modelSelect.autocomplete = "off";
		modelSelect.spellcheck = false;
		modelSelect.style.flex = "1";
		modelSelect.placeholder = "Type to filter available models...";
		modelSelect.setAttribute("list", datalistId);

		const presetWrap = document.createElement("div");
		presetWrap.style.display = "none";
		presetWrap.style.alignItems = "center";
		presetWrap.style.gap = "4px";
		presetWrap.style.flexShrink = "0";
		const presetIcon = document.createElement("span");
		presetIcon.className = "preset-icon";
		presetIcon.textContent = "\u{1F527}";
		presetIcon.style.cursor = "default";
		presetIcon.title = "This model has known parameters. Apply a tuned preset.";
		const presetSelect = document.createElement("select");
		presetSelect.className = "themed-select";
		presetSelect.dataset.probePreset = "preset";
		presetSelect.classList.add("compact-select");
		presetSelect.style.padding = "4px";
		presetSelect.title = "Apply a tuned parameter preset";
		["default", "coding", "planning"].forEach(p => {
			const opt = document.createElement("option");
			opt.value = p;
			opt.textContent = p === "default" ? "Default" : p.charAt(0).toUpperCase() + p.slice(1);
			presetSelect.appendChild(opt);
		});
		presetWrap.append(presetIcon, presetSelect);
		modelRow.append(modelSelect, presetWrap);
		modelContainer.appendChild(modelRow);
		const modelDatalist = document.createElement("datalist");
		modelDatalist.id = datalistId;
		modelContainer.appendChild(modelDatalist);
		const modelPlaceholder = document.createElement("div");
		modelPlaceholder.className = "model-placeholder";
		modelPlaceholder.textContent = "Test the connection to load available models";
		modelContainer.appendChild(modelPlaceholder);
		form.appendChild(modelContainer);

		// Model capability panel
		const modelInfo = document.createElement("div");
		modelInfo.dataset.probePanel = "modelInfo";
		modelInfo.className = "probe-panel";
		modelInfo.style.display = "none";
		modelInfo.style.flexDirection = "column";
		modelInfo.style.gap = "6px";
		modelInfo.style.padding = "8px";
		form.appendChild(modelInfo);

		// Test status container
		const testStatus = document.createElement("div");
		testStatus.className = "test-status";
		testStatus.style.padding = "8px";
		testStatus.style.display = "none";
		form.appendChild(testStatus);

		let buildSpecInputs = () => {
			specContainer.innerHTML = "";
			const provider = provSelect.value;

			const createInput = (labelVal, value, isPassword = false, placeholder = "", hint = "") => {
				const wrapper = document.createElement("div");
				wrapper.style.display = "flex";
				wrapper.style.flexDirection = "column";
				wrapper.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">${labelVal}</label>`;
				const inp = document.createElement("input");
				inp.type = isPassword ? "password" : "text";
				inp.className = "modal-text-input";
				inp.style.padding = "6px";
				inp.value = value;
				if (placeholder) inp.placeholder = placeholder;
				if (hint) {
					const hintEl = document.createElement("div");
					hintEl.className = "field-hint";
					hintEl.textContent = hint;
					wrapper.appendChild(hintEl);
				}
				wrapper.appendChild(inp);
				specContainer.appendChild(wrapper);
				return inp;
			};

			const createSelect = (labelVal, value, options) => {
				const wrapper = document.createElement("div");
				wrapper.style.display = "flex";
				wrapper.style.flexDirection = "column";
				wrapper.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">${labelVal}</label>`;
				const sel = document.createElement("select");
				sel.className = "themed-select";
				options.forEach(opt => {
					const o = document.createElement("option");
					o.value = opt.value;
					o.textContent = opt.label;
					if (opt.value === value) {
						o.selected = true;
					}
					sel.appendChild(o);
				});
				wrapper.appendChild(sel);
				specContainer.appendChild(wrapper);
				return sel;
			};

			if (provider === "gemini") {
				const defServer = "https://generativelanguage.googleapis.com";
				const srv = conn && conn.provider === "gemini" ? conn.config.server : defServer;
				const key = conn && conn.provider === "gemini" ? conn.config.apiKey : "";
				provSelect.serverInput = createInput("Gemini API Server", srv);
				provSelect.keyInput = createInput("Gemini API Key", key, true);
				
				// Gemini Limits
				const rpm = conn && conn.provider === "gemini" ? (conn.config.rpmLimit || 15) : 15;
				const tpm = conn && conn.provider === "gemini" ? (conn.config.tpmLimit || 250000) : 250000;
				const rpd = conn && conn.provider === "gemini" ? (conn.config.rpdLimit || 500) : 500;
				const maxInput = conn && conn.provider === "gemini" ? (conn.config.maxInputTokens || 0) : 0;
				const maxTurns = conn && conn.provider === "gemini" ? (conn.config.maxTurns !== undefined ? conn.config.maxTurns : 50) : 50;
				const thinking = conn && conn.provider === "gemini" ? (conn.config.thinkingLevel || "medium") : "medium";
				provSelect.rpmInput = createInput("RPM Limit (Requests/Min)", rpm);
				provSelect.tpmInput = createInput("TPM Limit (Tokens/Min)", tpm);
				provSelect.rpdInput = createInput("RPD Limit (Requests/Day)", rpd);
				provSelect.maxInputTokensInput = createInput("Max Input Tokens (0 for unlimited)", maxInput);
				provSelect.maxTurnsInput = createInput("Max Agent Turns (0 for unlimited)", maxTurns);
				provSelect.thinkingInput = createSelect("Thinking Budget", thinking, [
					{ value: "off", label: "Off" },
					{ value: "low", label: "Low" },
					{ value: "medium", label: "Medium" },
					{ value: "high", label: "High" },
					{ value: "unlimited", label: "Unlimited" }
				]);
			} else if (provider === "llamacpp") {
				const defServer = "http://localhost:8080";
				const srv = conn && conn.provider === "llamacpp" ? conn.config.server : defServer;
				provSelect.serverInput = createInput("Llama.cpp API Server", srv);
				
				// Llama.cpp options
				const nctx = conn && conn.provider === "llamacpp" ? (conn.config.n_ctx || 0) : 0;
				const topK = conn && conn.provider === "llamacpp" ? (conn.config.top_k || 40) : 40;
				const topP = conn && conn.provider === "llamacpp" ? (conn.config.top_p || 0.9) : 0.9;
				const temp = conn && conn.provider === "llamacpp" ? (conn.config.temperature !== undefined ? conn.config.temperature : 0.7) : 0.7;
				const maxTurns = conn && conn.provider === "llamacpp" ? (conn.config.maxTurns || 0) : 0;
				const thinking = conn && conn.provider === "llamacpp" ? (conn.config.thinkingLevel || "medium") : "medium";
				provSelect.nctxInput = createInput("Context Size (n_ctx, 0 for auto)", nctx);
				provSelect.topKInput = createInput("Top K", topK);
				provSelect.topPInput = createInput("Top P", topP);
				provSelect.tempInput = createInput("Temperature", temp);
				provSelect.maxTurnsInput = createInput("Max Agent Turns (0 for unlimited)", maxTurns);
				provSelect.thinkingInput = createSelect("Thinking Budget", thinking, [
					{ value: "off", label: "Off" },
					{ value: "low", label: "Low" },
					{ value: "medium", label: "Medium" },
					{ value: "high", label: "High" },
					{ value: "unlimited", label: "Unlimited" }
				]);
			} else if (provider === "ollama") {
				const defServer = "http://localhost:11434";
				const srv = conn && conn.provider === "ollama" ? conn.config.server : defServer;
				const maxTurns = conn && conn.provider === "ollama" ? (conn.config.maxTurns || 0) : 0;
				provSelect.serverInput = createInput("Ollama API Server", srv);
				provSelect.maxTurnsInput = createInput("Max Agent Turns (0 for unlimited)", maxTurns);
			} else if (provider === "claude") {
				const defServer = "https://api.anthropic.com";
				const srv = conn && conn.provider === "claude" ? conn.config.server : defServer;
				const key = conn && conn.provider === "claude" ? conn.config.apiKey : "";
				const maxTurns = conn && conn.provider === "claude" ? (conn.config.maxTurns || 0) : 0;
				provSelect.serverInput = createInput("Anthropic API Server", srv);
				provSelect.keyInput = createInput("Anthropic API Key", key, true);
				provSelect.maxTurnsInput = createInput("Max Agent Turns (0 for unlimited)", maxTurns);
			} else if (provider === "openai") {
				const defServer = "https://api.openai.com/v1";
				const srv = conn && conn.provider === "openai" ? conn.config.server : defServer;
				const key = conn && conn.provider === "openai" ? conn.config.apiKey : "";
				const temp = conn && conn.provider === "openai" ? (conn.config.temperature !== undefined ? conn.config.temperature : 0.7) : 0.7;
				const topP = conn && conn.provider === "openai" ? (conn.config.top_p !== undefined ? conn.config.top_p : 1.0) : 1.0;
				const topK = conn && conn.provider === "openai" ? (conn.config.top_k !== undefined ? conn.config.top_k : 0) : 0;
				const maxTokens = conn && conn.provider === "openai" ? (conn.config.maxTokens || 4096) : 4096;
				const maxTurns = conn && conn.provider === "openai" ? (conn.config.maxTurns || 0) : 0;
				const thinking = conn && conn.provider === "openai" ? (conn.config.thinkingLevel || "medium") : "medium";
				provSelect.serverInput = createInput(
					"API Server (OpenAI, OpenRouter, or compatible)",
					srv,
					false,
					"https://openrouter.ai/api/v1",
					"OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1"
				);
				provSelect.keyInput = createInput("API Key", key, true);
				provSelect.tempInput = createInput("Temperature", temp);
				provSelect.topPInput = createInput("Top P", topP);
				provSelect.topKInput = createInput("Top K (0 for default)", topK);
				provSelect.maxTokensInput = createInput("Max Tokens (per response)", maxTokens);
				provSelect.maxTurnsInput = createInput("Max Agent Turns (0 for unlimited)", maxTurns);
				provSelect.thinkingInput = createSelect("Thinking Level", thinking, [
					{ value: "off", label: "Off" },
					{ value: "low", label: "Low" },
					{ value: "medium", label: "Medium" },
					{ value: "high", label: "High" },
					{ value: "unlimited", label: "Unlimited" }
				]);
			}
		};

		provSelect.onchange = buildSpecInputs;
		buildSpecInputs();

		modalObj.inner.appendChild(form);

		// Action buttons
		const cancelBtn = new Button("Cancel");
		cancelBtn.className = "cancel";
		cancelBtn.onclick = () => {
			clearTransient(workConnId);
			modalObj.hide();
		};

		const testBtn = new Button("Test Connection");
		testBtn.className = "theme-button secondary";

		// Auto test on blur of serverInput for local providers
		const bindBlurTest = () => {
			const provider = provSelect.value;
			if ((provider === "llamacpp" || provider === "ollama") && provSelect.serverInput) {
				provSelect.serverInput.onblur = () => {
					if (provSelect.serverInput.value.trim()) {
						testBtn.onclick();
					}
				};
			}
		};
		
		const originalBuildSpecInputs = buildSpecInputs;
		buildSpecInputs = () => {
			originalBuildSpecInputs();
			bindBlurTest();
			modelSelect.value = "";
			modelDatalist.innerHTML = "";
			showModelPlaceholder();
		};
		bindBlurTest();
		
		const saveBtn = new Button(conn ? "Save" : "Create");
		saveBtn.className = "theme-button primary";

		const workConnId = conn ? conn.id : `conn-${crypto.randomUUID()}`;

		const currentConnConfig = () => {
			const configObj = {
				server: provSelect.serverInput?.value || ""
			};
			if (provSelect.keyInput) {
				configObj.apiKey = provSelect.keyInput.value;
			}
			if (provSelect.rpmInput) {
				configObj.rpmLimit = parseInt(provSelect.rpmInput.value) || 15;
			}
			if (provSelect.tpmInput) {
				configObj.tpmLimit = parseInt(provSelect.tpmInput.value) || 250000;
			}
			if (provSelect.rpdInput) {
				configObj.rpdLimit = parseInt(provSelect.rpdInput.value) || 500;
			}
			if (provSelect.maxInputTokensInput) {
				configObj.maxInputTokens = parseInt(provSelect.maxInputTokensInput.value) || 0;
			}
			if (provSelect.maxTurnsInput) {
				configObj.maxTurns = parseInt(provSelect.maxTurnsInput.value) || 0;
			}
			if (provSelect.nctxInput) {
				configObj.n_ctx = parseInt(provSelect.nctxInput.value) || 0;
			}
			if (provSelect.topKInput) {
				const v = parseInt(provSelect.topKInput.value);
				configObj.top_k = Number.isFinite(v) ? v : (provSelect.value === "openai" ? 0 : 40);
			}
			if (provSelect.topPInput) {
				const v = parseFloat(provSelect.topPInput.value);
				configObj.top_p = Number.isFinite(v) ? v : (provSelect.value === "openai" ? 1.0 : 0.9);
			}
			if (provSelect.tempInput) {
				const v = parseFloat(provSelect.tempInput.value);
				configObj.temperature = Number.isFinite(v) ? v : 0.7;
			}
			if (provSelect.maxTokensInput) {
				configObj.maxTokens = parseInt(provSelect.maxTokensInput.value) || 4096;
			}
			if (provSelect.thinkingInput) {
				configObj.thinkingLevel = provSelect.thinkingInput.value;
			}
			return {
				id: workConnId,
				name: nameInput.value || `${provSelect.value} connection`,
				provider: provSelect.value,
				size: sizeSelect.value,
				config: configObj
			};
		};

		let baseConfigStr = "";
		let lastPassedStr = "";
		let lastFamily = "";
		let verifiedValues = { temperature: null, top_p: null };

		const showModelPlaceholder = () => {
			modelSelect.style.display = "";
			modelPlaceholder.textContent = "Test the connection to load available models, or type a model ID manually";
			modelPlaceholder.style.display = "";
			modelContainer.style.display = "flex";
		};

		const sortModels = models => {
			const providerOf = id => {
				const slash = id.indexOf("/");
				return slash === -1 ? "" : id.slice(0, slash);
			};
			const modelOf = id => {
				const slash = id.indexOf("/");
				return slash === -1 ? id : id.slice(slash + 1);
			};
			return [...models].sort((a, b) => {
				const pa = providerOf(a).toLowerCase();
				const pb = providerOf(b).toLowerCase();
				if (pa !== pb) {
					if (pa === "") return 1;
					if (pb === "") return -1;
					return pa < pb ? -1 : pa > pb ? 1 : 0;
				}
				const ma = modelOf(a).toLowerCase();
				const mb = modelOf(b).toLowerCase();
				if (ma !== mb) return ma < mb ? -1 : 1;
				return a < b ? -1 : a > b ? 1 : 0;
			});
		};

		const populateModelList = (models, selected) => {
			const valid = models.filter(m => typeof m === "string" && m.trim());
			const sorted = sortModels(valid);
			modelDatalist.innerHTML = "";
			sorted.forEach(m => {
				const opt = document.createElement("option");
				opt.value = m;
				opt.textContent = m;
				modelDatalist.appendChild(opt);
			});
			if (selected && !sorted.some(m => m.toLowerCase() === selected.toLowerCase())) {
				sorted.unshift(selected);
				const opt = document.createElement("option");
				opt.value = selected;
				opt.textContent = selected;
				modelDatalist.prepend(opt);
			}
			if (selected) {
				modelSelect.value = selected;
			} else {
				modelSelect.value = sorted[0] || "";
			}
			modelSelect.style.display = "";
			modelPlaceholder.style.display = "none";
			modelContainer.style.display = "flex";
			refreshCapabilityPanel();
		};

		const capForCurrent = () => {
			const conf = currentConnConfig();
			return getCapability(workConnId, modelSelect.value, { server: conf.config.server });
		};

		const renderModelInfo = () => {
			const cap = capForCurrent();
			if (!cap) {
				modelInfo.style.display = "none";
				return;
			}
			modelInfo.style.display = "flex";
			modelInfo.innerHTML = "";
			const familyLine = document.createElement("div");
			familyLine.style.display = "flex";
			familyLine.style.justifyContent = "space-between";
			familyLine.style.alignItems = "center";
			const familyLabelEl = document.createElement("span");
			const badge = document.createElement("span");
			badge.className = "family-badge";
			badge.textContent = cap.family ? familyLabel(cap.family) : familyLabel(guessFamilyFromUrl(currentConnConfig().config.server));
			badge.style.padding = "1px 6px";
			badge.style.fontWeight = "bold";
			const presetTag = document.createElement("span");
			presetTag.className = "preset-tag";
			presetTag.textContent = cap.preset && cap.preset !== "default" ? `Preset: ${cap.preset}` : "Preset: Default";
			familyLabelEl.append(badge, presetTag);
			const probeStatus = document.createElement("span");
			probeStatus.className = cap.probeOk ? "probe-status is-ok" : "probe-status is-error";
			probeStatus.textContent = cap.probeOk ? `Probe OK in ${cap.latencyMs}ms` : `Probe failed: ${cap.error || "unknown"}`;
			familyLine.append(familyLabelEl, probeStatus);
			modelInfo.appendChild(familyLine);

			if (!cap.probeOk) {
				const note = document.createElement("div");
				note.className = "probe-note";
				note.textContent = "Investigation could not reach the model. Check the connection details.";
				modelInfo.appendChild(note);
				return;
			}

			if (cap.reasoning && cap.reasoning.accepted) {
				const row = document.createElement("div");
				row.className = "field";
				const scheme = cap.reasoning.mode === "openrouter" ? "reasoning:effort" : cap.reasoning.mode === "o-series" ? "reasoning_effort" : "thinking budget";
				const allowed = (cap.reasoning.effortAllowed || []).join(", ");
				const rLabel = document.createElement("span");
				rLabel.className = "field-label field-label-xs";
				rLabel.textContent = "Reasoning";
				const rValue = document.createElement("span");
				rValue.title = `${"Supported scheme: " + scheme + (allowed ? " · Levels: " + allowed : "")}`;
				rValue.textContent = `🧠 ${cap.reasoning.mode === "openrouter" ? "OpenRouter scheme" : scheme}`;
				row.append(rLabel, rValue);
				modelInfo.appendChild(row);
			}

			for (const key of ["temperature", "top_p", "top_k"]) {
				const info = cap.params && cap.params[key];
				if (!info) continue;
				const meta = stateMeta(info.state);
				const row = document.createElement("div");
				row.className = "field";
				row.style.justifyContent = "space-between";
				const label = document.createElement("span");
				label.className = "param-label";
				label.textContent = key;
				const value = document.createElement("span");
				value.className = "param-value" + (info.state === "locked" ? " state-locked" : info.state === "preset" ? " state-preset" : info.state === "unverified" ? " state-unverified" : "");
				value.textContent = `${meta.icon} ${meta.label}`;
				value.title = `${meta.tip} ${info.note || ""}`;
				value.style.cursor = "help";
				row.append(label, value);
				if (info.state === "preset" && info.available) {
					const sub = document.createElement("div");
					sub.className = "param-sub";
					sub.textContent = info.available.join(", ");
					modelInfo.appendChild(sub);
				}
				modelInfo.appendChild(row);
			}
		};

		const refreshCapabilityPanel = () => {
			const cap = capForCurrent();
			const known = !!(cap && cap.params && Object.keys(cap.params).length > 0);
			presetWrap.style.display = known ? "flex" : "none";
			if (cap) {
				presetSelect.value = cap.preset || "default";
			}
			renderModelInfo();
		};

		modelSelect.addEventListener("input", refreshCapabilityPanel);

		presetSelect.onchange = () => {
			const cap = capForCurrent();
			if (!cap) return;
			cap.preset = presetSelect.value;
			setCapability(workConnId, modelSelect.value, cap);
			const pp = PROBE_PRESETS[cap.preset];
			if (pp) {
				if (provSelect.tempInput && cap.params?.temperature?.state !== "locked") {
					provSelect.tempInput.value = pp.temperature;
				}
				if (provSelect.topPInput && cap.params?.top_p?.state !== "locked") {
					provSelect.topPInput.value = pp.top_p;
				}
				if (provSelect.thinkingInput) {
					provSelect.thinkingInput.value = pp.thinkingLevel;
				}
			}
			renderModelInfo();
		};

		const buildConnConf = () => {
			const connConf = currentConnConfig();
			if (modelSelect.value) {
				connConf.config.model = modelSelect.value;
			}
			return connConf;
		};

		const doSave = () => {
			commitCapabilities(workConnId);
			AIConnections.saveConnection(buildConnConf());
			modalObj.hide();
			this.renderConnectionsList();
		};

		const runTest = async (silent = false) => {
			if (!silent) {
				testBtn.disabled = true;
				testBtn.text = "Testing...";
				testStatus.style.display = "block";
				testStatus.classList.remove("is-ok", "is-error");
				testStatus.classList.add("is-idle");
				testStatus.textContent = "Connecting to endpoint...";
			}

			try {
				const connConf = currentConnConfig();
				const result = await AIConnections.testConnection(connConf);

				if (!silent) {
					testStatus.classList.remove("is-idle", "is-error");
					testStatus.classList.add("is-ok");
					const viaProbe = result.probe && result.probe.ok && (!result.models || result.models.length === 0);
					testStatus.textContent = viaProbe
						? `Connection check succeeded via live probe${result.probe.latencyMs ? ` (${result.probe.latencyMs}ms)` : ""}. Model list not available.`
						: "Connection check succeeded! Server reached and API key verified.";
				}

				lastFamily = result.family || lastFamily || guessFamilyFromUrl(connConf.config.server);
				connConf.config._family = lastFamily;

				const models = result.models || (result.model ? [result.model] : []);
				if (models.length > 0) {
					const prev = modelSelect.value || (conn && conn.config.model);
					populateModelList(models, prev);
				} else {
					showModelPlaceholder();
				}

				lastPassedStr = JSON.stringify(buildConnConf());
				saveWithErrorsBtn.hide();
				if (modelSelect.value) {
					investigateBtn.show();
				}
				return true;
			} catch (err) {
				if (!silent) {
					testStatus.classList.remove("is-idle", "is-ok");
					testStatus.classList.add("is-error");
					testStatus.textContent = `Connection check failed: ${err.message}`;
				}
				lastPassedStr = "";
				return false;
			} finally {
				if (!silent) {
					testBtn.disabled = false;
					testBtn.text = "Test Connection";
				}
			}
		};
		testBtn.onclick = () => runTest(false);

		const investigateBtn = new Button("Investigate");
		investigateBtn.className = "theme-button secondary";
		investigateBtn.icon = "\u{1F50D}";
		investigateBtn.title = "Live-probe this model to discover parameter support and tuned presets";
		investigateBtn.hide();

		const runInvestigate = async () => {
			const model = modelSelect.value;
			if (!model) {
				testStatus.style.display = "block";
				testStatus.classList.remove("is-ok", "is-error");
				testStatus.classList.add("is-idle");
				testStatus.textContent = "Select a model to investigate.";
				return;
			}
			investigateBtn.disabled = true;
			investigateBtn.text = "Investigating...";
			modelInfo.style.display = "flex";
			modelInfo.innerHTML = `<span style="font-size: 11px; opacity: 0.8;">Probing ${model} for parameter support...</span>`;
			try {
				const conf = currentConnConfig();
				const cap = await investigateModel({ ...conf.config, _family: lastFamily }, model);
				if (!cap) return;
				setCapability(workConnId, model, cap);
				const tempVal = provSelect.tempInput ? parseFloat(provSelect.tempInput.value) : null;
				const topPVal = provSelect.topPInput ? parseFloat(provSelect.topPInput.value) : null;
				if (Number.isFinite(tempVal)) verifiedValues.temperature = tempVal;
				if (Number.isFinite(topPVal)) verifiedValues.top_p = topPVal;
				refreshCapabilityPanel();
			} catch (err) {
				modelInfo.innerHTML = `<span style="color: var(--color-error, #dc3545); font-size: 11px;">Investigation failed: ${err.message}</span>`;
			} finally {
				investigateBtn.disabled = false;
				investigateBtn.text = "Investigate";
				investigateBtn.icon = "\u{1F50D}";
			}
		};
		investigateBtn.onclick = runInvestigate;

		const saveWithErrorsBtn = new Button("Save w/Errors");
		saveWithErrorsBtn.className = "theme-button secondary has-errors";
		saveWithErrorsBtn.hide();
		saveWithErrorsBtn.onclick = () => doSave();

		const verifyEdits = async () => {
			const conf = buildConnConf();
			const model = conf.config.model;
			if (!model) return true;
			const cap = capForCurrent();
			if (!cap || !cap.probeOk) return true;
			const params = {};
			const tempInput = provSelect.tempInput && cap.params?.temperature?.state !== "locked" ? provSelect.tempInput : null;
			const topPInput = provSelect.topPInput && cap.params?.top_p?.state !== "locked" ? provSelect.topPInput : null;
			if (tempInput && verifiedValues.temperature !== null) {
				const v = parseFloat(tempInput.value);
				if (Number.isFinite(v) && Math.abs(v - verifiedValues.temperature) > 1e-9) {
					params.temperature = v;
				}
			}
			if (topPInput && verifiedValues.top_p !== null) {
				const v = parseFloat(topPInput.value);
				if (Number.isFinite(v) && Math.abs(v - verifiedValues.top_p) > 1e-9) {
					params.top_p = v;
				}
			}
			if (Object.keys(params).length === 0) return true;
			const probe = await probeChat({ ...conf.config, _family: cap.family }, { model, params });
			if (probe.ok) {
				if (params.temperature !== undefined) verifiedValues.temperature = params.temperature;
				if (params.top_p !== undefined) verifiedValues.top_p = params.top_p;
				return true;
			}
			const msg = (probe.errorMessage || probe.error || "").toLowerCase();
			const rejectedKeys = ["temperature", "top_p"].filter(k => {
				const plain = k === "top_p" ? "top_p" : k;
				return params[k] !== undefined && (msg.includes(plain) || msg.includes(plain.replace("_", "")) || msg.includes("param"));
			});
			const fallback = rejectedKeys.length > 0 ? rejectedKeys : Object.keys(params);
			let reverted = false;
			for (const key of fallback) {
				const input = key === "temperature" ? tempInput : topPInput;
				if (!input) continue;
				const revertTo = key === "temperature" ? verifiedValues.temperature : verifiedValues.top_p;
				if (revertTo === null) continue;
				input.value = revertTo;
				input.classList.add("invalid");
				reverted = true;
				setTimeout(() => {
					input.classList.remove("invalid");
				}, 2500);
			}
			if (reverted) {
				testStatus.style.display = "block";
				testStatus.classList.remove("is-idle", "is-ok");
				testStatus.classList.add("is-error");
				testStatus.textContent = `Server rejected edited values (${Object.keys(params).join(", ")}); reverted to last verified values.`;
				return false;
			}
			return true;
		};

		saveBtn.onclick = async () => {
			const curConf = buildConnConf();
			const curStr = JSON.stringify(curConf);
			const needsAuth = ["gemini", "claude", "openai"].includes(curConf.provider);
			const untouched = curStr === baseConfigStr || curStr === lastPassedStr;
			if (untouched && (isEdit || !needsAuth || curConf.config.apiKey)) {
				if (!(await verifyEdits())) return;
				doSave();
				return;
			}
			const passed = await runTest(false);
			if (!passed) {
				saveWithErrorsBtn.show();
				return;
			}
			if (!(await verifyEdits())) return;
			doSave();
		};

		modalObj.actionBar.append(cancelBtn, testBtn, investigateBtn, saveBtn, saveWithErrorsBtn);
		modalObj.show();

		// Preload saved model so an untouched modal can be saved without a test
		if (isEdit && conn.config.model) {
			populateModelList([conn.config.model], conn.config.model);
		} else {
			showModelPlaceholder();
		}
		baseConfigStr = JSON.stringify(buildConnConf());

		// Non-gating silent model refresh; preserves the current selection
		if (isEdit && conn.config.apiKey) {
			runTest(true);
		}
	}

	_buildTelemetryAccordion() {
		this.telemetryAccordion = new UIAccordion("model-telemetry", "Model Telemetry", "insights", "#8250df");
		const content = this.telemetryAccordion.content;
		content.className = "accordion-content settings-content-wrapper telemetry-wrapper";
		this.container.appendChild(this.telemetryAccordion);
		this.renderTelemetry();
	}

	renderTelemetry() {
		const content = this.telemetryAccordion.content;
		content.innerHTML = "";

		const connections = AIConnections.getConnections();
		if (connections.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty-state";
			const icon = document.createElement("ui-icon");
			icon.textContent = "insights";
			const text = document.createElement("span");
			text.textContent = "No connections available for telemetry.";
			empty.append(icon, text);
			content.appendChild(empty);
			return;
		}

		const table = document.createElement("table");
		table.className = "telemetry-table";
		table.style.width = "100%";
		table.style.marginTop = "8px";

		table.innerHTML = `
			<thead>
				<tr style="border-bottom: 2px solid var(--border); text-align: left;">
					<th style="padding: 8px 4px; color: var(--text-secondary);">Connection</th>
					<th style="padding: 8px 4px; color: var(--text-secondary);">Last Speed</th>
					<th style="padding: 8px 4px; color: var(--text-secondary);">5-Resp Avg</th>
					<th style="padding: 8px 4px; color: var(--text-secondary);">1-Min Volume</th>
					<th style="padding: 8px 4px; color: var(--text-secondary);">Requests (RPM)</th>
					<th style="padding: 8px 4px; color: var(--text-secondary);">Total (In / Out)</th>
					<th style="padding: 8px 4px; color: var(--text-secondary); text-align: right; width: 36px;"></th>
				</tr>
			</thead>
			<tbody></tbody>
		`;

		const tbody = table.querySelector("tbody");

		connections.forEach(conn => {
			const inst = AIConnections.getInstance(conn.id);
			if (!inst) return;

			const tr = document.createElement("tr");
			tr.className = "telemetry-row";
			tr.dataset.connId = conn.id;

			const nameTd = document.createElement("td");
			nameTd.innerHTML = `
				<div style="font-weight: bold;">${conn.name}</div>
				<div style="font-size: 10px; color: var(--text-secondary);">${conn.provider} (${conn.config?.model || 'No model'})</div>
			`;

			const speedTd = document.createElement("td");
			speedTd.className = "telemetry-speed";
			const tps = inst.tokensPerSec;
			const thinking = inst.secondsThinking;
			speedTd.textContent = tps > 0 ? `${tps} t/s${thinking > 0 ? ` (${thinking}s think)` : ''}` : "-";

			const avgSpeedTd = document.createElement("td");
			avgSpeedTd.className = "telemetry-avg-speed";
			const avgTps = inst.averageTokensPerSec;
			avgSpeedTd.textContent = avgTps > 0 ? `${avgTps} t/s` : "-";

			const volumeTd = document.createElement("td");
			volumeTd.className = "telemetry-volume";
			const tpm = inst.tokensPerMin;
			volumeTd.textContent = tpm > 0 ? `${tpm} t/min` : "-";

			const rpmTd = document.createElement("td");
			rpmTd.className = "telemetry-rpm";
			const rpm = inst.requestsPerMin;
			rpmTd.textContent = rpm > 0 ? `${rpm} RPM` : "-";

			const totalTd = document.createElement("td");
			totalTd.className = "telemetry-total";
			const totalIn = inst._totalTokensIn || 0;
			const totalOut = inst._totalTokensOut || 0;
			totalTd.textContent = (totalIn || totalOut) ? `${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}` : "-";

			const actionTd = document.createElement("td");
			actionTd.className = "telemetry-actions";

			const resetBtn = new Button("");
			resetBtn.icon = "refresh";
			resetBtn.className = "icon-button secondary danger";
			resetBtn.title = `Reset telemetry for ${conn.name}`;
			resetBtn.setAttribute("aria-label", `Reset telemetry for ${conn.name}`);
			resetBtn.style.width = "24px";
			resetBtn.style.height = "24px";
			resetBtn.style.minWidth = "24px";
			resetBtn.onclick = (e) => {
				e.stopPropagation();
				inst.resetTelemetry();
				this.renderTelemetry();
				this.renderConnectionsList();
				if (window.modal && typeof window.modal.toast === "function") {
					window.modal.toast(`Reset telemetry for "${conn.name}"`);
				}
			};
			actionTd.appendChild(resetBtn);

			tr.appendChild(nameTd);
			tr.appendChild(speedTd);
			tr.appendChild(avgSpeedTd);
			tr.appendChild(volumeTd);
			tr.appendChild(rpmTd);
			tr.appendChild(totalTd);
			tr.appendChild(actionTd);
			tbody.appendChild(tr);
		});

		content.appendChild(table);

		// Add Clear Telemetry button
		const btnContainer = document.createElement("div");
		btnContainer.style.display = "flex";
		btnContainer.style.justifyContent = "flex-end";
		btnContainer.style.marginTop = "16px";

		const clearBtn = new Button("Clear All Telemetry");
		clearBtn.className = "variant-danger clear-telemetry-btn";
		clearBtn.onclick = () => {
			connections.forEach(conn => {
				const inst = AIConnections.getInstance(conn.id);
				if (inst) {
					inst.resetTelemetry();
				}
			});
			this.renderTelemetry();
			this.renderConnectionsList();
			if (window.modal && typeof window.modal.toast === "function") {
				window.modal.toast("Cleared all telemetry data");
			}
		};

		btnContainer.appendChild(clearBtn);
		content.appendChild(btnContainer);
	}

	updateTimedMetrics() {
		// Update speed labels in connection list rows
		const badges = this.querySelectorAll(".connection-tps-badge");
		badges.forEach(badge => {
			const connId = badge.dataset.connId;
			const inst = AIConnections.getInstance(connId);
			if (inst && inst.averageTokensPerSec > 0) {
				badge.textContent = `${inst.averageTokensPerSec} t/s`;
				badge.style.display = "inline-flex";
			} else {
				badge.style.display = "none";
			}
		});

		// Update rows in telemetry table
		const telemetryRows = this.querySelectorAll(".telemetry-row");
		telemetryRows.forEach(tr => {
			const connId = tr.dataset.connId;
			const inst = AIConnections.getInstance(connId);
			if (!inst) return;
			
			const speedTd = tr.querySelector(".telemetry-speed");
			const avgSpeedTd = tr.querySelector(".telemetry-avg-speed");
			const volumeTd = tr.querySelector(".telemetry-volume");
			const rpmTd = tr.querySelector(".telemetry-rpm");
			const totalTd = tr.querySelector(".telemetry-total");
			
			const tps = inst.tokensPerSec;
			const thinking = inst.secondsThinking;
			if (speedTd) {
				speedTd.textContent = tps > 0 ? `${tps} t/s${thinking > 0 ? ` (${thinking}s think)` : ''}` : "-";
			}
			if (avgSpeedTd) {
				const avgTps = inst.averageTokensPerSec;
				avgSpeedTd.textContent = avgTps > 0 ? `${avgTps} t/s` : "-";
			}
			if (volumeTd) {
				const tpm = inst.tokensPerMin;
				volumeTd.textContent = tpm > 0 ? `${tpm} t/min` : "-";
			}
			if (rpmTd) {
				const rpm = inst.requestsPerMin;
				rpmTd.textContent = rpm > 0 ? `${rpm} RPM` : "-";
			}
			if (totalTd) {
				const totalIn = inst._totalTokensIn || 0;
				const totalOut = inst._totalTokensOut || 0;
				totalTd.textContent = (totalIn || totalOut) ? `${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}` : "-";
			}
		});
	}

	update() {
		this.renderCustomisationAccordion();
		this.renderConnectionsList();
		this.renderTelemetry();
	}
}

customElements.define("ui-agent-config-panel", AgentConfigPanel);
