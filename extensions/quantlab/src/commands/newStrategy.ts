/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Fixed command id. The desktop host runs this one command, by id, when the
 * terminal's Create entry is used; it is part of that contract.
 */
export const NEW_STRATEGY_COMMAND = 'quantlab.newStrategy';

/**
 * The document the command opens. It must stay a valid vectorized strategy
 * for StrategyValidator (`def strategy(data)`), so the Chart and Action views
 * accept the new document as it is.
 */
export const NEW_STRATEGY_TEMPLATE = [
	'import quantlab as ql',
	'',
	'',
	'def strategy(data):',
	'    """Your strategy logic here."""',
	'    # Example: Simple moving average crossover',
	'    # sma_fast = ql.sma(data.close, 10)',
	'    # sma_slow = ql.sma(data.close, 50)',
	'    pass',
	''
].join('\n');

/**
 * Creates a new, unsaved strategy document and opens it in the text editor.
 * No prompt and no arguments: nothing is written to disk until the user saves.
 */
export async function createNewStrategy(): Promise<vscode.TextEditor> {
	const doc = await vscode.workspace.openTextDocument({ language: 'python', content: NEW_STRATEGY_TEMPLATE });
	return vscode.window.showTextDocument(doc, { preview: false });
}
