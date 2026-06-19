/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I (R13 + R14, 2026-06-19) -- registers the "Errors" diagnostics sidebar under the quantbook
// Activity Bar, plus its tree-invoked reveal command.
//
// Kept SEPARATE from registerQuantbookShell (which owns the Activity Bar container + the gating context
// key) so the increment is additive -- this module registers ONLY the new view, its provider, and the
// reveal command, never touching the container or the `quantbook.hasOpenGrid` key. Called once from
// activate() AFTER the QuantbookDiagnostics instance exists (its read API + onDidChange are the sidebar's
// data source + refresh signal). Everything is pushed onto context.subscriptions so a same-host
// re-activation does not leak a view/provider/listener/command.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { QuantbookDiagnostics } from '../diagnostics/quantbookDiagnostics';
import type { DiagnosticsNode } from '../diagnostics/diagnosticsTreeModel';
import type { SessionInstance } from '../types';
import { DiagnosticsTreeProvider, REVEAL_CELL_COMMAND } from './DiagnosticsTreeProvider';

/** The view id of the Errors sidebar (matches `contributes.views` in package.json). */
const DIAGNOSTICS_VIEW_ID = 'quantlab.diagnosticsView';

/**
 * Register the R13/R14 "Errors" diagnostics sidebar over the focused workbook's current diagnostics.
 * Idempotent per activation (all subscriptions disposed on deactivate). The view is gated by the same
 * `quantbook.hasOpenGrid` context key as the other quantbook sidebars (set in its package.json `when`).
 *
 * @param diagnostics the W2 diagnostics bridge -- the sidebar's read-only data source (`currentDiagnostics`
 *   / `reactiveError`) AND its refresh signal (`onDidChange`, fired on every diagnostic mutation).
 */
export function registerDiagnosticsView(
	context: vscode.ExtensionContext,
	diagnostics: QuantbookDiagnostics,
): void {
	// Refresh on BOTH the grids-changed signal (focus/open/close/selection -> a different focused workbook)
	// and the diagnostics-changed signal (a cell error appeared/cleared, or a reactive error landed). The
	// provider reads the focused workbook's diagnostics lazily in getChildren.
	const provider = new DiagnosticsTreeProvider(
		diagnostics,
		(listener) => CellGridPanel.onDidChangeGrids(listener),
		(listener) => diagnostics.onDidChange(() => listener()),
	);
	const treeView = vscode.window.createTreeView<DiagnosticsNode>(DIAGNOSTICS_VIEW_ID, { treeDataProvider: provider });
	context.subscriptions.push(
		treeView,
		provider,
		// The reveal command is invoked ONLY by a cell-error tree node (by-reference args), so it is not a
		// palette command. revealCellInSession guards a closed workbook + validates the coordinate (loud).
		vscode.commands.registerCommand(
			REVEAL_CELL_COMMAND,
			(session: SessionInstance, sheet: number, row: number, col: number) => {
				CellGridPanel.revealCellInSession(session, sheet, row, col);
			},
		),
	);
}
