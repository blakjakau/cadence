// app/js/syntax-validator.mjs
import prettier from "https://unpkg.com/prettier@2.8.8/esm/standalone.mjs"
import parserBabel from "https://unpkg.com/prettier@2.8.8/esm/parser-babel.mjs"
import parserHtml from "https://unpkg.com/prettier@2.8.8/esm/parser-html.mjs"
import parserCss from "https://unpkg.com/prettier@2.8.8/esm/parser-postcss.mjs"
import workspaceClient from "./workspace-client.mjs"

export const syntaxValidator = {
	/**
	 * Validates content syntax in browser memory using Prettier / JSON.parse.
	 * @param {string} filePath - Path or filename (used for extension detection)
	 * @param {string} content - Unsaved file content string
	 * @returns {{valid: boolean, error?: string, source?: string}}
	 */
	validateClient(filePath, content) {
		if (typeof content !== "string") {
			return { valid: true };
		}

		const cleanPath = (filePath || "").toLowerCase();
		
		// 1. JSON Validation
		if (cleanPath.endsWith(".json")) {
			try {
				JSON.parse(content);
				return { valid: true, source: "prettier/json" };
			} catch (err) {
				return {
					valid: false,
					error: `JSON SyntaxError: ${err.message}`,
					source: "prettier/json"
				};
			}
		}

		// 2. Prettier parser mapping
		let parser = null;
		let plugins = [];

		if (cleanPath.endsWith(".js") || cleanPath.endsWith(".mjs") || cleanPath.endsWith(".jsx") || cleanPath.endsWith(".ts")) {
			parser = "babel";
			plugins = [parserBabel];
		} else if (cleanPath.endsWith(".html") || cleanPath.endsWith(".htm")) {
			parser = "html";
			plugins = [parserHtml];
		} else if (cleanPath.endsWith(".css")) {
			parser = "postcss";
			plugins = [parserCss];
		}

		if (!parser) {
			// Unsupported extension for client prettier check (e.g. go, py, sh) -> pass cleanly
			return { valid: true };
		}

		try {
			prettier.format(content, {
				parser: parser,
				plugins: plugins,
				filepath: filePath
			});
			return { valid: true, source: `prettier/${parser}` };
		} catch (err) {
			let errorMsg = err.message || String(err);
			// Clean up verbose prettier stack trace if present
			if (errorMsg.includes("\n")) {
				const firstLines = errorMsg.split("\n").slice(0, 5).join("\n");
				errorMsg = firstLines;
			}
			return {
				valid: false,
				error: `SyntaxError (${parser}): ${errorMsg}`,
				source: `prettier/${parser}`
			};
		}
	},

	/**
	 * Validates content syntax via backend API (/api/check-syntax).
	 * Sends buffer in-memory without saving to disk.
	 * @param {string} filePath - Path or filename
	 * @param {string} content - Unsaved file content string
	 * @returns {Promise<{valid: boolean, error?: string, nodeAvailable?: boolean, source?: string}>}
	 */
	async validateBackend(filePath, content) {
		try {
			const result = await workspaceClient.checkSyntax(filePath, content);
			return {
				valid: !!result.valid,
				error: result.error || undefined,
				nodeAvailable: result.nodeAvailable !== false,
				source: "backend/node"
			};
		} catch (err) {
			// If backend request fails (e.g. offline/network), do not block save
			return { valid: true, error: undefined, source: "backend/error-fallback" };
		}
	},

	/**
	 * Comprehensive syntax validation combining client-side Prettier & backend Node -c API.
	 * Runs without modifying or writing the file to disk.
	 * @param {string} filePath - Path or filename
	 * @param {string} content - Unsaved file content string
	 * @returns {Promise<{valid: boolean, error?: string, source?: string}>}
	 */
	async validate(filePath, content) {
		// First check via client Prettier/JSON parser
		const clientResult = this.validateClient(filePath, content);
		if (!clientResult.valid) {
			return clientResult;
		}

		// Second check via backend Node -c endpoint (if applicable)
		const backendResult = await this.validateBackend(filePath, content);
		if (!backendResult.valid) {
			return backendResult;
		}

		return { valid: true };
	}
};

export default syntaxValidator;
