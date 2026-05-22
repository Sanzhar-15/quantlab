/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.2.a scaffold (2026-05-22) -- read-only cell-grid
 * webview panel.
 *
 * Minimal scaffold for the V3.2 cell-grid UI. Renders the engine
 * snapshot via {@link exportCellSnapshot} as a static HTML table.
 * NO editing (V3.2.b), NO virtualization (V3.3), NO live updates
 * from remote peers (V3.2.c). The panel is a one-shot snapshot:
 * opening the command shows the current state; the user closes the
 * panel and re-opens to see a refreshed snapshot.
 *
 * Future V3.2.b+ work will add message-passing for cell edits + a
 * 1s poll loop for live remote updates + a virtualized renderer.
 *
 * The pure HTML-building helpers (`buildHtml`, `formatCellValue`)
 * live in `cellGridHtml.ts` so unit tests can exercise them without
 * pulling the `vscode` host module.
 */

import * as vscode from 'vscode';

import { exportCellSnapshot } from '../session';
import type { CollabSessionInstance } from '../types';
import { buildHtml } from './cellGridHtml';

const VIEW_TYPE = 'quantlab.quantbookCellGrid';

/**
 * Module-level registry of live panels keyed by sheet number. Lets
 * the `quantlab.quantbookCellGridRefresh` command find the active
 * panel(s) without the user having to remember which window spawned
 * them. Removed on panel dispose.
 *
 * **V3.2.a.1 enhancement (2026-05-22)** -- pre-enhancement the
 * command surface was "Open Cell Grid" only; closing + re-opening
 * was the only way to refresh the snapshot. The registry + Refresh
 * command lets users re-render in place. V3.2.b will replace this
 * with auto-refresh on remote-op observed (push or pollRemote).
 */
const activePanels: Map<number, CellGridPanel> = new Map();

/**
 * Render-once webview panel that displays the given session's cell
 * snapshot for the given sheet. The panel does NOT subscribe to
 * session updates -- closing + re-opening refreshes; V3.2.b will
 * add live updates via message-passing.
 */
export class CellGridPanel {
	static show(
		context: vscode.ExtensionContext,
		session: CollabSessionInstance,
		sheet: number,
	): CellGridPanel {
		// If a panel for this sheet is already open, reveal +
		// refresh it rather than creating a duplicate. Matches VS
		// Code's "single tab per resource" convention.
		const existing = activePanels.get(sheet);
		if (existing !== undefined) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			existing.render();
			return existing;
		}
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			`Cell Grid (sheet ${sheet})`,
			vscode.ViewColumn.Active,
			{
				// V3.2.a is read-only static HTML. Scripts stay OFF.
				// V3.2.b will flip this on when message-passing lands.
				enableScripts: false,
				retainContextWhenHidden: false,
				localResourceRoots: [context.extensionUri],
			},
		);
		const instance = new CellGridPanel(panel, session, sheet);
		instance.render();
		activePanels.set(sheet, instance);
		panel.onDidDispose(() => {
			activePanels.delete(sheet);
		});
		context.subscriptions.push(panel);
		return instance;
	}

	/**
	 * Refresh ALL currently-open cell-grid panels. Called by the
	 * `quantlab.quantbookCellGridRefresh` command. Returns the
	 * number of panels refreshed (0 if none open -- the command
	 * surfaces an information message in that case).
	 */
	static refreshAll(): number {
		let count = 0;
		for (const instance of activePanels.values()) {
			instance.render();
			count += 1;
		}
		return count;
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly session: CollabSessionInstance,
		private readonly sheet: number,
	) { }

	/**
	 * Compute the snapshot AND set the webview's HTML. Exposed so
	 * V3.2.b can call it after a cell edit to refresh the view (a
	 * temporary measure until message-passing lands).
	 */
	render(): void {
		const snapshot = exportCellSnapshot(this.session, this.sheet);
		this.panel.webview.html = buildHtml(snapshot);
	}
}
