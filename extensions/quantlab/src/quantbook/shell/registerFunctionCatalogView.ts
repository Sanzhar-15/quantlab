/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I-b (R12, 2026-06-19) -- registers the "Functions" catalog sidebar under the quantbook Activity Bar,
// plus its tree-invoked copy-name command.
//
// Kept SEPARATE from registerQuantbookShell (which owns the container + the gating context key) so the
// increment is additive -- registers ONLY the new view, its provider, and the copy command, never the
// container or the `quantbook.hasOpenGrid` key. Everything is pushed onto context.subscriptions so a
// same-host re-activation does not leak a view/provider/listener/command.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import { COPY_FUNCTION_NAME_COMMAND, FunctionCatalogTreeProvider } from './FunctionCatalogTreeProvider';
import type { FunctionCatalogNode } from './functionCatalogModel';

/** The view id of the Functions catalog sidebar (matches `contributes.views` in package.json). */
const FUNCTION_CATALOG_VIEW_ID = 'quantlab.functionCatalogView';

/**
 * Register the R12 "Functions" catalog sidebar over the focused workbook's `listFunctions()`. Idempotent
 * per activation (all subscriptions disposed on deactivate). The view is gated by the same
 * `quantbook.hasOpenGrid` context key as the other quantbook sidebars (set in its package.json `when`).
 */
export function registerFunctionCatalogView(context: vscode.ExtensionContext): void {
	const provider = new FunctionCatalogTreeProvider(
		(listener) => CellGridPanel.onDidChangeGrids(listener),
	);
	const treeView = vscode.window.createTreeView<FunctionCatalogNode>(FUNCTION_CATALOG_VIEW_ID, { treeDataProvider: provider });
	context.subscriptions.push(
		treeView,
		provider,
		// The copy command is invoked ONLY by a function tree node (a name string arg), so it is not a
		// palette command. Copies to the clipboard + a confirming toast (insert-into-cell is a v1.5 cut).
		vscode.commands.registerCommand(COPY_FUNCTION_NAME_COMMAND, (name: string) => {
			vscode.env.clipboard.writeText(name).then(
				() => {
					void vscode.window.showInformationMessage(`Copied "${name}" to the clipboard.`);
				},
				(err: unknown) => {
					// No-Fallbacks: a user-initiated copy that FAILS must say so (toast + log), never silently
					// complete as if it worked (which would leave the user pasting stale clipboard content).
					console.warn('[functionCatalog] clipboard write failed:', err);
					void vscode.window.showErrorMessage(`Quantbook: could not copy "${name}" to the clipboard.`);
				},
			);
		}),
	);
}
