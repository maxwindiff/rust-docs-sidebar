import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as util from 'util';
import * as path from 'path';
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';

hljs.registerLanguage('rust', rust);

const execFilePromise = util.promisify(child_process.execFile);

// Constants
const MIN_DOC_SENTENCES = 3;
const MAX_GREP_CONTEXT_LINES = 1000;
const MAX_HISTORY_ENTRIES = 20;
const MAX_DOC_LINES_TO_SCAN = 30;
const MAX_SIGNATURE_CONTINUATION_LINES = 20;

// Input validation: only allow valid Rust identifiers with generics
function isValidRustIdentifier(name: string): boolean {
	return /^[a-zA-Z_][a-zA-Z0-9_<>:,\s]*$/.test(name);
}

// Path validation: ensure path is safe and within expected locations
function isPathSafe(filePath: string, workspaceFolder?: vscode.WorkspaceFolder): boolean {
	const absolutePath = path.resolve(filePath);

	// Allow .rs files in workspace
	if (workspaceFolder) {
		const workspacePath = workspaceFolder.uri.fsPath;
		if (absolutePath.startsWith(workspacePath) && absolutePath.endsWith('.rs')) {
			return true;
		}
	}

	// Allow .rs files in rustup toolchain directories
	if (absolutePath.includes('/.rustup/') && absolutePath.endsWith('.rs')) {
		return true;
	}

	// Allow .rs files in cargo registry
	if (absolutePath.includes('/.cargo/registry/') && absolutePath.endsWith('.rs')) {
		return true;
	}

	return false;
}

// Strip grep output prefix (filename.rs: or filename.rs-)
function stripGrepPrefix(line: string): string {
	const match = line.match(/^[^:]+\.rs[:|-]/);
	return match ? line.substring(match[0].length) : line;
}

// Count sentences in documentation text
function countDocSentences(text: string): number {
	const sentences = text.split(/[.!?](?:\s+|$)/).filter(s => s.trim().length > 0);
	return sentences.length;
}

// Check if documentation meets minimum quality threshold
function hasMinimumDocs(doc: string, minSentences: number = MIN_DOC_SENTENCES): boolean {
	return countDocSentences(doc) >= minSentences;
}

interface NavigationEntry {
	content: string;
	title: string;
}

class RustDocsProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _history: NavigationEntry[] = [];
	private _historyIndex: number = -1;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				if (message.command === 'showMethodDocs') {
					const methodName = message.methodName;
					const structName = message.structName;
					const filePath = message.filePath;

					// Validate inputs
					if (!isValidRustIdentifier(methodName) || !isValidRustIdentifier(structName)) {
						outputChannel.appendLine(`Invalid identifier: ${methodName} or ${structName}`);
						return;
					}

					const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
					if (!isPathSafe(filePath, workspaceFolder)) {
						outputChannel.appendLine(`Unsafe file path: ${filePath}`);
						return;
					}

					outputChannel.appendLine(`Clicked method: ${methodName} for struct ${structName}`);
					const methodDocs = await getMethodDocumentation(methodName, structName, filePath);
					this.updateContent(methodDocs, `${structName}::${methodName}`);
				} else if (message.command === 'goBack') {
					this.goBack();
				} else if (message.command === 'goForward') {
					this.goForward();
				} else if (message.command === 'openFile') {
					const filePath = message.filePath;
					const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

					// Validate file path
					if (!isPathSafe(filePath, workspaceFolder)) {
						outputChannel.appendLine(`Unsafe file path: ${filePath}`);
						return;
					}

					const uri = vscode.Uri.file(filePath);
					const document = await vscode.workspace.openTextDocument(uri);
					const editor = await vscode.window.showTextDocument(document);
					const line = message.line || 0;
					const position = new vscode.Position(line, 0);
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
				}
			} catch (error) {
				outputChannel.appendLine(`Error handling message: ${error instanceof Error ? error.message : 'Unknown error'}`);
			}
		});

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, 'Select a Rust symbol to view documentation', '', false, false);
	}

	public updateContent(content: string, title: string = '', addToHistory: boolean = true) {
		if (this._view) {
			// Filter out invalid/partial symbols
			const isInvalidSymbol = content.includes('Use rust-analyzer hover') ||
			                        (title.length === 1 && /^[a-z]$/.test(title));

			// Add to history (unless we're navigating, it's placeholder content, invalid symbol, or identical to the last entry)
			const lastEntry = this._historyIndex >= 0 ? this._history[this._historyIndex] : null;
			const isDuplicate = lastEntry && lastEntry.title === title && lastEntry.content === content;

			if (addToHistory && !content.includes('No hover information available') && !isInvalidSymbol && !isDuplicate) {
				// If we're in the middle of history, clear forward history
				if (this._historyIndex >= 0 && this._historyIndex < this._history.length - 1) {
					this._history = this._history.slice(0, this._historyIndex + 1);
				}

				this._history.push({ content, title });
				this._historyIndex = this._history.length - 1;

				// Limit history to MAX_HISTORY_ENTRIES
				if (this._history.length > MAX_HISTORY_ENTRIES) {
					this._history.shift();
					this._historyIndex = this._history.length - 1;
				}
			}

			// Don't update UI for invalid symbols
			if (isInvalidSymbol) {
				return;
			}

			const canGoBack = this._historyIndex > 0;
			const canGoForward = this._historyIndex < this._history.length - 1;

			this._view.webview.html = this._getHtmlForWebview(this._view.webview, content, title, canGoBack, canGoForward);
		}
	}

	private goBack() {
		if (this._historyIndex > 0) {
			this._historyIndex--;
			const entry = this._history[this._historyIndex];
			const canGoBack = this._historyIndex > 0;
			const canGoForward = this._historyIndex < this._history.length - 1;
			if (this._view) {
				this._view.webview.html = this._getHtmlForWebview(this._view.webview, entry.content, entry.title, canGoBack, canGoForward);
			}
		}
	}

	private goForward() {
		if (this._historyIndex < this._history.length - 1) {
			this._historyIndex++;
			const entry = this._history[this._historyIndex];
			const canGoBack = this._historyIndex > 0;
			const canGoForward = this._historyIndex < this._history.length - 1;
			if (this._view) {
				this._view.webview.html = this._getHtmlForWebview(this._view.webview, entry.content, entry.title, canGoBack, canGoForward);
			}
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview, content: string, title: string, canGoBack: boolean, canGoForward: boolean) {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					/* Highlight.js syntax highlighting */
					.hljs { display: block; overflow-x: auto; padding: 0; }
					.hljs-comment, .hljs-quote { color: var(--vscode-editor-foreground); opacity: 0.6; font-style: italic; }
					.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: #569CD6; }
					.hljs-string { color: #CE9178; }
					.hljs-number { color: #B5CEA8; }
					.hljs-built_in, .hljs-title, .hljs-function { color: #DCDCAA; }
					.hljs-params { color: #9CDCFE; }
					.hljs-meta { color: #808080; }
					.hljs-attr, .hljs-variable { color: #9CDCFE; }

					body {
						padding: 10px;
						color: var(--vscode-foreground);
						font-family: var(--vscode-font-family);
					}
					pre {
						background-color: var(--vscode-textCodeBlock-background);
						padding: 10px;
						border-radius: 4px;
						overflow-x: auto;
					}
					code {
						font-family: var(--vscode-editor-font-family);
					}
					pre code {
						background: none;
						padding: 0;
					}
					h1, h2, h3, h4 {
						color: var(--vscode-editor-foreground);
					}
					h3 a {
						cursor: pointer;
						text-decoration: none;
					}
					h3 a:hover {
						text-decoration: underline;
					}
					hr {
						border: none;
						border-top: 1px solid var(--vscode-panel-border);
						margin: 16px 0;
						opacity: 0.5;
					}
					ul {
						margin: 8px 0;
						padding-left: 20px;
					}
					li {
						margin: 4px 0;
					}
					details {
						margin-top: 16px;
						font-size: 12px;
						color: var(--vscode-descriptionForeground);
					}
					summary {
						cursor: pointer;
						user-select: none;
					}
					a.method-link {
						color: var(--vscode-textLink-foreground);
						text-decoration: none;
						cursor: pointer;
					}
					a.method-link:hover {
						text-decoration: underline;
					}
					a[href*="implementations"] {
						display: none;
					}
					.nav-bar {
						display: flex;
						gap: 8px;
						padding: 8px 0;
						border-bottom: 1px solid var(--vscode-panel-border);
						margin-bottom: 12px;
					}
					.nav-button {
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						padding: 4px 12px;
						cursor: pointer;
						border-radius: 2px;
						font-size: 12px;
					}
					.nav-button:hover:not(:disabled) {
						background: var(--vscode-button-hoverBackground);
					}
					.nav-button:disabled {
						opacity: 0.4;
						cursor: not-allowed;
					}
					.nav-title {
						flex: 1;
						font-size: 12px;
						color: var(--vscode-descriptionForeground);
						align-self: center;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
				</style>
				<script>
					const vscode = acquireVsCodeApi();
					function showMethodDocs(fnName, structName, filePath) {
						vscode.postMessage({
							command: 'showMethodDocs',
							methodName: fnName,
							structName: structName,
							filePath: filePath
						});
					}
					function goBack() {
						vscode.postMessage({ command: 'goBack' });
					}
					function goForward() {
						vscode.postMessage({ command: 'goForward' });
					}
					function openFile(filePath, line) {
						vscode.postMessage({ command: 'openFile', filePath: filePath, line: line });
					}
				</script>
			</head>
			<body>
				<div class="nav-bar">
					<button class="nav-button" onclick="goBack()" ${canGoBack ? '' : 'disabled'}>← Back</button>
					<button class="nav-button" onclick="goForward()" ${canGoForward ? '' : 'disabled'}>Forward →</button>
					${title ? `<div class="nav-title">${escapeHtml(title)}</div>` : ''}
				</div>
				${content}
			</body>
			</html>`;
	}
}

async function getRustDocumentation(symbol: string, documentUri: vscode.Uri): Promise<string | null> {
	try {
		// Validate symbol is a valid Rust identifier
		if (!isValidRustIdentifier(symbol)) {
			outputChannel.appendLine(`Invalid symbol name: ${symbol}`);
			return null;
		}

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
		const cwd = workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!cwd) {
			return '<p>No workspace folder found</p>';
		}

		const { stdout } = await execFilePromise('rustup', ['doc', '--path'], { cwd });
		const docsPath = stdout.trim();

		// Use execFile with array arguments to prevent command injection
		const searchResult = await execFilePromise('rg', [
			'-i',
			`^${symbol}`,
			docsPath,
			'--type', 'html',
			'-l'
		], { cwd }).then(result => {
			// Limit to first 5 lines
			const lines = result.stdout.trim().split('\n').slice(0, 5);
			return { stdout: lines.join('\n') };
		}).catch(() => ({ stdout: '' }));

		if (!searchResult.stdout.trim()) {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const position = editor.selection.active;
				const hoverInfo = await getHoverInfo(symbol, documentUri);
				const result = await getStructMethods(symbol, documentUri, position);
				if (hoverInfo) {
					return formatHoverInfo(hoverInfo, result, documentUri, position);
				}
			}
			return null;
		}

		return `<h2>${symbol}</h2>
				<p>Documentation path: <code>${searchResult.stdout.trim().split('\n')[0]}</code></p>
				<p>Use rust-analyzer hover for detailed information</p>`;
	} catch (error) {
		return `<p>Error fetching documentation: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
	}
}

async function getHoverInfo(symbol: string, documentUri: vscode.Uri): Promise<vscode.Hover[] | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.toString() !== documentUri.toString()) {
		return undefined;
	}

	const position = editor.selection.active;
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		'vscode.executeHoverProvider',
		documentUri,
		position
	);

	return hovers;
}

interface MethodInfo {
	signature: string;
	doc: string;
	line: number;
	implBlock?: string;
}

interface ImplBlock {
	header: string;
	comment?: string;
	methods: MethodInfo[];
}

interface StructMethodsResult {
	methods: MethodInfo[];
	implBlocks: ImplBlock[];
	structName: string;
	filePath: string;
}

// Render a single method as HTML list item
function renderMethodListItem(method: MethodInfo, structName: string, filePath: string): string {
	const fnNameMatch = method.signature.match(/^(\w+)/);
	const fnName = fnNameMatch ? fnNameMatch[1] : '';

	const parts: string[] = [];
	parts.push('<li style="margin-bottom: 12px;">');
	parts.push(`<code><a href="#" class="method-link" onclick="showMethodDocs('${escapeHtml(fnName)}', '${escapeHtml(structName)}', '${escapeHtml(filePath)}'); return false;">${escapeHtml(method.signature)}</a></code>`);

	if (method.doc) {
		const docHtml = markdownToHtml(method.doc, false);
		parts.push(`<div style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; margin-left: 0;">${docHtml}</div>`);
	}

	parts.push('</li>');
	return parts.join('');
}

// Render methods list with optional filtering
function renderMethodsList(methods: MethodInfo[], structName: string, filePath: string, filterByDocs: boolean = true): string {
	const parts: string[] = [];
	parts.push('<ul style="list-style: none; padding-left: 0;">');

	for (const method of methods) {
		if (filterByDocs && !hasMinimumDocs(method.doc)) {
			continue;
		}
		parts.push(renderMethodListItem(method, structName, filePath));
	}

	parts.push('</ul>');
	return parts.join('');
}

async function getMethodDocumentation(methodName: string, structName: string, filePath: string): Promise<string> {
	try {
		outputChannel.appendLine(`Getting full docs for ${structName}::${methodName} from ${filePath}`);

		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		const text = document.getText();
		const lines = text.split('\n');

		// Find the method
		let methodStart = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(`fn ${methodName}(`)) {
				methodStart = i;
				break;
			}
		}

		if (methodStart === -1) {
			return `<h2>${structName}::${methodName}</h2><p>Method not found</p>`;
		}

		// Collect all doc comments before the method
		const docLines: string[] = [];
		for (let i = methodStart - 1; i >= 0; i--) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('///')) {
				docLines.unshift(trimmed.substring(3).trim());
			} else if (trimmed.startsWith('#[') || trimmed === '') {
				continue;
			} else {
				break;
			}
		}

		// Get the method signature
		let signature = '';
		for (let i = methodStart; i < lines.length; i++) {
			signature += lines[i].trim() + ' ';
			if (lines[i].includes('{')) {
				break;
			}
		}

		signature = signature.replace(/\s+/g, ' ').trim();
		if (signature.includes('{')) {
			signature = signature.substring(0, signature.indexOf('{')).trim();
		}

		let content = `<h2>${structName}::${methodName}</h2>`;
		content += `<pre><code>${escapeHtml(signature)}</code></pre>`;

		if (docLines.length > 0) {
			content += '<div>';
			content += markdownToHtml(docLines.join('\n'), false);
			content += '</div>';
		}

		return content;
	} catch (error) {
		return `<h2>${structName}::${methodName}</h2><p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
	}
}

async function getStructMethods(symbol: string, documentUri: vscode.Uri, position: vscode.Position): Promise<StructMethodsResult> {
	try {
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeDefinitionProvider',
			documentUri,
			position
		);

		if (!definitions || definitions.length === 0) {
			return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
		}

		const defLocation = definitions[0];

		const defUri = 'targetUri' in defLocation ? (defLocation as any).targetUri : (defLocation as vscode.Location).uri;
		const defRange = 'targetRange' in defLocation ? (defLocation as any).targetRange : (defLocation as vscode.Location).range;

		if (!defUri) {
			return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
		}

		const defPath = defUri.fsPath;

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
		const cwd = workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!cwd) {
			return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
		}

		const isExternalCrate = !defPath.includes(cwd);

		let searchPattern: string;
		let searchPath: string;

		const document = await vscode.workspace.openTextDocument(defUri);
		const defText = document.getText();
		const lines = defText.split('\n');
		const startLine = defRange.start.line;

		let structName: string | undefined;

		for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
			const line = lines[i];
			const structMatch = line.match(/(?:pub\s+)?struct\s+(\w+)/);
			const typeAliasMatch = line.match(/(?:pub\s+)?type\s+(\w+)\s*=\s*(\w+)/);

			if (typeAliasMatch) {
				structName = typeAliasMatch[2];
				break;
			} else if (structMatch) {
				structName = structMatch[1];
				break;
			}
		}

		if (!structName) {
			structName = symbol;
		}

		// Validate struct name before using in regex
		if (!isValidRustIdentifier(structName)) {
			outputChannel.appendLine(`Invalid struct name: ${structName}`);
			return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
		}

		searchPattern = `impl\\s+(?:<[^>]+>\\s+)?${structName}(?:<[^>]*>)?\\s*(?:for\\s+)?\\s*\\{`;

		if (isExternalCrate) {
			const defDir = defPath.substring(0, defPath.lastIndexOf('/'));
			searchPath = defDir;
		} else {
			searchPath = cwd;
		}

		// Use execFile to prevent command injection
		const { stdout } = await execFilePromise('grep', [
			'-r',
			'-E',
			searchPattern,
			searchPath,
			'--include=*.rs',
			'-A', MAX_GREP_CONTEXT_LINES.toString()
		], { cwd, maxBuffer: 10 * 1024 * 1024 }).catch((err) => {
			// grep returns exit code 1 when no matches found, which is not an error
			return { stdout: err.stdout || '' };
		});

		if (!stdout.trim()) {
			return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
		}

		const methods: Array<{signature: string, doc: string, line: number}> = [];
		const implBlocks: ImplBlock[] = [];
		let currentImplBlock: ImplBlock | null = null;

		const outputLines = stdout.split('\n');
		for (let i = 0; i < outputLines.length; i++) {
			let line = stripGrepPrefix(outputLines[i]);

			// Check for impl block start
			const implMatch = line.match(/^(impl(?:\s+<[^>]+>)?\s+(?:[\w:]+(?:\s+for\s+)?)?[\w<>:]+)\s*\{/);
			if (implMatch) {
				// Save previous impl block if it exists
				if (currentImplBlock && currentImplBlock.methods.length > 0) {
					implBlocks.push(currentImplBlock);
				}

				// Look backwards for comment before impl block
				let implComment = '';
				for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
					const prevLine = stripGrepPrefix(outputLines[j]);
					const trimmed = prevLine.trim();
					if (trimmed.startsWith('///')) {
						implComment = trimmed.substring(3).trim();
						break;
					} else if (trimmed === '' || trimmed === '--') {
						continue;
					} else {
						break;
					}
				}

				currentImplBlock = {
					header: implMatch[1].trim(),
					comment: implComment || undefined,
					methods: []
				};
			}

			const fnMatch = line.match(/(?:pub\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(.+)/);

			if (fnMatch) {
				let signature = fnMatch[1].trim();

				// If signature doesn't contain '{' and doesn't end with ')', collect continuation lines
				if (!signature.includes('{') && !signature.endsWith(')')) {
					for (let k = i + 1; k < outputLines.length && k < i + MAX_SIGNATURE_CONTINUATION_LINES; k++) {
						const nextLine = stripGrepPrefix(outputLines[k]);
						const trimmed = nextLine.trim();
						if (trimmed === '--' || trimmed === '') {
							continue;
						}

						signature += ' ' + trimmed;

						if (trimmed.includes('{')) {
							break;
						}
					}
				}

				if (signature.includes('{')) {
					signature = signature.substring(0, signature.indexOf('{')).trim();
				}

				// Normalize whitespace: remove extra spaces after '(' and before ')'
				signature = signature.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
				// Normalize multiple spaces to single space
				signature = signature.replace(/\s+/g, ' ');

				if (signature && !signature.startsWith('_')) {
					let doc = '';
					let docLines: string[] = [];

					// Collect all doc lines
					for (let j = i - 1; j >= 0 && j >= Math.max(0, i - MAX_DOC_LINES_TO_SCAN); j--) {
						let prevLine = outputLines[j];

						// Use helper to strip grep prefix
						prevLine = stripGrepPrefix(prevLine);

						const trimmed = prevLine.trim();

						if (trimmed === '--' || trimmed === '') {
							continue;
						}

						if (trimmed.startsWith('///')) {
							const docLine = trimmed.substring(3).trim();
							if (docLine && !docLine.startsWith('```') && !docLine.startsWith('#') && !docLine.startsWith('assert') && !docLine.startsWith('[') && !docLine.startsWith('*')) {
								docLines.unshift(docLine); // Add to beginning
							}
						} else if (trimmed.startsWith('//!') || trimmed.startsWith('//')) {
							continue;
						} else if (trimmed.startsWith('#[')) {
							continue;
						} else {
							if (docLines.length > 0) {
								break;
							}
						}
					}

					// Use first paragraph (up to MIN_DOC_SENTENCES lines or until empty line)
					if (docLines.length > 0) {
						const paragraph: string[] = [];
						for (const line of docLines) {
							if (line === '') {
								break;
							}
							paragraph.push(line);
							if (paragraph.length >= MIN_DOC_SENTENCES) {
								break;
							}
						}
						doc = paragraph.join(' ');
					}

					const method = { signature, doc, line: i };
					methods.push(method);
					if (currentImplBlock) {
						currentImplBlock.methods.push(method);
					}
				}
			}
		}

		// Save the last impl block
		if (currentImplBlock && currentImplBlock.methods.length > 0) {
			implBlocks.push(currentImplBlock);
		}

		return { methods, implBlocks, structName, filePath: defPath };
	} catch (error) {
		return { methods: [], implBlocks: [], structName: symbol, filePath: '' };
	}
}

