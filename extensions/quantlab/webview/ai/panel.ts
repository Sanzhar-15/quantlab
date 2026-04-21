/*---------------------------------------------------------------------------------------------
 *  AI Panel Webview Scripts
 *  Client-side logic for the AI assistant panel
 *---------------------------------------------------------------------------------------------*/

/**
 * Chat message interface.
 */
interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp: Date;
	id: string;
}

/**
 * VS Code API interface.
 */
interface VSCodeAPI {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

/**
 * AI Panel Controller.
 * Manages the webview UI and communication with the extension.
 */
class AIPanelController {
	private readonly vscode: VSCodeAPI;
	private readonly messagesContainer: HTMLElement;
	private readonly inputField: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly statusBar: HTMLElement;

	private isStreaming = false;
	private currentStreamElement: HTMLElement | null = null;
	private messages: ChatMessage[] = [];

	constructor() {
		this.vscode = acquireVsCodeApi();
		this.messagesContainer = document.getElementById('messages')!;
		this.inputField = document.getElementById('inputField') as HTMLTextAreaElement;
		this.sendButton = document.getElementById('sendBtn') as HTMLButtonElement;
		this.statusBar = document.getElementById('statusBar')!;

		this.setupEventListeners();
		this.restoreState();
	}

	private setupEventListeners(): void {
		// Send button
		this.sendButton.addEventListener('click', () => this.sendMessage());

		// Enter key (without shift)
		this.inputField.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		// Header buttons
		document.getElementById('addContextBtn')?.addEventListener('click', () => {
			this.vscode.postMessage({ type: 'addContext' });
		});

		document.getElementById('clearBtn')?.addEventListener('click', () => {
			this.clearConversation();
		});

		document.getElementById('settingsBtn')?.addEventListener('click', () => {
			this.vscode.postMessage({ type: 'configure' });
		});

		// Messages from extension
		window.addEventListener('message', (event) => this.handleMessage(event.data));
	}

	private sendMessage(): void {
		const content = this.inputField.value.trim();
		if (!content || this.isStreaming) {
			return;
		}

		this.vscode.postMessage({ type: 'sendMessage', content });
		this.inputField.value = '';
	}

	private handleMessage(message: any): void {
		switch (message.type) {
			case 'addMessage':
				this.addMessageToUI(message.message);
				break;

			case 'streamStart':
				this.startStreaming();
				break;

			case 'streamChunk':
				this.appendStreamChunk(message.content);
				break;

			case 'streamEnd':
				this.endStreaming();
				break;

			case 'error':
				this.showError(message.message);
				break;

			case 'statusUpdate':
				this.updateStatus(message.status, message.rateLimit);
				break;

			case 'conversationCleared':
				this.onConversationCleared();
				break;

			case 'contextAdded':
				this.onContextAdded(message.context);
				break;
		}
	}

	private addMessageToUI(message: ChatMessage): void {
		// Remove empty state if present
		const emptyState = this.messagesContainer.querySelector('.empty-state');
		if (emptyState) {
			emptyState.remove();
		}

		const messageEl = document.createElement('div');
		messageEl.className = `message ${message.role}`;
		messageEl.innerHTML = `
			<div class="message-role">${message.role === 'user' ? 'You' : 'AI'}</div>
			<div class="message-content">${this.escapeHtml(message.content)}</div>
		`;

		this.messagesContainer.appendChild(messageEl);
		this.scrollToBottom();

		// Track message
		this.messages.push(message);
		this.saveState();

		return messageEl as any;
	}

	private startStreaming(): void {
		this.isStreaming = true;
		this.sendButton.disabled = true;

		// Create placeholder for streaming response
		const messageEl = document.createElement('div');
		messageEl.className = 'message assistant';
		messageEl.innerHTML = `
			<div class="message-role">AI</div>
			<div class="message-content"><span class="streaming-indicator"></span></div>
		`;

		this.messagesContainer.appendChild(messageEl);
		this.currentStreamElement = messageEl;
		this.scrollToBottom();
	}

	private appendStreamChunk(content: string): void {
		if (!this.currentStreamElement) return;

		const contentEl = this.currentStreamElement.querySelector('.message-content');
		if (!contentEl) return;

		// Remove streaming indicator on first chunk
		const indicator = contentEl.querySelector('.streaming-indicator');
		if (indicator) {
			indicator.remove();
		}

		contentEl.textContent += content;
		this.scrollToBottom();
	}

	private endStreaming(): void {
		this.isStreaming = false;
		this.sendButton.disabled = false;

		if (this.currentStreamElement) {
			const contentEl = this.currentStreamElement.querySelector('.message-content');
			if (contentEl) {
				// Track the completed message
				this.messages.push({
					role: 'assistant',
					content: contentEl.textContent || '',
					timestamp: new Date(),
					id: `msg-${Date.now()}`,
				});
				this.saveState();
			}
		}

		this.currentStreamElement = null;
	}

	private showError(message: string): void {
		this.statusBar.textContent = message;
		this.statusBar.classList.add('error');

		setTimeout(() => {
			this.statusBar.classList.remove('error');
		}, 5000);
	}

	private updateStatus(status: string, rateLimit: { remaining: number; max: number }): void {
		let text: string;

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
				text = `Ready (${rateLimit.remaining}/${rateLimit.max} requests)`;
		}

		this.statusBar.textContent = text;
	}

	private clearConversation(): void {
		this.vscode.postMessage({ type: 'clearConversation' });
	}

	private onConversationCleared(): void {
		this.messages = [];
		this.messagesContainer.innerHTML = `
			<div class="empty-state">
				<h3>Quantlab AI Assistant</h3>
				<p>Ask questions about your trading strategies, get help with Python code, or debug errors.</p>
				<p><small>Click + to add code from your editor</small></p>
			</div>
		`;
		this.saveState();
	}

	private onContextAdded(context: string): void {
		const currentValue = this.inputField.value;
		this.inputField.value = currentValue + (currentValue ? '\n\n' : '') + 'Context:\n' + context;
		this.inputField.focus();
	}

	private scrollToBottom(): void {
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	private saveState(): void {
		this.vscode.setState({
			messages: this.messages.map(m => ({
				...m,
				timestamp: m.timestamp.toISOString(),
			})),
		});
	}

	private restoreState(): void {
		const state = this.vscode.getState() as any;
		if (state?.messages) {
			this.messages = state.messages.map((m: any) => ({
				...m,
				timestamp: new Date(m.timestamp),
			}));

			// Restore UI
			for (const message of this.messages) {
				this.addMessageToUI(message);
			}
		}
	}
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
	new AIPanelController();
});

// Export for module bundlers
export { AIPanelController };
