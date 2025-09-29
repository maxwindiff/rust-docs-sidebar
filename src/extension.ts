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
					h1, h2, h3 {
						color: var(--vscode-editor-foreground);
					}
				</style>
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
			const hoverInfo = await getHoverInfo(symbol, documentUri);
			if (hoverInfo) {
				return formatHoverInfo(hoverInfo);
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

function formatHoverInfo(hovers: vscode.Hover[]): string {
	if (!hovers || hovers.length === 0) {
		return '<p>No hover information available</p>';
	}

	let content = '<div>';
	let isFirst = true;
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

export function activate(context: vscode.ExtensionContext) {
	const provider = new RustDocsProvider(context.extensionUri);

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
