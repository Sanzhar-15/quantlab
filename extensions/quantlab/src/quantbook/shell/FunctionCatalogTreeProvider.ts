/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I-b (R12, 2026-06-19) -- the "Functions" catalog sidebar TreeDataProvider.
//
// Mirrors the DepGraphTreeProvider / LivePythonTreeProvider pattern: it renders the node model from the
// vscode-free {@link buildFunctionCatalogNodes}. It reads the FOCUSED Cell Grid's owning Session and calls
// `session.listFunctions()` (built-ins + any registered UDFs), groups them (user-defined first, then
// built-ins by first letter), and adapts each node to a TreeItem -- a one-line signature as the description
// and the full metadata in the tooltip. Clicking a function copies its name to the clipboard.
//
// Refresh signal: one pull event at construction -- the CellGrid "grids changed" event (a different focused
// workbook could expose a different function set). On it, fires onDidChangeTreeData and re-reads. No polling.
// All vscode coupling lives here; the model + signature/tooltip formatting are pure + tested.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import {
	buildFunctionCatalogNodes,
	type FunctionCatalogInput,
	type FunctionCatalogNode,
} from './functionCatalogModel';

/** The command the catalog invokes to copy a function name to the clipboard. Registered in
 *  {@link registerFunctionCatalogView}; tree-invoked, so not a palette command. */
export const COPY_FUNCTION_NAME_COMMAND = 'quantlab.quantbookCopyFunctionName';

export class FunctionCatalogTreeProvider implements vscode.TreeDataProvider<FunctionCatalogNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<FunctionCatalogNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		/** Fired on focus/open/close -- {@link CellGridPanel.onDidChangeGrids}. */
		onGridsChanged: (listener: () => void) => { dispose(): void },
	) {
		this.disposables.push(onGridsChanged(() => this.refresh()));
	}

	// --- TreeDataProvider interface ---

	getTreeItem(element: FunctionCatalogNode): vscode.TreeItem {
		const collapsible = element.kind === 'group'
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(element.label, collapsible);
		item.id = element.id;

		switch (element.kind) {
			case 'noGrid':
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = 'Open or focus a Quantbook workbook to browse its functions.';
				item.contextValue = 'quantlab.functionCatalog.noGrid';
				break;

			case 'empty':
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = 'No functions are registered for the focused workbook.';
				item.contextValue = 'quantlab.functionCatalog.empty';
				break;

			case 'group':
				item.iconPath = new vscode.ThemeIcon(element.userDefined ? 'symbol-namespace' : 'symbol-function');
				item.description = `${element.count}`;
				item.tooltip = element.userDefined
					? `${element.count} user-defined function${element.count === 1 ? '' : 's'}.`
					: `${element.count} built-in function${element.count === 1 ? '' : 's'} starting with "${element.label}".`;
				item.contextValue = 'quantlab.functionCatalog.group';
				break;

			case 'function':
				item.iconPath = new vscode.ThemeIcon(element.userDefined ? 'symbol-variable' : 'symbol-function');
				item.description = element.signature;
				item.tooltip = element.tooltip;
				item.contextValue = 'quantlab.functionCatalog.function';
				// Click -> copy the function name to the clipboard (insert-into-cell is a v1.5 enhancement).
				item.command = {
					command: COPY_FUNCTION_NAME_COMMAND,
					title: 'Copy Function Name',
					arguments: [element.name],
				};
				break;
		}

		return item;
	}

	getChildren(element?: FunctionCatalogNode): FunctionCatalogNode[] {
		// Root -> the focused workbook's grouped functions; a group -> its function leaves.
		if (element === undefined) {
			return buildFunctionCatalogNodes(this.computeInput());
		}
		if (element.kind === 'group') {
			return [...element.children];
		}
		return [];
	}

	// --- Focused-workbook function list ---

	/**
	 * Read the focused Cell Grid's registered functions into the pure model's input. No focused grid ->
	 * `hasFocusedGrid:false` (the model yields a distinct `noGrid` node, NOT a misleading "no functions").
	 * A `listFunctions()` throw on a faulted session propagates LOUD (No-Fallbacks) rather than showing a
	 * healthy-looking empty catalog.
	 */
	private computeInput(): FunctionCatalogInput {
		const focused = CellGridPanel.focusedLocalPanel();
		if (focused === undefined) {
			return { hasFocusedGrid: false, functions: [] };
		}
		return { hasFocusedGrid: true, functions: focused.session.listFunctions() };
	}

	// --- Lifecycle ---

	refresh(): void {
		if (!this.disposed) {
			this._onDidChangeTreeData.fire();
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		this._onDidChangeTreeData.dispose();
	}
}
