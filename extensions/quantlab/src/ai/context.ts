/*---------------------------------------------------------------------------------------------
 *  Context Builder
 *  Builds context for AI requests from strategy files and errors
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AIRequestContext, ContextItem, ConsentCategory } from './types';
import { ConsentManager } from './consent';
import { sanitizeStrategyCode } from './sanitize';

/**
 * Maximum context size in characters.
 */
const MAX_CONTEXT_SIZE = 30000;

/**
 * Context builder for AI requests.
 */
export class ContextBuilder {
	private readonly consentManager = ConsentManager.getInstance();
	private readonly items: ContextItem[] = [];
	private currentSize = 0;

	constructor(private readonly sessionId: string) {}

	/**
	 * Add the current strategy file to context.
	 */
	async addCurrentStrategy(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return false;
		}

		const document = editor.document;
		if (document.languageId !== 'python') {
			return false;
		}

		// Check consent
		if (!this.consentManager.hasConsent(this.sessionId, 'strategy_code')) {
			const granted = await this.consentManager.promptForConsent(
				this.sessionId,
				'strategy_code'
			);
			if (!granted) {
				return false;
			}
		}

		const code = document.getText();
		const sanitized = sanitizeStrategyCode(code);

		// Warn if sensitive data was found
		if (sanitized.hadSensitiveData) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('Sensitive data was found and redacted from your strategy before sending to AI.')
			);
		}

		this.addItem({
			type: 'strategy',
			content: sanitized.sanitized,
			source: document.fileName,
		});

		return true;
	}

	/**
	 * Add a specific file to context.
	 */
	async addFile(uri: vscode.Uri): Promise<boolean> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const code = document.getText();
			const sanitized = sanitizeStrategyCode(code);

			this.addItem({
				type: 'strategy',
				content: sanitized.sanitized,
				source: uri.fsPath,
			});

			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Add selected code to context.
	 */
	addSelection(): boolean {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			return false;
		}

		const selection = editor.document.getText(editor.selection);
		const sanitized = sanitizeStrategyCode(selection);

		this.addItem({
			type: 'strategy',
			content: sanitized.sanitized,
			source: editor.document.fileName,
			lineStart: editor.selection.start.line + 1,
			lineEnd: editor.selection.end.line + 1,
		});

		return true;
	}

	/**
	 * Add error messages to context.
	 */
	async addErrors(errors: string[]): Promise<boolean> {
		if (errors.length === 0) {
			return false;
		}

		// Check consent
		if (!this.consentManager.hasConsent(this.sessionId, 'error_messages')) {
			const granted = await this.consentManager.promptForConsent(
				this.sessionId,
				'error_messages'
			);
			if (!granted) {
				return false;
			}
		}

		for (const error of errors) {
			this.addItem({
				type: 'error',
				content: error,
				source: 'diagnostics',
			});
		}

		return true;
	}

	/**
	 * Add diagnostics from current file.
	 */
	async addDiagnostics(): Promise<boolean> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return false;
		}

		const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
		const errors = diagnostics
			.filter(d => d.severity === vscode.DiagnosticSeverity.Error)
			.map(d => `Line ${d.range.start.line + 1}: ${d.message}`);

		return this.addErrors(errors);
	}

	/**
	 * Add data sample to context (requires explicit consent).
	 */
	async addDataSample(sample: string): Promise<boolean> {
		// Data samples require explicit consent
		if (!this.consentManager.hasConsent(this.sessionId, 'data_samples')) {
			const granted = await this.consentManager.promptForConsent(
				this.sessionId,
				'data_samples'
			);
			if (!granted) {
				return false;
			}
		}

		// Limit sample size
		const truncated = sample.slice(0, 5000);

		this.addItem({
			type: 'data',
			content: truncated,
			source: 'data_sample',
		});

		return true;
	}

	/**
	 * Add documentation reference.
	 */
	addDocumentation(docContent: string, source: string): void {
		this.addItem({
			type: 'documentation',
			content: docContent,
			source,
		});
	}

	/**
	 * Build the final context string.
	 */
	build(): AIRequestContext {
		const context: AIRequestContext = {
			additionalItems: [],
		};

		for (const item of this.items) {
			switch (item.type) {
				case 'strategy':
					if (!context.strategyCode) {
						context.strategyFile = item.source;
						context.strategyCode = item.content;
					}
					break;
				case 'error':
					if (!context.errorMessages) {
						context.errorMessages = [];
					}
					context.errorMessages.push(item.content);
					break;
				case 'data':
					context.dataSample = item.content;
					break;
				default:
					context.additionalItems.push(item);
			}
		}

		return context;
	}

	/**
	 * Format context for inclusion in prompt.
	 */
	formatForPrompt(): string {
		const parts: string[] = [];

		for (const item of this.items) {
			switch (item.type) {
				case 'strategy':
					if (item.lineStart && item.lineEnd) {
						parts.push(
							`## Code from ${item.source} (lines ${item.lineStart}-${item.lineEnd}):\n\`\`\`python\n${item.content}\n\`\`\``
						);
					} else {
						parts.push(
							`## Strategy file: ${item.source}\n\`\`\`python\n${item.content}\n\`\`\``
						);
					}
					break;
				case 'error':
					parts.push(`## Error:\n${item.content}`);
					break;
				case 'data':
					parts.push(`## Data sample:\n\`\`\`\n${item.content}\n\`\`\``);
					break;
				case 'documentation':
					parts.push(`## Reference (${item.source}):\n${item.content}`);
					break;
			}
		}

		return parts.join('\n\n');
	}

	/**
	 * Get the current context size.
	 */
	getSize(): number {
		return this.currentSize;
	}

	/**
	 * Get remaining space in context.
	 */
	getRemainingSpace(): number {
		return MAX_CONTEXT_SIZE - this.currentSize;
	}

	/**
	 * Get consent categories used in this context.
	 */
	getUsedConsentCategories(): ConsentCategory[] {
		const categories = new Set<ConsentCategory>();

		for (const item of this.items) {
			switch (item.type) {
				case 'strategy':
					categories.add('strategy_code');
					break;
				case 'error':
					categories.add('error_messages');
					break;
				case 'data':
					categories.add('data_samples');
					break;
			}
		}

		return Array.from(categories);
	}

	private addItem(item: ContextItem): boolean {
		const itemSize = item.content.length;

		if (this.currentSize + itemSize > MAX_CONTEXT_SIZE) {
			// Truncate if possible
			const available = MAX_CONTEXT_SIZE - this.currentSize;
			if (available < 500) {
				return false;
			}

			item.content = item.content.slice(0, available - 50) + '\n... [truncated]';
		}

		this.items.push(item);
		this.currentSize += item.content.length;
		return true;
	}
}

/**
 * Create a context builder for a session.
 */
export function createContextBuilder(sessionId: string): ContextBuilder {
	return new ContextBuilder(sessionId);
}

/**
 * Quick context from current editor state.
 */
export async function buildQuickContext(sessionId: string): Promise<string> {
	const builder = new ContextBuilder(sessionId);

	// Add current file if it's a Python strategy
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.languageId === 'python') {
		// Prefer selection if available
		if (!editor.selection.isEmpty) {
			builder.addSelection();
		} else {
			await builder.addCurrentStrategy();
		}
	}

	// Add any errors
	await builder.addDiagnostics();

	return builder.formatForPrompt();
}
