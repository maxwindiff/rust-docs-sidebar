import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as util from 'util';

const execPromise = util.promisify(child_process.exec);

class RustDocsProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;

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
			if (message.command === 'showMethodDocs') {
				const methodName = message.methodName;
				outputChannel.appendLine(`Clicked method: ${methodName}`);
				vscode.window.showInformationMessage(`Method: ${methodName} (full docs coming soon)`);
			}
		});

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, 'Select a Rust symbol to view documentation');
	}

	public updateContent(content: string) {
		if (this._view) {
			this._view.webview.html = this._getHtmlForWebview(this._view.webview, content);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview, content: string) {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
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
					h1, h2, h3, h4 {
						color: var(--vscode-editor-foreground);
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
				</style>
				<script>
					const vscode = acquireVsCodeApi();
					function showMethodDocs(fnName) {
						vscode.postMessage({
							command: 'showMethodDocs',
							methodName: fnName
						});
					}
				</script>
			</head>
			<body>
				${content}
			</body>
			</html>`;
	}
}

async function getRustDocumentation(symbol: string, documentUri: vscode.Uri): Promise<string> {
	try {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
		const cwd = workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!cwd) {
			return '<p>No workspace folder found</p>';
		}

		const { stdout } = await execPromise(`rustup doc --path`, { cwd });
		const docsPath = stdout.trim();

		const searchResult = await execPromise(
			`rg -i "^${symbol}" "${docsPath}" --type html -l | head -5`,
			{ cwd }
		).catch(() => ({ stdout: '' }));

		if (!searchResult.stdout.trim()) {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const position = editor.selection.active;
				const hoverInfo = await getHoverInfo(symbol, documentUri);
				const { methods, diagnostics } = await getStructMethods(symbol, documentUri, position);
				if (hoverInfo) {
					return formatHoverInfo(hoverInfo, methods, diagnostics);
				}
			}
			return `<p>No documentation found for symbol: <code>${symbol}</code></p>`;
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
}

async function getStructMethods(symbol: string, documentUri: vscode.Uri, position: vscode.Position): Promise<{methods: MethodInfo[], diagnostics: string[]}> {
	const diagnostics: string[] = [];

	function log(msg: string) {
		diagnostics.push(msg);
		outputChannel.appendLine(msg);
	}

	try {
		log(`Starting method search for symbol: ${symbol}`);

		const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeDefinitionProvider',
			documentUri,
			position
		);

		if (!definitions || definitions.length === 0) {
			log('No definitions found');
			return { methods: [], diagnostics };
		}

		log(`Found ${definitions.length} definition(s)`);

		const defLocation = definitions[0];
		log(`Definition location type: ${typeof defLocation}`);
		log(`Definition location keys: ${Object.keys(defLocation).join(', ')}`);

		const defUri = 'targetUri' in defLocation ? (defLocation as any).targetUri : (defLocation as vscode.Location).uri;
		const defRange = 'targetRange' in defLocation ? (defLocation as any).targetRange : (defLocation as vscode.Location).range;

		if (!defUri) {
			log('Definition has no URI');
			return { methods: [], diagnostics };
		}

		const defPath = defUri.fsPath;
		log(`Definition path: ${defPath}`);

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
		const cwd = workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!cwd) {
			log('No workspace folder found');
			return { methods: [], diagnostics };
		}

		log(`Workspace folder: ${cwd}`);

		const isExternalCrate = !defPath.includes(cwd);
		log(`Is external crate: ${isExternalCrate}`);

		let searchPattern: string;
		let searchPath: string;

		const document = await vscode.workspace.openTextDocument(defUri);
		const defText = document.getText();
		const lines = defText.split('\n');
		const startLine = defRange.start.line;

		log(`Definition start line: ${lines[startLine]}`);

		let structName: string | undefined;

		for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
			const line = lines[i];
			const structMatch = line.match(/(?:pub\s+)?struct\s+(\w+)/);
			const typeAliasMatch = line.match(/(?:pub\s+)?type\s+(\w+)\s*=\s*(\w+)/);

			if (typeAliasMatch) {
				structName = typeAliasMatch[2];
				log(`Found type alias on line ${i}: ${typeAliasMatch[1]} = ${structName}`);
				break;
			} else if (structMatch) {
				structName = structMatch[1];
				log(`Found struct on line ${i}: ${structName}`);
				break;
			}
		}

		if (!structName) {
			structName = symbol;
			log(`Using symbol as fallback: ${structName}`);
		}

		searchPattern = `impl\\s+(?:<[^>]+>\\s+)?${structName}(?:<[^>]*>)?\\s*(?:for\\s+)?\\s*\\{`;

		if (isExternalCrate) {
			const defDir = defPath.substring(0, defPath.lastIndexOf('/'));
			searchPath = defDir;
		} else {
			searchPath = cwd;
		}

		log(`Search pattern: ${searchPattern}`);
		log(`Search path: ${searchPath}`);

		const grepCommand = `grep -r -E "${searchPattern}" "${searchPath}" --include="*.rs" -A 200 || true`;
		log(`Running command: ${grepCommand}`);

		const { stdout } = await execPromise(grepCommand, { cwd }).catch((err) => {
			log(`Grep error: ${err.message}`);
			log(`Exit code: ${err.code}`);
			return { stdout: err.stdout || '' };
		});

		log(`Grep output length: ${stdout.length} chars`);

		if (!stdout.trim()) {
			log('No impl blocks found');
			return { methods: [], diagnostics };
		}

		const methods: Array<{signature: string, doc: string, line: number}> = [];

		const outputLines = stdout.split('\n');
		for (let i = 0; i < outputLines.length; i++) {
			let line = outputLines[i];

			// Strip grep prefix: either "file.rs:" or "file.rs-"
			const match = line.match(/^[^:]+\.rs[:|-]/);
			if (match) {
				line = line.substring(match[0].length);
			}

			const fnMatch = line.match(/(?:pub\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(.+)/);

			if (fnMatch) {
				let signature = fnMatch[1].trim();

				if (signature.includes('{')) {
					signature = signature.substring(0, signature.indexOf('{')).trim();
				}

				if (signature && !signature.startsWith('_')) {
					let doc = '';
					const fnName = signature.split('(')[0];
					let debugLines: string[] = [];
					let docLines: string[] = [];

					// Collect all doc lines
					for (let j = i - 1; j >= 0 && j >= Math.max(0, i - 30); j--) {
						let prevLine = outputLines[j];

						// Strip grep prefix: either "file.rs:" or "file.rs-"
						const match = prevLine.match(/^[^:]+\.rs[:|-]/);
						if (match) {
							prevLine = prevLine.substring(match[0].length);
						}

						const trimmed = prevLine.trim();

						if (j >= i - 5) {
							debugLines.push(`  [${i - j}] "${trimmed.substring(0, 60)}"`);
						}

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

					// Use first paragraph (up to 3 lines or until empty line)
					if (docLines.length > 0) {
						const paragraph: string[] = [];
						for (const line of docLines) {
							if (line === '') {
								break;
							}
							paragraph.push(line);
							if (paragraph.length >= 3) {
								break;
							}
						}
						doc = paragraph.join(' ');
					}

					if (!doc && debugLines.length > 0) {
						log(`No doc found for ${fnName}, previous lines:`);
						debugLines.forEach(l => log(l));
					}

					const methodLog = `Method: ${signature.substring(0, 40)}`;
					const docLog = doc ? `Doc: "${doc}"` : 'Doc: (none)';
					log(`${methodLog} | ${docLog}`);
					methods.push({ signature, doc, line: i });
				}
			}
		}

		log(`Found ${methods.length} methods`);

		return { methods, diagnostics };
	} catch (error) {
		log(`Exception: ${error instanceof Error ? error.message : 'Unknown error'}`);
		return { methods: [], diagnostics };
	}
}

function formatHoverInfo(hovers: vscode.Hover[], methods?: MethodInfo[], diagnostics?: string[]): string {
	if (!hovers || hovers.length === 0) {
		return '<p>No hover information available</p>';
	}

	let content = '<div>';
	let isFirst = true;
	let isStruct = false;

	for (const hover of hovers) {
		for (const item of hover.contents) {
			if (typeof item === 'string') {
				content += `<p>${item}</p>`;
			} else if (item instanceof vscode.MarkdownString) {
				content += markdownToHtml(item.value, isFirst);
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
						content += `<h3>${escapeHtml(firstLine)}</h3>`;
						if (lines.length > 1) {
							content += `<pre><code>${escapeHtml(lines.slice(1).join('\n').trim())}</code></pre>`;
						}
						isFirst = false;
					} else {
						content += `<pre><code>${escapeHtml(value)}</code></pre>`;
					}
				} else {
					content += `<p>${value}</p>`;
				}
			}
		}
	}

	if (methods && methods.length > 0) {
		content += '<h4>Methods</h4>';
		content += '<ul style="list-style: none; padding-left: 0;">';
		for (const method of methods) {
			const fnNameMatch = method.signature.match(/^(\w+)/);
			const fnName = fnNameMatch ? fnNameMatch[1] : '';

			content += '<li style="margin-bottom: 12px;">';
			content += `<code><a href="#" class="method-link" onclick="showMethodDocs('${escapeHtml(fnName)}'); return false;">${escapeHtml(method.signature)}</a></code>`;
			if (method.doc) {
				content += `<div style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; margin-left: 0;">${escapeHtml(method.doc)}</div>`;
			}
			content += '</li>';
		}
		content += '</ul>';
	}

	if (diagnostics && diagnostics.length > 0) {
		content += '<details><summary>Diagnostics</summary>';
		content += '<pre style="font-size: 11px; max-height: 300px; overflow-y: auto;">';
		for (const diag of diagnostics) {
			content += escapeHtml(diag) + '\n';
		}
		content += '</pre></details>';
	}

	content += '</div>';
	return content;
}

function markdownToHtml(markdown: string, isFirst: boolean = false): string {
	let html = markdown.trim();

	html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, _lang, code) => {
		if (isFirst) {
			const lines = code.trim().split('\n');
			const firstLine = lines[0].trim();
			let result = `<h3>${escapeHtml(firstLine)}</h3>`;
			if (lines.length > 1) {
				result += `<pre><code>${escapeHtml(lines.slice(1).join('\n').trim())}</code></pre>`;
			}
			isFirst = false;
			return result;
		}
		return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
	});

	html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

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
			const editor = event.textEditor;
			if (editor.document.languageId !== 'rust') {
				return;
			}

			const position = editor.selection.active;
			const wordRange = editor.document.getWordRangeAtPosition(position);

			if (wordRange) {
				const word = editor.document.getText(wordRange);
				const documentation = await getRustDocumentation(word, editor.document.uri);
				provider.updateContent(documentation);
			}
		})
	);
}

export function deactivate() {}
