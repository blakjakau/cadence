import { FileList } from './filelist.mjs';
import { Button } from './button.mjs';
import { Block } from './element.mjs';
import { Input } from './input.mjs';
import { readAndOrderDirectory } from './utils.mjs';
import modal from './modal.mjs';
import { Menu } from './menu.mjs';
import { MenuItem } from './menuitem.mjs';
import conduit from '../conduit-client.mjs';

export const promptAddFolder = async () => {
    return new Promise((resolve) => {
        const pickerList = new FileList();
        pickerList.disableIndexing = true;
        pickerList.classList.add("folder-picker-list");

        let selectedPath = null;
        pickerList.addEventListener("click", (e) => {
            const fileItem = e.target.closest('ui-file-item');
            if (fileItem && fileItem.item && fileItem.item.isDir) {
                const allItems = pickerList.querySelectorAll('ui-file-item');
                allItems.forEach(i => i.removeAttribute('active'));
                fileItem.setAttribute('active', '');
                selectedPath = fileItem.item.path || fileItem.item.name;
            }
        });

        pickerList.hideDotFiles = true;

        const contentContainer = new Block();
        contentContainer.innerHTML = '<h1>Select Folder</h1><p>Choose a folder from the backend to add to your workspace.</p>';
        
        // Inline Folder Creation Row
        const createFolderRow = new Block();
        createFolderRow.classList.add("create-folder-row");

        const newFolderInput = new Input();
        newFolderInput.placeholder = 'New folder name...';
        newFolderInput.classList.add("create-folder-input");

        const createFolderBtn = new Button('Create Folder');
        createFolderBtn.classList.add('themed', 'create-folder-btn');

        createFolderRow.append(newFolderInput, createFolderBtn);

        const checkContainer = document.createElement('label');
        checkContainer.classList.add("checkbox-container");
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        
        const labelText = document.createTextNode('Show hidden folders');
        checkContainer.append(checkbox, labelText);

        checkbox.addEventListener('change', async (e) => {
            pickerList.hideDotFiles = !e.target.checked;
            pickerList.setAttribute("loading", "true");
            try {
                const tree = await readAndOrderDirectory('.');
                pickerList.files = tree;
            } catch (err) {
                console.error("Failed to read root directory for picker", err);
            }
            pickerList.removeAttribute("loading");
        });

        // Inline Folder Deletion Confirmation Banner
        const deleteConfirmBanner = new Block();
        deleteConfirmBanner.classList.add("delete-confirm-banner");

        const deleteConfirmText = new Block();
        deleteConfirmText.classList.add("delete-confirm-text");

        const deleteConfirmButtons = new Block();
        deleteConfirmButtons.classList.add("delete-confirm-buttons");

        const deleteConfirmBtnYes = new Button("Delete");
        deleteConfirmBtnYes.classList.add("delete-confirm-btn-yes");
        const deleteConfirmBtnNo = new Button("Cancel");
        deleteConfirmBtnNo.classList.add("delete-confirm-btn-no");

        deleteConfirmButtons.append(deleteConfirmBtnYes, deleteConfirmBtnNo);
        deleteConfirmBanner.append(deleteConfirmText, deleteConfirmButtons);

        contentContainer.append(pickerList, createFolderRow, deleteConfirmBanner, checkContainer);

        const okButton = new Button('Add Folder');
        okButton.classList.add('themed');
        const cancelButton = new Button('Cancel');
        cancelButton.classList.add('cancel');

        okButton.on('click', () => {
            modal.hide();
            resolve(selectedPath);
        });
        cancelButton.on('click', () => {
            modal.hide();
            resolve(null);
        });

        const showFolderModal = () => {
            modal.inner.innerHTML = '';
            modal.inner.append(contentContainer);
            modal.actionBar.innerHTML = '';
            modal.actionBar.append(cancelButton, okButton);
            modal.show();
        };

        let pendingDeletePath = null;
        let pendingDeleteItemEl = null;

        deleteConfirmBtnNo.on('click', () => {
            deleteConfirmBanner.classList.remove("active");
            pendingDeletePath = null;
            pendingDeleteItemEl = null;
        });

        deleteConfirmBtnYes.on('click', async () => {
            if (!pendingDeletePath || !pendingDeleteItemEl) return;
            try {
                await conduit.wsDelete(pendingDeletePath);
                window.modal.toast(`Folder "${pendingDeleteItemEl.item.name}" deleted successfully`);
                
                const parentFileItem = pendingDeleteItemEl.parentElement.closest('ui-file-item');
                if (parentFileItem && parentFileItem.refresh) {
                    parentFileItem.refresh.click();
                } else {
                    const tree = await readAndOrderDirectory('.');
                    pickerList.files = tree;
                }
            } catch (err) {
                window.modal.toast("Failed to delete folder: " + (err.message || err));
            } finally {
                deleteConfirmBanner.classList.remove("active");
                pendingDeletePath = null;
                pendingDeleteItemEl = null;
            }
        });

        createFolderBtn.on('click', async () => {
            const folderName = newFolderInput.value.trim();
            if (!folderName) {
                window.modal.toast("Please enter a folder name");
                return;
            }

            const parentPath = selectedPath || '.';
            const newPath = parentPath === '.' ? folderName : `${parentPath}/${folderName}`;

            try {
                await conduit.wsMkdir(newPath);
                newFolderInput.value = '';
                window.modal.toast(`Folder "${folderName}" created successfully`);
                
                const activeItemEl = pickerList.querySelector('ui-file-item[active]');
                if (activeItemEl && activeItemEl.refresh) {
                    if (!activeItemEl.item.open) {
                        activeItemEl.click();
                    } else {
                        activeItemEl.refresh.click();
                    }
                } else {
                    const tree = await readAndOrderDirectory('.');
                    pickerList.files = tree;
                }
            } catch (err) {
                window.modal.toast("Failed to create folder: " + (err.message || err));
            }
        });

        pickerList.context = async (ev) => {
            console.log("FileList context menu triggered", ev);
            const itemEl = pickerList.contextElement;
            console.log("Context element (itemEl):", itemEl);

            if (itemEl && itemEl.item) {
                const allItems = pickerList.querySelectorAll('ui-file-item');
                allItems.forEach(i => i.removeAttribute('active'));
                itemEl.setAttribute('active', '');
                selectedPath = itemEl.item.path || itemEl.item.name;
            }

            const menu = new Menu();
            const newItem = new MenuItem("Create New Folder");
            newItem.setAttribute("icon", "create_new_folder");
            menu.append(newItem);

            let deleteItem = null;
            if (itemEl && itemEl.item) {
                deleteItem = new MenuItem("Delete Folder");
                deleteItem.setAttribute("icon", "delete");
                menu.append(deleteItem);
            }

            menu.click = async (clickedItem) => {
                if (clickedItem === newItem) {
                    newFolderInput.focus();
                    newFolderInput.select();
                } else if (clickedItem === deleteItem) {
                    const targetPath = itemEl.item.path || itemEl.item.name;
                    try {
                        const countRes = await conduit.wsCountFiles(targetPath);
                        const fileCount = countRes.data || 0;
                        
                        pendingDeletePath = targetPath;
                        pendingDeleteItemEl = itemEl;

                        if (fileCount > 0) {
                            deleteConfirmText.textContent = `Folder is not empty (${fileCount} files/folders inside). Are you sure you want to delete "${itemEl.item.name}"?`;
                        } else {
                            deleteConfirmText.textContent = `Are you sure you want to delete "${itemEl.item.name}"?`;
                        }
                        
                        deleteConfirmBanner.classList.add("active");
                    } catch (err) {
                        window.modal.toast("Failed to check folder content: " + (err.message || err));
                    }
                }
            };

            document.body.append(menu);
            menu.showAt(ev);
        };

        (async () => {
            try {
                const tree = await readAndOrderDirectory('.');
                pickerList.files = tree;
            } catch (e) {
                console.error("Failed to read root directory for picker", e);
            }
        })();

        showFolderModal();
    });
};

