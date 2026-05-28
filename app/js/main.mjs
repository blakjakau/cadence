import prettier from "https://unpkg.com/prettier@2.4.1/esm/standalone.mjs"
import parserBabel from "https://unpkg.com/prettier@2.4.1/esm/parser-babel.mjs"
import parserHtml from "https://unpkg.com/prettier@2.4.1/esm/parser-html.mjs"
import parserCss from "https://unpkg.com/prettier@2.4.1/esm/parser-postcss.mjs"
import workspaceClient from "./workspace-client.mjs"

import {
	getIconForFileName, addStylesheet, buildPath, clone, isElement, isFunction, isNotNull,
	isset, readAndOrderDirectory, readAndOrderDirectoryRecursive, sortOnName,
} from "./elements/utils.mjs"
import ui from "./ui-main.mjs" // Assuming ui-main.mjs handles its own import of Modal via elements.mjs
import {
	Modal, ActionBar, Block, Button, ContentFill, CounterButton, Element, Effects, Effect,
	FileItem, FileList, Icon, Inline, Input, Inner, MediaView, Panel, Ripple, TabBar, TabItem,
	View, Menu, MenuItem, FileUploadList, actionBars, promptSaveFile, promptAddFolder,
} from "./elements.mjs"
import { observeFile, unobserveFile } from "./fileSystemObserver.mjs"
import conduitClient from "./conduit-client.mjs?v=1778190000000"

function updateIndexerStatus(data) {
	const el = document.getElementById('indexer_status');
	if (el && data) {
		const size = data.size || "0 KB";
		const roots = data.roots || [];
		el.textContent = `Index ready (Size: ${size})`;
		el.title = `Roots:\n${roots.join('\n')}`;
	}
}

conduitClient.on('indexer_status', (msg) => {
	updateIndexerStatus(msg.data);
});

conduitClient.on('connect', () => {
	if (workspace && workspace.folders) {
		conduitClient.wsSetActiveRoots(workspace.folders).catch(e => console.warn(e));
	}
	conduitClient.wsGetIndexerStatus().then(res => {
		if (!res.error) {
			updateIndexerStatus(res.data);
		}
	}).catch(e => console.warn("Could not get initial index status:", e));
});

const canPrettify = {
	"ace/mode/javascript": { name: "babel", plugins: [parserBabel] },
	"ace/mode/json": { name: "json", plugins: [parserBabel] },
	"ace/mode/html": { name: "html", plugins: [parserHtml] },
	"ace/mode/css": { name: "css", plugins: [parserCss] },
}

function sleep(ms) {
	return new Promise((accept, reject) => {
		setTimeout(accept, ms)
	})
}
function safeString(string) {
	return string.replace(/\ /g, "-").replace(/[^A-Za-z0-9\-]/g, "")
}

ui.create()
window.ui = ui
window.modal = Modal // Assign the singleton instance
window.code = {
	version: (() => {
		const last = "0.4.2"
		fetch("/version.json")
			.then(async (response) => {
				if (response.ok) {
					const version = await response.json()
					if (version.appName && version.version) {
						window.code = { ...window.code, ...version }
					}
				}
			})
			.catch((e) => console.warn("Failed to fetch version.json", e))
		return last
	})(),
}

const leftEdit = ui.leftEdit
const rightEdit = ui.rightEdit
const leftMedia = ui.leftMedia
const rightMedia = ui.rightMedia

const installer = ui.installer
const fileActions = ui.fileActions
const fileList = ui.fileList
const filesPanel = ui.files
const leftTabs = ui.leftTabs
const rightTabs = ui.rightTabs
const prettify = document.querySelector("#prettier")

const app = {
	folders: [],
	workspaces: [],
	sessionOptions: null,
	rendererOptions: null,
	enableLiveAutocompletion: null,
	darkmode: "system",
	aiConfig: {},
	systemPromptConfig: {}, // NEW: For generic system prompt settings
}

const workspace = {
	id: "default",
	name: "default",
	folders: [],
	ignorePaths: [".git", "node_modules", "dist", "build"],
	files: [],
	sidebarPanelWidths: {},
	scratchpad: "",
	// REMOVED: promptHistory: [], // This will be stored per AI session now
	aiConfig: {},
	systemPromptConfig: {}, // NEW: For generic system prompt settings
	// NEW: AI session metadata and active session ID
	aiSessionsMetadata: [], // Array of {id, name, createdAt, lastModified}
	activeAiSessionId: null, // The ID of the currently active AI session
}

// window.showSettings = ui.showSettings
window.app = app
window.workspace = workspace

const fileOpen = new Button("Add Folder to Workspace")
// Removed manual fileAccess/Restore buttons for Conduit migration

window.ui.commands = {
	byKeys: {},
	byName: {},
	add(command) {
		if (command && command.name && "function" == typeof command.exec) {
			switch (command.target) {
				case "editor":
					//register with ACE editor
					leftEdit.commands.addCommand({
						name: command.name,
						bindKey: command.bindKey,
						exec: command.exec,
					})
					break
				case "app":
				default:
					// register with ui
					if (command.bindKey) {
						if (command.bindKey.mac) {
							const win = command.bindKey.win
							const mac = command.bindKey.mac

							command.bindKey = win
							if (window.navigator.userAgent.toLowerCase().includes("os x")) {
								command.bindKeyAlt = mac
							}
						}
					}

					if (command.name in this.byName) {
						console.warn(command.name, "already registered, removing existing")
						if (this.byName[command.name].bindKey) {
							if (this.byKeys[command.bindKey] == command.name) {
								delete this.byKeys[command.bindKey]
							}
							if (this.byKeys[command.bindKeyAlt] == command.name) {
								delete this.byKeys[command.bindKeyAlt]
							}
						}
						delete this.byName[command.name]
					}
					this.byName[command.name] = command

					if (command.bindKey) {
						command.bindKey = command.bindKey
							.toLowerCase()
							.replace(/command/g, "meta")
							.replace(/option/g, "alt")
							.replace(/\+/g, "-")
						this.byKeys[command.bindKey] = command.name
					}
					if (command.bindKeyAlt) {
						command.bindKeyAlt = command.bindKeyAlt
							.toLowerCase()
							.replace(/command/g, "meta")
							.replace(/option/g, "alt")
							.replace(/\+/g, "-")
						this.byKeys[command.bindKeyAlt] = command.name
					}

					break
			}
		} else {
			console.warn("Invalid command definition", command)
		}
	},
	exec(commandName, args) {
		if (commandName in this.byName) {
			this.byName[commandName].exec(args)
		}
	},
	bindToDocument() {
		if (this.boundToDocument) return
		if (this.boundToDocument) return
		document.addEventListener(
			"keydown",
			(e) => {
				const skipKeys = {
					ControlLeft: true,
					ShiftLeft: true,
					AltLeft: true,
					AltRight: true,
					ShiftRight: true,
					ControlRight: true,
					MetaLeft: true,
				}

				const ctrl = e.ctrlKey,
					shift = e.shiftKey,
					alt = e.altKey,
					meta = e.metaKey

				const cancelEvent = (e, bound) => {
					e.preventDefault()
					e.stopPropagation()
				}
				if (e.code in skipKeys) {
					return
				}

				// build a key code string from this event
				const bindKey = (
					(ctrl ? "ctrl-" : "") +
					(shift ? "shift-" : "") +
					(alt ? "alt-" : "") +
					(meta ? "meta-" : "") +
					e.code.replace(/(Key|Digit)/, "")
				).toLowerCase()

				if (bindKey in this.byKeys) {
					if (bindKey !== "escape") cancelEvent(e, bindKey)
					this.exec(this.byKeys[bindKey])
				}
			},
			{ capture: true }
		)
		this.boundToDocument = true
	},
}

window.ui.commands.bindToDocument()

const getSuggestedStartDirectory = async () => {
	const activeTab = currentTabs?.activeTab

	// 1. From active tab's project folder (for existing files like Save As)
	if (activeTab?.config?.folder) {
		return activeTab.config.folder
	}

	// 2. From last used project folder (for new files)
	const lastUsed = localStorage.getItem('lastUsedProjectFolder');
	if (lastUsed && workspace.folders?.includes(lastUsed)) {
		return lastUsed;
	}

	// 3. From a sibling tab's folder
	for (const tab of currentTabs?.tabs || []) {
		if (tab.config?.folder) {
			return tab.config.folder
		}
	}

	// 4. From a tab in the other panel
	const otherTabs = currentTabs === leftTabs ? rightTabs : leftTabs
	for (const tab of otherTabs?.tabs || []) {
		if (tab.config?.folder) {
			return tab.config.folder
		}
	}

	// 5. From any open folder in the workspace
	if (workspace.folders?.length > 0) {
		return workspace.folders[0]
	}

	return null // Fallback to default behavior
}

const saveFile = async (tab) => {
	const path = tab.config.handle
	if (!path || tab.config.mode?.mode === "media") return
	const text = tab.config.session.getValue()

	unobserveFile(path) // Stop listening to prevent self-triggering modification events
	tab.config.ignoreNextNotify = true
	try {
		const base64Content = btoa(unescape(encodeURIComponent(text)))
		await conduitClient.wsWrite(path, base64Content)
		tab.config.fileModified = false
		tab.changed = false
	} catch (error) {
		console.error("Error saving file:", error)
		window.modal.notice(`Failed to save ${path}:<br><small>${error.message}</small>`, "Save Error")
	} finally {
		observeFile(path, onFileModified) // Always resume listening
		setTimeout(() => {
			tab.config.ignoreNextNotify = false
		}, 2000)
	}
}
window.saveFileTab = saveFile;

const saveAppConfig = async () => {
	app.sessionOptions = ui.leftEdit.session.getOptions()
	app.rendererOptions = ui.leftEdit.renderer.getOptions()
	app.enableLiveAutocompletion = ui.leftEdit.$enableLiveAutocompletion
	delete app.sessionOptions.mode // don't persist the mode, that's dumb
	delete app.folders //app.folders = workspace.folders

	// ensure that the app config has links to the current workspace name
	if (app.workspaces.indexOf(workspace.id) == -1) {
		app.workspaces.push(workspace.id)
	}
	app.workspace = workspace.id

	// updateWorkspaceSelectors()

	await workspaceClient.setAppConfig(app)
	console.debug("saved", app)
}
window.saveAppConfig = saveAppConfig

// New function to handle file modifications from FileSystemObserver
const onFileModified = (path) => {
	// Find the tab associated with the modified file path
	let foundTab = null
	for (const tab of leftTabs.tabs) {
		if (tab.config.handle === path) {
			foundTab = tab
			break
		}
	}
	if (!foundTab) {
		for (const tab of rightTabs.tabs) {
			if (tab.config.handle === path) {
				foundTab = tab
				break
			}
		}
	}

	if (foundTab) {
		if (foundTab.config.ignoreNextNotify) {
			foundTab.config.ignoreNextNotify = false
			return
		}

		foundTab.config.fileModified = true
		foundTab.changed = true // Trigger setter to update tab UI icons

		const fileItem = fileList.find(path)
		if (fileItem && fileItem.length > 0) {
			fileItem[0].changed = true
		}

		// If the modified tab is the active tab, show the notice bar
		if (foundTab === currentTabs.activeTab) {
			ui.showFileModifiedNotice(foundTab, foundTab.config.side)
		}
	}
}

