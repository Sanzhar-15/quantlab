/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TradeTreeProvider } from './TradeTreeProvider';
import { BadgeManager } from '../../ui/notifications/BadgeManager';

export class TradePanelProvider {
	private readonly treeView: vscode.TreeView<unknown>;

	constructor(context: vscode.ExtensionContext, badgeManager?: BadgeManager) {
		const provider = new TradeTreeProvider(context);
		this.treeView = vscode.window.createTreeView('quantlab.tradeView', { treeDataProvider: provider });
		if (badgeManager) {
			badgeManager.registerTradeView(this.treeView);
		}
		context.subscriptions.push(this.treeView);
	}
}
