/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave J-a (R16, 2026-06-20) -- the "local-first" messaging surface: a status-bar shield + an info command.
//
// A `$(shield) Local` status-bar item appears while a Quantbook grid is open (gated on the SAME
// CellGridPanel.hasAnyPanel() signal that drives `quantbook.hasOpenGrid`, so it tracks the quantbook
// sidebars exactly). Its hover summarizes the local-first guarantee; clicking it (or running the palette
// command) shows the full, HONEST statement -- what runs locally vs the opt-in AI / sign-in / market-data
// network surface. The user-facing text is built by the pure {@link localFirstModel} (unit-tested); this
// shell only wires it to vscode. Kept SEPARATE from registerQuantbookShell so the increment is additive;
// everything is pushed onto context.subscriptions so a same-host re-activation does not leak.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import { LOCAL_FIRST_HEADLINE, buildLocalFirstDetail, buildShieldTooltip } from './localFirstModel';

/** The command the shield (and the palette) invokes to show the full local-first statement. */
export const LOCAL_FIRST_INFO_COMMAND = 'quantlab.quantbookLocalFirstInfo';

/**
 * Register the R16 local-first messaging surface. Idempotent per activation (all subscriptions disposed on
 * deactivate). The status-bar item is shown only while a Cell Grid is open and hidden otherwise -- it is
 * scoped to the workbook whose locality it advertises.
 */
export function registerLocalFirstStatus(context: vscode.ExtensionContext): void {
	// Left-aligned, low priority so it sits to the right of the connection/account items rather than
	// competing with them. The shield reads as "this workbook is local".
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
	item.text = '$(shield) Local';
	item.tooltip = buildShieldTooltip();
	item.command = LOCAL_FIRST_INFO_COMMAND;

	// Show iff a quantbook grid is open. hasAnyPanel() is the single source of truth (matches how
	// quantbookShell drives the gating context key); seed now (a grid may already be open on a same-host
	// re-activation) and re-evaluate on every grids-changed signal.
	const sync = (): void => {
		if (CellGridPanel.hasAnyPanel()) {
			item.show();
		} else {
			item.hide();
		}
	};
	sync();

	context.subscriptions.push(
		item,
		CellGridPanel.onDidChangeGrids(sync),
		vscode.commands.registerCommand(LOCAL_FIRST_INFO_COMMAND, () => {
			// Modal so the full statement is read once on demand (not a passive, easily-missed toast). The
			// detail carries the honest network-surface enumeration from the pure model.
			void vscode.window.showInformationMessage(LOCAL_FIRST_HEADLINE, {
				modal: true,
				detail: buildLocalFirstDetail(),
			});
		}),
	);
}
