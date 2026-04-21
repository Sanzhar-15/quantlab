/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GlobalState } from '../../core/state/GlobalState';
import { createSymbolDataTransfer, SYMBOL_MIME } from '../../utils/dragDrop';
import { DataNode, DataTreeProvider } from './DataTreeProvider';
import { WatchlistManager } from './WatchlistManager';

export class DataPanelProvider {
	private readonly treeView: vscode.TreeView<DataNode>;
	private readonly provider: DataTreeProvider;

	constructor(context: vscode.ExtensionContext, globalState: GlobalState, watchlistManager: WatchlistManager) {
		this.provider = new DataTreeProvider(globalState, watchlistManager);
		this.treeView = vscode.window.createTreeView('quantlab.dataView', {
			treeDataProvider: this.provider,
			dragAndDropController: new DataDragAndDropController(watchlistManager)
		});

		context.subscriptions.push(
			this.treeView,
			vscode.commands.registerCommand('quantlab.reloadServerSymbols', () => {
				this.provider.reloadServerSymbols();
			})
		);
	}

	dispose(): void {
		this.provider.dispose();
	}
}

class DataDragAndDropController implements vscode.TreeDragAndDropController<DataNode> {
	readonly dropMimeTypes: string[] = [SYMBOL_MIME, 'text/plain'];
	readonly dragMimeTypes: string[] = [SYMBOL_MIME, 'text/plain'];

	constructor(private readonly watchlistManager: WatchlistManager) { }

	handleDrag(source: DataNode[], dataTransfer: vscode.DataTransfer): void {
		const symbols = source
			.filter((node): node is DataNode & { symbol: string } =>
				(node.nodeKind === 'instrument' || node.nodeKind === 'watchlistItem') && 'symbol' in node)
			.map(node => node.symbol)
			.filter(Boolean);

		if (!symbols.length) {
			return;
		}

		const transfer = createSymbolDataTransfer(symbols);
		for (const [mime, item] of transfer) {
			dataTransfer.set(mime, item);
		}
	}

	handleDrop(target: DataNode | undefined, dataTransfer: vscode.DataTransfer): void {
		if (!target) {
			return;
		}

		let watchlistId: string | undefined;
		if (target.nodeKind === 'watchlist') {
			watchlistId = target.watchlist.id;
		}
		if (target.nodeKind === 'watchlistItem') {
			watchlistId = target.watchlistId;
		}

		if (!watchlistId) {
			return;
		}

		const symbols = this.extractSymbols(dataTransfer);
		for (const symbol of symbols) {
			this.watchlistManager.addSymbol(watchlistId, symbol);
		}
	}

	private extractSymbols(dataTransfer: vscode.DataTransfer): string[] {
		const item = dataTransfer.get(SYMBOL_MIME) ?? dataTransfer.get('text/plain');
		if (!item) {
			return [];
		}
		const raw = typeof item.value === 'string' ? item.value : String(item.value ?? '');
		return raw.split(',').map(symbol => symbol.trim()).filter(Boolean);
	}
}