let workspaceUnloading = false
const saveWorkspace = async () => {
	if (workspaceUnloading) return

	const orderedFiles = []
	let planTasksSide = null

	const addTabsFrom = (tabBar) => {
		if (tabBar && tabBar.tabs) {
			tabBar.tabs.forEach(tab => {
				if (tab.config && tab.config.handle) {
					if (tab.config.path === "plan_tasks") {
						planTasksSide = tab.config.side
					} else {
						orderedFiles.push({
							name: tab.config.name,
							path: tab.config.path,
							handle: tab.config.handle,
							side: tab.config.side,
						})
					}
				}
			})
		}
	}
	addTabsFrom(leftTabs)
	addTabsFrom(rightTabs)
	workspace.files = orderedFiles
	workspace.planTasksSide = planTasksSide

	workspace.openFolders = fileList.openFolders
	workspace.activeSidebarTab = ui.iconTabBar?.activeTab?.iconId
	workspaceClient.setWorkspace(workspace)
	
	if (workspace.folders) {
		conduitClient.wsSetActiveRoots(workspace.folders).catch(e => console.warn(e));
	}
}
window.saveWorkspace = saveWorkspace

const updateFileListBackground = () => {
	if (ui.fileListBackground) {
		if (workspace.folders?.length > 0) {
			ui.fileListBackground.style.display = "none"
		} else {
			ui.fileListBackground.style.display = "flex"
		}
	}
}

const updateWorkspaceSelectors = (() => {
	const close = document.querySelector("#workspaceClose")
	const rename = document.querySelector("#workspaceRename")
	const remove = document.querySelector("#workspaceDelete")
	const selectors = document.querySelector("#workspaceSelectors")
	const actions = document.querySelector("#workspaceActions")
	return () => {
		selectors.innerHTML = ""
		for (const name of app.workspaces) {
			// if(name == "default") continue
			let item = document.createElement("ui-menu-item")
			item.setAttribute("command", `app:workspaceOpen:${name}`)
			item.text = name

			selectors.appendChild(item)

			if (workspace.id == name) {
				item.icon = "done"
				if (name !== "default") {
					actions.appendChild(close)
					// actions.appendChild(rename)
					actions.appendChild(remove)

					close.text = `Close workspace`
					rename.text = `Rename workspace "${name}"`
					remove.text = `Delete workspace "${name}"`
				} else {
					close.remove()
					rename.remove()
					remove.remove()
				}
			}
		}
	}
})()

const openWorkspace = (() => {
	const close = document.querySelector("#workspaceClose")
	const rename = document.querySelector("#workspaceRename")
	const remove = document.querySelector("#workspaceDelete")
	const selectors = document.querySelector("#workspaceSelectors")
	const actions = document.querySelector("#workspaceActions")

	// rename for possible future functionality
	rename.remove()

	let isOpeningWorkspace = false;

	return async (name, triggered = false) => {
		if (isOpeningWorkspace) return;
		isOpeningWorkspace = true;
		try {
			console.debug(`openWorkspace: Opening workspace ${name}.`)
			let load;
			try {
				load = await workspaceClient.getWorkspace(name)
			} catch(e) {
				console.warn("Failed to load workspace", name, e)
			}

			const hideActions = () => {
				close.remove()
				rename.remove()
				remove.remove()
			}

			if ("undefined" != typeof load) {
				workspaceUnloading = true
			// clear the leftTabs
			while (leftTabs.tabs.length > 1) {
				leftTabs.tabs[0].close.click()
			}
			if (leftTabs.tabs[0]) leftTabs.tabs[0].close.click()

			workspaceUnloading = false

			workspace.name = load.name || "default"
			workspace.folders = load.folders || []
			workspace.files = load.files || []
			try {
				const cadenceResp = await conduitClient.wsRead(".cadence")
				if (!cadenceResp.error && cadenceResp.content) {
					const cadenceConfig = JSON.parse(cadenceResp.content)
					if (cadenceConfig.folders) workspace.folders = cadenceConfig.folders
					if (cadenceConfig.files) workspace.files = cadenceConfig.files
				}
			} catch (e) {
				// Ignore if .cadence doesn't exist
			}
			
			if (workspace.folders) {
				conduitClient.wsSetActiveRoots(workspace.folders).catch(e => console.warn(e));
			}
			
			workspace.ignorePaths = load.ignorePaths || [".git", "node_modules", "dist", "build"]
			workspace.openFolders = load.openFolders || []
			workspace.scratchpad = load.scratchpad || ""
			ui.scratchEditor.setValue(workspace.scratchpad || "")
			workspace.sidebarPanelWidths = load.sidebarPanelWidths || {}
			// Backward compatibility
			workspace.systemPromptConfig = load.systemPromptConfig || {} // NEW
			if (load.sidebarWidth && Object.keys(workspace.sidebarPanelWidths).length === 0) {
				workspace.sidebarPanelWidths["folder"] = load.sidebarWidth
			}
			workspace.activeSidebarTab = load.activeSidebarTab || null
			workspace.id = load.id || safeString(workspace.name)

			fileList.ignorePaths = workspace.ignorePaths
			// REMOVED: workspace.promptHistory = load.promptHistory || []; // Removed
			// REMOVED: ui.aiManager.promptHistory = workspace.promptHistory; // Removed
			workspace.aiConfig = load.aiConfig || {}
			// REMOVED: workspace.chatHistory = load.chatHistory || []; // Removed
			// if (ui.aiManager.historyManager) {
			//     ui.aiManager.historyManager.loadHistory(workspace.chatHistory, true);
			// }

			// NEW: Load system prompt settings into the AI Manager
			if (ui.aiManager) {
				const useWorkspaceSettings =
					!!window.workspace?.systemPromptConfig &&
					Object.keys(window.workspace.systemPromptConfig).length > 0
				ui.aiManager.systemPromptConfig = useWorkspaceSettings
					? workspace.systemPromptConfig
					: app.systemPromptConfig
			}

			// NEW: Load AI session metadata and active session ID
			workspace.aiSessionsMetadata = load.aiSessionsMetadata || []
			workspace.activeAiSessionId = load.activeAiSessionId || null
			if (ui.aiManager) {
				// Pass the AI session metadata and active ID to the manager
				ui.aiManager.loadSessions(workspace.aiSessionsMetadata, workspace.activeAiSessionId)
			}

			// After loading workspace, ensure aiManager is initialized with the correct provider's config
			// This assumes ui.aiManager.aiProvider is already set by ui.aiManager.loadSettings() in its init
			const currentProvider = ui.aiManager.aiProvider
			updateFileListBackground()
			if (workspace.aiConfig[currentProvider]) {
				ui.aiManager.ai.setOptions(workspace.aiConfig[currentProvider], null, null, true, "workspace")
			} else if (app.aiConfig[currentProvider]) {
				ui.aiManager.ai.setOptions(app.aiConfig[currentProvider], null, null, false, "global")
			} else {
				// If no specific config for the current provider, reset to default for that provider
				ui.aiManager.ai.setOptions({}, null, null, false, "global")
			}

			setTimeout(() => {
				ui.scratchEditor.session.setOption("wrap", "free")
				ui.scratchEditor.session.setOption("indentedSoftWrap", false)
				ui.scratchEditor.session.setMode("ace/mode/markdown")
			})

			fileOpen.text = "Add Folder"
			app.workspace = workspace.id

			// Trigger automatic restoration of folders and files
			restoreWorkspaceContent()

			if (name === "default") {
				hideActions()
			}

			saveAppConfig()
			ui.showSidebar()
			fileList.openFolders = workspace.openFolders || []
			updateWorkspaceSelectors()

			if (ui.iconTabBar) {
				if (workspace.activeSidebarTab) {
					ui.iconTabBar.activeTabById = workspace.activeSidebarTab
				}
				const activeTabId = ui.iconTabBar.activeTab?.iconId || "folder"
				const savedWidth = workspace.sidebarPanelWidths?.[activeTabId]

				if (savedWidth) {
					ui.sidebar.style.width = `${savedWidth}px`
					ui.mainContent.style.left = `${savedWidth}px`
				}
			}
		} else {
			if (name === "default") {
				workspace.name = "default"
				workspace.id = "default"
				workspace.files = []
				workspace.folders = []
				workspace.ignorePaths = [".git", "node_modules", "dist", "build"]
				// NEW: Initialize empty AI session metadata
				workspace.aiSessionsMetadata = []
				// NEW: Initialize empty system prompt config
				workspace.systemPromptConfig = {}
				workspace.activeAiSessionId = null
				updateFileListBackground()
				// AIManager will handle creating the first session when it gets loadSessions call
				hideActions()
				let item = document.createElement("ui-menu-item")
				item.setAttribute("command", `app:workspaceOpen:default`)
				item.text = name
				selectors.appendChild(item)
				if (name == workspace.name) {
					item.icon = "done"
				}

				saveWorkspace()
			} else {
				window.modal.notice(
					`Couldn't load workspace "${name}". It may have been deleted or corrupted.`,
					"Workspace Error"
				)
				app.workspaces.splice(app.workspaces.indexOf(name), 1)
				saveAppConfig()
				openWorkspace("default")
			}
		}
		} finally {
			isOpeningWorkspace = false;
		}
	}
})()

const prefersDarkMode = window.matchMedia("(prefers-color-scheme: dark)")

const clearInjectedTheme = () => {
	// This function is no longer needed as we're not dynamically injecting editor colors
	// Instead, CSS handles light/dark mode with pre-defined variables.
}

const execCommandSetDarkMode = (mode) => {
	app.darkmode = mode

	switch (mode) {
		case "light":
			document.body.classList.remove("darkmode")
			break
		case "dark":
			document.body.classList.add("darkmode")
			break
		case "system":
			if (prefersDarkMode.matches) {
				// This only updates on initial load and system preference change
				document.body.classList.add("darkmode")
			} else {
				document.body.classList.remove("darkmode")
			}
			break
	}
	saveAppConfig()
	updateThemeAndMode(false) // Update menus, but don't save again
}

prefersDarkMode.addEventListener("change", () => {
	if (app.darkmode === "system") {
		execCommandSetDarkMode("system")
	}
})

const updateThemeAndMode = (doSave = false) => {
	ui.updateThemeAndMode()

	if (leftEdit.getOption("mode") in canPrettify) {
		prettify.removeAttribute("disabled")
	} else {
		prettify.setAttribute("disabled", "disabled")
	}

	if (doSave) saveAppConfig()
}

const execCommandPrettify = () => {
	let text = currentEditor.getValue()
	const mode = currentEditor.getOption("mode")
	if (!(mode in canPrettify)) return

	const parser = canPrettify[mode]
	const activeRow = currentEditor.getCursorPosition().row + 1

	try {
		text = prettier.format(text, {
			parser: parser.name,
			plugins: parser.plugins,
			printWidth: currentEditor.getOption("printMargin") || 120,
			tabWidth: currentEditor.getOption("tabSize") || 4,
			useTabs: !currentEditor.getOption("useSoftTabs") || false,
			semi: false,
		})
		currentEditor.setValue(text)
		currentEditor.clearSelection()
		currentEditor.gotoLine(activeRow)
	} catch (e) {
		console.warn("Unable to prettify", e)
		const m = e.message
		try {
			let match = m.match(/\>\s(\d*) \|/g)
			if (match.length > 0) {
				let l = parseInt(match[0].replace(/[\>\|\s]/g, "")) - 1
				currentEditor.getSession().setAnnotations([
					{
						row: l,
						column: 0,
						text: m, // Or the Json reply from the parser
						type: "error", // also "warning" and "information"
					},
				])
				currentEditor.execCommand("goToNextError")
			}
		} catch (er) {
			console.error("Unable to prettify", e, er)
		}
	}
}

const execCommandEditorOptions = () => {
	for (const editor of window.editors) {
		// Exclude special editors from global session/renderer options
		if (app.sessionOptions && !["scratch-editor", "ai-prompt-editor"].includes(editor.id)) {
			editor.session.setOptions(app.sessionOptions)
		}
		if (app.rendererOptions && !["scratch-editor", "ai-prompt-editor"].includes(editor.id)) {
			editor.renderer.setOptions(app.rendererOptions)
		}
		if (app.enableLiveAutocompletion) {
			editor.$enableLiveAutocompletion = app.enableLiveAutocompletion
		}

		if (editor.getOption("mode") === "ace/mode/javascript") {
			editor.setOption("useWorker", false)
		} else {
			editor.setOption("useWorker", true)
		}
	}
}

