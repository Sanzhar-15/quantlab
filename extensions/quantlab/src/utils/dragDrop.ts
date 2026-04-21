/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const SYMBOL_MIME = 'application/quantlab-symbol';
export const FILE_MIME = 'application/quantlab-file';
export const RUN_MIME = 'application/quantlab-run';

export function createSymbolDataTransfer(symbols: string[]): vscode.DataTransfer {
	const payload = symbols.join(',');
	const transfer = new vscode.DataTransfer();

	transfer.set(SYMBOL_MIME, new vscode.DataTransferItem(payload));
	transfer.set('text/plain', new vscode.DataTransferItem(payload));

	return transfer;
}

export function createFileDataTransfer(filePath: string): vscode.DataTransfer {
	const transfer = new vscode.DataTransfer();
	transfer.set(FILE_MIME, new vscode.DataTransferItem(filePath));
	transfer.set('text/plain', new vscode.DataTransferItem(filePath));
	return transfer;
}

export function createRunDataTransfer(runId: string): vscode.DataTransfer {
	const transfer = new vscode.DataTransfer();
	transfer.set(RUN_MIME, new vscode.DataTransferItem(runId));
	transfer.set('text/plain', new vscode.DataTransferItem(runId));
	return transfer;
}