async function formatHoverInfo(hovers: vscode.Hover[], result?: StructMethodsResult, documentUri?: vscode.Uri, position?: vscode.Position): Promise<string | null> {
	if (!hovers || hovers.length === 0) {
		return null;
	}

	// Count documentation sentences from markdown content
	let docSentenceCount = 0;
	for (const hover of hovers) {
		for (const item of hover.contents) {
			let textContent = '';
			if (typeof item === 'string') {
				textContent = item;
			} else if (item instanceof vscode.MarkdownString) {
				textContent = item.value;
			} else if ('value' in item) {
				if ('language' in item && item.language) {
					continue; // Skip code blocks
				}
				textContent = item.value;
			}

			docSentenceCount += countDocSentences(textContent);
		}
	}

	// Filter out symbols with insufficient documentation
	if (docSentenceCount < MIN_DOC_SENTENCES) {
		return null;
	}

	let filePath = '';
	let line = 0;

	// Use result's filePath if available
	if (result && result.filePath) {
		filePath = result.filePath;
		// Try to get the line from definition provider
		if (documentUri && position) {
			try {
				const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
					'vscode.executeDefinitionProvider',
					documentUri,
					position
				);
				if (definitions && definitions.length > 0) {
					const defLocation = definitions[0];
					const defRange = 'targetRange' in defLocation ? (defLocation as any).targetRange : (defLocation as vscode.Location).range;
					if (defRange) {
						line = defRange.start.line;
					}
				}
			} catch (error) {
				// Ignore errors
			}
		}
	} else if (documentUri && position) {
		// Fallback: Get definition location
		try {
			const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeDefinitionProvider',
				documentUri,
				position
			);
			if (definitions && definitions.length > 0) {
				const defLocation = definitions[0];
				const defUri = 'targetUri' in defLocation ? (defLocation as any).targetUri : (defLocation as vscode.Location).uri;
				const defRange = 'targetRange' in defLocation ? (defLocation as any).targetRange : (defLocation as vscode.Location).range;
				if (defUri) {
					filePath = defUri.fsPath;
					line = defRange.start.line;
				}
			}
		} catch (error) {
			// Ignore errors
		}
	}

	let content = '<div>';
	let isFirst = true;
	let isStruct = false;

	for (const hover of hovers) {
		for (const item of hover.contents) {
			if (typeof item === 'string') {
				content += `<p>${item}</p>`;
			} else if (item instanceof vscode.MarkdownString) {
				content += markdownToHtml(item.value, isFirst, filePath, line);
				isFirst = false;
			} else if ('value' in item) {
				const value = item.value;
				if ('language' in item && item.language) {
					if (isFirst) {
						const lines = value.split('\n');
						const firstLine = lines[0].trim();
						if (firstLine.startsWith('struct ')) {
							isStruct = true;
						}
						if (filePath) {
							content += `<h3><a href="#" onclick="openFile('${escapeHtml(filePath)}', ${line}); return false;">${escapeHtml(firstLine)}</a></h3>`;
						} else {
							content += `<h3>${escapeHtml(firstLine)}</h3>`;
						}
						if (lines.length > 1) {
							const restCode = lines.slice(1).join('\n').trim();
							const highlighted = item.language === 'rust' ? hljs.highlight(restCode, { language: 'rust' }).value : escapeHtml(restCode);
							content += `<pre><code class="hljs">${highlighted}</code></pre>`;
						}
						isFirst = false;
					} else {
						const highlighted = item.language === 'rust' ? hljs.highlight(value, { language: 'rust' }).value : escapeHtml(value);
						content += `<pre><code class="hljs">${highlighted}</code></pre>`;
					}
				} else {
					content += `<p>${value}</p>`;
				}
			}
		}
	}

	if (result && result.implBlocks && result.implBlocks.length > 0) {
		for (const implBlock of result.implBlocks) {
			// Show impl block header
			const header = implBlock.comment ? escapeHtml(implBlock.comment) : escapeHtml(implBlock.header);
			content += `<h4>${header}</h4>`;
			content += renderMethodsList(implBlock.methods, result.structName, result.filePath);
		}
	} else if (result && result.methods && result.methods.length > 0) {
		// Fallback: show methods without grouping if implBlocks is empty
		content += '<h4>Methods</h4>';
		content += renderMethodsList(result.methods, result.structName, result.filePath);
	}

	content += '</div>';
	return content;
}

