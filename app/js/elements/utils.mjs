import conduitClient from '../conduit-client.mjs';

export const isset = (v) => {
	return "undefined" != typeof v
}
export const isNotNull = (v) => {
	return isset(v) && v != null
}
export const isFunction = (v) => {
	return isset(v) && "function" == typeof v
}
export const isElement = (v) => {
	return isset(v) && v instanceof Element
}
export const clone = (e) => {
	return JSON.parse(JSON.stringify(e))
}

// add a stylesheet with a promise return
export const addStylesheet = (u, id) => {
	return new Promise((i, n) => {
		let s = document.createElement("link")
		s.addEventListener("load", (e) => {
			i(e)
		})
		s.rel = "stylesheet"
		if (isset(id)) {
			s.setAttribute("id", id)
		}

		// find first style elements
		let f = document.head.querySelector("style")
		if (f !== null) {
			s.href = u
			document.head.insertBefore(s, f)
		} else {
			s.href = u
			document.head.append(s, f)
		}
	})
}

let _ignorePaths = new Set();

export function setIgnorePaths(paths = []) {
    _ignorePaths = new Set(paths);
}

export function getIgnorePaths() {
    return Array.from(_ignorePaths);
}

export function isPathIgnored(path) {
    if (!_ignorePaths.size) return false;
    // Check if the folder name itself is in the ignore list.
    return _ignorePaths.has(path);
}

// Load a script dynamically with a promise return
export const loadScript = (src) => {
	return new Promise((resolve, reject) => {
		// if the script already exists, resolve immediately
		if (document.querySelector(`script[src="${src}"]`)) {
			resolve();
			return;
		}
		const script = document.createElement('script');
		script.src = src;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`Script load error for ${src}`));
		document.head.append(script);
	});
}

export function sortOnName(a, b) { return a.name < b.name ? -1 : 1 }

export async function readAndOrderDirectory(itemOrPath) {
	let path = typeof itemOrPath === 'string' ? itemOrPath : itemOrPath.path;
	if (!path) path = '.';

	try {
		const response = await conduitClient.wsList(path);
		if (response.error) throw new Error(response.error);

		let files = [], folders = [];
		for (const entry of (response.data || [])) {
			entry.path = path === '.' ? entry.name : `${path}/${entry.name}`;
			if (entry.isDir) {
				folders.push(entry);
			} else {
				files.push(entry);
			}
		}
		
		files.sort(sortOnName);
		folders.sort(sortOnName);
		
		return [...folders, ...files];
	} catch (e) {
		console.error("Failed to read directory:", e);
		return [];
	}
}

export async function readAndOrderDirectoryRecursive(itemOrPath) {
    if (Array.isArray(itemOrPath)) {
        let results = [];
        for (let item of itemOrPath) {
            let processed = { ...item };
            processed.tree = await readAndOrderDirectoryRecursive(processed.path);
            results.push(processed);
        }
        return results;
    }

	let path = typeof itemOrPath === 'string' ? itemOrPath : itemOrPath.path;
	if (!path) path = '.';

	try {
		const entries = await readAndOrderDirectory(path);
		
		let files = [], folders = [];
		for (const entry of entries) {
			if (entry.isDir) {
				folders.push(entry);
			} else {
				files.push(entry);
			}
		}

		for (let folder of folders) {
			if (folder.name.startsWith(".") || isPathIgnored(folder.name)) continue;
			try {
				folder.tree = await readAndOrderDirectoryRecursive(folder.path);
			} catch(e) {
				console.warn("Unable to generate subindex", e.message);
			}
		}
		
		if (typeof itemOrPath === 'object') {
			itemOrPath.tree = [...folders, ...files];
		}
		
		return [...folders, ...files];
	} catch(e) {
		console.error("Failed to read directory recursively:", e);
		return [];
	}
}

export const buildPath = (f) => {
	if (typeof f === 'string') return f;
	if (f && f.path) return f.path;
	return "";
}

// Add this function to your utils.mjs file

/**
 * Determines a Material Symbols icon name for a file based on its extension.
 * @param {string} name - The full name of the file (e.g., 'styles.css').
 * @returns {string} The name of the icon.
 */