const execCommandAbout = () => {
	const modeStr = terminalManager?.conduitStatus?.mode || "unknown"
	const versionInfo = `Version ${
		window.code.version
	} (${modeStr}) - Copyright &copy; ${new Date().getFullYear()} jakbox.dev`
	const content = `<p>Simple, fast, lightweight code editing. Edit your local code files straight from your web browser, 
			or install the web app for that sweet "native app" experience.</p>

			<p>For issues &amp; bugs please see the <a href="https://github.com/blakjakau/dev.jakbox.code/issues" target="_blank">issue tracker</a></p>
			
			<p>Cadence is open source and uses other open source projects see <a href="https://github.com/blakjakau/dev.jakbox.code/blob/master/licence.md" target="_blank">here</a> for licence information</a>.</p>
			<br/><small>${versionInfo}</small>`
	const title = `<img src="images/code-192-blue.svg" width="32px" style="vertical-align: middle;">&nbsp;Cadence`
	Modal.notice(content, title)
}
const execCommandAddFolder = async () => {
	if (window.runtime) {
		const folder = await window.runtime.OpenDirectoryDialog({
			Title: "Add Folder to Workspace",
			DefaultDirectory: workspace.folders?.[0] || "",
		})
		if (folder) {
			if (!workspace.folders.includes(folder)) {
				workspace.folders.push(folder)
				updateFileListBackground()
				saveWorkspace()
				await fileList.refreshAll()
			}
		}
	} else {
		fileOpen.click()
	}
}
const execCommandToggleFolders = () => {
	ui.toggleSidebar()
}

const execCommandSplitView = () => {
	ui.toggleSplitView()
}

const execCommandToggleSidebarPanel = (panelId) => {
	const isSidebarVisible = document.body.classList.contains("showSidebar")
	const currentPanel = ui.iconTabBar.activeTab?.iconId

	if (isSidebarVisible && currentPanel === panelId) {
		if (panelId == "developer_board") {
			if (!document.activeElement.classList.contains("ace_text-input")) {
				// just focus the tab
				ui.iconTabBar.activeTabById = panelId
				return
			}
		}
		if (panelId == "terminal") {
			if (!document.activeElement.classList.contains("xterm-helper-textarea")) {
				// just focus the tab
				ui.iconTabBar.activeTabById = panelId
				return
			}
		}
		ui.toggleSidebar() // Close the sidebar
	} else if (!isSidebarVisible) {
		ui.toggleSidebar() // Open the sidebar
		ui.iconTabBar.activeTabById = panelId
	} else {
		ui.iconTabBar.activeTabById = panelId // Switch to the new panel
	}
}

const execCommandRemoveAllFolders = () => {
	setTimeout(async () => {
		const l = workspace.folders.length
		if (l == 0) {
			window.modal.notice("You don't have any folders in your workspace.", "No Folders")
		} else {
			const confirmed = await window.modal.confirm(
				`Are you sure you want to remove ${l} folder${l > 1 ? "s" : ""} from your workspace?`
			)
			if (confirmed) {
				while (workspace.folders.length > 0) {
					workspace.folders.pop()
				}
				updateFileListBackground()
				ui.showSidebar()
				// saveAppConfig()
				saveWorkspace()
			}
		}
	}, 400)
}

const execCommandRefreshFolders = () => {}

const execCommandRefreshOpenFiles = async () => {
	const tabsToReload = []
	for (const tab of leftTabs.tabs) {
		if (!tab.changed && tab.config.handle && typeof tab.config.handle === "string") {
			tabsToReload.push(tab)
		}
	}
	for (const tab of rightTabs.tabs) {
		if (!tab.changed && tab.config.handle && typeof tab.config.handle === "string") {
			tabsToReload.push(tab)
		}
	}
	for (const tab of tabsToReload) {
		await reloadFile(tab)
	}
}

const execCommandRestoreFolders = () => {
	restoreWorkspaceContent()
}

const execCommandCloseActiveTab = async () => {
	const activeEl = document.activeElement

	// If the active element is within a terminal instance
	if (activeEl && activeEl.closest(".terminal-instance-container")) {
		if (window.terminalManager && window.terminalManager._activeSessionId) {
			const session = window.terminalManager._sessions.get(window.terminalManager._activeSessionId)
			if (session && session.tabItem) {
				window.terminalManager.deleteTerminalSession(session.tabItem.config.id, session.tabItem)
				window.terminalManager.sessionTabBar.activeTab?.click() // Re-clicking the new active tab ensures focus
			}
		}
		return
	}
	// If the active element is within the AI prompt editor
	if (activeEl && activeEl.closest("#ai-prompt-editor-container")) {
		if (ui.aiManager && ui.aiManager.activeSession) {
			ui.aiManager.deleteSession(ui.aiManager.activeSession.id, ui.aiManager.sessionTabBar.activeTab)
		}
		return
	}

	// Fallback to closing the current editor file if neither terminal nor AI is focused
	const tab = ui.currentTabs.activeTab
	if (tab) {
		tab.close.click()
	}
}
const execCommandNextBuffer = () => {
	const activeEl = document.activeElement
	// Check if focus is within the Terminal panel
	if (activeEl && activeEl.closest(".terminal-instance-container")) {
		if (window.terminalManager?.sessionTabBar) {
			window.terminalManager.sessionTabBar.next() // Switches the tab
			window.terminalManager.sessionTabBar.activeTab?.click() // Re-clicking the new active tab ensures focus
		}
		return
	}
	// Check if focus is within the AI panel
	if (activeEl && activeEl.closest("#ai-panel")) {
		if (ui.aiManager?.sessionTabBar) {
			ui.aiManager.sessionTabBar.next()
		}
		return
	}
	// Default to the current editor's tabs
	if (ui.currentTabs) {
		ui.currentTabs.next()
	}
}
const execCommandPrevBuffer = () => {
	const activeEl = document.activeElement
	if (activeEl && activeEl.closest(".terminal-instance-container")) {
		if (window.terminalManager?.sessionTabBar) {
			window.terminalManager.sessionTabBar.prev() // Switches the tab
			window.terminalManager.sessionTabBar.activeTab?.click() // Re-clicking the new active tab ensures focus
		}
	} else if (activeEl && activeEl.closest("#ai-panel")) {
		if (ui.aiManager?.sessionTabBar) {
			ui.aiManager.sessionTabBar.prev()
		}
	} else if (ui.currentTabs) {
		ui.currentTabs.prev()
	}
}

const execCommandSave = async () => {
	const tab = currentTabs.activeTab
	const config = tab.config
	if (config.handle) {
		await saveFile(tab)
		config.session.baseValue = config.session.getValue()
	} else {
		const startIn = await getSuggestedStartDirectory()
		const expandPath = tab.config?.path ? tab.config.path.substring(0, tab.config.path.lastIndexOf('/')) : startIn;
		const newFile = await promptSaveFile(tab.name || "Untitled", startIn, workspace.folders, expandPath)
		if (!newFile) {
			// window.modal.notice("File save operation was cancelled.", "Not Saved")
			return
		}

		config.handle = newFile.path
		config.name = newFile.name
		config.path = newFile.path
		config.folder = newFile.folder
		tab.name = config.name
		tab.setAttribute("title", config.path)

		await saveFile(tab)
		config.session.baseValue = config.session.getValue()

		// This is a new file, add it to the workspace
		syncWorkspaceFile(tab)

		// Refresh the folder in the file list to show the new file
		await fileList.refreshFolder(config.folder)
	}
}

const execCommandSaveAs = async () => {
	const tab = currentTabs.activeTab
	const config = tab.config
	const oldHandle = config.handle
	const oldFolderHandle = config.folder

	const startIn = await getSuggestedStartDirectory()
	const expandPath = tab.config?.path ? tab.config.path.substring(0, tab.config.path.lastIndexOf('/')) : startIn;
	const newFile = await promptSaveFile(config.name || "Untitled", startIn, workspace.folders, expandPath)

	if (!newFile) {
		// window.modal.notice("File save operation was cancelled.", "Not Saved")
		return
	}

	if (oldHandle) {
		workspace.files = workspace.files.filter((f) => f.handle !== oldHandle)
	}

	config.handle = newFile.path
	config.name = newFile.name
	config.path = newFile.path
	config.folder = newFile.folder
	tab.name = config.name
	tab.setAttribute("title", config.path)

	await saveFile(tab)
	syncWorkspaceFile(tab)

	await fileList.refreshFolder(config.folder)
	if (oldFolderHandle && oldFolderHandle !== config.folder) {
		await fileList.refreshFolder(oldFolderHandle)
	}
}

const execCommandOpen = async () => {
	const startIn = await getSuggestedStartDirectory()
	const newHandle = await window.showOpenFilePicker({ startIn }).catch(console.warn)
	if (!newHandle) {
		return
	}
	fileList.open(newHandle[0])
}

const execCommandNewFile = async () => {
	const activeEl = document.activeElement
	let context = "editor" // Default context
	// 1. Check for specific focused elements first
	if (activeEl && activeEl.closest(".terminal-instance-container")) {
		context = "terminal"
	} else if (activeEl && activeEl.closest("#ai-prompt-editor-container")) {
		context = "ai"
	} else if (activeEl && (activeEl.closest(".ace_editor") || activeEl.classList.contains("ace_text-input"))) {
		context = "editor"
	} else {
		// 2. If no editor is focused, use the active sidebar panel as the context
		const activeSidebarTabId = ui.iconTabBar?.activeTab?.iconId
		switch (activeSidebarTabId) {
			case "developer_board":
				context = "ai"
				break
			case "terminal":
				context = "terminal"
				break
			default:
				context = "editor"
				break
		}
	}
	// Execute the 'new' action based on the determined context
	switch (context) {
		case "ai":
			return ui.aiManager.createNewSession()
		case "terminal":
			return window.terminalManager.createNewTerminalSession()
		case "editor":
		default:
			const srcTab = ui.currentTabs.activeTab
			const mode = srcTab?.config?.mode?.mode || ""
			const folder = srcTab?.config?.folder || undefined
			const newSession = ace.createEditSession("", mode)
			if (app.sessionOptions) newSession.setOptions(app.sessionOptions)
			newSession.baseValue = ""
			const targetTabs = ui.currentTabs
			const tab = targetTabs.add({
				name: "untitled",
				mode: { mode: mode },
				session: newSession,
				folder: folder,
				side: targetTabs === leftTabs ? "left" : "right",
			})
			return tab.click()
	}

	// const srcTab = ui.currentTabs.activeTab
	// const mode = srcTab?.config?.mode?.mode || "";
	// const folder = srcTab?.config?.folder || undefined;
	// const newSession = ace.createEditSession("", mode);

	// // Check for active element focus to determine context
	// const activeEl = document.activeElement;

	// if(activeEl.tagName !== "TEXTAREA") {
	// 	// we're NOT on a text area at all, we'll use the actice sidebar instead
	// 	//GEMINI do this bit? trigger based on the curret active icon in the side iconbar
	// }

	// // If the active element is within a terminal instance
	// if (activeEl && activeEl.closest('.terminal-instance-container')) {
	// 	window.terminalManager.createNewTerminalSession();
	// 	return;
	// }
	// // If the active element is within the AI prompt editor
	// if (activeEl && activeEl.closest('#ai-prompt-editor-container')) {
	// 	ui.aiManager.createNewSession();
	// 	return;
	// }

	// // Apply stored session options to the new session
	// if (app.sessionOptions) {
	// 	newSession.setOptions(app.sessionOptions);
	// }
	// newSession.baseValue = "";

	// let targetTabs = ui.currentTabs

	// const tab = targetTabs.add({ name: "untitled", mode: { mode: mode }, session: newSession, folder: folder, side: (targetTabs === leftTabs) ? "left" : "right" });

	const tab = targetTabs.add({
		name: "untitled",
		mode: { mode: mode },
		session: newSession,
		folder: folder,
		side: targetTabs === leftTabs ? "left" : "right",
	})
	// Set a default icon for new untitled tabs
	tab.defaultStatusIcon = "description"

	// tab.click();
}

