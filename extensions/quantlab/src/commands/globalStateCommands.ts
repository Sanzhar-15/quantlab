/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { GlobalSelectors } from '../ui/GlobalSelectors';
import { DataSourceDescriptor, ServerDataSource, isServerSource } from '../types/market';

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
		vscode.commands.registerCommand('quantlab.setServerDataSource', (source?: ServerDataSource) => {
			if (source && isServerSource(source)) {
				globalState.setDataSource(source);
				// NOTE: DataViewManager.setActiveDataSource() now delegates to globalState,
				// so we don't need to call it separately

				vscode.window.showInformationMessage(`Selected ${source.displayName} (${source.symbol})`);
			}
		}),
		vscode.commands.registerCommand('quantlab.openServerSymbol',
			async (symbol: string, displayName: string, assetClass?: string) => {
				const uri = vscode.Uri.parse(`quantlab-server://symbol/${symbol}.py`);

				// Set state BEFORE opening (ChartViewProvider reads this immediately)
				const source: ServerDataSource = { kind: 'server', symbol, displayName, assetClass };
				globalState.setDataSource(source);
				// NOTE: DataViewManager.setActiveDataSource() now delegates to globalState,
				// so we don't need to call it separately

				try {
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { preview: false });

					// Automatically switch to Chart view to show the data
					await vscode.commands.executeCommand('quantlab.switchToChart');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to open ${displayName}: ${error}`);
				}
			}
		)
	);
}
