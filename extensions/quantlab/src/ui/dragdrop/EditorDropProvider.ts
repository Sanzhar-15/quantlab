/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FILE_MIME, RUN_MIME, SYMBOL_MIME } from '../../utils/dragDrop';

export class EditorDropProvider implements vscode.DocumentDropEditProvider {
	static register(context: vscode.ExtensionContext): void {
		const selector: vscode.DocumentSelector = [
			{ language: 'python', scheme: 'file' },
			{ language: 'python', scheme: 'untitled' }
		];
		context.subscriptions.push(
			vscode.languages.registerDocumentDropEditProvider(selector, new EditorDropProvider())
		);
	}

	async provideDocumentDropEdits(
		_document: vscode.TextDocument,
		_position: vscode.Position,
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken
	): Promise<vscode.DocumentDropEdit | undefined> {
		const filePath = this.extractData(dataTransfer, FILE_MIME);
		if (filePath) {
			const edit = new vscode.DocumentDropEdit(`"${filePath}"`);
			return edit;
		}

		const symbol = this.extractData(dataTransfer, SYMBOL_MIME);
		if (symbol) {
			const edit = new vscode.DocumentDropEdit(`"${symbol}"`);
			return edit;
		}

		const runId = this.extractData(dataTransfer, RUN_MIME);
		if (runId) {
			const edit = new vscode.DocumentDropEdit(`# Run ID: ${runId}`);
			return edit;
		}

		return undefined;
	}

	private extractData(dataTransfer: vscode.DataTransfer, mime: string): string | undefined {
		const item = dataTransfer.get(mime) ?? dataTransfer.get('text/plain');
		if (!item) {
			return undefined;
		}
		const raw = typeof item.value === 'string' ? item.value : String(item.value ?? '');
		const value = raw.trim();
		return value ? value : undefined;
	}
}
