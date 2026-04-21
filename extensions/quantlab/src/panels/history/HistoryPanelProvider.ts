/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryState } from '../../core/state/HistoryState';
import { createRunDataTransfer, RUN_MIME } from '../../utils/dragDrop';
import { HistoryTreeProvider } from './HistoryTreeProvider';

export class HistoryPanelProvider {
	private readonly treeView: vscode.TreeView<unknown>;

	constructor(context: vscode.ExtensionContext, historyState: HistoryState) {
		const provider = new HistoryTreeProvider(historyState);
		this.treeView = vscode.window.createTreeView('quantlab.historyView', {
			treeDataProvider: provider,
			dragAndDropController: new HistoryDragAndDropController()
		});

		context.subscriptions.push(this.treeView);
	}
}

class HistoryDragAndDropController implements vscode.TreeDragAndDropController<unknown> {
	readonly dropMimeTypes: string[] = [];
	readonly dragMimeTypes: string[] = [RUN_MIME];

	handleDrag(source: unknown[], dataTransfer: vscode.DataTransfer): void {
		const entry = source.find(item => typeof item === 'object' && item && 'entry' in (item as Record<string, unknown>));
		if (!entry) {
			return;
		}

		const entryId = (entry as { entry: { id: string } }).entry.id;
		const transfer = createRunDataTransfer(entryId);
		for (const [mime, item] of transfer) {
			dataTransfer.set(mime, item);
		}
	}
}
