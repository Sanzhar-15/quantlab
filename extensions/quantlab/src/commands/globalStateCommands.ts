/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { GlobalSelectors } from '../ui/GlobalSelectors';
import { DataSourceDescriptor } from '../types/market';
import { resolveServerSymbolHandle } from '../panels/data/serverSymbolHandles';

export function registerGlobalStateCommands(context: vscode.ExtensionContext): void {
	const globalState = GlobalState.getInstance();
	const selectors = GlobalSelectors.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.selectDataSource', () => selectors.selectDataSource()),
		vscode.commands.registerCommand('quantlab.searchSymbol', () => selectors.selectDataSource()),
		vscode.commands.registerCommand('quantlab.setGlobalDataSource', (filePath?: string) => {
			if (typeof filePath === 'string' && filePath) {
				const source: DataSourceDescriptor = {
					kind: 'localFile',
					filePath,
					displayName: path.basename(filePath)
				};
				globalState.setDataSource(source);
				// NOTE: DataViewManager.setActiveDataSource() now delegates to globalState,
				// so we don't need to call it separately

				vscode.window.showInformationMessage(`Selected ${source.displayName}`);
			}
		}),
		// HOST review c1 M1: quantlab.setServerDataSource is gone (no caller; it took a caller-supplied server selection).
		vscode.commands.registerCommand('quantlab.openServerSymbol', openServerSymbol)
	);
}

/**
 * `quantlab.openServerSymbol`: opens a server symbol the data tree rendered. HOST review c1 M1: the only accepted argument is
 * a handle DataTreeProvider minted (serverSymbolHandles.ts); anything else throws before the global data source changes.
 */
export async function openServerSymbol(handle: unknown): Promise<void> {
	const source = resolveServerSymbolHandle(handle);
	const uri = vscode.Uri.parse(`quantlab-server://symbol/${source.symbol}.py`);

	// Set state BEFORE opening (ChartViewProvider reads this immediately)
	GlobalState.getInstance().setDataSource(source);
	// NOTE: DataViewManager.setActiveDataSource() now delegates to globalState,
	// so we don't need to call it separately

	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });

		// Automatically switch to Chart view to show the data
		await vscode.commands.executeCommand('quantlab.switchToChart');
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to open ${source.displayName}: ${error}`);
	}
}