const execCommandNewWindow = async () => {
	window.open("/", "new-window", `width=${window.outerWidth},height=${window.outerHeight}`)
}

// Function to reload a file from disk
const reloadFile = async (tab) => {
	const handle = tab.config.handle
	if (!handle || typeof handle !== "string") {
		console.warn("No valid file handle found for tab:", tab.config.name)
		return
	}

	try {
		const response = await conduitClient.wsRead(handle)
		let text = response.content
		if (text === undefined && response.data) {
			try {
				// Decode UTF-8 base64
				text = decodeURIComponent(escape(atob(response.data)))
			} catch (e) {
				text = atob(response.data)
			}
		}

		// Update the session with the new content
		tab.config.session.setValue(text)
		tab.config.session.baseValue = text // Reset baseValue to current content
		tab.config.fileModified = false // Clear the file modified flag
		tab.changed = false // Clear unsaved changes flag

		// If the reloaded tab is the active tab, ensure the editor updates
		if (tab === currentTabs.activeTab) {
			currentEditor.setSession(tab.config.session)
			currentEditor.focus()
		}
	} catch (error) {
		console.error("Error reloading file:", tab.config.name, error)
		window.modal.notice(
			`Error reloading file ${tab.config.name}:<br><small>${error.message}</small>`,
			"Reload Error"
		)
	}
}

// Expose it globally for ui-main.mjs to call
window.ui.reloadFile = reloadFile

// 	const buildPath = (f) => {
// 	if (!(f instanceof FileSystemFileHandle || f instanceof FileSystemDirectoryHandle)) {
// 		return ""
// 	}
// 	let n = f.name
// 	if (f.container) n = buildPath(f.container) + "/" + n
// 	return n
// }

const syncWorkspaceFile = (tab) => {
	const config = tab.config
	const handle = config.handle
	if (!handle || handle === "plan_tasks") return

	let matched = false
	for (const file of workspace.files) {
		if (file.handle === handle) {
			file.side = config.side
			matched = true
			break
		}
	}

	if (!matched) {
		workspace.files.push({
			name: config.name,
			path: config.path,
			handle: handle,
			side: config.side,
		})
	}
	saveWorkspace()
}
const setupSessionChangeListener = (session, tab) => {
	session.on("change", () => {
		const isDirty = session.getValue() !== session.baseValue

		// Update tab's changed status
		tab.changed = isDirty

		// Update corresponding file list item's changed status
		const handle = tab.config.handle
		if (handle) {
			const fileItem = fileList.byTitle(buildPath(handle))
			if (fileItem) {
				fileItem.changed = isDirty
			}
		}
	})
}
let currentEditor = leftEdit
let currentTabs = leftEdit
let currentMediaView = ui.leftMedia

const setCurrentEditor = (editor) => {
	ui.currentEditor = currentEditor = editor
	ui.currentTabs = currentTabs = editor === leftEdit ? ui.leftTabs : ui.rightTabs
	ui.currentMediaView = currentMediaView = editor === leftEdit ? ui.leftMedia : ui.rightMedia
	ui.aiManager.editor = editor

	const tab = editor?.tabs?.activeTab
	if (tab) {
		fileList.active = tab.config.handle
		tab.scrollIntoViewIfNeeded()
		tab.parentElement.scrollTop = 0
		if (tab.changed && fileList.activeItem) {
			fileList.activeItem.changed = true
		}

		// Update the side property in workspace.files when the active editor changes
		const fileInWorkspace = workspace.files.find((file) => file.handle === tab.config.handle)
		if (fileInWorkspace) {
			fileInWorkspace.side = editor === leftEdit ? "left" : "right"
			saveWorkspace()
		}
	}
}

