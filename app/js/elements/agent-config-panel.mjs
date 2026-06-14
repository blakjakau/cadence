import { Block } from './element.mjs';
import { Button } from './button.mjs';
import { UIAccordion } from './session-artifacts-panel.mjs';
import AIConnections from '../ai-connections.mjs';
import workspaceClient from '../workspace-client.mjs';

function showUndoToast(message, undoCallback) {
	const toastEl = document.createElement('div');
	toastEl.style.position = 'fixed';
	toastEl.style.bottom = '20px';
	toastEl.style.left = '50%';
	toastEl.style.transform = 'translateX(-50%)';
	toastEl.style.backgroundColor = 'var(--theme-dark, #333)';
	toastEl.style.color = '#fff';
	toastEl.style.padding = '12px 24px';
	toastEl.style.borderRadius = 'var(--radius, 8px)';
	toastEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
	toastEl.style.zIndex = '99999';
	toastEl.style.opacity = '0';
	toastEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
	toastEl.style.fontSize = '14px';
	toastEl.style.display = 'flex';
	toastEl.style.alignItems = 'center';
	toastEl.style.gap = '16px';

	const textSpan = document.createElement('span');
	textSpan.textContent = message;
	toastEl.appendChild(textSpan);

	const undoBtn = document.createElement('button');
	undoBtn.textContent = 'Undo';
	undoBtn.style.background = 'var(--theme, #303f9f)';
	undoBtn.style.color = '#fff';
	undoBtn.style.border = 'none';
	undoBtn.style.padding = '4px 12px';
	undoBtn.style.borderRadius = '4px';
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
			input.checked = localStorage.getItem(key) === "true";
			input.onchange = () => {
				localStorage.setItem(key, input.checked);
				if (window.ui?.aiManager) {
					if (key === "aiForgivenessMode") window.ui.aiManager.forgivenessMode = input.checked;
					if (key === "defaultAgentMode") window.ui.aiManager.config.defaultAgentMode = input.checked;
					if (key === "defaultPlanningMode") window.ui.aiManager.config.defaultPlanningMode = input.checked;
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
		};

		createToggleRow("default-forgiveness-mode", "Forgiveness Mode", "Commit edits immediately to disk with robust single-click rollback safety.", "aiForgivenessMode");
		createToggleRow("default-agent-mode", "Default Agent Mode", "Start new sessions in Agent Mode automatically.", "defaultAgentMode");
		createToggleRow("default-planning-mode", "Default Planning Mode", "Start new sessions with Planning Mode enabled.", "defaultPlanningMode");

		this.container.appendChild(this.defaultsAccordion);
	}

	_buildCustomisationAccordion() {
		this.customisationAccordion = new UIAccordion("customisation", "Chat Prompt Customisation", "edit", "#d19a66");
		const content = this.customisationAccordion.content;
		content.className = "accordion-content settings-content-wrapper";
		this.container.appendChild(this.customisationAccordion);
		this.renderCustomisationAccordion();
	}

	renderCustomisationAccordion() {
		const content = this.customisationAccordion.content;
		content.innerHTML = "";

		const desc = document.createElement("p");
		desc.style.fontSize = "12px";
		desc.style.color = "var(--text-secondary)";
		desc.style.marginBottom = "14px";
		desc.style.fontStyle = "italic";
		desc.style.lineHeight = "1.4";
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
		focusWrapper.className = "toggle-row";
		focusWrapper.style.display = "flex";
		focusWrapper.style.flexDirection = "column";
		focusWrapper.innerHTML = `<label style="font-weight: bold; font-size: 12px; margin-bottom: 4px;">AI Focus</label>`;
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
		focusWrapper.appendChild(select);
		grid.appendChild(focusWrapper);

		// Tech inputs
		const createTextInput = (labelText, value, onChange) => {
			const wrapper = document.createElement("div");
			wrapper.style.display = "flex";
			wrapper.style.flexDirection = "column";
			wrapper.style.gap = "4px";
			const label = document.createElement("label");
			label.style.fontWeight = "bold";
			label.style.fontSize = "12px";
			label.textContent = labelText;
			const input = document.createElement("input");
			input.type = "text";
			input.style.padding = "6px";
			input.style.borderRadius = "4px";
			input.style.border = "1px solid var(--border)";
			input.style.background = "var(--bg-input, rgba(0,0,0,0.1))";
			input.style.color = "var(--text)";
			input.value = value;
			input.onchange = () => {
				onChange(input.value);
				saveConfig();
			};
			wrapper.appendChild(label);
			wrapper.appendChild(input);
			grid.appendChild(wrapper);
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
		this.connectionsAccordion = new UIAccordion("connections-pool", "Connection Pool", "hub", "#2da44e");
		const content = this.connectionsAccordion.content;
		content.className = "accordion-content settings-content-wrapper connections-pool-wrapper";

		this.connListContainer = document.createElement("div");
		this.connListContainer.className = "connections-list";
		this.connListContainer.style.display = "flex";
		this.connListContainer.style.flexDirection = "column";
		this.connListContainer.style.gap = "8px";
		content.appendChild(this.connListContainer);

		// FAB add connection
		const fabContainer = document.createElement("div");
		fabContainer.style.display = "flex";
		fabContainer.style.justifyContent = "flex-end";
		fabContainer.style.marginTop = "16px";
		const addBtn = new Button("+ Connection");
		addBtn.className = "theme-button primary";
		addBtn.icon = "add";
		addBtn.onclick = () => this.showConnectionModal();
		fabContainer.appendChild(addBtn);
		content.appendChild(fabContainer);

		this.container.appendChild(this.connectionsAccordion);

		this.renderConnectionsList();
	}

	renderConnectionsList() {
		this.connListContainer.innerHTML = "";
		const connections = AIConnections.getConnections();
		const defaultId = AIConnections.defaultConnectionId;

		if (connections.length === 0) {
			this.connListContainer.innerHTML = `<p style="color: var(--text-muted); text-align: center; font-size: 13px; margin: 12px 0;">No connections configured. Click "+ Connection" to create one.</p>`;
			return;
		}

		connections.forEach(conn => {
			const item = document.createElement("div");
			item.className = "connection-item-row";
			item.style.display = "flex";
			item.style.justifyContent = "space-between";
			item.style.alignItems = "center";
			item.style.padding = "8px 12px";
			item.style.border = "1px solid var(--border)";
			item.style.borderRadius = "var(--radius, 6px)";
			item.style.background = "var(--bg-secondary, rgba(0,0,0,0.05))";

			// Left details
			const left = document.createElement("div");
			left.style.display = "flex";
			left.style.alignItems = "center";
			left.style.gap = "8px";

			// 2-bar/3-bar drag handle
			const handle = document.createElement("ui-icon");
			handle.textContent = "drag_handle";
			handle.style.cursor = "grab";
			handle.style.color = "var(--text-muted, #888)";
			handle.style.fontSize = "16px";
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
				item.style.borderTop = "2px solid var(--theme)";
			});
			item.addEventListener("dragleave", () => {
				item.style.borderTop = "";
			});
			item.addEventListener("drop", (e) => {
				e.preventDefault();
				item.style.borderTop = "";
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
			star.style.cursor = "pointer";
			star.style.color = conn.id === defaultId ? "var(--color-warning, #b58900)" : "var(--text-muted, #888)";
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
			name.style.fontWeight = "bold";
			name.style.fontSize = "13px";
			name.textContent = conn.name;
			nameWrapper.appendChild(name);

			const size = conn.size || "medium";
			const sizeChip = document.createElement("span");
			sizeChip.style.fontSize = "9px";
			sizeChip.style.padding = "1px 5px";
			sizeChip.style.borderRadius = "8px";
			sizeChip.style.fontWeight = "bold";
			sizeChip.style.textTransform = "capitalize";
			sizeChip.style.display = "inline-flex";
			sizeChip.style.alignItems = "center";
			
			if (size === "tiny") {
				sizeChip.style.background = "rgba(108, 117, 125, 0.15)";
				sizeChip.style.color = "var(--text-secondary, #6c757d)";
			} else if (size === "small") {
				sizeChip.style.background = "rgba(45, 164, 78, 0.15)";
				sizeChip.style.color = "#2da44e";
			} else if (size === "medium") {
				sizeChip.style.background = "rgba(9, 105, 218, 0.15)";
				sizeChip.style.color = "#0969da";
			} else if (size === "large") {
				sizeChip.style.background = "rgba(219, 109, 40, 0.15)";
				sizeChip.style.color = "#db6d28";
			} else if (size === "ultra") {
				sizeChip.style.background = "rgba(130, 80, 223, 0.15)";
				sizeChip.style.color = "#8250df";
			}
			sizeChip.textContent = size;
			nameWrapper.appendChild(sizeChip);

			const info = document.createElement("span");
			info.style.fontSize = "11px";
			info.style.color = "var(--text-secondary)";
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
			tpsLabel.style.fontSize = "11px";
			tpsLabel.style.color = "var(--text-secondary)";
			tpsLabel.style.background = "var(--bg-secondary, rgba(0,0,0,0.05))";
			tpsLabel.style.padding = "2px 6px";
			tpsLabel.style.borderRadius = "4px";
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
			editBtn.onclick = () => this.showConnectionModal(conn);

			const deleteBtn = new Button("");
			deleteBtn.icon = "delete";
			deleteBtn.className = "icon-button secondary danger";
			deleteBtn.title = "Delete connection";
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
					info.style.color = "var(--text-secondary)";
					
					// Automatically persist the resolved model path and n_ctx window details
					AIConnections.save();
				}).catch(() => {
					// Failed - visually disable
					item.style.opacity = "0.5";
					info.textContent = `${conn.provider} - unavailable`;
					info.style.color = "var(--color-error, #dc3545)";
				});
			}

			this.connListContainer.appendChild(item);
		});
	}

	showConnectionModal(conn = null) {
		const isEdit = !!conn;
		const modalObj = window.modal;

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
		["gemini", "llamacpp", "ollama", "claude"].forEach(p => {
			const opt = document.createElement("option");
			opt.value = p;
			opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
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
		nameInput.style.padding = "6px";
		nameInput.style.borderRadius = "4px";
		nameInput.style.border = "1px solid var(--border)";
		nameInput.style.background = "var(--bg-input)";
		nameInput.style.color = "var(--text)";
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
		const modelSelect = document.createElement("select");
		modelSelect.className = "themed-select";
		modelContainer.appendChild(modelSelect);
		form.appendChild(modelContainer);

		// Test status container
		const testStatus = document.createElement("div");
		testStatus.style.padding = "8px";
		testStatus.style.borderRadius = "4px";
		testStatus.style.fontSize = "12px";
		testStatus.style.display = "none";
		form.appendChild(testStatus);

		let buildSpecInputs = () => {
			specContainer.innerHTML = "";
			const provider = provSelect.value;

			const createInput = (labelVal, value, isPassword = false) => {
				const wrapper = document.createElement("div");
				wrapper.style.display = "flex";
				wrapper.style.flexDirection = "column";
				wrapper.innerHTML = `<label style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">${labelVal}</label>`;
				const inp = document.createElement("input");
				inp.type = isPassword ? "password" : "text";
				inp.style.padding = "6px";
				inp.style.borderRadius = "4px";
				inp.style.border = "1px solid var(--border)";
				inp.style.background = "var(--bg-input)";
				inp.style.color = "var(--text)";
				inp.value = value;
				wrapper.appendChild(inp);
				specContainer.appendChild(wrapper);
				return inp;
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
				provSelect.rpmInput = createInput("RPM Limit (Requests/Min)", rpm);
				provSelect.tpmInput = createInput("TPM Limit (Tokens/Min)", tpm);
				provSelect.rpdInput = createInput("RPD Limit (Requests/Day)", rpd);
			} else if (provider === "llamacpp") {
				const defServer = "http://localhost:8080";
				const srv = conn && conn.provider === "llamacpp" ? conn.config.server : defServer;
				provSelect.serverInput = createInput("Llama.cpp API Server", srv);
				
				// Llama.cpp options
				const nctx = conn && conn.provider === "llamacpp" ? (conn.config.n_ctx || 0) : 0;
				const topK = conn && conn.provider === "llamacpp" ? (conn.config.top_k || 40) : 40;
				const topP = conn && conn.provider === "llamacpp" ? (conn.config.top_p || 0.9) : 0.9;
				const temp = conn && conn.provider === "llamacpp" ? (conn.config.temperature !== undefined ? conn.config.temperature : 0.7) : 0.7;
				provSelect.nctxInput = createInput("Context Size (n_ctx, 0 for auto)", nctx);
				provSelect.topKInput = createInput("Top K", topK);
				provSelect.topPInput = createInput("Top P", topP);
				provSelect.tempInput = createInput("Temperature", temp);
			} else if (provider === "ollama") {
				const defServer = "http://localhost:11434";
				const srv = conn && conn.provider === "ollama" ? conn.config.server : defServer;
				provSelect.serverInput = createInput("Ollama API Server", srv);
			} else if (provider === "claude") {
				const defServer = "https://api.anthropic.com";
				const srv = conn && conn.provider === "claude" ? conn.config.server : defServer;
				const key = conn && conn.provider === "claude" ? conn.config.apiKey : "";
				provSelect.serverInput = createInput("Anthropic API Server", srv);
				provSelect.keyInput = createInput("Anthropic API Key", key, true);
			}
		};

		provSelect.onchange = buildSpecInputs;
		buildSpecInputs();

		modalObj.inner.appendChild(form);

		// Action buttons
		const cancelBtn = new Button("Cancel");
		cancelBtn.className = "cancel";
		cancelBtn.onclick = () => modalObj.hide();

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
		};
		bindBlurTest();
		
		const saveBtn = new Button("Save");
		saveBtn.className = "theme-button primary";
		saveBtn.disabled = !isEdit;

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
			if (provSelect.nctxInput) {
				configObj.n_ctx = parseInt(provSelect.nctxInput.value) || 0;
			}
			if (provSelect.topKInput) {
				configObj.top_k = parseInt(provSelect.topKInput.value) || 40;
			}
			if (provSelect.topPInput) {
				configObj.top_p = parseFloat(provSelect.topPInput.value) || 0.9;
			}
			if (provSelect.tempInput) {
				configObj.temperature = parseFloat(provSelect.tempInput.value) !== undefined ? parseFloat(provSelect.tempInput.value) : 0.7;
			}
			return {
				id: conn ? conn.id : `conn-${crypto.randomUUID()}`,
				name: nameInput.value || `${provSelect.value} connection`,
				provider: provSelect.value,
				size: sizeSelect.value,
				config: configObj
			};
		};

		testBtn.onclick = async () => {
			testBtn.disabled = true;
			testBtn.text = "Testing...";
			testStatus.style.display = "block";
			testStatus.style.background = "var(--bg-secondary)";
			testStatus.style.border = "1px solid var(--border)";
			testStatus.style.color = "var(--text)";
			testStatus.textContent = "Connecting to endpoint...";

			try {
				const connConf = currentConnConfig();
				const result = await AIConnections.testConnection(connConf);
				
				testStatus.style.background = "rgba(45, 164, 78, 0.1)";
				testStatus.style.border = "1px solid rgba(45, 164, 78, 0.3)";
				testStatus.style.color = "#2da44e";
				testStatus.textContent = "Connection check succeeded! Successfully reached server.";

				// Populate model selections if models are returned
				const models = result.models || (result.model ? [result.model] : []);
				if (models.length > 0) {
					modelSelect.innerHTML = "";
					models.forEach(m => {
						const opt = document.createElement("option");
						opt.value = m;
						opt.textContent = m;
						if (conn && conn.config.model === m) opt.selected = true;
						modelSelect.appendChild(opt);
					});
					modelContainer.style.display = "flex";
				} else {
					modelContainer.style.display = "none";
				}

				saveBtn.disabled = false;
			} catch (err) {
				testStatus.style.background = "rgba(220, 53, 69, 0.1)";
				testStatus.style.border = "1px solid rgba(220, 53, 69, 0.3)";
				testStatus.style.color = "#dc3545";
				testStatus.textContent = `Connection check failed: ${err.message}`;
				saveBtn.disabled = true;
			} finally {
				testBtn.disabled = false;
				testBtn.text = "Test Connection";
			}
		};

		saveBtn.onclick = () => {
			const connConf = currentConnConfig();
			if (modelSelect.value) {
				connConf.config.model = modelSelect.value;
			}
			AIConnections.saveConnection(connConf);
			modalObj.hide();
			this.renderConnectionsList();
		};

		modalObj.actionBar.append(cancelBtn, testBtn, saveBtn);
		modalObj.show();

		// If editing, preload model selection directly and trigger test automatically
		if (isEdit && conn.config.model) {
			const opt = document.createElement("option");
			opt.value = conn.config.model;
			opt.textContent = conn.config.model;
			opt.selected = true;
			modelSelect.appendChild(opt);
			modelContainer.style.display = "flex";
			
			// Automatically test to refresh models list
			testBtn.onclick();
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
			content.innerHTML = `<p style="color: var(--text-muted); text-align: center; font-size: 13px; margin: 12px 0;">No connections available for telemetry.</p>`;
			return;
		}

		const table = document.createElement("table");
		table.style.width = "100%";
		table.style.borderCollapse = "collapse";
		table.style.fontSize = "12px";
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
			tr.style.borderBottom = "1px solid var(--border)";

			const nameTd = document.createElement("td");
			nameTd.style.padding = "8px 4px";
			nameTd.innerHTML = `
				<div style="font-weight: bold;">${conn.name}</div>
				<div style="font-size: 10px; color: var(--text-secondary);">${conn.provider} (${conn.config?.model || 'No model'})</div>
			`;

			const speedTd = document.createElement("td");
			speedTd.className = "telemetry-speed";
			speedTd.style.padding = "8px 4px";
			const tps = inst.tokensPerSec;
			const thinking = inst.secondsThinking;
			speedTd.textContent = tps > 0 ? `${tps} t/s${thinking > 0 ? ` (${thinking}s think)` : ''}` : "-";

			const avgSpeedTd = document.createElement("td");
			avgSpeedTd.className = "telemetry-avg-speed";
			avgSpeedTd.style.padding = "8px 4px";
			const avgTps = inst.averageTokensPerSec;
			avgSpeedTd.textContent = avgTps > 0 ? `${avgTps} t/s` : "-";

			const volumeTd = document.createElement("td");
			volumeTd.className = "telemetry-volume";
			volumeTd.style.padding = "8px 4px";
			const tpm = inst.tokensPerMin;
			volumeTd.textContent = tpm > 0 ? `${tpm} t/min` : "-";

			const rpmTd = document.createElement("td");
			rpmTd.className = "telemetry-rpm";
			rpmTd.style.padding = "8px 4px";
			const rpm = inst.requestsPerMin;
			rpmTd.textContent = rpm > 0 ? `${rpm} RPM` : "-";

			const totalTd = document.createElement("td");
			totalTd.className = "telemetry-total";
			totalTd.style.padding = "8px 4px";
			const totalIn = inst._totalTokensIn || 0;
			const totalOut = inst._totalTokensOut || 0;
			totalTd.textContent = (totalIn || totalOut) ? `${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}` : "-";

			tr.appendChild(nameTd);
			tr.appendChild(speedTd);
			tr.appendChild(avgSpeedTd);
			tr.appendChild(volumeTd);
			tr.appendChild(rpmTd);
			tr.appendChild(totalTd);
			tbody.appendChild(tr);
		});

		content.appendChild(table);

		// Add Clear Telemetry button
		const btnContainer = document.createElement("div");
		btnContainer.style.display = "flex";
		btnContainer.style.justifyContent = "flex-end";
		btnContainer.style.marginTop = "16px";

		const clearBtn = new Button("Clear Telemetry");
		clearBtn.className = "theme-button secondary";
		clearBtn.style.fontSize = "11px";
		clearBtn.onclick = () => {
			connections.forEach(conn => {
				const inst = AIConnections.getInstance(conn.id);
				if (inst) {
					inst._telemetryRequests = [];
					inst._telemetryTokens = [];
					inst._totalTokensIn = 0;
					inst._totalTokensOut = 0;
					inst._saveTelemetry();
				}
			});
			this.renderTelemetry();
			this.renderConnectionsList();
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
