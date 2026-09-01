import { FileList, Panel, Inline, Block, Button, TabBar, MediaView, Input, MenuItem, ActionBar, EditorHolder, IconTabBar, IconTab, SidebarPanel, extractFilenameAtColumn, findFileMatchesInIndex } from './elements.mjs';
import { getIconForFileName } from './elements/utils.mjs';
import TerminalManager from './terminal-manager.mjs'; // Import the new TerminalManager
import conduitClient from './conduit-client.mjs';
import { ConduitFileList } from './elements/conduit-filelist.mjs';
import aiManager from './ai-manager.mjs';
import ollama from './ai-ollama.mjs';
import agentTools from './agent/agent-tools.mjs';

const defaultSettings = {
	showGutter: true, //set to true to hide the line numbering
	highlightGutterLine: true,
	printMargin: false,
	displayIndentGuides: true,
	showInvisibles: false, //show whitespace characters (spaces, tabs, returns)
	scrollPastEnd: 1, //allow the leftEditto scroll past the end of the document
	useSoftTabs: false,
	tabSize: 4,
	newLineMode: "auto",
	enableBasicAutocompletion: true,
	fontSize: 12,
	fontFamily: "roboto mono",
}

// these become the actual editor elements
var mainContent
var leftEdit, leftHolder, leftTabs
var rightEdit, rightHolder, rightTabs


var menu
var omni, modal, installer, conduitFileList
var sidebar, fileActions, fileList
var drawer, statusbar, statusTheme, statusMode, statusWorkspace
var themeMenu, modeMenu, workspaceMenu
var darkmodeMenu, darkmodeSelect
var openDir, themeModeToggle, toggleSplitViewBtn, scratchEditor, iconTabBar;
var fileListBackground
var currentEditor, currentTabs, currentMediaView
var drawerLastHeight = window.innerHeight * 0.3;
var currentSearchQuery = ""
var currentSearchMatches = []
var grepPending = false
var grepNextQuery = null
var lastReceivedRequestId = 0
var activeSearchRequestId = 0

// Sidebar search panel variables
var sidebarActiveSearchRequestId = 0
var sidebarLastReceivedRequestId = 0
var sidebarSearchMatches = []
var sidebarSearchQuery = ""
var sidebarAllowMoreThan20 = false
var sidebarIdleRenderTimeout = null
var sidebarGrepPending = false
var sidebarGrepNextQuery = null
var sidebarRenderTimeout = null
var searchPanel, searchTab, searchInput, searchResultsContainer

const focusSearchInput = (delay = 50) => {
	if (searchInput) {
		setTimeout(() => {
			searchInput.focus()
			searchInput.select()
		}, delay)
	}
}

const toggleBodyClass = (className) => {
	if (document.body.classList.contains(className)) {
		document.body.classList.remove(className)
		return false
	} else {
		document.body.classList.add(className)
		return true
	}
}
var animRate = 250, constrainHolders, constrainHoldersTimeout, debounceConstrainHolders
var saveSidepanelWidth