const renderPlanTasksView = (container) => {
	const session = ui.aiManager.activeSession
	if (!session) {
		container.innerHTML = `<div class="plan-tasks-empty">No active session found. Open the Agent panel to begin.</div>`
		return
	}

	// Initialize accordion expand/collapse state tracking
	session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true };
	const isExpanded = (section) => session._accordionStates[section] !== false;


	const settingsExpanded = isExpanded("settings");
	const planExpanded = isExpanded("plan");
	const tasksExpanded = isExpanded("tasks");
	const backupsExpanded = isExpanded("backups");

	const planHtml = session.implementationPlan 
		? ui.aiManager.md.render(session.implementationPlan)
		: `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`

	const tasksHtml = session.taskList
		? ui.aiManager.md.render(session.taskList)
		: `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`

	// Generate history & rollback rows if modifiedFiles is populated
	const modifiedFiles = session.modifiedFiles || {};
	const filePaths = Object.keys(modifiedFiles);
	let backupsHtml = "";

	if (filePaths.length === 0) {
		backupsHtml = `<div class="plan-tasks-empty" style="padding: 16px 0;">No file modifications recorded in this session yet.</div>`;
	} else {
		backupsHtml = `<div class="backups-list" style="display: flex; flex-direction: column; gap: 8px;">`;
		filePaths.forEach(path => {
			const list = modifiedFiles[path];
			const filename = path.split('/').pop();
			const relativePath = path; 
			const latestBackup = list[list.length - 1];
			const formatTime = (ts) => {
				const diff = Date.now() - ts;
				if (diff < 60000) return "Just now";
				const mins = Math.floor(diff / 60000);
				if (mins < 60) return `${mins}m ago`;
				const hours = Math.floor(mins / 60);
				if (hours < 24) return `${hours}h ago`;
				return new Date(ts).toLocaleDateString();
			};

			backupsHtml += `
				<div class="backup-row" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--borderRadius); gap: 16px;">
					<div class="backup-info" style="display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1;">
						<span class="backup-file" style="font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--text-primary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${filename}</span>
						<span class="backup-path" style="font-size: 10.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${relativePath}</span>
					</div>
					<div class="backup-actions" style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 11px; color: var(--text-secondary);">${formatTime(latestBackup.timestamp)}</span>
						<button class="rollback-btn theme-button secondary" data-backup-id="${latestBackup.backupId}" data-path="${path}" style="padding: 4px 10px; font-size: 11.5px; display: flex; align-items: center; gap: 4px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border-primary); color: var(--text-primary); background: var(--bg-primary);">
							<ui-icon style="font-size: 14px;">undo</ui-icon>
							<span>Rollback</span>
						</button>
					</div>
				</div>
			`;
		});
		backupsHtml += `</div>`;
	}

	container.innerHTML = `
		<div class="artifacts-accordion-container" style="display: flex; flex-direction: column; width: 100%; height: 100%; overflow-y: auto; padding: 16px 20px; gap: 12px; box-sizing: border-box; background: var(--bg-primary);">
			
			<!-- Accordion Item 1: Session Settings -->
			<div class="accordion-item settings-section ${settingsExpanded ? 'expanded' : ''}" style="display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--borderRadius); overflow: hidden; background: var(--bg-primary);">
				<div class="accordion-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-secondary); cursor: pointer; user-select: none;">
					<div class="header-left" style="display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--text-primary);">
						<ui-icon style="color: var(--theme);">settings</ui-icon>
						<span>Session Settings</span>
					</div>
					<ui-icon class="expand-arrow" style="font-size: 16px; transition: transform 0.2s ease; ${settingsExpanded ? '' : 'transform: rotate(180deg);'}">${settingsExpanded ? 'expand_less' : 'expand_more'}</ui-icon>
				</div>
				<div class="accordion-content" style="${settingsExpanded ? '' : 'display: none; '}padding: 16px; border-top: 1px solid var(--border-primary); background: var(--bg-primary);">
					<div class="settings-grid" style="display: flex; flex-direction: column; gap: 16px;">
						<div class="agent-toggle-wrapper" style="display: flex; align-items: flex-start; gap: 12px; margin-right: 0;">
							<label class="switch" title="Agent Mode: Allow Cadence to call tools to read/edit code" style="flex-shrink: 0;">
								<input type="checkbox" id="accordion-agent-mode">
								<span class="slider round"></span>
							</label>
							<div class="setting-meta" style="display: flex; flex-direction: column; gap: 2px;">
								<span class="toggle-label" style="font-size: 12.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; user-select: none;">Agent Mode</span>
								<span class="setting-desc" style="font-size: 11px; color: var(--text-secondary);">Allow Cadence to automatically read, write, and manage workspace files.</span>
							</div>
						</div>
						<div class="planning-toggle-wrapper" style="display: flex; align-items: flex-start; gap: 12px; margin-right: 0;">
							<label class="switch" title="Planning Mode: Focus on generating implementation plans" style="flex-shrink: 0;">
								<input type="checkbox" id="accordion-planning-mode">
								<span class="slider round"></span>
							</label>
							<div class="setting-meta" style="display: flex; flex-direction: column; gap: 2px;">
								<span class="toggle-label" style="font-size: 12.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; user-select: none;">Planning Mode</span>
								<span class="setting-desc" style="font-size: 11px; color: var(--text-secondary);">Focus Cadence on generating structured implementation plans before applying edits.</span>
							</div>
						</div>
						<div class="agent-toggle-wrapper" style="display: flex; align-items: flex-start; gap: 12px; margin-right: 0;">
							<label class="switch" title="Forgiveness Mode: Commit edits immediately" style="flex-shrink: 0;">
								<input type="checkbox" id="accordion-forgiveness-mode">
								<span class="slider round"></span>
							</label>
							<div class="setting-meta" style="display: flex; flex-direction: column; gap: 2px;">
								<span class="toggle-label" style="font-size: 12.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; user-select: none;">Forgiveness Mode</span>
								<span class="setting-desc" style="font-size: 11px; color: var(--text-secondary);">Commit edits immediately to disk with robust single-click rollback safety.</span>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Accordion Item 2: Implementation Plan -->
			<div class="accordion-item plan-section ${planExpanded ? 'expanded' : ''}" style="display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--borderRadius); overflow: hidden; background: var(--bg-primary);">
				<div class="accordion-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-secondary); cursor: pointer; user-select: none;">
					<div class="header-left" style="display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--text-primary);">
						<ui-icon style="color: #d19a66;">assignment</ui-icon>
						<span>Implementation Plan</span>
					</div>
					<div style="display: flex; align-items: center; gap: 8px;">
						<button class="edit-plan-btn" style="display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-weight: 600; border-radius: var(--borderRadius); border: 1px solid var(--border-primary); background: var(--bg-primary); color: var(--text-secondary);">
							<ui-icon style="font-size: 14px;">edit</ui-icon>
							<span>Edit</span>
						</button>
						<ui-icon class="expand-arrow" style="font-size: 16px; transition: transform 0.2s ease; ${planExpanded ? '' : 'transform: rotate(180deg);'}">${planExpanded ? 'expand_less' : 'expand_more'}</ui-icon>
					</div>
				</div>
				<div class="accordion-content" style="${planExpanded ? '' : 'display: none; '}border-top: 1px solid var(--border-primary); background: var(--bg-primary); position: relative; min-height: 100px;">
					<div class="pane-content markdown-body" style="padding: 16px 20px; line-height: 1.6; font-size: 13px; color: var(--text-secondary);">${planHtml}</div>
				</div>
			</div>

			<!-- Accordion Item 3: Task Checklist -->
			<div class="accordion-item tasks-section ${tasksExpanded ? 'expanded' : ''}" style="display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--borderRadius); overflow: hidden; background: var(--bg-primary);">
				<div class="accordion-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-secondary); cursor: pointer; user-select: none;">
					<div class="header-left" style="display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--text-primary);">
						<ui-icon style="color: #2da44e;">playlist_add_check</ui-icon>
						<span>Task Checklist</span>
					</div>
					<div style="display: flex; align-items: center; gap: 8px;">
						<button class="edit-tasks-btn" style="display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-weight: 600; border-radius: var(--borderRadius); border: 1px solid var(--border-primary); background: var(--bg-primary); color: var(--text-secondary);">
							<ui-icon style="font-size: 14px;">edit</ui-icon>
							<span>Edit</span>
						</button>
						<ui-icon class="expand-arrow" style="font-size: 16px; transition: transform 0.2s ease; ${tasksExpanded ? '' : 'transform: rotate(180deg);'}">${tasksExpanded ? 'expand_less' : 'expand_more'}</ui-icon>
					</div>
				</div>
				<div class="accordion-content" style="${tasksExpanded ? '' : 'display: none; '}border-top: 1px solid var(--border-primary); background: var(--bg-primary); position: relative; min-height: 100px;">
					<div class="pane-content markdown-body tasks-content" style="padding: 16px 20px; line-height: 1.6; font-size: 13px; color: var(--text-secondary);">${tasksHtml}</div>
				</div>
			</div>

			<!-- Accordion Item 4: Edit History & Rollbacks -->
			<div class="accordion-item backups-section ${backupsExpanded ? 'expanded' : ''}" style="display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--borderRadius); overflow: hidden; background: var(--bg-primary);">
				<div class="accordion-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-secondary); cursor: pointer; user-select: none;">
					<div class="header-left" style="display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--text-primary);">
						<ui-icon style="color: var(--color-error, #ea4335);">history</ui-icon>
						<span>Edit History & Rollbacks</span>
					</div>
					<ui-icon class="expand-arrow" style="font-size: 16px; transition: transform 0.2s ease; ${backupsExpanded ? '' : 'transform: rotate(180deg);'}">${backupsExpanded ? 'expand_less' : 'expand_more'}</ui-icon>
				</div>
				<div class="accordion-content" style="${backupsExpanded ? '' : 'display: none; '}padding: 16px; border-top: 1px solid var(--border-primary); background: var(--bg-primary);">
					${backupsHtml}
				</div>
			</div>

		</div>
	`

	// Toggles expand/collapse on headers
	container.querySelectorAll(".accordion-header").forEach(header => {
		header.onclick = (e) => {
			if (e.target.closest("button") || e.target.closest(".header-actions")) return;
			const item = header.closest(".accordion-item");
			const content = item.querySelector(".accordion-content");
			const arrow = header.querySelector(".expand-arrow");
			const isExpanded = item.classList.toggle("expanded");
			
			// Save the expanded state in session
			let sectionKey = "";
			if (item.classList.contains("settings-section")) sectionKey = "settings";
			else if (item.classList.contains("plan-section")) sectionKey = "plan";
			else if (item.classList.contains("tasks-section")) sectionKey = "tasks";
			else if (item.classList.contains("backups-section")) sectionKey = "backups";
			
			if (sectionKey) {
				session._accordionStates[sectionKey] = isExpanded;
			}
			
			if (isExpanded) {
				content.style.display = "";
				arrow.style.transform = "rotate(0deg)";
				arrow.textContent = "expand_less";
			} else {
				content.style.display = "none";
				arrow.style.transform = "rotate(180deg)";
				arrow.textContent = "expand_more";
			}
		};
	});

	// Sync checkbox values & wire change events for Settings Toggles
	const agentModeCheckbox = container.querySelector("#accordion-agent-mode");
	const planningModeCheckbox = container.querySelector("#accordion-planning-mode");
	const forgivenessModeCheckbox = container.querySelector("#accordion-forgiveness-mode");

	if (agentModeCheckbox) {
		agentModeCheckbox.checked = ui.aiManager.agentMode || false;
		agentModeCheckbox.addEventListener("change", (e) => {
			const checked = e.target.checked;
			ui.aiManager.agentMode = checked;
			localStorage.setItem("aiAgentMode", checked);
			
			const mainCheck = document.querySelector("#agent-mode-checkbox");
			if (mainCheck) mainCheck.checked = checked;
			
			ui.aiManager._updatePromptAreaPlaceholder();
			// Avoid full re-render of tab on setting toggle
		});
	}

	if (planningModeCheckbox) {
		planningModeCheckbox.checked = ui.aiManager.planningMode || false;
		planningModeCheckbox.addEventListener("change", (e) => {
			const checked = e.target.checked;
			ui.aiManager.planningMode = checked;
			localStorage.setItem("aiPlanningMode", checked);
			
			const mainCheck = document.querySelector("#planning-mode-checkbox");
			if (mainCheck) mainCheck.checked = checked;
			
			ui.aiManager._updatePromptAreaPlaceholder();
		});
	}

	if (forgivenessModeCheckbox) {
		forgivenessModeCheckbox.checked = ui.aiManager.forgivenessMode || false;
		forgivenessModeCheckbox.addEventListener("change", (e) => {
			const checked = e.target.checked;
			ui.aiManager.forgivenessMode = checked;
			localStorage.setItem("aiForgivenessMode", checked);
		});
	}

	// Save/edit logic for Implementation Plan
	const planBtn = container.querySelector(".edit-plan-btn")
	const planContent = container.querySelector(".plan-section .pane-content")
	let planEditorInstance = null

	planBtn.onclick = async (e) => {
		if (e) e.stopPropagation();
		if (!planEditorInstance) {
			planBtn.innerHTML = `<ui-icon>save</ui-icon><span>Save</span>`
			planBtn.style.color = "var(--theme)"
			planBtn.style.borderColor = "var(--theme)"

			const currentHeight = planContent.offsetHeight;
			const rawMarkdown = session.implementationPlan || ""
			const editorHeight = Math.max(currentHeight, 150);
			planContent.style.padding = "0";
			planContent.innerHTML = `<div class="plan-ace-editor" style="height: ${editorHeight}px; width: 100%; position: relative;"></div>`
			const editorDiv = planContent.querySelector(".plan-ace-editor")

			planEditorInstance = window.ace.edit(editorDiv)
			const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night"
			planEditorInstance.setTheme(theme)
			planEditorInstance.session.setMode("ace/mode/markdown")
			planEditorInstance.setValue(rawMarkdown, -1)
			planEditorInstance.setFontSize(12)
			planEditorInstance.setShowPrintMargin(false)
			planEditorInstance.renderer.setShowGutter(true)
			planEditorInstance.focus()
		} else {
			const newValue = planEditorInstance.getValue()
			session.implementationPlan = newValue

			planEditorInstance.destroy()
			planEditorInstance = null

			try {
				await workspaceClient.setSession(session.id, session)
			} catch (e) {
				console.error("[PlanTasksView] Error saving session plan:", e)
			}

			planContent.style.padding = "16px 20px"
			planContent.innerHTML = newValue 
				? ui.aiManager.md.render(newValue)
				: `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`
			
			planBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`
			planBtn.style.color = "var(--text-secondary)"
			planBtn.style.borderColor = "var(--border-primary)"
		}
	}

	// Save/edit logic for Task Checklist
	const tasksBtn = container.querySelector(".edit-tasks-btn")
	const tasksContent = container.querySelector(".tasks-section .pane-content")
	let tasksEditorInstance = null

	tasksBtn.onclick = async (e) => {
		if (e) e.stopPropagation();
		if (!tasksEditorInstance) {
			tasksBtn.innerHTML = `<ui-icon>save</ui-icon><span>Save</span>`
			tasksBtn.style.color = "var(--theme)"
			tasksBtn.style.borderColor = "var(--theme)"

			const currentHeight = tasksContent.offsetHeight;
			const rawMarkdown = session.taskList || ""
			const editorHeight = Math.max(currentHeight, 150);
			tasksContent.style.padding = "0";
			tasksContent.innerHTML = `<div class="tasks-ace-editor" style="height: ${editorHeight}px; width: 100%; position: relative;"></div>`
			const editorDiv = tasksContent.querySelector(".tasks-ace-editor")

			tasksEditorInstance = window.ace.edit(editorDiv)
			const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night"
			tasksEditorInstance.setTheme(theme)
			tasksEditorInstance.session.setMode("ace/mode/markdown")
			tasksEditorInstance.setValue(rawMarkdown, -1)
			tasksEditorInstance.setFontSize(12)
			tasksEditorInstance.setShowPrintMargin(false)
			tasksEditorInstance.renderer.setShowGutter(true)
			tasksEditorInstance.focus()
		} else {
			const newValue = tasksEditorInstance.getValue()
			session.taskList = newValue

			tasksEditorInstance.destroy()
			tasksEditorInstance = null

			try {
				await workspaceClient.setSession(session.id, session)
			} catch (e) {
				console.error("[PlanTasksView] Error saving session tasks:", e)
			}

			tasksContent.style.padding = "16px 20px"
			tasksContent.innerHTML = newValue 
				? ui.aiManager.md.render(newValue)
				: `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`
			
			tasksBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`
			tasksBtn.style.color = "var(--text-secondary)"
			tasksBtn.style.borderColor = "var(--border-primary)"
		}
	}


	// Rollback action logic
	container.querySelectorAll(".rollback-btn").forEach(btn => {
		btn.onclick = async () => {
			const backupId = btn.getAttribute("data-backup-id");
			const path = btn.getAttribute("data-path");
			
			try {
				btn.disabled = true;
				btn.innerHTML = `<ui-icon class="spinner">sync</ui-icon><span>Rolling back...</span>`;

				// 1. Revert content in AgentBackup
				const { default: AgentBackup } = await import('./agent/agent-backup.mjs');
				const content = await AgentBackup.rollback(backupId);

				// 2. Write content directly to disk via Conduit
				const base64Content = btoa(unescape(encodeURIComponent(content)));
				const result = await conduitClient.wsWrite(path, base64Content);
				if (result.error) throw new Error(result.error);

				// 3. Update active editor session if currently open in tabs
				const clean = (p) => p ? p.replace(/\\/g, '/') : '';
				const normPath = clean(path);
				const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
				const tab = allOpenTabs.find(t => clean(t.config?.path) === normPath);
				if (tab && tab.config.session) {
					tab.config.session.setValue(content);
					tab.config.session.baseValue = content;
					tab.changed = false;
				}

				// 4. Mark backup as rolled back in the session state so it doesn't clutter
				if (session.modifiedFiles && session.modifiedFiles[path]) {
					session.modifiedFiles[path] = session.modifiedFiles[path].filter(b => b.backupId !== backupId);
					if (session.modifiedFiles[path].length === 0) {
						delete session.modifiedFiles[path];
					}
					await workspaceClient.setSession(session.id, session);
				}

				window.modal.toast(`Successfully rolled back ${path.split('/').pop()} to original state.`);
				renderPlanTasksView(container); 
			} catch (err) {
				console.error("Rollback failed:", err);
				window.modal.notice(`Rollback failed:<br><small>${err.message}</small>`, "Rollback Error");
				btn.disabled = false;
				btn.innerHTML = `<ui-icon>undo</ui-icon><span>Rollback</span>`;
			}
		};
	});
}

