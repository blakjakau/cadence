import { FileList } from './filelist.mjs';
import { Button } from './button.mjs';
import { readAndOrderDirectory } from './utils.mjs';
import modal from './modal.mjs';

export const promptAddFolder = async () => {
    return new Promise((resolve) => {
        const pickerList = new FileList();
        pickerList.disableIndexing = true;
        pickerList.style.height = '400px';
        pickerList.style.overflow = 'auto';
        pickerList.style.display = 'block';
        pickerList.style.border = '1px solid var(--border-color)';
        pickerList.style.borderRadius = 'var(--radius)';
        pickerList.style.marginTop = '10px';
        pickerList.style.padding = '10px';

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

        (async () => {
            try {
                const tree = await readAndOrderDirectory('.');
                pickerList.files = tree;
            } catch (e) {
                console.error("Failed to read root directory for picker", e);
            }
        })();

        const contentContainer = document.createElement('div');
        contentContainer.innerHTML = '<h1>Select Folder</h1><p>Choose a folder from the backend to add to your workspace.</p>';
        
        const checkContainer = document.createElement('label');
        checkContainer.style.display = 'flex';
        checkContainer.style.alignItems = 'center';
        checkContainer.style.gap = '8px';
        checkContainer.style.marginTop = '10px';
        checkContainer.style.cursor = 'pointer';
        
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

        contentContainer.append(pickerList, checkContainer);
        modal.inner.innerHTML = '';
        modal.inner.append(contentContainer);

        modal.actionBar.innerHTML = '';
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

        modal.actionBar.append(cancelButton, okButton);
        modal.show();
    });
};

export const promptSaveFile = async (suggestedName = "Untitled", suggestedFolder = ".", workspaceFolders = [], expandPath = null) => {
    return new Promise((resolve) => {
        const pickerList = new FileList();
        pickerList.disableIndexing = true;
        pickerList.style.height = '300px';
        pickerList.style.overflow = 'auto';
        pickerList.style.display = 'block';
        pickerList.style.border = '1px solid var(--border-color)';
        pickerList.style.borderRadius = 'var(--radius)';
        pickerList.style.marginTop = '10px';
        pickerList.style.padding = '10px';

        let selectedFolder = suggestedFolder || '.';
        
        const inputContainer = document.createElement('div');
        inputContainer.style.display = 'flex';
        inputContainer.style.alignItems = 'center';
        inputContainer.style.gap = '8px';
        inputContainer.style.marginTop = '10px';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = suggestedName;
        nameInput.style.flex = '1';
        nameInput.style.padding = '8px';
        nameInput.style.borderRadius = 'var(--radius)';
        nameInput.style.border = '1px solid var(--border-color)';
        nameInput.style.background = 'var(--bg-primary)';
        nameInput.style.color = 'var(--text-primary)';
        
        inputContainer.append(document.createTextNode('Filename: '), nameInput);

        // Project folder selector
        const folderSelectorContainer = document.createElement('div');
        folderSelectorContainer.style.display = 'flex';
        folderSelectorContainer.style.alignItems = 'center';
        folderSelectorContainer.style.gap = '8px';
        folderSelectorContainer.style.marginBottom = '10px';

        const folderSelect = document.createElement('select');
        folderSelect.style.flex = '1';
        folderSelect.style.padding = '8px';
        folderSelect.style.paddingRight = '32px';
        folderSelect.style.borderRadius = 'var(--radius)';
        folderSelect.style.border = '1px solid var(--border-color)';
        folderSelect.style.background = 'var(--bg-primary)';
        folderSelect.style.color = 'var(--text-primary)';
        folderSelect.style.appearance = 'none';
        folderSelect.style.webkitAppearance = 'none';
        folderSelect.style.backgroundImage = 'url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23888\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'%3E%3C/polyline%3E%3C/svg%3E")';
        folderSelect.style.backgroundRepeat = 'no-repeat';
        folderSelect.style.backgroundPosition = 'right 8px center';
        folderSelect.style.backgroundSize = '16px';
        
        // Add all available options
        const allOptions = new Set(['.', ...workspaceFolders]);
        allOptions.forEach(folder => {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = folder === '.' ? 'Root (All Drives)' : folder;
            option.style.background = 'var(--bg-primary)';
            option.style.color = 'var(--text-primary)';
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
            option.style.background = 'var(--bg-primary)';
            option.style.color = 'var(--text-primary)';
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

        const contentContainer = document.createElement('div');
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