export const promptSaveFile = async (suggestedName = "Untitled", suggestedFolder = ".", workspaceFolders = [], expandPath = null) => {
    return new Promise((resolve) => {
        const pickerList = new FileList();
        pickerList.disableIndexing = true;
        pickerList.classList.add("save-picker-list");

        let selectedFolder = suggestedFolder || '.';
        
        const inputContainer = new Block();
        inputContainer.classList.add("save-input-container");

        const nameInput = new Input();
        nameInput.value = suggestedName;
        nameInput.classList.add("save-name-input");
        
        inputContainer.append(document.createTextNode('Filename: '), nameInput);

        // Project folder selector
        const folderSelectorContainer = new Block();
        folderSelectorContainer.classList.add("save-folder-selector-container");

        const folderSelect = document.createElement('select');
        folderSelect.classList.add("save-folder-select");
        
        // Add all available options
        const allOptions = new Set(['.', ...workspaceFolders]);
        allOptions.forEach(folder => {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = folder === '.' ? 'Root (All Drives)' : folder;
            if (folder === selectedFolder) {
                option.selected = true;
            }
            folderSelect.append(option);
        });

        // Ensure selectedFolder matches the dropdown if the passed folder wasn't in the list
        if (!allOptions.has(selectedFolder)) {
            const option = document.createElement('option');
            option.value = selectedFolder;
            option.textContent = selectedFolder;
            option.selected = true;
            folderSelect.append(option);
        }

        folderSelectorContainer.append(document.createTextNode('Project: '), folderSelect);

        let saveTargetFolder = expandPath && expandPath.startsWith(selectedFolder) ? expandPath : selectedFolder;

        folderSelect.addEventListener('change', async (e) => {
            selectedFolder = e.target.value;
            saveTargetFolder = selectedFolder;
            pickerList.setAttribute("loading", "true");
            try {
                const tree = await readAndOrderDirectory(selectedFolder);
                pickerList.files = tree;
                setTimeout(() => { pickerList.active = saveTargetFolder; }, 50);
            } catch (err) {
                console.error("Failed to read directory for save picker", err);
            }
            pickerList.removeAttribute("loading");
        });

        const setupInitialExpand = () => {
            if (expandPath && expandPath.startsWith(selectedFolder)) {
                const pathsToOpen = [selectedFolder];
                const relativePath = expandPath.substring(selectedFolder.length);
                const parts = relativePath.split(/[/\\]/).filter(p => p.length > 0);
                
                let currentPath = selectedFolder;
                for (const part of parts) {
                    currentPath += currentPath.endsWith('/') ? part : '/' + part;
                    pathsToOpen.push(currentPath);
                }
                pickerList.openFolders = pathsToOpen;
            }
        };

        setupInitialExpand();

        pickerList.addEventListener("click", (e) => {
            const fileItem = e.target.closest('ui-file-item');
            if (fileItem && fileItem.item) {
                const allItems = pickerList.querySelectorAll('ui-file-item');
                allItems.forEach(i => i.removeAttribute('active'));
                fileItem.setAttribute('active', '');
                
                if (fileItem.item.isDir) {
                    saveTargetFolder = fileItem.item.path || fileItem.item.name;
                } else {
                    const pathParts = (fileItem.item.path || fileItem.item.name).split(/[/\\]/);
                    nameInput.value = pathParts.pop();
                    saveTargetFolder = pathParts.join('/') || '.';
                }
            }
        });

        pickerList.hideDotFiles = true;

        (async () => {
            try {
                const tree = await readAndOrderDirectory(selectedFolder);
                pickerList.files = tree;
                // Wait for potential dynamic tree expansion to finish before highlighting
                setTimeout(() => { pickerList.active = saveTargetFolder; }, 500);
            } catch (e) {
                console.error("Failed to read root directory for save picker", e);
            }
        })();

        const contentContainer = new Block();
        contentContainer.innerHTML = '<h1>Save File As</h1><p>Choose a location and enter a file name.</p>';
        contentContainer.append(folderSelectorContainer, pickerList, inputContainer);

        modal.inner.innerHTML = '';
        modal.inner.append(contentContainer);

        modal.actionBar.innerHTML = '';
        const saveButton = new Button('Save');
        saveButton.classList.add('themed');
        const cancelButton = new Button('Cancel');
        cancelButton.classList.add('cancel');

        saveButton.on("click", () => {
            const fileName = nameInput.value.trim();
            if (!fileName) return;
            modal.hide();
            
            // Remember the last used project folder
            localStorage.setItem('lastUsedProjectFolder', selectedFolder);
            
            const fullPath = saveTargetFolder === '.' ? fileName : `${saveTargetFolder}/${fileName}`;
            resolve({
                path: fullPath,
                name: fileName,
                folder: saveTargetFolder
            });
        });

        cancelButton.on("click", () => {
            modal.hide();
            resolve(null);
        });

        modal.actionBar.append(cancelButton, saveButton);
        modal.show();
        setTimeout(() => nameInput.focus(), 50);
    });
};