const openPlanAndTaskList = (targetEditor = leftEdit) => {
	{
		let tab = leftTabs.tabs.find(t => t.config?.path === "plan_tasks")
		if (tab) return tab.click()
		tab = rightTabs.tabs.find(t => t.config?.path === "plan_tasks")
		if (tab) return tab.click()
	}

	const removeEmptyUntitledTab = (tabGroup) => {
		if (tabGroup.tabs.length === 1) {
			const tab = tabGroup.tabs[0]
			if (tab.config.name === "untitled" && tab.config.session.getValue() === "") {
				tabGroup.remove(tab, true)
			}
		}
	}
	removeEmptyUntitledTab(leftTabs)
	removeEmptyUntitledTab(rightTabs)

	const tab = targetEditor.tabs.add({
		name: "Session Artifacts & Settings",
		path: "plan_tasks",
		mode: { mode: "plan_tasks" },
		session: null,
		side: targetEditor === leftEdit ? "left" : "right",
		handle: "plan_tasks",
		folder: "",
		fileModified: false,
		defaultStatusIcon: "playlist_add_check",
	})
	
	tab.classList.add("plan-tasks-tab")
	tab.click()
}

ui.renderPlanTasksView = renderPlanTasksView
ui.openPlanAndTaskList = openPlanAndTaskList

const openFileHandle = async (handle, knownPath = null, targetEditor = currentEditor) => {
	let path = typeof handle === "string" ? handle : handle.path || knownPath
	let name = typeof handle === "string" ? path.split("/").pop() : handle.name

	// don't add a new tab if the file is already open in a tab
	{
		const clean = (p) => p ? p.replace(/\\/g, '/') : '';
		const normPath = clean(path);
		const findOpenTab = (tabBar) => {
			for (const tab of tabBar.tabs) {
				const normTabPath = clean(tab.config?.path);
				if (normTabPath === normPath || normTabPath.endsWith('/' + normPath) || normPath.endsWith('/' + normTabPath)) {
					return tab;
				}
			}
			return null;
		};

		let tab = findOpenTab(leftTabs)
		if (tab) return tab.click()
		tab = findOpenTab(rightTabs)
		if (tab) return tab.click()
	}

	let fileMode = { mode: "" }
	const images = "png|jpg|jpeg|bmp|tiff|gif|webp|ico".split("|")
	let isImage = false
	for (const i of images) {
		if (name.toLowerCase().endsWith(i)) {
			isImage = true
			fileMode.mode = "media"
			break
		}
	}

	let text = ""
	let rawData = null
	try {
		const fileData = await conduitClient.wsRead(path)
		if (fileData.error) throw new Error(fileData.error)
		rawData = fileData.data
		if (!isImage) {
			text = decodeURIComponent(escape(atob(fileData.data)))
		}
	} catch (e) {
		window.modal.notice(`Failed to open file ${path}:<br><small>${e.message}</small>`, "Read Error")
		return
	}

	// lookup editor modes
	for (let n in ace_modes) {
		const mode = ace_modes[n]

		// HTML should be html, not django
		if (mode.name == "django") continue

		if (name.match(mode.extRe)) {
			fileMode = mode
			break
		}
	}

	if (fileMode.mode == "") {
		// attempt to infer from line 1
		const filters = {
			"ace/mode/sh": /#!.*bash/,
			"ace/mode/javascript": /#!.*node/,
		}
		for (let n in filters) {
			let filter = filters[n]
			if (fileMode.mode == "") {
				const match = filter.exec(text)
				if (match && match.index === 0) {
					fileMode.mode = n
				}
			}
		}
	}

	if (fileMode.mode == "") {
		if (name.startsWith(".")) {
			fileMode.mode = "ace/mode/sh"
		} else {
			fileMode.mode = "ace/mode/text"
		}
	}

	if (fileMode.mode == "") {
		console.warn("Unsupported File", name)
		window.modal.notice(
			`Unsupported or unrecognised file type: <strong>${name.split(".").pop().toUpperCase()}</strong>`,
			"Unsupported File"
		)
		return
	}

	if (fileMode.name == "javascript" && 1 == 0) {
		text = prettier.format(text, {
			parser: "babel",
			plugins: [parserBabel, parserHtml],
			printWidth: 120,
			tabWidth: 4,
			useTabs: true,
			semi: false,
		})
	}

	// Check for and remove empty "untitled" tabs before opening a new file.
	const removeEmptyUntitledTab = (tabGroup) => {
		if (tabGroup.tabs.length === 1) {
			const tab = tabGroup.tabs[0]
			if (tab.config.name === "untitled" && tab.config.session.getValue() === "") {
				tabGroup.remove(tab, true) // Pass true to suppress defaultTab creation
			}
		}
	}

	removeEmptyUntitledTab(leftTabs)
	removeEmptyUntitledTab(rightTabs)

	const tabIcon = getIconForFileName(name)
	const newSession = ace.createEditSession(text, fileMode.mode)
	newSession.baseValue = text

	targetEditor.setSession(newSession)
	execCommandEditorOptions()

	let projectFolder = typeof handle === "string" ? "" : handle.container;
	if (!projectFolder && typeof path === "string") {
		// Find the longest matching workspace folder
		const matches = workspace.folders.filter(f => path.startsWith(f));
		if (matches.length > 0) {
			projectFolder = matches.sort((a, b) => b.length - a.length)[0];
		} else {
			// Fallback to the immediate parent directory
			projectFolder = path.substring(0, path.lastIndexOf('/')) || '.';
		}
	}

	const tab = targetEditor.tabs.add({
		name: name,
		path: path,
		mode: fileMode,
		session: newSession,
		side: targetEditor === leftEdit ? "left" : "right",
		handle: path,
		folder: projectFolder,
		fileModified: false,
		defaultStatusIcon: tabIcon, // Pass the determined icon to the new tab.
		rawData: rawData,
	})
	setupSessionChangeListener(newSession, tab)
	tab.click()
	observeFile(path, onFileModified) // Observe the file for changes

	// Only add to workspace and save if it's a newly opened file, not from a restore
	if (knownPath === null) {
		syncWorkspaceFile(tab)
	}
}

const fileMenu = document.getElementById("file_context")
const folderMenu = document.getElementById("folder_context")
const topfolderMenu = document.getElementById("top_folder_context")

fileMenu.click = folderMenu.click = topfolderMenu.click = async (action) => {
	const active = fileList.contextElement
	const file = active.item
	const filePath = file.path || file.name;

	switch (action) {
		case "remove":
			for (let i = 0; i < workspace.folders.length; i++) {
				if (workspace.folders[i] === filePath) {
					workspace.folders.splice(i, 1)
					i--
				}
			}
			saveWorkspace()
			ui.showSidebar()
			break
		case "refresh":
			if (active.refresh) {
				active.refresh.click()
			}
			break
		case "newfile":
			const newFileName = await Modal.prompt("", "New File Name", "");
			if (!newFileName) return;
			const newFilePath = `${filePath}/${newFileName}`;
			try {
				await conduitClient.wsWrite(newFilePath, btoa("")); // Create empty file
				await fileList.refreshFolder(filePath);
				await openFileHandle(newFilePath, newFilePath);
			} catch (e) {
				Modal.notice(`Failed to create file: ${e.message}`, "Error");
			}
			break;
		case "rename":
			const newName = await Modal.prompt("", `Rename ${file.isDir ? 'folder' : 'file'}`, file.name);
			if (!newName || newName === file.name) return;
			const parentPathRename = filePath.substring(0, filePath.lastIndexOf('/'));
			const newPath = parentPathRename ? `${parentPathRename}/${newName}` : newName;
			try {
				await conduitClient.wsRename(filePath, newPath);
				await fileList.refreshFolder(parentPathRename || ".");
			} catch (e) {
				Modal.notice(`Failed to rename: ${e.message}`, "Error");
			}
			break;
		case "delete":
			const confirmed = await Modal.confirm(`Are you sure you want to delete ${file.isDir ? 'folder' : 'file'} <strong>${file.name}</strong>?`, "Confirm Deletion");
			if (confirmed) {
				try {
					await conduitClient.wsDelete(filePath);
					// If this was an open tab, close it
					if (!file.isDir) {
						const openTabLeft = leftTabs.byTitle(filePath);
						if (openTabLeft) leftTabs.remove(openTabLeft);
						const openTabRight = rightTabs.byTitle(filePath);
						if (openTabRight) rightTabs.remove(openTabRight);
					}
					const parentPathDelete = filePath.substring(0, filePath.lastIndexOf('/'));
					await fileList.refreshFolder(parentPathDelete || ".");
				} catch (e) {
					Modal.notice(`Failed to delete: ${e.message}`, "Error");
				}
			}
			break;
	}
}

fileList.context = (e) => {
	let menu = folderMenu

	const fileItem = e.srcElement.closest("ui-file-item")
	if (!fileItem) return
	if (workspace.folders.includes(fileItem.item.path || fileItem.item)) {
		menu = topfolderMenu
	} else {
		if (fileItem?.item?.isDir === false) {
			menu = fileMenu
		} else {
			menu = folderMenu
		}
	}
	menu.showAt(e)
}

fileList.expand = (item) => {
	for (const tab of leftTabs.tabs) {
		fileList.active = tab.config.handle
		if (tab._changed) {
			fileList.activeItem.changed = true
		}
	}
	fileList.active = currentTabs?.activeTab?.config?.handle
}

const updateEditorUI = async (targetEditor, targetMediaView, tab) => {
	const holder = targetEditor === leftEdit ? ui.leftHolder : ui.rightHolder
	
	if (tab.config.mode.mode === "plan_tasks") {
		targetEditor.container.style.display = "none"
		targetMediaView.style.display = "none"
		if (holder.planTasksView) {
			holder.planTasksView.style.display = "block"
			renderPlanTasksView(holder.planTasksView)
		}
	} else if (tab.config.mode.mode === "media") {
		targetEditor.container.style.display = "none"
		targetMediaView.style.display = "block"
		if (holder.planTasksView) holder.planTasksView.style.display = "none"

		let data = tab.config.rawData
		if (!data) {
			const fileData = await conduitClient.wsRead(tab.config.path)
			data = fileData.data
		}
		const imageUrl = `data:image/${tab.config.path.split(".").pop()};base64,${data}`
		targetMediaView.setImage(imageUrl)
	} else {
		targetEditor.container.style.display = "block"
		targetMediaView.style.display = "none"
		if (holder.planTasksView) holder.planTasksView.style.display = "none"
		targetEditor.setSession(tab.config.session)
		targetEditor.focus()
	}
	// setCurrentEditor(targetEditor);
	fileList.active = tab.config.handle
	tab.scrollIntoViewIfNeeded()
	tab.parentElement.scrollTop = 0
	updateThemeAndMode()
	if (tab.changed && fileList.activeItem) {
		fileList.activeItem.changed = true
	}
}

leftTabs.click = async (event) => {
	const tab = event.tab
	setCurrentEditor(leftEdit)
	await updateEditorUI(leftEdit, ui.leftMedia, tab)
	// Check if the file has been modified externally and show notice
	if (tab.config.fileModified) {
		ui.showFileModifiedNotice(tab, "left")
		ui.hideAgentEditsNotice("left")
	} else {
		ui.hideFileModifiedNotice("left") // Hide if not modified
		ui.updateAgentEditsNotice(tab)
	}
}

rightTabs.click = async (event) => {
	const tab = event.tab
	setCurrentEditor(rightEdit)
	await updateEditorUI(rightEdit, ui.rightMedia, tab)
	// Check if the file has been modified externally and show notice
	if (tab.config.fileModified) {
		ui.showFileModifiedNotice(tab, "right")
		ui.hideAgentEditsNotice("right")
	} else {
		ui.hideFileModifiedNotice("right") // Hide if not modified
		ui.updateAgentEditsNotice(tab)
	}
}