export function getIconForFileName(name) {
    // This map is now the single source of truth for file extension icons!
    const fileTypes = {
        "javascript": ["js", "mjs", "cjs"],
        "code": ["c", "cpp", "h", "hpp", "cs", "java", "py", "rb", "go", "rs", "sh"],
        "html": ["htm", "html", "dhtml"],
        "css": ["css", "scss", "less"],
        "php": ["php"],
        "picture_as_pdf": ["pdf"],
        "data_object": ["json", "xml", "yaml", "yml"],
        "image": ["svg", "jpg", "jpeg", "gif", "tiff", "png", "ico", "bmp", "webp"],
        "movie": ["avi", "mp4", "webm", "wmv", "mov", "flv", "f4v", "mkv", "3gp"],
        "music_note": ["mp3", "aac", "wma", "ogg", "wav", "flac"],
        "folder_zip": ["zip", "rar", "7z", "tar", "gz"],
        "table": ["csv", "xls", "xlsx"],
    };

    const extension = name.split('.').pop().toLowerCase();

    for (const icon in fileTypes) {
        if (fileTypes[icon].includes(extension)) {
            return icon;
        }
    }

    // Default icon for any other file type.
    return 'description';
}

/**
 * Extracts a filename string at the given column index on a line if it looks like one.
 */
export function extractFilenameAtColumn(line, column) {
	if (!line || column < 0 || column >= line.length) return null;
	const allowed = /[a-zA-Z0-9_\-./\\]/;
	if (!allowed.test(line[column])) return null;

	let start = column;
	while (start > 0 && allowed.test(line[start - 1])) {
		start--;
	}

	let end = column;
	while (end < line.length - 1 && allowed.test(line[end + 1])) {
		end++;
	}

	const str = line.substring(start, end + 1);
	
	const parts = str.split(/[/\\]/);
	const lastPart = parts[parts.length - 1];
	if (lastPart && lastPart.includes('.') && !lastPart.startsWith('.') && !lastPart.endsWith('.')) {
		const extParts = lastPart.split('.');
		const ext = extParts[extParts.length - 1];
		// File extension must be alphanumeric and between 1 and 6 characters.
		// Also filter out common code patterns that look like property/method access.
		if (/^[a-zA-Z0-9]{1,6}$/.test(ext)) {
			if (!str.startsWith('this.') && !str.startsWith('console.') && !str.startsWith('window.') && !str.startsWith('document.')) {
				return str;
			}
		}
	}
	return null;
}

/**
 * Find all matching files in the index or tree.
 */
export function findFileMatchesInIndex(extractedString) {
	if (!window.ui || !window.ui.fileList) {
		return [];
	}
	
	const normalize = (p) => {
		if (!p) return '';
		let clean = p.replace(/\\/g, '/').replace(/\/+/g, '/');
		clean = clean.replace(/^(?:\.\.?\/)+/, '');
		return clean.replace(/^\//, '').replace(/\/$/, '');
	};
	const normExtracted = normalize(extractedString);
	
	const filterFiles = (fileListArray) => {
		const matches = [];
		for (const file of fileListArray) {
			const normPath = normalize(file.path);
			if (normPath === normExtracted || normPath.endsWith('/' + normExtracted) || normPath.includes(normExtracted)) {
				matches.push(file);
			} else if (file.name === extractedString || file.name.includes(extractedString)) {
				matches.push(file);
			}
		}
		// De-duplicate matches by path
		return [...new Map(matches.map(item => [item.path, item])).values()];
	};

	// 1. Try checking the flattened index first
	if (window.ui.fileList.index && window.ui.fileList.index.files) {
		return filterFiles(window.ui.fileList.index.files);
	}

	// 2. Fall back to recursive search on the tree in case the index is not yet built
	if (window.ui.fileList._tree) {
		const allTreeFiles = [];
		const gatherFiles = (tree) => {
			for (const item of tree) {
				if (item.isDir) {
					if (item.tree) gatherFiles(item.tree);
				} else {
					allTreeFiles.push(item);
				}
			}
		};
		gatherFiles(window.ui.fileList._tree);
		return filterFiles(allTreeFiles);
	}
	
	return [];
}
