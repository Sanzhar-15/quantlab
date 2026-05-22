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
		context.subscriptions.push(panel);
		return instance;
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