const closeTab = async (targetTabs, event) => {
	const tab = event.tab
	if (tab.changed) {
		const confirmed = await window.modal.confirm(
			"This file has unsaved changes. Are you sure you want to close it?",
			"Unsaved Changes"
		)
		if (!confirmed) {
			return
		}
	}

	// If the tab is a media file, revoke the object URL
	if (tab.config.mode.mode === "media") {
		if (targetTabs === leftTabs && ui.leftMedia.style.backgroundImage) {
			const imageUrl = ui.leftMedia.style.backgroundImage.replace(/url\("|"\)/g, "")
			URL.revokeObjectURL(imageUrl)
		} else if (targetTabs === rightTabs && ui.rightMedia.style.backgroundImage) {
			const imageUrl = ui.rightMedia.style.backgroundImage.replace(/url\("|"\)/g, "")
			URL.revokeObjectURL(imageUrl)
		}
	}

	// remove from workspace recent files
	for (let i = 0; i < workspace.files.length; i++) {
		if (workspace.files[i].handle == tab.config.handle) {
			workspace.files.splice(i, 1)
			i--
		}
	}

	fileList.inactive = tab.config.handle

	unobserveFile(tab.config.handle) // Stop observing the file

	tab.tabBar.remove(tab)
	// targetTabs.remove(tab);
	tab.config.session.destroy()
	saveWorkspace()
}

leftTabs.close = (event) => {
	closeTab(leftTabs, event)
}

rightTabs.close = (event) => {
	closeTab(rightTabs, event)
}

const defaultTab = (targetTabs) => {
	if (!targetTabs) {
		targetTabs = ui.currentTabs
	}
	const defaultSession = ace.createEditSession("", "") // Already defined
	const tab = targetTabs.add({
		name: "untitled",
		mode: { mode: "" },
		session: defaultSession,
		defaultStatusIcon: "description",
	})
	setupSessionChangeListener(newSession, tab)

	// Determine which editor and media view to use based on the targetTabs
	let editorToUse = leftEdit
	let mediaViewToUse = leftMedia

	if (targetTabs === rightTabs) {
		editorToUse = rightEdit
		mediaViewToUse = rightMedia
	}

	editorToUse.setSession(defaultSession)
	execCommandEditorOptions()
	tab.click()
}

// fileActions.hook="bottom";
let restoreInProgress = false
const restoreWorkspaceContent = async () => {
	if (restoreInProgress) return
	if (!conduitClient.isConnected) {
		console.debug("restoreWorkspaceContent: WebSocket not connected, waiting...")
		return
	}
	restoreInProgress = true
	try {
		fileList.openFolders = workspace.openFolders

		// Check if split view needs to be enabled
		let enableSplitView = false
		for (const file of workspace.files) {
			if (file.side === "right") {
				enableSplitView = true
				break
			}
		}
		if (workspace.planTasksSide === "right") {
			enableSplitView = true
		}

		if (enableSplitView) {
			if (!document.body.classList.contains("showSplitView")) {
				ui.toggleSplitView() // Enable split view if needed
			}
		}

		fileOpen.text = "Add Folder to Workspace"
		await fileList.refreshAll()

		if (workspace.files.length > 0) {
			const missingFiles = []
			for (const file of workspace.files) {
				try {
					await openFileHandle(file.handle, file.path, file.side === "right" ? rightEdit : leftEdit)
					fileList.active = file.handle
				} catch (e) {
					console.warn(`Failed to open file ${file.path}: ${e.message}`)
					missingFiles.push(file.path)
				}
			}

			// Restore the open/edited status icons for all tabs
			for (const tab of leftTabs.tabs) {
				fileList.active = tab.config.handle
				if (tab.changed && fileList.activeItem) {
					fileList.activeItem.changed = true
				}
			}
			fileList.active = currentTabs?.activeTab?.config?.handle

			// Remove missing files from workspace.files
			workspace.files = workspace.files.filter((file) => !missingFiles.includes(file.path))
			saveWorkspace() // Save workspace after removing missing files
		}

		if (workspace.planTasksSide) {
			const targetEditor = workspace.planTasksSide === "right" ? rightEdit : leftEdit
			openPlanAndTaskList(targetEditor)
		}

		ui.showSidebar(1)
	} finally {
		restoreInProgress = false
	}
}

fileOpen.icon = "create_new_folder"
fileOpen.title = "Add Folder to Workspace"
fileActions.append(fileOpen)

if (workspace.folders.length > 0) {
	fileOpen.text = "Add Folder"
}

fileOpen.on("click", async () => {
	const path = await promptAddFolder()
	if (!path) return

	let addToFolders = true
	workspace.folders.forEach((handle) => {
		if (handle == path) {
			addToFolders = false
		}
	})
	if (addToFolders) workspace.folders.push(path)
	updateFileListBackground()
	saveWorkspace()
	ui.showSidebar()
})

const keyBinds = [
	{
		target: "app",
		name: "showKeyboardShortcuts",
		bindKey: { win: "ctrl-alt-k", mac: "Command-Alt-k" },
		exec: function () {
			ace.config.loadModule("ace/ext/keybinding_menu", function (module) {
				module.init(leftEdit)
				currentEditor.showKeyboardShortcuts()
			})
		},
	},
	{
		target: "app",
		name: "find",
		bindKey: { win: "Ctrl-F", mac: "Command-F" },
		exec: () => {
			window.ui.omnibox("find")
		},
	},
	{
		target: "app",
		name: "find-next",
		bindKey: { win: "F3", mac: "F3" },
		exec: () => {
			currentEditor.execCommand("findnext")
		},
	},
	{
		target: "editor",
		name: "collapselines",
		bindKey: { win: "Ctrl-Shift-J", mac: "Command-Shift-J" },
		exec: () => {
			currentEditor.execCommand("joinlines")
		},
	},
	{
		target: "app",
		name: "find-regex",
		bindKey: { win: "Ctrl-Shift-F", mac: "Command-Shift-F" },
		exec: () => {
			window.ui.omnibox("regex")
		},
	},
	{
		target: "app",
		name: "find-regex-multiline",
		bindKey: { win: "Ctrl-Shift-Alt-F", mac: "Command-Shift-Alt-F" },
		exec: () => {
			window.ui.omnibox("regex-m")
		},
	},
	{
		target: "app",
		name: "goto",
		bindKey: { win: "Ctrl-G", mac: "Command-G" },
		exec: () => {
			window.ui.omnibox("goto")
		},
	},
	{
		target: "editor",
		name: "lookup",
		bindKey: { win: "Ctrl-L", mac: "Command-L" },
		exec: () => {
			window.ui.omnibox("lookup")
		},
	},
	{
		target: "app",
		name: "showAllCommands",
		bindKey: { win: "Ctrl+Shift+P", mac: "Command+Shift+P" },
		exec: () => {
			currentEditor.execCommand("openCommandPallete")
		},
	},
	{
		target: "editor",
		name: "prettify",
		bindKey: { win: "Ctrl+Shift+I", mac: "Command+Shift+I" },
		exec: () => {
			execCommandPrettify()
		},
	},
	{
		target: "app",
		name: "next-buffer",
		bindKey: { win: "Ctrl+Tab", mac: "Ctrl+Tab" },
		exec: execCommandNextBuffer,
	},
	{
		target: "app",
		name: "prev-buffer",
		bindKey: { win: "Ctrl+Shift+Tab", mac: "Ctrl+Shift+Tab" },
		exec: execCommandPrevBuffer,
	},
	{
		target: "app",
		name: "newFile",
		bindKey: { win: "Ctrl+N", mac: "Command+N" },
		exec: execCommandNewFile,
	},
	{
		target: "app",
		name: "newWindow",
		bindKey: { win: "Ctrl+Shift+N", mac: "Command+Shift+N" },
		exec: execCommandNewWindow,
	},
	{
		target: "app",
		name: "openFile",
		bindKey: { win: "Ctrl+O", mac: "Command+O" },
		exec: execCommandOpen,
	},
	{
		target: "app",
		name: "saveFile",
		bindKey: { win: "Ctrl+S", mac: "Command+S" },
		exec: execCommandSave,
	},
	{
		target: "app",
		name: "saveFileAs",
		bindKey: { win: "Ctrl+Shift+S", mac: "Command+Shift+S" },
		exec: execCommandSaveAs,
	},
	{
		target: "app",
		name: "showEditorSettings",
		exec: () => {
			currentEditor.execCommand("showSettingsMenu", () => {
				updateThemeAndMode(true)
			})
		},
	},
	{
		target: "app",
		name: "closeFile",
		bindKey: { win: "Ctrl+W", mac: "Command+W" },
		exec: execCommandCloseActiveTab,
	},
	{
		target: "app",
		name: "toggleFolders",
		bindKey: { win: "Alt+F", mac: "Option+F" },
		exec: () => {
			execCommandToggleSidebarPanel("folder")
		},
	},
	// {
	// 	target: "app",
	// 	name: "toggleFoldersSidebar",
	// 	bindKey: { win: "Alt+Shift+S", mac: "Option+Shift+S" },
	// 	exec: execCommandToggleFolders,
	// },
	{
		target: "app",
		name: "toggleSplitView",
		bindKey: { win: "Alt+S", mac: "Option+S" },
		exec: execCommandSplitView,
	},
	{
		target: "app",
		name: "show-scratchpad",
		bindKey: { win: "Alt+N", mac: "Option+N" },
		exec: () => {
			execCommandToggleSidebarPanel("edit_note")
		},
	},
	{
		target: "app",
		name: "show-terminal",
		bindKey: { win: "Alt+T", mac: "Option+T" },
		exec: () => {
			ui.toggleDrawer()
		},
	},
	{
		target: "app",
		name: "addFolder",
		exec: execCommandAddFolder,
	},
	{
		target: "app",
		name: "refeshFolders",
		exec: execCommandRefreshFolders,
	},
	{
		target: "app",
		name: "removeAllFolders",
		exec: execCommandRemoveAllFolders,
	},
	{
		target: "app",
		name: "restoreFolders",
		exec: execCommandRestoreFolders,
	},
	{
		target: "app",
		name: "refreshOpenFiles",
		bindKey: { win: "Alt+R", mac: "Option+R" },
		exec: execCommandRefreshOpenFiles,
	},
	{
		target: "app",
		name: "showAbout",
		exec: execCommandAbout,
	},
	{
		target: "app",
		name: "setTheme",
		exec: (theme) => {
			window.editors.forEach((editor) => {
				editor.setOption("theme", theme)
			})
			updateThemeAndMode(true)
		},
	},
	{
		target: "app",
		name: "setMode",
		exec: (mode) => {
			currentEditor.setOption("mode", mode)
			updateThemeAndMode(false)
		},
	},
	{
		target: "app",
		name: "hindOmniBox",
		bindKey: { win: "escape", mac: "escape" },
		exec: () => {
			window.ui.hideOmnibox()
		},
	},
	{
		target: "app",
		name: "workspaceOpen",
		exec: async (args) => {
			await sleep(400)
			if (args === workspace.name) {
				return
			}
			openWorkspace(args, true)
		},
	},
	{
		target: "app",
		name: "workspaceRename",
		exec: async () => {
			await sleep(400)
		},
	},
	{
		target: "app",
		name: "workspaceDelete",
		exec: async () => {
			await sleep(400)
			if (workspace.name !== "default") {
				const confirmed = await window.modal.confirm(
					`Are you sure you want to permanently delete the workspace "<strong>${workspace.name}</strong>"? This action cannot be undone.`,
					"Delete Workspace"
				)
				if (confirmed) {
					// set(`workspace_${workspace.id}`console.warn("DELETE", workspace)
					console.warn("DELETE", workspace)
					await workspaceClient.deleteWorkspace(workspace.id)

					// NEW: Also delete all associated AI sessions from IndexedDB
					// Note: This assumes `workspace.aiSessionsMetadata` holds all session IDs.
					for (const sessionMeta of workspace.aiSessionsMetadata) {
						await workspaceClient.deleteSession(sessionMeta.id)
					}
					// This is where a more robust orphaned session cleanup could happen if needed for truly lost sessions.

					app.workspaces.splice(app.workspaces.indexOf(workspace.id), 1)

					// reset to default
					app.workspace = "default"
					workspace.id = "default"
					saveAppConfig()
					openWorkspace("default")
				}
			} else {
				console.warn("unsupported")
			}
		},
	},
	{
		target: "app",
		name: "workspaceNew",
		exec: async () => {
			await sleep(400)
			// ensure there are no unsaved edits
			let unsaved = false
			for (const tab of leftTabs.tabs) {
				if (tab._changed) unsaved = true
			}
			if (unsaved) {
				const confirmed = await window.modal.confirm(
					"You have unsaved changes that will be lost. Are you sure you want to create a new workspace?",
					"Unsaved Changes"
				)
				if (!confirmed) {
					return
				}
			}

			let name = await window.modal.prompt("Please enter a name for the new workspace.", "New Workspace")
			if (name) {
				const id = safeString(name)
				if (app.workspaces.indexOf(id) !== -1) {
					window.modal.notice(
						`A workspace with the name "<strong>${name}</strong>" already exists. Please choose a different name.`,
						"Workspace Exists"
					)
					return
				}
				app.workspaces.push(id)
				app.workspace = id

				workspace.name = name
				workspace.id = id
				workspace.folders = []
				workspace.files = []
				workspace.ignorePaths = [".git", "node_modules", "dist", "build"]
				workspace.openFolders = []
				// NEW: Initialize empty AI session metadata for new workspace
				updateFileListBackground()
				workspace.aiSessionsMetadata = []
				workspace.activeAiSessionId = null

				if (ui.aiManager) {
					ui.aiManager.loadSessions(workspace.aiSessionsMetadata, workspace.activeAiSessionId)
				}

				// clear the leftTabs
				while (leftTabs.tabs.length > 1) {
					leftTabs.tabs[0].close.click()
				}
				if (leftTabs.tabs[0]) leftTabs.tabs[0].close.click()

				// refresh the folder list
				await fileList.refreshAll()
				ui.showSidebar()
				
				// update the workspace menu
				// update the app config object
				saveAppConfig()
				saveWorkspace()

				updateWorkspaceSelectors()
			}
		},
	},
	{
		target: "app",
		name: "setDarkMode",
		exec: (mode) => {
			execCommandSetDarkMode(mode)
		},
	},
	{
		target: "app",
		name: "show-ai",
		bindKey: { win: "Alt+A", mac: "Option+A" },
		exec: () => {
			execCommandToggleSidebarPanel("developer_board")
		},
	},
]