function markdownToHtml(markdown: string, isFirst: boolean = false, filePath: string = '', line: number = 0): string {
	let html = markdown.trim();

	html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
		if (isFirst) {
			const lines = code.trim().split('\n');
			const firstLine = lines[0].trim();
			let result = '';
			if (filePath) {
				result = `<h3><a href="#" onclick="openFile('${escapeHtml(filePath)}', ${line}); return false;">${escapeHtml(firstLine)}</a></h3>`;
			} else {
				result = `<h3>${escapeHtml(firstLine)}</h3>`;
			}
			if (lines.length > 1) {
				const restCode = lines.slice(1).join('\n').trim();
				const highlighted = lang === 'rust' ? hljs.highlight(restCode, { language: 'rust' }).value : escapeHtml(restCode);
				result += `<pre><code class="hljs">${highlighted}</code></pre>`;
			}
			isFirst = false;
			return result;
		}
		const highlighted = lang === 'rust' ? hljs.highlight(code.trim(), { language: 'rust' }).value : escapeHtml(code.trim());
		return `<pre><code class="hljs">${highlighted}</code></pre>`;
	});

	html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

	html = html.replace(/^---$/gm, '<hr>');
	html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
	html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
	html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

	html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	html = html.replace(/\n\n/g, '</p><p>');
	html = html.replace(/\n/g, '<br>');

	if (!html.startsWith('<h') && !html.startsWith('<pre')) {
		html = '<p>' + html + '</p>';
	}

	return html;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

const outputChannel = vscode.window.createOutputChannel('Rust Docs Sidebar');

export function activate(context: vscode.ExtensionContext) {
	const provider = new RustDocsProvider(context.extensionUri);

	context.subscriptions.push(outputChannel);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('rust-docs-sidebar.docsView', provider)
	);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(async (event) => {
			try {
				const editor = event.textEditor;
				if (editor.document.languageId !== 'rust') {
					return;
				}

				const position = editor.selection.active;
				const wordRange = editor.document.getWordRangeAtPosition(position);

				if (wordRange) {
					const word = editor.document.getText(wordRange);
					const documentation = await getRustDocumentation(word, editor.document.uri);
					if (documentation !== null) {
						provider.updateContent(documentation);
					}
				}
			} catch (error) {
				outputChannel.appendLine(`Error in selection handler: ${error instanceof Error ? error.message : 'Unknown error'}`);
			}
		})
	);
}

export function deactivate() {}