let isResizingSidebar = false; // Flag to hide panel content during manual resize to prevent jank
const uiManager = {
	_isDrawerTransitioningToClosed: false,

	isDrawerOpen: () => {
		return drawer && drawer.offsetHeight > 40 && !uiManager._isDrawerTransitioningToClosed;
	},

	toggleDrawer: (forceState) => {
		const isOpen = uiManager.isDrawerOpen();
		const targetState = forceState !== undefined ? forceState : !isOpen;

		if (targetState) {
			// Opening
			uiManager._isDrawerTransitioningToClosed = false;
			drawer.style.height = drawerLastHeight + "px";
			const drawerToggle = document.querySelector("#drawerToggle");
			if (drawerToggle) drawerToggle.icon = "expand_more";
			
			if (window.terminalManager) {
				window.terminalManager.connect();
			}
		} else {
			// Closing
			uiManager._isDrawerTransitioningToClosed = true;
			if (isOpen) {
				drawerLastHeight = drawer.offsetHeight - 4; // Subtract border/handle visual
			}
			drawer.style.height = "34px";
			const drawerToggle = document.querySelector("#drawerToggle");
			if (drawerToggle) drawerToggle.icon = "expand_less";
		}
		
		if (typeof debounceConstrainHolders === "function") {
			// debounceConstrainHolders();
			drawer.removeEventListener("transitionend", debounceConstrainHolders);
			drawer.addEventListener("transitionend", debounceConstrainHolders, { once: true });
		}
	},

	create: (options = {}) => {

		document.documentElement.style.setProperty('--animRate', `${animRate}ms`);

		const defaults = {
			theme: "ace/theme/code",
			mode: "ace/mode/javascript",
			keyboard: "ace/keyboard/sublime",
		}

		window.addEventListener("resize", () => {
			debounceConstrainHolders()
		})
		
		debounceConstrainHolders = () => {
			clearTimeout(constrainHoldersTimeout);
			constrainHoldersTimeout = setTimeout(constrainHolders, 100);
		}
			// const vh = window.innerHeight;
			// const minH = vh * 0.2;
			// const maxH = vh * 0.8;
			// let currentH = drawer.offsetHeight;

			// if (currentH < minH) {
			// 	drawer.style.height = minH + "px";
			// } else if (currentH > maxH) {
			// 	drawer.style.height = maxH + "px";
			// }
			// mainContent.style.bottom = drawer.offsetHeight + "px";


		const getDrawerConstraints = () => {
			const vh = window.innerHeight;
			return { min: 34, max: vh * 0.8, default: 34 };
		};

		const constrainDrawer = ()=>{

			const constraints = getDrawerConstraints();
			drawer.minSize = constraints.min;
			drawer.maxSize = constraints.max;
			
			if(drawer.offsetHeight < constraints.default) {
				drawer.style.height = constraints.default + "px";
			}

			if (document.body.classList.contains("showSidebar")) {
				drawer.style.left = (sidebar.offsetLeft + sidebar.offsetWidth) + "px";
				drawer.style.width = `calc(100% - ${sidebar.offsetWidth}px)`;
			} else {
				drawer.style.left = "0px";
				drawer.style.width = "100%";
			}
			
			if(uiManager.isDrawerOpen()) {
				// Handle Height Snap-back
				const vh = window.innerHeight;
				const minH = vh * 0.2;
				const maxH = vh * 0.9;
				let currentH = drawer.offsetHeight;
	
				if (currentH < minH) {
					drawer.style.height = minH + "px";
				} else if (currentH > maxH) {
					drawer.style.height = maxH + "px";
				}
			}
			
			
			// Handle Width sync
			const sidebarWidth = document.body.classList.contains("showSidebar") ? sidebar.offsetWidth : 0;
			drawer.style.width = `calc(100% - ${sidebarWidth}px)`;
			drawer.style.left = `${sidebarWidth}px`;

			setTimeout(()=>{
				mainContent.style.bottom = drawer.offsetHeight + "px";
			})
		}
		constrainHolders = () => {
			void sidebar.offsetWidth
			const minWidth = 350
			const maxWidth = window.innerWidth - 300; // 50% of window width


			sidebar.removeEventListener("transitionend", constrainDrawer)
			sidebar.addEventListener("transitionend", constrainDrawer, { once: true })
		
			if (document.body.classList.contains("showSidebar")) {
				if (sidebar.offsetWidth > maxWidth) {
					sidebarWidth = maxWidth;
					sidebar.style.width = maxWidth + "px"
					mainContent.style.left = maxWidth + "px";
				} else if (sidebar.offsetWidth < minWidth) {
					sidebarWidth = minWidth;
					sidebar.style.width = minWidth + "px"
					mainContent.style.left = minWidth + "px";
				} else {
					sidebarWidth = sidebar.offsetWidth;
				}
		
				drawer.style.left = (sidebar.offsetLeft + sidebarWidth) + "px";
				drawer.style.width = `calc(100% - ${sidebarWidth}px)`;
			}
			
			mainContent.style.bottom = drawer.offsetHeight + "px"
			saveSidepanelWidth()
			if (window.terminalManager && uiManager.isDrawerOpen()) {
				setTimeout(() => {
					if (uiManager.isDrawerOpen()) window.terminalManager.fit();
				}, 100);
				// Ensure fit after sidebar transition
				sidebar.removeEventListener("transitionend", uiManager._sidebarFitTerminalAfterTransition); // Prevent duplicate listeners
				uiManager._sidebarFitTerminalAfterTransition = () => {
					if (uiManager.isDrawerOpen()) {
						setTimeout(() => {
							if (uiManager.isDrawerOpen()) window.terminalManager.fit();
						}, 100);
					}
				};
				sidebar.addEventListener("transitionend", uiManager._sidebarFitTerminalAfterTransition, { once: true });
			}

			if (!document.body.classList.contains("showSplitView")) {

			} else {
				const w = mainContent.offsetWidth
				let l = leftHolder.offsetWidth / w
				let r = rightHolder.offsetWidth / w
				l = Math.max(0.25, Math.min(0.75, l))
				r = 1 - l
				leftHolder.style.width = ((l) * 100) + "%"
				rightHolder.style.width = ((r) * 100) + "%"
			}

			setTimeout(() => {
				window.editors.forEach(e=>{
					e.resize()
				})
			}, animRate)
		}

		options = { ...defaults, ...options }

		mainContent = document.querySelector("#mainContent")

		fileActions = new Block()
		fileActions.setAttribute("id", "fileActions")
		fileActions.setAttribute("slim", "true")

		const fileSettingsBtn = new Button();
		fileSettingsBtn.icon = "settings";
		fileSettingsBtn.setAttribute("title", "File list settings");
		fileSettingsBtn.setAttribute("hook", "right");
		fileSettingsBtn.on('click', () => {
			uiManager.fileList.toggleSettingsPanel();
		});
		fileActions.append(fileSettingsBtn);

		fileList = new FileList();
		uiManager.fileList = fileList;

		iconTabBar = new IconTabBar();

		const filesTab = new IconTab('folder');
		searchTab = new IconTab('find_in_page');
		const conduitTab = new IconTab('public');
		const aiTab = new IconTab('developer_board');
		const scratchTab = new IconTab('edit_note');
		iconTabBar.addTab(filesTab);
		iconTabBar.addTab(searchTab);
		// iconTabBar.addTab(conduitTab);
		iconTabBar.addTab(aiTab);
		iconTabBar.addTab(scratchTab);

		const filesPanel = new SidebarPanel();
		filesPanel.append(fileActions); 
		filesPanel.append(fileList); 
		fileListBackground = document.createElement("div");
		fileListBackground.classList.add("file-list-background-element");
		fileListBackground.innerHTML = `<ui-icon icon="folder_open" style="font-size: 48px; opacity: 0.5;"></ui-icon><div class="caption">No folders in workspace<br/>Add a folder to begin.</div>`;
		filesPanel.append(fileListBackground);

		// Initialize Search Panel
		searchPanel = new SidebarPanel();
		searchPanel.setAttribute("id", "search-panel");

		const searchTopWrapper = new Block();
		searchTopWrapper.addClass("search-top-wrapper");

		const searchHeader = new Block();
		searchHeader.addClass("search-header");
		searchHeader.innerHTML = "<h3>Search in Files</h3>";

		searchInput = new Input();
		searchInput.placeholder = "Search...";

		searchTopWrapper.append(searchHeader);
		searchTopWrapper.append(searchInput);

		searchResultsContainer = new Block();
		searchResultsContainer.setAttribute("id", "search-panel-results");

		searchPanel.append(searchTopWrapper);
		searchPanel.append(searchResultsContainer);

		// The AI Panel creation is delegated to aiManager.init(aiManagerPanel)
		// Ensure aiManagerPanel exists for aiManager to append its UI
		// aiManager.panel is set here for the first time
		const aiManagerPanel = new SidebarPanel();
		aiManager.init(aiManagerPanel)
		// as we need global app/workspace config loaded before aiManager fully initializes.
		// So this append happens here, but init() is external.

		const scratchPanel = new SidebarPanel();
		const scratchEditorElement = new Block();
		scratchEditorElement.setAttribute("id", "scratchpad-editor");
		scratchEditorElement.style.height = "100%";
		scratchPanel.append(scratchEditorElement);

		const terminalPanel = new SidebarPanel(); // Create a SidebarPanel to host the terminal
		terminalPanel.setAttribute("id", "terminal-panel");
		terminalPanel.style.top = "0"; // Leave 8px for the drawer resize handle
		terminalPanel.style.bottom = "34px"; // Leave 34px for the bottom action bar overlap
		terminalPanel.style.paddingBottom="34px"
		terminalPanel.active = true;

		window.terminalManager = TerminalManager; // Create the manager instance
		window.terminalManager.init(terminalPanel); // Initialize the manager with its panel
		window.terminalManager._checkConduitStatus()

		const sidebarPanelsContainer = new Block();
		sidebarPanelsContainer.setAttribute("id", "sidebar-panels-container");
		sidebarPanelsContainer.append(filesPanel);
		sidebarPanelsContainer.append(searchPanel);
		sidebarPanelsContainer.append(aiManagerPanel);
		sidebarPanelsContainer.append(scratchPanel);

		sidebar = new Panel()
		sidebar.setAttribute("id", "sidebar")
		sidebar.append(iconTabBar);
		sidebar.append(sidebarPanelsContainer);
		sidebar.minSize = 240
		sidebar.maxSize = 2440


		let currentTab
		saveSidepanelWidth = () => {
			const activeTabId = iconTabBar.activeTab?.iconId;
			if (activeTabId && window.workspace) {
				window.workspace.sidebarPanelWidths = window.workspace.sidebarPanelWidths || {};
				window.workspace.sidebarPanelWidths[activeTabId] = sidebar.offsetWidth;
				if (window.saveWorkspace) {
					window.saveWorkspace();
				}
			}
		}


		iconTabBar.on('tabs-updated', ({ detail }) => {
			const tab = detail.tab;
			const panels = sidebar.querySelectorAll('ui-sidebar-panel');

			let nextActivePanel;
			if (tab === filesTab) {
				nextActivePanel = filesPanel;
			} else if (tab === searchTab) {
				nextActivePanel = searchPanel;
			} else if (tab === conduitTab) {
				nextActivePanel = conduitPanel;
			} else if (tab === aiTab) {
				nextActivePanel = aiManagerPanel;
			} else if (tab === scratchTab) {
				nextActivePanel = scratchPanel
			}

			const currentlyVisiblePanel = sidebar.querySelector('ui-sidebar-panel[active]');
			const isSwitchingPanel = currentlyVisiblePanel !== nextActivePanel;
			if (isSwitchingPanel) {
				panels.forEach(panel => panel.active = false); // Hide all panels only if truly switching
			}
			const tabId = tab.iconId;
			const newWidth = window.workspace?.sidebarPanelWidths?.[tabId];
			if (newWidth && sidebar.offsetWidth !== newWidth) {
				// Animate the resize and reveal the panel content after the animation completes
				sidebar.style.transition = "width var(--animRate) ease-in-out";
				mainContent.style.transition = "left var(--animRate) ease-in-out";
				sidebar.style.width = `${newWidth}px`;
				mainContent.style.left = `${newWidth}px`;
				setTimeout(() => {
					sidebar.style.transition = "";
					mainContent.style.transition = "";
					if (nextActivePanel) nextActivePanel.active = true; // Reveal the correct panel after animation
					debounceConstrainHolders(); // Re-constrain holders after sidebar resize
					saveSidepanelWidth()
					if (nextActivePanel === searchPanel) {
						focusSearchInput(50)
					}
				}, animRate);
			} else {
				// No animation needed, or it's the same width, just ensure the correct panel is active
				if (nextActivePanel) nextActivePanel.active = true;
				// If no animation, ensure current width is stored and saved
				saveSidepanelWidth()
				if (nextActivePanel === searchPanel) {
					focusSearchInput(50)
				}
			}
		});

		iconTabBar.activeTab = filesTab;
		sidebar.resizable = "right"
		sidebar.minSize = 40
		let sidebarWidth = 350

		menu = document.querySelector("#menu")
		if (menu == null) {
			menu = new ActionBar()
			menu.setAttribute("id", "menu")
			menu.addClass("slim")
			menu.append(new Inline('<img src="images/code-192.png"/> Cadence'))
		}

		openDir = new Button()
		openDir.icon = "menu_open"
		openDir.setAttribute("title", "hide file list")

		openDir.on("click", () => {
			if (toggleBodyClass("showSidebar")) {
				openDir.icon = "menu_open"
				openDir.setAttribute("title", "hide sidebar")
				mainContent.style.left = uiManager.sidebar.offsetWidth + "px"
				if (iconTabBar.activeTab === searchTab) {
					focusSearchInput(300)
				}
			} else {
				openDir.icon = "menu"
				openDir.setAttribute("title", "show sidebar")
				mainContent.style.left = ""
			}
			setTimeout(() => {
				debounceConstrainHolders()
			}, animRate)
		})

		toggleSplitViewBtn = new Button()
		toggleSplitViewBtn.icon = "vertical_split"
		toggleSplitViewBtn.setAttribute("title", "Toggle split view")
		toggleSplitViewBtn.setAttribute("id", "toggleSplitView")
		toggleSplitViewBtn.on("click", () => {
			uiManager.toggleSplitView()
		})

		leftTabs = new TabBar()
		leftTabs.type = "tabs"
		leftTabs.setAttribute("id", "leftTabs")
		leftTabs.setAttribute("slim", "true")
		leftTabs.splitViewDragEnabled = true;

		leftTabs.append(openDir)
		leftTabs.append(toggleSplitViewBtn)

		rightTabs = new TabBar()
		rightTabs.type = "tabs"
		rightTabs.setAttribute("id", "rightTabs")
		rightTabs.setAttribute("slim", "true")


		statusbar = document.querySelector("#statusbar")
		if (statusbar == null) {
			statusbar = new ActionBar()
			statusbar.setAttribute("id", "statusbar")
			statusbar.setAttribute("slim", "true")
			statusbar.hook = "top"
		}

		toggleSplitViewBtn.setAttribute("hook", "right")

		statusTheme = document.querySelector("#theme_select")
		statusMode = document.querySelector("#mode_select")

		themeMenu = document.querySelector("#theme_menu")
		modeMenu = document.querySelector("#mode_menu")

		// Query darkmode elements directly within the function
		darkmodeSelect = document.querySelector("#darkmode_select");
		darkmodeMenu = document.querySelector("#darkmode_menu");

		themeMenu.on("show", (e) => {
			e.stopPropagation()
			setTimeout(() => {
				const active = themeMenu.querySelector("[icon='done']")
				themeMenu.scrollTop = active.offsetTop - themeMenu.offsetHeight / 2 + 12
			})
		}, true)

		modeMenu.on("show", (e) => {
			e.stopPropagation()
			setTimeout(() => {
				const active = modeMenu.querySelector("[icon='done']")
				modeMenu.scrollTop = active.offsetTop - modeMenu.offsetHeight / 2 + 12
			})
		}, true)

		leftHolder = new EditorHolder()
		leftHolder.setAttribute("id", "leftHolder")
		leftHolder.classList.add("current")
		leftHolder.mediaView.id = "leftMedia"

		rightHolder = new EditorHolder()
		rightHolder.mediaView.id = "rightMedia"

		window.rightHolder = rightHolder

		rightHolder.setAttribute("id", "rightHolder")
		// rightHolder.querySelector(".notice-bar").setAttribute("id", "rightFileModifiedNotice")
		rightHolder.style.width = "0px"
		rightHolder.style.right = "0px"
		rightHolder.resizable = "left"
		rightHolder.minSize = 0
		rightHolder.maxSize = 2440


		leftTabs.exclusiveDropType = "editor-tab"
		rightTabs.exclusiveDropType = "editor-tab"
		leftHolder.exclusiveDropType = "editor-tab"
		rightHolder.exclusiveDropType = "editor-tab"


		sidebar.resizeListener((width) => {
			const maxWidth = window.innerWidth * 0.8; // 50% of window width
			// sidebar.style.transition = "none";
			sidebarWidth = Math.min(width, maxWidth); // Constrain width
			mainContent.style.transition = "none";
			drawer.style.transition = "none";
			
			mainContent.style.left = sidebarWidth + "px";
			drawer.style.left = (sidebar.offsetLeft + sidebarWidth) + "px";
		});

		sidebar.resizeEndListener(() => {
			if (isResizingSidebar && sidebarPanelsContainer) {
				isResizingSidebar = false;
				sidebarPanelsContainer.style.visibility = 'hidden';
			}
			sidebar.style.transition = ""
			mainContent.style.transition = ""
			drawer.style.transition = ""

			debounceConstrainHolders()

			sidebar.on("transitionend", () => {
				console.debug("save sidepanel resize event")
				saveSidepanelWidth()
				if (document.body.classList.contains("showSidebar")) {
					drawer.style.left = (sidebar.offsetLeft + sidebarWidth) + "px";
					drawer.style.width = `calc(100% - ${sidebarWidth}px)`;
				} else {
					drawer.style.left = "0px";
					drawer.style.width = "100%";
				}
				// sidebarPanelsContainer.style.visibility = 'hidden';
			}, { once: true })
		})

		rightHolder.resizeListener((width) => {
			const w = mainContent.offsetWidth
			const l = w - width
			const r = width
			leftHolder.style.transition = "none";
			leftHolder.style.width = l + "px"
		})
		rightHolder.resizeEndListener(() => {
			leftHolder.style.transition = ""
			debounceConstrainHolders()
		})

		drawer = new Panel()
		drawer.setAttribute("id", "drawer")
		drawer.resizable = "top"
		const initialConstraints = getDrawerConstraints();
		drawer.minSize = initialConstraints.min;
		drawer.maxSize = initialConstraints.max;

		const drawerToggle = new Button();
		drawerToggle.icon = "expand_more";
		drawerToggle.setAttribute("id", "drawerToggle");
		drawerToggle.on("click", () => {
			uiManager.toggleDrawer();
		});
		drawer.prepend(drawerToggle);
		drawer.append(terminalPanel)

		drawer.resizeListener((height) => {
			mainContent.style.transition = "none"
			drawer.style.transition = "none"
			mainContent.style.bottom = height + "px"
		})

		drawer.resizeEndListener((height) => {
			mainContent.style.bottom = height + "px"
			mainContent.style.transition = ""
			drawer.style.transition = ""
			debounceConstrainHolders()
		})

		window.addEventListener('resize', () => {
			const newConstraints = getDrawerConstraints();
			drawer.minSize = newConstraints.min;
			drawer.maxSize = newConstraints.max;
		});

		// Sync drawer width when sidebar resizes
		sidebar.resizeListener((width) => {
			const sidebarWidth = width;
			drawer.style.width = `calc(100% - ${sidebarWidth}px)`;
			drawer.style.left = `${sidebarWidth}px`;
			mainContent.style.left = `${sidebarWidth}px`;
		});


		installer = new Panel()
		installer.setAttribute("type", "modal")
		document.body.append(installer)
		installer.classList.add("slideUp")
		installer.style.cssText = `left:auto; top:auto; right:32px; bottom:64px; width:auto; height:105px; text-align:center;`
		installer.innerHTML = `<p><img src="images/code-192.png" height='32px' style="vertical-align:middle; margin-top:-4px;">&nbsp;&nbsp;<b>Add 'Cadence' as an app?</b></p>`

		installer.confirm = new Button("Yes please!")
		installer.confirm.classList.add("themed")
		installer.confirm.icon = "done"

		installer.later = new Button("Later")
		installer.later.classList.add("themed")
		installer.later.icon = "watch_later"

		installer.deny = new Button("No thanks")
		installer.deny.classList.add("cancel")
		// installer.deny.icon = "close"

		installer.onscreen = () => {
			installer.show()
			setTimeout(() => {
				installer.setAttribute("active", "active")
			}, 1)
		}

		installer.offscreen = () => {
			installer.removeAttribute("active")
			setTimeout(() => {
				installer.hide()
			}, 333)
		}

		installer.clear = new Button("")
		installer.clear.icon = "close"
		installer.clear.style.cssText = `
        position:absolute;
        right:0px;
        top:0px;
        text-indent: -1px;
        width:32px;
        height:28px;
        min-height:34px;
        border-radius: 16px;
        `
		installer.clear.on("click", () => {
			installer.offscreen()
		})

		installer.prepend(installer.clear)
		installer.append(installer.deny, installer.later, installer.confirm)

		installer.hide()
		document.body.append(drawer)

		omni = new Panel()
		omni.results = new Panel()
		omni.results.classList.add("results")
		omni.results.next = (step = 1) => {
			omni.resultItemIndex += step
			if (step == 1) {
				if (omni.resultItemIndex >= omni.results.children.length) {
					omni.resultItemIndex = 0
				}
			} else {
				if (omni.resultItemIndex >= omni.results.children.length) {
					omni.resultItemIndex = omni.results.children.length - 1
				}
			}
			for (let node of omni.results.children) {
				node.classList.remove("active")
			}
			omni.results.children[omni.resultItemIndex].classList.add("active")
			omni.results.children[omni.resultItemIndex].scrollIntoViewIfNeeded()
		}
		omni.results.prev = (step = 1) => {
			omni.resultItemIndex -= step
			if (step == 1) {
				if (omni.resultItemIndex < 0) {
					omni.resultItemIndex = omni.results.children.length - 1
				}
			} else {
				if (omni.resultItemIndex < 0) {
					omni.resultItemIndex = 0
				}
			}
			for (let node of omni.results.children) {
				node.classList.remove("active")
			}
			omni.results.children[omni.resultItemIndex].classList.add("active")
			omni.results.children[omni.resultItemIndex].scrollIntoViewIfNeeded()
		}

		omni.appendChild(omni.results)

		currentSearchQuery = ""
		currentSearchMatches = []
		grepPending = false
		grepNextQuery = null
		lastReceivedRequestId = 0
		activeSearchRequestId = 0

		const renderGrepResults = () => {
			if (omni.last !== "grep") return
			const query = omni.input.value.slice(1)
			
			let matches = [...currentSearchMatches]

			// Relevance scoring: filename matches (exact word > substring) > text matches (exact word > substring)
			const getRelevanceScore = (item, q) => {
				const filePath = item[0]
				const snippet = item[2]
				const fileName = filePath.split("/").pop()
				
				const escapedQuery = q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
				const wordRegex = new RegExp('\\b' + escapedQuery + '\\b', 'i')
				
				// 1. Filename exact word match
				if (wordRegex.test(fileName)) return 0
				
				// 2. Filename substring match
				if (fileName.toLowerCase().includes(q.toLowerCase())) return 1
				
				// 3. Snippet/text exact word match
				if (wordRegex.test(snippet)) return 2
				
				// 4. Snippet/text substring match
				if (snippet.toLowerCase().includes(q.toLowerCase())) return 3
				
				return 4
			}

			matches.sort((a, b) => getRelevanceScore(a, query) - getRelevanceScore(b, query))

			// Limit results to the first 20 matches
			if (matches.length > 20) {
				matches = matches.slice(0, 20)
			}

			omni.results.empty()
			omni.results.scrollTop = 0
			if (matches.length === 0) {
				omni.resultItem = null
				omni.results.hide()
				return
			}

			omni.results.show()
			omni.resultItem = matches[0]

			let counter = 0
			for (let item of matches) {
				const [filePath, lineNum, snippet] = item
				const result = new Block()
				if (counter === omni.resultItemIndex) {
					result.classList.add("active")
				}
				result.itemIndex = counter
				result.addEventListener("click", async () => {
					// Save the last query and results for Ctrl+Alt+F restoration!
					omni.lastGrepQuery = query
					omni.lastGrepResults = [...currentSearchMatches]

					omni.results.hide()
					uiManager.hideOmnibox()

					await fileList.open(filePath)
					currentEditor.gotoLine(lineNum, 0, true)
					currentEditor.focus()
				})
				result.addEventListener("pointerover", () => {
					for (let node of omni.results.children) {
						node.classList.remove("active")
					}
					result.classList.add("active")
					omni.resultItemIndex = result.itemIndex
				})
				counter++

				const escapeHtml = (str) => {
					if (!str) return ""
					return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				}

				const fileName = filePath.split("/").pop()
				const escapedQuery = escapeHtml(query)
				const cleanQuery = escapedQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
				const regex = new RegExp(`(${cleanQuery})`, "gi")
				const highlightedName = escapeHtml(fileName).replace(regex, "<b>$1</b>")
				const highlightedSnippet = escapeHtml(snippet).replace(regex, "<b>$1</b>")
				const escapedPath = escapeHtml(filePath)

				result.innerHTML = `<big>${highlightedName}</big> <small style="opacity: 0.6;">(line ${lineNum})</small><br/><small>${escapedPath}</small><br/><code style="font-family: monospace; font-size: 11px; white-space: pre-wrap; color: var(--text-secondary, #888);">${highlightedSnippet}</code>`
				omni.results.append(result)
			}
		}

		let renderTimeout = null
		const queueLiveRender = () => {
			if (renderTimeout) return
			renderTimeout = setTimeout(() => {
				renderTimeout = null
				renderGrepResults()
			}, 150)
		}

		conduitClient.on("search_match", (message) => {
			if (message.requestId === sidebarActiveSearchRequestId) {
				const match = message.data
				if (message.requestId !== sidebarLastReceivedRequestId) {
					sidebarLastReceivedRequestId = message.requestId
					sidebarSearchMatches = [match]
				} else {
					sidebarSearchMatches.push(match)
				}
				queueSidebarLiveRender()
				return
			}

			if (omni.last !== "grep") return
			const match = message.data

			if (message.requestId !== lastReceivedRequestId) {
				lastReceivedRequestId = message.requestId
				currentSearchMatches = [match]
			} else {
				currentSearchMatches.push(match)
			}

			queueLiveRender()
		})

		conduitClient.on("search_done", (message) => {
			// If this search was cancelled by the server because a newer search started, ignore it
			if (message.error === "Cancelled") {
				return
			}

			if (message.requestId === sidebarActiveSearchRequestId) {
				if (sidebarRenderTimeout) {
					clearTimeout(sidebarRenderTimeout)
					sidebarRenderTimeout = null
				}
				if (message.requestId !== sidebarLastReceivedRequestId) {
					sidebarLastReceivedRequestId = message.requestId
					sidebarSearchMatches = []
				}
				sidebarAllowMoreThan20 = true
				renderSidebarResults(true)
				return
			}

			if (omni.last !== "grep") return
			if (renderTimeout) {
				clearTimeout(renderTimeout)
				renderTimeout = null
			}
			if (message.requestId !== lastReceivedRequestId) {
				lastReceivedRequestId = message.requestId
				currentSearchMatches = []
			}
			renderGrepResults()
			console.log("Search completed, found matches:", message.data)
		})

		const executeGrepSearch = async (query) => {
			activeSearchRequestId++
			try {
				await conduitClient.wsSearch(".", "grep", query)
			} catch (err) {
				console.error("Grep search failed:", err)
			}
		}

		const runGrep = async (query) => {
			executeGrepSearch(query)
		}

		const renderSidebarResults = (forceFull = false) => {
			const query = sidebarSearchQuery
			const rawMatches = [...sidebarSearchMatches]

			const getRelevanceScore = (item, q) => {
				const filePath = item[0]
				const snippet = item[2]
				const fileName = filePath.split("/").pop()
				
				const escapedQuery = q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
				const wordRegex = new RegExp('\\b' + escapedQuery + '\\b', 'i')
				
				if (wordRegex.test(fileName)) return 0
				if (fileName.toLowerCase().includes(q.toLowerCase())) return 1
				if (wordRegex.test(snippet)) return 2
				if (snippet.toLowerCase().includes(q.toLowerCase())) return 3
				return 4
			}

			// Group by filePath
			const groupedMap = new Map()
			for (let item of rawMatches) {
				const [filePath, lineNum, snippet] = item
				if (!groupedMap.has(filePath)) {
					groupedMap.set(filePath, {
						filePath,
						fileName: filePath.split("/").pop(),
						hits: [],
						bestScore: 999
					})
				}
				const group = groupedMap.get(filePath)
				const score = getRelevanceScore(item, query)
				if (score < group.bestScore) {
					group.bestScore = score
				}
				group.hits.push({ lineNum, snippet })
			}

			const groupedList = Array.from(groupedMap.values())

			// Sort by best relevance score, then alphabetically
			groupedList.sort((a, b) => {
				if (a.bestScore !== b.bestScore) {
					return a.bestScore - b.bestScore
				}
				return a.fileName.localeCompare(b.fileName)
			})

			// Limit to 20 files
			let filesToRender = groupedList
			if (!forceFull && !sidebarAllowMoreThan20 && filesToRender.length > 20) {
				filesToRender = filesToRender.slice(0, 20)
			}

			searchResultsContainer.empty()
			if (filesToRender.length === 0) {
				return
			}

			for (let fileGroup of filesToRender) {
				const { filePath, fileName, hits } = fileGroup

				// Sort hits by line number ascending
				hits.sort((a, b) => a.lineNum - b.lineNum)

				// Group lines as a range if they are less than 10 apart
				const lineNums = hits.map(h => h.lineNum)
				const uniqueLineNums = [...new Set(lineNums)]
				
				const segments = []
				let currentSeg = null
				for (const line of uniqueLineNums) {
					if (!currentSeg) {
						currentSeg = { start: line, end: line }
					} else if (line - currentSeg.end < 10) {
						currentSeg.end = line
					} else {
						segments.push(currentSeg)
						currentSeg = { start: line, end: line }
					}
				}
				if (currentSeg) {
					segments.push(currentSeg)
				}

				// Format ranges like #L123-127, #L581
				const annotations = segments.map(seg => {
					if (seg.start === seg.end) {
						return `#L${seg.start}`
					} else {
						return `#L${seg.start}-${seg.end}`
					}
				})

				// If more than 5 annotations, end with "..."
				let annotationStr = ""
				if (annotations.length > 5) {
					annotationStr = annotations.slice(0, 5).join(", ") + ", ..."
				} else {
					annotationStr = annotations.join(", ")
				}

				const card = new Block()
				card.addClass("search-result-item")
				card.setAttribute("tabindex", "0")

				// Click on card itself (fallback) opens the first match line
				card.on("click", async () => {
					await fileList.open(filePath)
					currentEditor.gotoLine(hits[0].lineNum, 0, true)
					currentEditor.focus()
				})

				card.on("keydown", async (e) => {
					if (e.key === "Enter") {
						e.preventDefault()
						await fileList.open(filePath)
						currentEditor.gotoLine(hits[0].lineNum, 0, true)
						currentEditor.focus()
					}
				})

				const escapeHtml = (str) => {
					if (!str) return ""
					return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				}

				const fileIcon = getIconForFileName(fileName)
				const escapedQuery = escapeHtml(query)
				const cleanQuery = escapedQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
				const regex = new RegExp(`(${cleanQuery})`, "gi")

				// Create header
				const header = new Block()
				header.addClass("match-header")
				
				const fileInfo = new Block()
				fileInfo.addClass("match-file")
				const escapedFileName = escapeHtml(fileName)
				fileInfo.innerHTML = `<ui-icon>${fileIcon}</ui-icon><strong>${escapedFileName}</strong> <span style="opacity: 0.6; font-size: 0.85em;">(${hits.length})</span>`
				
				const lineNumSpan = new Inline()
				lineNumSpan.addClass("line-num")
				lineNumSpan.innerHTML = annotationStr

				header.append(fileInfo)
				header.append(lineNumSpan)
				card.append(header)

				// Path
				const pathDiv = new Block()
				pathDiv.addClass("match-path")
				pathDiv.innerHTML = escapeHtml(filePath)
				card.append(pathDiv)

				// Snippets container
				const snippetsContainer = new Block()
				snippetsContainer.addClass("snippets-container")

				// Render snippets
				hits.forEach((hit, idx) => {
					const escapedSnippet = escapeHtml(hit.snippet)
					const highlightedSnippet = escapedSnippet.replace(regex, "<b>$1</b>")
					const snippetPre = new Block()
					snippetPre.addClass("match-snippet", "clickable-snippet")
					snippetPre.setAttribute("tabindex", "0")
					if (idx >= 5) {
						snippetPre.addClass("extra-snippet")
						snippetPre.style.display = "none"
					}
					snippetPre.innerHTML = `<code>${hit.lineNum}: ${highlightedSnippet}</code>`

					// Clicking snippet opens specific line number
					snippetPre.on("click", async (e) => {
						e.stopPropagation() // Don't trigger the card's general click
						await fileList.open(filePath)
						currentEditor.gotoLine(hit.lineNum, 0, true)
						currentEditor.focus()
					})

					snippetPre.on("keydown", async (e) => {
						if (e.key === "Enter") {
							e.preventDefault()
							e.stopPropagation()
							await fileList.open(filePath)
							currentEditor.gotoLine(hit.lineNum, 0, true)
							currentEditor.focus()
						}
					})

					snippetsContainer.append(snippetPre)
				})

				card.append(snippetsContainer)

				// Toggle button if > 5 hits
				if (hits.length > 5) {
					const toggleBtn = new Block()
					toggleBtn.addClass("snippet-toggle-btn")
					toggleBtn.innerHTML = `show all ${hits.length} matches`
					toggleBtn.setAttribute("expanded", "false")

					toggleBtn.on("click", (e) => {
						e.stopPropagation() // Don't trigger card click
						const isExpanded = toggleBtn.getAttribute("expanded") === "true"
						const extraSnippets = snippetsContainer.querySelectorAll(".extra-snippet")
						if (isExpanded) {
							extraSnippets.forEach(el => el.style.display = "none")
							toggleBtn.innerHTML = `show all ${hits.length} matches`
							toggleBtn.setAttribute("expanded", "false")
						} else {
							extraSnippets.forEach(el => el.style.display = "block")
							toggleBtn.innerHTML = "hide extra matches"
							toggleBtn.setAttribute("expanded", "true")
						}
					})
					card.append(toggleBtn)
				}

				searchResultsContainer.append(card)
			}
		}

		const queueSidebarLiveRender = () => {
			if (sidebarRenderTimeout) return
			sidebarRenderTimeout = setTimeout(() => {
				sidebarRenderTimeout = null
				renderSidebarResults()
			}, 150)
		}

		const executeSidebarGrepSearch = async (query) => {
			const requestId = ++conduitClient.requestIdCounter
			sidebarActiveSearchRequestId = requestId
			try {
				await conduitClient.wsSearchWithId(requestId, ".", "grep", query)
			} catch (err) {
				if (err.message !== "Cancelled") {
					console.error("Sidebar grep search failed:", err)
				}
			}
		}

		const runSidebarGrep = async (query) => {
			executeSidebarGrepSearch(query)
		}

		searchInput.on("input", () => {
			if (sidebarIdleRenderTimeout) {
				clearTimeout(sidebarIdleRenderTimeout)
				sidebarIdleRenderTimeout = null
			}
			sidebarAllowMoreThan20 = false

			const query = searchInput.value.trim()
			if (query.length < 2) {
				sidebarSearchQuery = ""
				sidebarSearchMatches = []
				searchResultsContainer.empty()
				return
			}

			if (sidebarSearchQuery && query.startsWith(sidebarSearchQuery)) {
				sidebarSearchMatches = sidebarSearchMatches.filter(item => {
					const filePath = item[0]
					const snippet = item[2]
					const fileName = filePath.split("/").pop()
					return fileName.toLowerCase().includes(query.toLowerCase()) || 
					       snippet.toLowerCase().includes(query.toLowerCase()) || 
					       filePath.toLowerCase().includes(query.toLowerCase())
				})
				renderSidebarResults()
			}

			sidebarSearchQuery = query
			runSidebarGrep(query)

			sidebarIdleRenderTimeout = setTimeout(() => {
				sidebarIdleRenderTimeout = null
				sidebarAllowMoreThan20 = true
				renderSidebarResults(true)
			}, 2000)
		})

		omni.titleElement = new Block("omni box")
		omni.input = new Input()
		omni.input.value = ""
		omni.stack = []
		omni.perform = (e, next = false, prev = false) => {
			let val = omni.input.value
			let mode = ""

			if (val.substr(0, 1) == "/") { mode = "find" }
			if (val.substr(0, 1) == ":") { mode = "goto" }
			if (val.substr(0, 1) == "~") { mode = "regex" }
			if (val.substr(0, 1) == "?") { mode = "regex-m" }
			if (val.substr(0, 1) == "@") { mode = "index" }
			if (val.substr(0, 1) == "$") { mode = "grep" }

			if (mode === "" && val.length > 0) {
				const prefixMap = {
					"/": "find",
					":": "goto",
					"~": "regex",
					"?": "regex-m",
					"@": "index",
					"$": "grep"
				};
				mode = prefixMap[omni.modePrefix] || "find";
				omni.input.value = omni.modePrefix + val
				val = omni.input.value
			}
			val = val.slice(1)

			switch (mode) {
				case "regex-m":
				case "regex":
					let reg
					if (val.length < 3) {
						return currentEditor.find("")
					}
					try {
						reg = new RegExp(val, "gsim")
					} catch (e) {
						console.warn("incomplete or invalid regex")
					}

					if (reg instanceof RegExp) {
						if (mode == "regex") {
							currentEditor.find(reg)
						} else {
							const match = reg.exec(currentEditor.getValue())

							if (match && match.length > 0) {
								currentEditor.selection.setRange({
									start: currentEditor.session.doc.indexToPosition(match.index),
									end: currentEditor.session.doc.indexToPosition(match.index + match[0].length),
								})
							}
						}
					}
					break
				case "goto":
					if (isNaN(val)) {
						omni.resultItem = null
						omni.resultItemIndex = 0
						const matches = fileList.find(val)
						if (matches.length == 0) {
							omni.results.hide()
							return
						} else {
							omni.results.show()
							omni.results.empty()
							omni.results.scrollTop = 0
							if (matches.length > 0) {
								omni.resultItem = matches[0]
							} else {
								omni.results.hide()
							}

							let counter = 0
							for (let item of matches) {
								// if(counter>10) continue
								const result = new Block()
								if (counter === 0) result.classList.add("active")
								result.itemIndex = counter
								result.addEventListener("click", () => {
									fileList.open(item)
									omni.results.hide()
								})
								result.addEventListener("pointerover", () => {
									for (let node of omni.results.children) {
										node.classList.remove("active")
									}
									result.classList.add("active")
									omni.resultItemIndex = result.itemIndex
								})
								counter++

								const name = item.name.split(val).join(`<b>${val}</b>`)
								const path = item.path.split(val).join(`<b>${val}</b>`)

								result.innerHTML = `<big>${name}</big><br/><small>${path}</small>`
								omni.results.append(result)
							}
						}
					} else {
						omni.resultItem = null
						omni.results.hide()
						currentEditor.gotoLine(val)
					}
					break
				case "grep":
					if (val.length < 2) {
						currentSearchQuery = ""
						currentSearchMatches = []
						omni.resultItem = null
						omni.results.hide()
						return
					}

					if (currentSearchQuery && val.startsWith(currentSearchQuery)) {
						currentSearchMatches = currentSearchMatches.filter(item => {
							const filePath = item[0]
							const snippet = item[2]
							return filePath.toLowerCase().includes(val.toLowerCase()) || 
							       snippet.toLowerCase().includes(val.toLowerCase())
						})
						currentSearchQuery = val
						renderGrepResults()
					} else {
						currentSearchQuery = val
						currentSearchMatches = []
						omni.resultItemIndex = 0
					}

					runGrep(val)
					break
				case "find":
					// 	if(prev) { return currentEditor.findPrevious({needle: val}); }
					// 	if(next) { return currentEditor.findNext({needle: val}); }
					currentEditor.find("")
					currentEditor.find(val)
					break
			}
		}
		omni.saveStack = () => {
			if (omni.input.value.length < 2) return
			if (omni.stack.length == 0 || omni.stack.indexOf(omni.input.value) == -1) {
				omni.stack.push(omni.input.value)
			}
			while (omni.stack.length > 50) {
				omni.stack.shift()
			}
		}

		omni.input.addEventListener("keydown", (e) => {
			if ((omni.last === "goto" || omni.last === "grep") && omni.resultItem) {
				// ArrowDown or Tab -> next item
				if (e.code === "ArrowDown" || (e.code === "Tab" && !e.shiftKey && !e.ctrlKey)) {
					e.preventDefault();
					omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length);
					omni.results.next();
					return;
				}
				// ArrowUp or Shift+Tab or Ctrl+Tab -> previous item
				if (e.code === "ArrowUp" || (e.code === "Tab" && (e.shiftKey || e.ctrlKey))) {
					e.preventDefault();
					omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length);
					omni.results.prev();
					return;
				}
				if (e.code == "PageUp") {
					e.preventDefault()
					omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length)
					omni.results.prev(10)
					return
				}
				if (e.code == "PageDown") {
					e.preventDefault()
					omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length)
					omni.results.next(10)
					return
				}
			}
		})
		omni.input.addEventListener("keyup", (e) => {
			// 			console.debug(e.code, omni.stackPos, omni.stack.length)

			if ((omni.last === "goto" || omni.last === "grep") && omni.resultItem) {
				if (e.code == "ArrowUp") {
					// e.preventDefault()
					// omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length)
					// omni.results.prev()
					return
				}

				if (e.code == "ArrowDown") {
					// e.preventDefault()
					// omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length)
					// omni.results.next()
					return
				}
			} else {
				if (e.code == "ArrowUp") {
					if (omni.stackPos > omni.stack.length) {
						omni.stackPos == omni.stack.length
					} else if (omni.stackPos == omni.stack.length) {
						omni.saveStack()
					}
					if (omni.stack.length > 0) {
						omni.stackPos--
						if (omni.stackPos < 0) omni.stackPos = 0
						omni.input.value = omni.stack[omni.stackPos]
						omni.input.setSelectionRange(1, omni.input.value.length)
						omni.perform(e)
					}
					return
				}
				if (e.code == "ArrowDown") {
					if (omni.stackPos < omni.stack.length - 1) {
						omni.stackPos++
						if (omni.stackPos >= omni.stack.length) {
							omni.input.value = ""
						}
						omni.input.value = omni.stack[omni.stackPos]
						omni.input.setSelectionRange(1, omni.input.value.length)
						omni.perform(e)
					} else {
						omni.stackPos = omni.stack.length
						// omni.input.value = omni.modePrefix
					}
					return
				}
			}

			if (e.code == "Escape") {
				uiManager.hideOmnibox()
				currentEditor.focus()
				return
			}

			if (e.code == "Enter") {
				if (omni.last === "goto" || omni.last === "grep") {
					if (omni.resultItem) {
						if (omni.last === "grep") {
							omni.lastGrepQuery = omni.input.value.slice(1)
							omni.lastGrepResults = [...currentSearchMatches]
						}
						omni.results.children[omni.resultItemIndex].click()
						omni.results.hide()
					}
					uiManager.hideOmnibox()
					currentEditor.focus()
					return
				}
				if (e.ctrlKey) {
					uiManager.hideOmnibox()
					currentEditor.focus()
				} else if (e.shiftKey) {
					if (omni.last == "regex") currentEditor.gotoLine(currentEditor.getCursorPosition().row)
					currentEditor.execCommand("findprevious")
					// omni.perform(e, false, true)
				} else {
					if (omni.last == "regex") currentEditor.gotoLine(currentEditor.getCursorPosition().row + 2)
					currentEditor.execCommand("findnext")
					// 	omni.perform(e, true)
				}
				return
			}

			omni.stackPos = omni.stack.length
		})
		omni.input.addEventListener("input", omni.perform)
		omni.prepend(omni.titleElement)
		omni.append(omni.input)
		omni.append(
			new Block(
				`
				&nbsp;&nbsp; <acronym title='Ctrl+G'>:Goto</acronym> 
				&nbsp;&nbsp; <acronym title='Ctrl+F'>/Find	</acronym> 
				&nbsp;&nbsp; <acronym title='Ctrl+Alt+F'>~RegEx</acronym> 
				&nbsp;&nbsp; <acronym title='Ctrl+Shift+Alt+F'>?RegEx-Multiline</acronym> 
				&nbsp;&nbsp; <acronym title='Ctrl+Shift+F'>$Sidebar Search</acronym> 
				<!--&nbsp;&nbsp; <acronym title='Ctrl-R (Not implemented)'><strike>@Reference</strike></acronym>-->
				&nbsp;&nbsp; `
			)
		)
		omni.setAttribute("id", "omni")
		omni.setAttribute("omni", "true")

		themeModeToggle = document.querySelector("#themeModeToggle")
		if (themeModeToggle) {
			themeModeToggle.on("click", () => {
				if (document.body.classList.contains("darkmode")) {
					document.body.classList.remove("darkmode")
					themeModeToggle.icon = "dark_mode"
				} else {
					document.body.classList.add("darkmode")
					themeModeToggle.icon = "light_mode"
				}
			})
		}

		leftHolder.tabs = leftTabs
		rightHolder.tabs = rightTabs

		leftTabs.on("click", () => { uiManager.currentEditor = leftEdit })
		rightTabs.on("click", () => { uiManager.currentEditor = rightEdit })
		leftHolder.on("click", () => { uiManager.currentEditor = leftEdit })
		rightHolder.on("click", () => { uiManager.currentEditor = rightEdit })

		leftHolder.on("empty", () => {
			leftEdit.setSession(ace.createEditSession("", ""))
		})
		rightHolder.on("empty", () => {
			rightEdit.setSession(ace.createEditSession("", ""))
		})

		document.body.addEventListener('tabdroppedonbar', () => {
			leftHolder.classList.remove("drag-over");
			rightHolder.classList.remove("drag-over");
		});

		document.body.appendChild(menu)
		document.body.appendChild(statusbar)



		mainContent.appendChild(leftHolder)
		mainContent.appendChild(rightHolder)

		document.body.appendChild(sidebar)
		document.body.appendChild(drawer)
		document.body.appendChild(omni)

		// Create the global notice bar dynamically
		const globalNoticeBar = document.createElement("div");
		globalNoticeBar.id = "globalFileModifiedNotice";
		globalNoticeBar.className = "global-notice-bar";
		
		const globalIcon = document.createElement("ui-icon");
		globalIcon.textContent = "warning";
		globalNoticeBar.appendChild(globalIcon);
		
		const globalText = document.createElement("span");
		globalNoticeBar.appendChild(globalText);
		
		const reloadAllBtn = document.createElement("button");
		reloadAllBtn.className = "primary";
		reloadAllBtn.textContent = "Reload All";
		reloadAllBtn.onclick = async () => {
			const allOpenTabs = [...(leftTabs?.tabs || []), ...(rightTabs?.tabs || [])];
			const modifiedTabs = allOpenTabs.filter(t => t.config?.fileModified === true);
			
			reloadAllBtn.disabled = true;
			reloadAllBtn.textContent = "Reloading...";
			
			for (const tab of modifiedTabs) {
				if (window.ui && window.ui.reloadFile) {
					await window.ui.reloadFile(tab);
				}
				const side = tab.config?.side || 'left';
				if (window.ui && window.ui.hideFileModifiedNotice) {
					window.ui.hideFileModifiedNotice(side);
				}
			}
			
			reloadAllBtn.disabled = false;
			reloadAllBtn.textContent = "Reload All";
			uiManager.checkGlobalFileModifiedNotice();
		};
		globalNoticeBar.appendChild(reloadAllBtn);
		
		const dismissAllBtn = document.createElement("button");
		dismissAllBtn.className = "cancel";
		dismissAllBtn.textContent = "Dismiss";
		dismissAllBtn.onclick = () => {
			const allOpenTabs = [...(leftTabs?.tabs || []), ...(rightTabs?.tabs || [])];
			const modifiedTabs = allOpenTabs.filter(t => t.config?.fileModified === true);
			
			for (const tab of modifiedTabs) {
				tab.config.fileModified = false;
				const isDirty = tab.config.session && tab.config.session.getValue() !== tab.config.session.baseValue;
				tab.changed = isDirty;
				
				if (window.ui && window.ui.fileList) {
					const fileItem = window.ui.fileList.find(tab.config.handle);
					if (fileItem && fileItem.length > 0) {
						fileItem[0].changed = isDirty;
					}
				}
				const side = tab.config?.side || 'left';
				if (window.ui && window.ui.hideFileModifiedNotice) {
					window.ui.hideFileModifiedNotice(side);
				}
			}
			uiManager.checkGlobalFileModifiedNotice();
		};
		globalNoticeBar.appendChild(dismissAllBtn);
		
		document.body.appendChild(globalNoticeBar);
		uiManager.globalNoticeBar = globalNoticeBar;
		uiManager.globalNoticeText = globalText;

		let cursorpos = new Inline()
		cursorpos.setAttribute("id", "cursor_pos")
		statusbar.append(cursorpos)

		const terminalToggleBtn = document.querySelector("#terminalToggleBtn");
		if (terminalToggleBtn) {
			terminalToggleBtn.on("click", () => {
				uiManager.toggleDrawer();
			});
		}

		window.leftEdit = leftEdit = ace.edit(leftHolder.editorElement)
		window.rightEdit = rightEdit = ace.edit(rightHolder.editorElement)

		leftEdit.id = "left-editor"
		rightEdit.id = "right-editor"

		leftHolder.editor = leftEdit
		rightHolder.editor = rightEdit

		window.editors = [leftEdit, rightEdit]
		leftEdit.tabs = leftTabs
		rightEdit.tabs = rightTabs

		uiManager.currentEditor = leftEdit;
		window.omni = omni
		ace.require("ace/keyboard/sublime")
		ace.require("ace/etc/keybindings_menu")

		scratchEditor = ace.edit(scratchEditorElement);
		scratchEditor.id = "scratch-editor"

		window.editors.push(scratchEditor);

		const updateCursorPositionStatus = (editor) => {
			if (editor === scratchEditor) return;
			const selection = editor.getSelection();
			const cursor = selection.getCursor();
			let displayText = `${cursor.row + 1}:${cursor.column + 1}`;

			const tab = editor.tabs?.activeTab;
			if (tab) {
				const fileName = tab.title || tab.config.name;
				if (fileName) {
					displayText += ` - ${fileName.replace(/\//g, " > ")}`;
				}
			}
			cursorpos.innerHTML = displayText;
		};

		for (const editor of editors) {
			const thisTabs = editor.tabs
			editor.setKeyboardHandler(options.keyboard)
			editor.setTheme(options.theme)

			editor.commands.removeCommand("find")
			editor.commands.removeCommand("removetolineendhard")
			editor.commands.removeCommand("removetolinestarthard")

			editor.setOptions(defaultSettings)

			editor.execCommand("loadSettingsMenu", () => {
				editor._signal("ready")
			})


			editor.on("focus", () => {
				// if (editor === scratchEditor) return;
				uiManager.currentEditor = editor
			})

			editor.on("changeSelection", () => {
				updateCursorPositionStatus(editor);
			})

			editor.container.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				
				const pos = editor.renderer.screenToTextCoordinates(e.clientX, e.clientY);
				const range = editor.session.getWordRange(pos.row, pos.column);
				const clickedWord = editor.session.getTextRange(range).trim();
				const symbol = clickedWord.replace(/[^a-zA-Z0-9_]/g, "");

				const gotoItem = document.getElementById("editor_context_goto");
				const splitItem = document.getElementById("editor_context_split");
				const gotoFileItem = document.getElementById("editor_context_goto_file");
				const gotoFileSplit = document.getElementById("editor_context_goto_file_split");
				
				// Check for filename
				const line = editor.session.getLine(pos.row);
				const filename = extractFilenameAtColumn(line, pos.column);
				if (filename) {
					const matches = findFileMatchesInIndex(filename);
					if (gotoFileItem) {
						gotoFileItem.textContent = `Go to File: ${filename}`;
						gotoFileItem.style.display = "block";
						if (matches && matches.length > 0) {
							gotoFileItem.removeAttribute("disabled");
							window.ui.activeContextMenuFileMatches = matches;
							window.ui.activeContextMenuFilename = filename;
						} else {
							gotoFileItem.setAttribute("disabled", "true");
							window.ui.activeContextMenuFileMatches = null;
							window.ui.activeContextMenuFilename = null;
						}
					}
					if (gotoFileSplit) {
						gotoFileSplit.style.display = "block";
					}
				} else {
					if (gotoFileItem) {
						gotoFileItem.style.display = "none";
					}
					if (gotoFileSplit) {
						gotoFileSplit.style.display = "none";
					}
					window.ui.activeContextMenuFileMatches = null;
					window.ui.activeContextMenuFilename = null;
				}
				
				if (symbol) {
					window.ui.activeContextMenuSymbol = symbol;
					if (gotoItem) {
						gotoItem.textContent = `Go to Definition of "${symbol}"`;
						gotoItem.style.display = "block";
					}
					if (splitItem) {
						splitItem.style.display = "block";
					}
				} else {
					window.ui.activeContextMenuSymbol = null;
					if (gotoItem) {
						gotoItem.style.display = "none";
					}
					if (splitItem) {
						splitItem.style.display = "none";
					}
				}

				const menuEl = document.getElementById("editor_context");
				if (menuEl && typeof menuEl.showAt === "function") {
					menuEl.showAt(e);
				}
			});
		}


		return
	},

	updateWorkspace: (appConfig) => {
		window.workspaceMenu = workspaceMenu

	},

	updateThemeAndMode: () => {
		const c_mode = leftEdit.getOption("mode")
		const c_theme = leftEdit.getOption("theme")
		window.themeMenu = themeMenu
		window.modeMenu = modeMenu

		// Query darkmode elements directly within the function

		if (window.ace_themes) {
			// themeMenu.empty();
			if (themeMenu.children.length == 0) {
				for (const n in ace_themes) {
					const theme = ace_themes[n]
					const item = new MenuItem(theme.caption)
					item.setAttribute("rel-data", ace_themes[n].theme)
					item.setAttribute("command", `app:setTheme:${ace_themes[n].theme}`)
					themeMenu.append(item)
				}
			}

			setTimeout(() => {
				const active = themeMenu.querySelector("[icon='done']")
				if (active) active.icon = ""
				for (const n in ace_themes) {
					if (ace_themes[n].theme == c_theme) {
						statusTheme.text = ace_themes[n].caption

						themeMenu.querySelector(`[rel-data='${ace_themes[n].theme}']`).icon = "done"
					}
				}
			})
		}
		if (window.ace_modes) {
			// modeMenu.empty();
			if (modeMenu.children.length == 0) {
				for (const n in ace_modes) {
					const mode = ace_modes[n]
					const item = new MenuItem(mode.caption)
					item.setAttribute("rel-data", ace_modes[n].mode)
					item.setAttribute("command", `app:setMode:${ace_modes[n].mode}`)
					modeMenu.append(item)
				}
			}
			setTimeout(() => {
				const active = modeMenu.querySelector("[icon='done']")
				if (active) active.icon = ""
				for (const n in ace_modes) {
					if (ace_modes[n].mode == c_mode) {
						statusMode.text = ace_modes[n].caption

						modeMenu.querySelector(`[rel-data='${ace_modes[n].mode}']`).icon = "done"
					}
				}
			})
		}

		// Update dark mode menu
		setTimeout(() => {
			// Clear all existing 'done' icons from dark mode menu items
			const allDarkModeMenuItems = darkmodeMenu.querySelectorAll("ui-menu-item"); // Query all menu items
			allDarkModeMenuItems.forEach(item => item.icon = "");

			const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)');

			// Apply the darkmode class to the body based on app.darkmode setting
			if (app.darkmode === 'dark' || (app.darkmode === 'system' && prefersDarkMode.matches)) {
				document.body.classList.add("darkmode");
				darkmodeSelect.icon = "dark_mode";
			} else {
				document.body.classList.remove("darkmode");
				darkmodeSelect.icon = "light_mode";
			}

			// Set the 'done' icon for the currently selected mode in the menu
			const selectedMenuItem = darkmodeMenu.querySelector(`[args='${app.darkmode}']`);
			if (selectedMenuItem) {
				selectedMenuItem.icon = "done";
			}
		});
	},

	showSidebar: async (expandLevels = 1) => {
		fileList.autoExpand = expandLevels
		const tree = (workspace.folders || []).map(path => {
			return {
				name: path.split('/').pop() || path,
				path: path,
				isDir: true
			};
		});
		fileList.files = tree;
	},

	toggleSidebar: () => {
		setTimeout(	debounceConstrainHolders, 300)
		return openDir.click()
	},

	toggleSplitView: (ext = {}) => {
		if (ext?.targetState == "closed") {
			if (!document.body.classList.contains("showSplitView")) {
				uiManager.currentEditor = leftEdit
				return
			}
		}
		const targetWidth = (window.innerWidth - leftHolder.offsetLeft) / 2
		if (toggleBodyClass("showSplitView")) {
			toggleSplitViewBtn.icon = "view_column"
			toggleSplitViewBtn.setAttribute("title", "Hide split view")
			leftHolder.style.width = "50%"
			rightHolder.style.width = "50%"
			rightTabs.reclaimTabs(leftTabs, "rightTabs");
		} else {
			toggleSplitViewBtn.icon = "vertical_split"
			toggleSplitViewBtn.setAttribute("title", "Show split view")
			leftHolder.style.width = "100%"
			rightHolder.style.width = "0%"
			rightTabs.moveAllTabsTo(leftTabs, "rightTabs", true);
		}

		debounceConstrainHolders()
	},

	omnibox: (mode) => {
		// read the existing value...
		const old = omni.classList.contains("active")?omni.input.value.substr(1):""
		omni.input.focus()
		omni.stackPos = omni.stack.length
		if (omni.last == mode && "find regex regex-m grep".indexOf(mode) != -1) {
			omni.input.setSelectionRange(1, omni.input.value.length)
			omni.perform()
		} else {
			switch (mode) {
				case "find":
					omni.input.value = "/"+old
					omni.input.setSelectionRange(1, 1)
					break
				case "regex":
					omni.input.value = "~"+old
					omni.input.setSelectionRange(1, 1)
					break
				case "regex-m":
					omni.input.value = "?"+old
					omni.input.setSelectionRange(1, 1)
					break
				case "grep":
					omni.input.value = "$"+(omni.lastGrepQuery || old)
					omni.input.setSelectionRange(1, omni.input.value.length)
					break
				case "goto":
					omni.results.hide()
					omni.input.value = ":"+old
					omni.input.setSelectionRange(1, 1)
					if(old) omni.results.show()
					break
				case "goto-o":
					omni.results.hide()
					omni.input.value = ":"+old
					omni.input.setSelectionRange(1, 1)
					if(old) omni.results.show()
					break
				case "lookup":
					omni.input.value = "@"+old
					omni.input.setSelectionRange(1, 1)
					break
			}
		}
		omni.classList.add("active")
		omni.results.hide()
		omni.last = mode
		omni.modePrefix = omni.input.value.substr(0, 1)
		if (mode === "grep" && omni.lastGrepResults && omni.lastGrepResults.length > 0) {
			currentSearchMatches = [...omni.lastGrepResults]
			currentSearchQuery = omni.lastGrepQuery
			renderGrepResults()
		} else if(old!=="") {
			omni.input.setSelectionRange(omni.input.value.length,omni.input.value.length)
			omni.perform()
		}
		setTimeout(() => {
			omni.input.on("blur", uiManager.hideOmnibox, { once: true })
		})
	},

	hideOmnibox: () => {
		omni.saveStack()
		if (omni.last === "grep") {
			omni.lastGrepQuery = omni.input.value.slice(1)
			omni.lastGrepResults = [...currentSearchMatches]
		}
		setTimeout(() => {
			omni.classList.remove("active")
		}, 200)
	},

	showSettings: (opts) => {
		console.debug(opts)
		settingsPanel.show()
	},


	get installer() { return installer },

	get mainContent() { return mainContent },
	get fileActions() { return fileActions },
	get sidebar() { return sidebar },
	get fileList() { return fileList },
	set fileList(v) { fileList = v },
	get leftTabs() { return leftTabs },
	get darkmodeSelect() { return darkmodeSelect },
	get darkmodeMenu() { return darkmodeMenu },

	get leftEdit() { return leftEdit },
	get leftHolder() { return leftHolder },
	get leftMedia() { return leftHolder.mediaView },

	get rightEdit() { return rightEdit },
	get rightHolder() { return rightHolder },
	get rightMedia() { return rightHolder.mediaView },
	get rightTabs() { return rightTabs },
	get scratchEditor() { return scratchEditor },
	get iconTabBar() { return iconTabBar },

	get terminalManager() { return terminalManager }, // Export the terminal's SidebarPanel
	get aiManager() { return aiManager },
	get searchInput() { return searchInput },
	focusSearchInput: focusSearchInput,

	fileListBackground: fileListBackground, // Expose the new element
	_sidebarFitTerminalAfterTransition: null, // To hold the bound function for removal
	constrainHolders: debounceConstrainHolders,

	set currentEditor(v) {
		currentEditor = v;
		if (v === leftEdit) {
			leftHolder.classList.add("current");
			rightHolder.classList.remove("current");
			currentTabs = leftTabs;
			// currentTabs?.activeTab?.click()
			// leftHolder._updateContentVisibility(false);
			// rightHolder._updateContentVisibility(true);
		} else {
			leftHolder.classList.remove("current");
			rightHolder.classList.add("current");
			currentTabs = rightTabs;
			// currentTabs?.activeTab?.click()
			// rightHolder._updateContentVisibility(false);
			// leftHolder._updateContentVisibility(true);
		}
	},
	set currentTabs(v) { currentTabs = v },
	get currentEditor() { return currentEditor },
	get currentTabs() { return currentTabs },
	get currentMediaView() { return currentMediaView },
	set currentMediaView(v) { currentMediaView = v },

	get reloadFile() {
		return uiManager._reloadFile
	},
	set reloadFile(v) {
		if ("function" == typeof v) {
			uiManager._reloadFile = v
		}
	},

	showFileModifiedNotice: (tab, side) => {
		tab.config.fileModified = true;
		const holder = (side === 'left') ? leftHolder : rightHolder;
		if (holder && holder.updateNoticeBar) {
			holder.updateNoticeBar(tab);
		}
		uiManager.checkGlobalFileModifiedNotice();
	},

	hideFileModifiedNotice: (side) => {
		const holder = (side === 'left') ? leftHolder : rightHolder;
		if (holder && holder.tabs && holder.tabs.activeTab) {
			holder.tabs.activeTab.config.fileModified = false;
			if (holder.updateNoticeBar) {
				holder.updateNoticeBar(holder.tabs.activeTab);
			}
		} else if (holder) {
			const noticeBar = holder.querySelector(".editor-header-bar");
			if (noticeBar) {
				noticeBar.style.display = "none";
				holder.editorElement.style.top = "";
				holder.editorElement.style.height = "";
				if (holder.editor && typeof holder.editor.resize === "function") holder.editor.resize();
			}
		}
		uiManager.checkGlobalFileModifiedNotice();
	},

	checkGlobalFileModifiedNotice: () => {
		const allOpenTabs = [...(leftTabs?.tabs || []), ...(rightTabs?.tabs || [])]
		const modifiedTabs = allOpenTabs.filter(t => t.config?.fileModified === true)
		const count = modifiedTabs.length
		
		if (count >= 3) {
			if (uiManager.globalNoticeBar && uiManager.globalNoticeText) {
				uiManager.globalNoticeText.textContent = `${count} files have changed outside the editor.`
				uiManager.globalNoticeBar.classList.add("active")
			}
		} else {
			if (uiManager.globalNoticeBar) {
				uiManager.globalNoticeBar.classList.remove("active")
			}
		}
	},

	updateAgentEditsNotice: (tab) => {
		if (!tab || !tab.config || !tab.config.path) return;
		const resolvedPath = tab.config.path;
		
		// Find edit buffer info using normalized path matching to handle leading slash variations
		const buffer = agentTools.getEditBuffer();
		const normTarget = agentTools._normalizePathForTabComparison(resolvedPath);
		const matchingPath = Object.keys(buffer).find(k => agentTools._normalizePathForTabComparison(k) === normTarget);
		const info = matchingPath ? buffer[matchingPath] : null;
		
		const side = tab.config.side || 'left';
		
		if (!info || !info.edits || info.edits.length === 0) {
			uiManager.hideAgentEditsNotice(side);
			return;
		}

		const noticeBarId = (side === 'left') ? "leftHolderAgentEditsNotice" : "rightHolderAgentEditsNotice";
		const noticeBar = document.getElementById(noticeBarId);
		if (!noticeBar) return;

		// Hide the other notice bar (file modified notice) if it's shown
		uiManager.hideFileModifiedNotice(side);

		const editIndexEl = noticeBar.querySelector(".edit-index");
		const editTotalEl = noticeBar.querySelector(".edit-total");
		
		editIndexEl.textContent = info.edits.length > 0 ? (info.currentIndex + 1) : 0;
		editTotalEl.textContent = info.edits.length;

		// Wire up buttons
		const prevBtn = noticeBar.querySelector("button[rel=prev-edit]");
		const nextBtn = noticeBar.querySelector("button[rel=next-edit]");
		const acceptBtn = noticeBar.querySelector("button[rel=accept-edit]");
		const rejectBtn = noticeBar.querySelector("button[rel=reject-edit]");
		const acceptAllBtn = noticeBar.querySelector("button[rel=accept-all]");
		const rejectAllBtn = noticeBar.querySelector("button[rel=reject-all]");

		prevBtn.onclick = () => {
			if (info.edits.length > 0) {
				info.currentIndex = (info.currentIndex - 1 + info.edits.length) % info.edits.length;
				uiManager.updateAgentEditsNotice(tab);
				uiManager.scrollToAgentEdit(tab, side, info.currentIndex);
			}
		};

		nextBtn.onclick = () => {
			if (info.edits.length > 0) {
				info.currentIndex = (info.currentIndex + 1) % info.edits.length;
				uiManager.updateAgentEditsNotice(tab);
				uiManager.scrollToAgentEdit(tab, side, info.currentIndex);
			}
		};

		acceptBtn.onclick = async () => {
			const idx = info.currentIndex;
			await agentTools.resolveEdit(resolvedPath, idx, true);
		};

		rejectBtn.onclick = async () => {
			const idx = info.currentIndex;
			await agentTools.resolveEdit(resolvedPath, idx, false);
		};

		acceptAllBtn.onclick = async () => {
			await agentTools.resolveAllEdits(resolvedPath, true);
		};

		rejectAllBtn.onclick = async () => {
			const confirmed = await window.modal.confirm("Are you sure you want to reject all pending edits for this file?", "Reject All Edits");
			if (confirmed) {
				await agentTools.resolveAllEdits(resolvedPath, false);
			}
		};

		noticeBar.style.display = "flex";
		uiManager.scrollToAgentEdit(tab, side, info.currentIndex);
	},

	scrollToAgentEdit: (tab, side, editIndex) => {
		const editor = (side === 'left') ? leftEdit : rightEdit;
		if (!editor) return;

		const resolvedPath = tab.config.path;
		// Find edit buffer info using normalized path matching to handle leading slash variations
		const buffer = agentTools.getEditBuffer();
		const normTarget = agentTools._normalizePathForTabComparison(resolvedPath);
		const matchingPath = Object.keys(buffer).find(k => agentTools._normalizePathForTabComparison(k) === normTarget);
		const info = matchingPath ? buffer[matchingPath] : null;
		if (!info || !info.edits || !info.edits[editIndex]) return;

		const edit = info.edits[editIndex];
		const start = edit.startDeletedAnchor ? edit.startDeletedAnchor.getPosition() : edit.startAnchor.getPosition();
		const end = edit.endAddedAnchor ? edit.endAddedAnchor.getPosition() : edit.endAnchor.getPosition();

		// Scroll to line
		editor.gotoLine(start.row + 1, start.column, true);

		// Set selection range to highlight the modified code chunk
		const Range = window.ace.require("ace/range").Range;
		const selectionRange = new Range(start.row, start.column, end.row, end.column);
		editor.selection.setRange(selectionRange);
		editor.focus();
	},

	hideAgentEditsNotice: (side) => {
		const noticeBarId = (side === 'left') ? "leftHolderAgentEditsNotice" : "rightHolderAgentEditsNotice";
		const noticeBar = document.getElementById(noticeBarId);
		if (noticeBar) {
			noticeBar.style.display = "none";
		}
	},

	clearAgentEdits: (path) => {
		if (!path) return;
		const resolvedPath = agentTools._resolveAndValidatePath(path);
		const info = agentTools.editBuffer[resolvedPath];
		if (info && info.edits) {
			info.edits.forEach(edit => {
				const session = edit.startAnchor ? edit.startAnchor.session : null;
				if (session) {
					try {
						session.removeMarker(edit.id);
					} catch(e) {}
				}
				try {
					if (edit.startDeletedAnchor) edit.startDeletedAnchor.detach();
					if (edit.endDeletedAnchor) edit.endDeletedAnchor.detach();
					if (edit.startAddedAnchor) edit.startAddedAnchor.detach();
					if (edit.endAddedAnchor) edit.endAddedAnchor.detach();
					if (edit.startAnchor) edit.startAnchor.detach();
					if (edit.endAnchor) edit.endAnchor.detach();
				} catch(e) {}
			});
		}
		delete agentTools.editBuffer[resolvedPath];
		
		const side = window.ui?.leftTabs?.tabs.find(t => t.config.path === path) ? 'left' : 'right';
		uiManager.hideAgentEditsNotice(side);
	},
}

setTimeout(() => {
	leftEdit.on("ready", () => {
		uiManager.updateThemeAndMode()
	})
})

uiManager.defaultSettings = defaultSettings
export default uiManager