keyBinds.forEach((bind) => {
	window.ui.commands.add(bind)
})

window.ui.execCommand = (c, args) => {
	let target = "editor",
		command = c,
		ext = ""
	if (c.indexOf(":") > -1) {
		let bits = c.split(":")
		;(target = bits[0]), (command = bits[1])
		if (bits.length > 2) {
			ext = bits[2]
		}
	}
	if (target == "editor") {
		currentEditor.focus()
		currentEditor.execCommand(command, ext)
	} else if (target == "editor-ex") {
		currentEditor.execCommand(command, ext)
	} else {
		window.ui.commands.exec(command, ext)
		// leftEdit.execCommand(command, ext)
	}
}

window.addEventListener("beforeinstallprompt", (e) => {
	let deferredPrompt = e
	const showInstallPromotion = () => {
		if (sessionStorage.getItem("install_defer") || localStorage.getItem("install_deny")) return
		ui.installer.later.on("click", () => {
			// make sure we don't ask again before next visit
			sessionStorage.setItem("install_defer", true)
			ui.installer.offscreen()
		})

		ui.installer.confirm.on("click", () => {
			// make sure we don't ask again before next visit
			sessionStorage.setItem("install_defer", true)
			deferredPrompt.prompt()
			ui.installer.offscreen()
		})

		ui.installer.deny.on("click", () => {
			// make sure we don't ask again, period
			localStorage.setItem("install_deny", true)
			ui.installer.offscreen()
		})

		ui.installer.onscreen()
	}
	// Prevent the mini-infobar from appearing on mobile
	e.preventDefault()
	// Stash the event so it can be triggered later.
	// Update UI notify the user they can install the PWA
	if (sessionStorage.getItem("notSupported")) return
	showInstallPromotion()
	// Optionally, send analytics event that PWA install promo was shown.
})

setTimeout(async () => {
	ui.leftHolder.editorElement.classList.remove("loading")
	ui.rightHolder.editorElement.classList.remove("loading")

	window.filesReceiver.addEventListener("message", (e) => {
		if (e.data?.open && window.activeFileReceiver) {
			window.filesReceiver.postMessage("fileAccepted")
			openFileHandle(e.data.open)
		}
	})

	leftEdit.on("focus", () => setCurrentEditor(leftEdit))
	rightEdit.on("focus", () => setCurrentEditor(rightEdit))

	ui.iconTabBar.on("tabs-updated", (e) => {
		saveWorkspace()
		if (e.detail?.tab?._iconId == "developer_board") {
			ui.aiManager.focus()
		}
		if (e.detail?.tab?._iconId == "terminal") {
			window.terminalManager.connect() // call intial connect
			if (ui.isDrawerOpen()) window.terminalManager.fit() // Fit active terminal when its tab is focused
		}
	})

	fileList.on("settings-changed", (event) => {
		if (event.detail.ignorePaths) {
			workspace.ignorePaths = event.detail.ignorePaths
			saveWorkspace()
		}
	})
	// REMOVED: ui.aiManager.panel.addEventListener('new-prompt', (event) => { /* ... */ });
	// This is now handled within ai-manager for activeSession.promptHistory

	ui.aiManager.panel.addEventListener("context-update", async (event) => {
		const { aiSessionsMetadata, activeSessionData, type } = event.detail

		// 1. Update workspace metadata (lightweight save)
		if (aiSessionsMetadata) {
			workspace.aiSessionsMetadata = aiSessionsMetadata.sessions
			workspace.activeAiSessionId = aiSessionsMetadata.activeSessionId
			// Debounce workspace saves, as they can happen on session switch, rename, delete
			clearTimeout(ui.aiManager.saveWorkspaceTimeout)
			ui.aiManager.saveWorkspaceTimeout = setTimeout(saveWorkspace, 1000)
		}

		// 2. Save the full active session data to IndexedDB (on demand)
		// This happens on message append, delete, summarization, or session switch
		if (activeSessionData && activeSessionData.id) {
			await workspaceClient.setSession(activeSessionData.id, activeSessionData)
			console.debug(`AI session "${activeSessionData.name}" (${activeSessionData.id}) saved to backend.`)
		}
	})

	window.addEventListener("setting-changed", (event) => {
		const { settingsName, settings, useWorkspaceSettings } = event.detail
		const providerName = settingsName.replace("Config", "") // e.g., 'ollama' or 'gemini'

		if (useWorkspaceSettings) {
			workspace.aiConfig[providerName] = { ...settings }
			if (app.aiConfig && app.aiConfig[providerName]) delete app.aiConfig[providerName] // Clear global settings for this provider if using workspace specific
			saveWorkspace()
		} else {
			app.aiConfig[providerName] = { ...settings }
			if (workspace.aiConfig && workspace.aiConfig[providerName]) delete workspace.aiConfig[providerName] // Clear workspace settings for this provider if using global
			saveAppConfig()
		}
	})
	ui.sidebar.resizeListener(() => {
		clearTimeout(ui.sidebar.saveTimeout)
		ui.sidebar.saveTimeout = setTimeout(saveWorkspace, 500)
	})

	leftEdit.on("ready", async () => {
		// preload stored file and folder handles
		let stored;
		try {
			stored = await workspaceClient.getAppConfig();
		} catch (e) {
			console.warn("Failed to load app config", e);
		}

		app.darkmode = stored?.darkmode || "system"
		app.sessionOptions = stored?.sessionOptions || null
		app.rendererOptions = stored?.rendererOptions || null
		app.enableLiveAutocompletion = stored?.enableLiveAutocompletion || null

		app.systemPromptConfig = stored?.systemPromptConfig || {} // NEW
		// Apply any stored editor settings immediately after loading them.
		execCommandEditorOptions()

		app.workspace = stored?.workspace || "default"
		app.workspaces = stored?.workspaces || [app.workspace]
		app.aiConfig = stored?.aiConfig || {}

		if (app.workspace) {
			openWorkspace(app.workspace)
		} else {
			updateWorkspaceSelectors()
		}

		execCommandSetDarkMode(app.darkmode)

		saveAppConfig()

		// Automatically restore workspace content once connected
		conduitClient.on("connect", () => {
			if (workspace.folders.length > 0 || workspace.files.length > 0) {
				restoreWorkspaceContent()
			}
		})

		// After appConfig is loaded and aiManager is initialized, apply global AI settings
		const currentProvider = ui.aiManager.aiProvider
		if (app.aiConfig[currentProvider]) {
			ui.aiManager.ai.setOptions(app.aiConfig[currentProvider], null, null, false, "global")
		} else {
			// If no specific config for the current provider, reset to default for that provider
			ui.aiManager.ai.setOptions({}, null, null, false, "global")
		}

		// set supported files in our FileList control
		let regs = []
		for (let n in ace_modes) {
			const mode = ace_modes[n]
			regs.push(mode.extRe)
		}
		ui.fileList.supported = regs

		let all = []

		Promise.all(all).then(() => {
			ui.showSidebar()
		})

		if (workspace.folders.length > 0) {
			ui.showSidebar()
		}
		ui.toggleSidebar()
		ui.currentTabs = ui.leftTabs

		//defaultTab()
		ui.fileList.open = openFileHandle
		fileList.unsupported = openFileHandle
		leftTabs.dropFileHandle = (handle, knownPath) => openFileHandle(handle, knownPath, leftEdit)
		rightTabs.dropFileHandle = (handle, knownPath) => openFileHandle(handle, knownPath, rightEdit)
		leftTabs.defaultTab = () => defaultTab(leftTabs)
		rightTabs.defaultTab = () => {
			console.debug("rightTabs.defaultTab: Creating default tab for right tab bar.")
			return defaultTab(rightTabs)
		}

		const scratchpad = ui.scratchEditor
		scratchpad.on("change", () => {
			workspace.scratchpad = scratchpad.getValue()
			// Debounced save
			clearTimeout(scratchpad.saveTimeout)
			scratchpad.saveTimeout = setTimeout(saveWorkspace, 500)
		})

		leftTabs.onEmpty = () => {
			leftEdit.setSession(ace.createEditSession(""))
			leftEdit.container.style.display = "none"
			leftMedia.style.display = "none"
			window.ui.hideFileModifiedNotice("left") // Hide notice bar when empty
			window.ui.hideAgentEditsNotice("left")
		}

		rightTabs.onEmpty = () => {
			rightEdit.setSession(ace.createEditSession(""))
			rightEdit.container.style.display = "none"
			rightMedia.style.display = "none"
			window.ui.hideFileModifiedNotice("right") // Hide notice bar when empty
			window.ui.hideAgentEditsNotice("right")
			ui.toggleSplitView({ targetState: "closed" })
		}

		if ("launchQueue" in window) {
			launchQueue.setConsumer((params) => {
				if (params.files.length > 0) {
					for (const fileHandle of params.files) {
						openFileHandle(fileHandle)
					}
				}
			})
		}

		// Listen for custom event to insert code snippets from AI panel
		window.addEventListener("insert-snippet", (event) => {
			if (currentEditor) {
				currentEditor.insert(event.detail)
				currentEditor.focus()
			}
		})
	})
})
