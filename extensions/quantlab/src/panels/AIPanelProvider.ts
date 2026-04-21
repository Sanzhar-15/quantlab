/*---------------------------------------------------------------------------------------------
 *  AI Panel Provider
 *  VS Code webview panel for AI assistant
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	ChatMessage,
	Conversation,
} from '../ai/types';
import { ClaudeProvider } from '../ai/provider';
import { buildQuickContext } from '../ai/context';
import { containsSensitiveData, validateMessageSafety } from '../ai/sanitize';

/**
 * AI Panel Provider for the sidebar.
 */
export class AIPanelProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'quantlab.aiPanel';

	private view?: vscode.WebviewView;
	private conversation: Conversation;
	private readonly provider = ClaudeProvider.getInstance();
	private isStreaming = false;

	constructor(private readonly extensionUri: vscode.Uri) {
		this.conversation = this.createNewConversation();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'sendMessage':
					await this.handleUserMessage(message.content);
					break;
				case 'clearConversation':
					this.clearConversation();
					break;
				case 'addContext':
					await this.addContextToConversation();
					break;
				case 'configure':
					await this.openSettings();
					break;
			}
		});

		// Initialize
		this.updateStatus();
	}

	/**
	 * Handle user message submission.
	 */
	private async handleUserMessage(content: string): Promise<void> {
		if (!content.trim() || this.isStreaming) {
			return;
		}

		// Validate message safety
		const safetyError = validateMessageSafety(content);
		if (safetyError) {
			await vscode.window.showWarningMessage(safetyError);
			return;
		}

		// Warn about sensitive data
		if (containsSensitiveData(content)) {
			const proceed = await vscode.window.showWarningMessage(
				vscode.l10n.t('Your message may contain sensitive data. It will be redacted before sending.'),
				vscode.l10n.t('Continue'),
				vscode.l10n.t('Cancel')
			);
			if (proceed !== vscode.l10n.t('Continue')) {
				return;
			}
		}

		// Create user message
		const userMessage: ChatMessage = {
			role: 'user',
			content,
			timestamp: new Date(),
			id: `msg-${Date.now()}`,
		};

		this.conversation.messages.push(userMessage);
		this.postMessage({ type: 'addMessage', message: userMessage });

		// Check provider status
		if (!this.provider.isReady()) {
			this.postMessage({
				type: 'error',
				message: 'AI not configured. Click the gear icon to set up your API key.',
			});
			return;
		}

		// Stream response
		this.isStreaming = true;
		this.postMessage({ type: 'streamStart' });

		try {
			let fullResponse = '';
			const assistantMessage: ChatMessage = {
				role: 'assistant',
				content: '',
				timestamp: new Date(),
				id: `msg-${Date.now()}-assistant`,
			};

			for await (const chunk of this.provider.streamMessage(
				this.conversation.id,
				this.conversation.messages
			)) {
				fullResponse += chunk;
				this.postMessage({ type: 'streamChunk', content: chunk });
			}

			assistantMessage.content = fullResponse;
			this.conversation.messages.push(assistantMessage);
			this.conversation.updatedAt = new Date();

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.postMessage({ type: 'error', message: errorMessage });
		} finally {
			this.isStreaming = false;
			this.postMessage({ type: 'streamEnd' });
			this.updateStatus();
		}
	}

	/**
	 * Add context from current editor.
	 */
	private async addContextToConversation(): Promise<void> {
		const context = await buildQuickContext(this.conversation.id);
		if (!context) {
			await vscode.window.showInformationMessage(
				vscode.l10n.t('No context available. Open a Python strategy file to add context.')
			);
			return;
		}

		this.postMessage({
			type: 'contextAdded',
			context: context.slice(0, 500) + (context.length > 500 ? '...' : ''),
		});
	}

	/**
	 * Clear the conversation.
	 */
	private clearConversation(): void {
		this.conversation = this.createNewConversation();
		this.postMessage({ type: 'conversationCleared' });
	}

	/**
	 * Open AI settings.
	 */
	private async openSettings(): Promise<void> {
		await vscode.commands.executeCommand(
			'workbench.action.openSettings',
			'quantlab.ai'
		);
	}

	/**
	 * Update status in webview.
	 */
	private updateStatus(): void {
		const status = this.provider.getStatus();
		const rateLimit = this.provider.getRateLimitInfo();

		this.postMessage({
			type: 'statusUpdate',
			status,
			rateLimit: {
				remaining: rateLimit.requestsRemaining,
				max: rateLimit.maxRequestsPerHour,
			},
		});
	}

	/**
	 * Post message to webview.
	 */
	private postMessage(message: any): void {
		this.view?.webview.postMessage(message);
	}

	/**
	 * Create a new conversation.
	 */
	private createNewConversation(): Conversation {
		return {
			id: `conv-${Date.now()}`,
			messages: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	/**
	 * Generate webview HTML.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Quantlab AI</title>
	<style>
		body {
			padding: 0;
			margin: 0;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
		}

		.container {
			display: flex;
			flex-direction: column;
			height: 100vh;
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.header-title {
			font-weight: 600;
			font-size: 13px;
		}

		.header-actions {
			display: flex;
			gap: 8px;
		}

		.header-btn {
			background: transparent;
			border: none;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 4px;
			opacity: 0.8;
		}

		.header-btn:hover {
			opacity: 1;
		}

		.status-bar {
			padding: 4px 12px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.status-bar.error {
			color: var(--vscode-errorForeground);
			background: var(--vscode-inputValidation-errorBackground);
		}

		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 12px;
		}

		.message {
			margin-bottom: 16px;
			padding: 8px 12px;
			border-radius: 6px;
		}

		.message.user {
			background: var(--vscode-input-background);
			margin-left: 24px;
		}

		.message.assistant {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
		}

		.message-role {
			font-size: 11px;
			font-weight: 600;
			margin-bottom: 4px;
			color: var(--vscode-descriptionForeground);
		}

		.message-content {
			white-space: pre-wrap;
			word-break: break-word;
		}

		.message-content code {
			background: var(--vscode-textCodeBlock-background);
			padding: 2px 4px;
			border-radius: 3px;
			font-family: var(--vscode-editor-font-family);
		}

		.message-content pre {
			background: var(--vscode-textCodeBlock-background);
			padding: 8px;
			border-radius: 4px;
			overflow-x: auto;
		}

		.input-area {
			padding: 12px;
			border-top: 1px solid var(--vscode-panel-border);
		}

		.input-wrapper {
			display: flex;
			gap: 8px;
		}

		.input-field {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			padding: 8px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			resize: none;
		}

		.input-field:focus {
			outline: 1px solid var(--vscode-focusBorder);
		}

		.send-btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			padding: 8px 16px;
			cursor: pointer;
			font-weight: 500;
		}

		.send-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}

		.send-btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.empty-state {
			text-align: center;
			padding: 40px 20px;
			color: var(--vscode-descriptionForeground);
		}

		.empty-state h3 {
			margin-bottom: 8px;
			color: var(--vscode-foreground);
		}

		.streaming-indicator {
			display: inline-block;
			width: 8px;
			height: 8px;
			background: var(--vscode-progressBar-background);
			border-radius: 50%;
			animation: pulse 1s infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.5; }
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<span class="header-title">Quantlab AI</span>
			<div class="header-actions">
				<button class="header-btn" id="addContextBtn" title="Add context from editor">+</button>
				<button class="header-btn" id="clearBtn" title="Clear conversation">x</button>
				<button class="header-btn" id="settingsBtn" title="Settings">&#x2699;</button>
			</div>
		</div>

		<div class="status-bar" id="statusBar">
			Ready
		</div>

		<div class="messages" id="messages">
			<div class="empty-state">
				<h3>Quantlab AI Assistant</h3>
				<p>Ask questions about your trading strategies, get help with Python code, or debug errors.</p>
				<p><small>Click + to add code from your editor</small></p>
			</div>
		</div>

		<div class="input-area">
			<div class="input-wrapper">
				<textarea
					class="input-field"
					id="inputField"
					placeholder="Ask a question..."
					rows="2"
				></textarea>
				<button class="send-btn" id="sendBtn">Send</button>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		const messagesEl = document.getElementById('messages');
		const inputField = document.getElementById('inputField');
		const sendBtn = document.getElementById('sendBtn');
		const statusBar = document.getElementById('statusBar');

		let isStreaming = false;
		let currentStreamEl = null;

		// Event listeners
		document.getElementById('addContextBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'addContext' });
		});

		document.getElementById('clearBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'clearConversation' });
		});

		document.getElementById('settingsBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'configure' });
		});

		sendBtn.addEventListener('click', sendMessage);

		inputField.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});

		function sendMessage() {
			const content = inputField.value.trim();
			if (!content || isStreaming) return;

			vscode.postMessage({ type: 'sendMessage', content });
			inputField.value = '';
		}

		function addMessage(message) {
			// Remove empty state if present
			const emptyState = messagesEl.querySelector('.empty-state');
			if (emptyState) emptyState.remove();

			const msgEl = document.createElement('div');
			msgEl.className = 'message ' + message.role;
			msgEl.innerHTML = \`
				<div class="message-role">\${message.role === 'user' ? 'You' : 'AI'}</div>
				<div class="message-content">\${escapeHtml(message.content)}</div>
			\`;
			messagesEl.appendChild(msgEl);
			messagesEl.scrollTop = messagesEl.scrollHeight;

			return msgEl;
		}

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		// Handle messages from extension
		window.addEventListener('message', (event) => {
			const message = event.data;

			switch (message.type) {
				case 'addMessage':
					addMessage(message.message);
					break;

				case 'streamStart':
					isStreaming = true;
					sendBtn.disabled = true;

					// Create placeholder for streaming response
					currentStreamEl = addMessage({ role: 'assistant', content: '' });
					const contentEl = currentStreamEl.querySelector('.message-content');
					contentEl.innerHTML = '<span class="streaming-indicator"></span>';
					break;

				case 'streamChunk':
					if (currentStreamEl) {
						const contentEl = currentStreamEl.querySelector('.message-content');
						const indicator = contentEl.querySelector('.streaming-indicator');
						if (indicator) indicator.remove();
						contentEl.textContent += message.content;
						messagesEl.scrollTop = messagesEl.scrollHeight;
					}
					break;

				case 'streamEnd':
					isStreaming = false;
					sendBtn.disabled = false;
					currentStreamEl = null;
					break;

				case 'error':
					statusBar.textContent = message.message;
					statusBar.className = 'status-bar error';
					setTimeout(() => {
						statusBar.className = 'status-bar';
						updateStatus(lastStatus, lastRateLimit);
					}, 5000);
					break;

				case 'statusUpdate':
					lastStatus = message.status;
					lastRateLimit = message.rateLimit;
					updateStatus(message.status, message.rateLimit);
					break;

				case 'conversationCleared':
					messagesEl.innerHTML = \`
						<div class="empty-state">
							<h3>Quantlab AI Assistant</h3>
							<p>Ask questions about your trading strategies.</p>
						</div>
					\`;
					break;

				case 'contextAdded':
					inputField.value += '\\n\\nContext:\\n' + message.context;
					break;
			}
		});

		let lastStatus = 'ready';
		let lastRateLimit = { remaining: 100, max: 100 };

		function updateStatus(status, rateLimit) {
			let text = '';
			switch (status) {
				case 'unconfigured':
					text = 'Not configured - click gear to set API key';
					break;
				case 'rate_limited':
					text = 'Rate limited - please wait';
					break;
				case 'disabled':
					text = 'AI disabled';
					break;
				default:
					text = \`Ready (\${rateLimit.remaining}/\${rateLimit.max} requests)\`;
			}
			statusBar.textContent = text;
		}
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
