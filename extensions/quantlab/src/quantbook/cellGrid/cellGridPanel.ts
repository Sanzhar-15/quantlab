/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.2.a scaffold (2026-05-22) -- read-only cell-grid
 * webview panel.
 *
 * Phase 5.7 V3.2.b.3 (2026-05-22) -- writable cell-edit flow.
 *
 * Renders the engine snapshot via {@link exportCellSnapshot} as an
 * HTML table.  V3.2.b allows the user to click any cell, type a
 * numeric value, and commit via Enter -- the panel parses + validates
 * + appends `PutValue` + re-renders.  Failure path posts a structured
 * `errorReply` back to the webview which decorates the offending
 * cell.
 *
 * Out-of-scope for V3.2.b (still): virtualization (V3.3), live
 * remote-peer propagation (V3.2.c).  V3.2.a.1 `quantlab.quantbookCell
 * GridRefresh` remains the workaround for cross-window updates.
 *
 * The vscode-free pure helpers live in companion files so unit tests
 * can exercise them without a vscode shim:
 * - {@link buildHtml} / {@link formatCellValue} in `cellGridHtml.ts`.
 * - {@link parseCellRawInput} / {@link dispatchIncomingMessage} /
 *   envelope types in `cellGridLogic.ts`.
 */

import * as vscode from 'vscode';

import { exportCellSnapshot } from '../session';
import type { CollabSessionInstance } from '../types';
import { buildHtml } from './cellGridHtml';
import { dispatchIncomingMessage } from './cellGridLogic';

const VIEW_TYPE = 'quantlab.quantbookCellGrid';

/**
 * Module-level registry of live panels keyed by sheet number.  Lets
 * the `quantlab.quantbookCellGridRefresh` command find the active
 * panel(s) without the user having to remember which window spawned
 * them.  Removed on panel dispose.
 *
 * **V3.2.a.1 enhancement (2026-05-22)** -- pre-enhancement the
 * command surface was "Open Cell Grid" only; closing + re-opening
 * was the only way to refresh the snapshot.  The registry + Refresh
 * command lets users re-render in place.  V3.2.c will replace the
 * Refresh-command workaround with auto-refresh on remote-op observed
 * (poll or push).
 */
const activePanels: Map<number, CellGridPanel> = new Map();

/**
 * Render-then-edit webview panel that displays the given session's
 * cell snapshot for the given sheet.  The panel binds the session for
 * its lifetime -- the dispatcher commits via this session, `render()`
 * reads via this session.
 */
export class CellGridPanel {
	static show(
		context: vscode.ExtensionContext,
		session: CollabSessionInstance,
		sheet: number,
	): CellGridPanel {
		// V3.2.a.1: single tab per sheet (reveal + refresh on
		// re-open).  V3.2.b inherits this convention -- the existing
		// panel keeps its session reference + onDidReceiveMessage
		// handler intact across reveal.
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
				// V3.2.b.3: scripts ON for click-to-edit flow.  CSP +
				// nonce enforce that only the host-emitted inline
				// script can execute.  Any future `<script src=>`
				// remote load would need a `localResourceRoots`-
				// relative URI + a CSP widen, which we DO NOT add
				// here.
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [context.extensionUri],
			},
		);
		const instance = new CellGridPanel(panel, session, sheet);
		// Attach the message handler BEFORE the first render() -- if
		// the webview script were ever to postMessage during initial
		// load (it doesn't today, but defensive), we don't want to
		// miss it.  The handler survives across `webview.html = ...`
		// rebuilds because it's attached to the PANEL, not the
		// document.
		panel.webview.onDidReceiveMessage(
			(raw: unknown) => instance.handleIncoming(raw),
			undefined,
			context.subscriptions,
		);
		instance.render();
		activePanels.set(sheet, instance);
		panel.onDidDispose(() => {
			activePanels.delete(sheet);
		});
		context.subscriptions.push(panel);
		return instance;
	}

	/**
	 * Refresh ALL currently-open cell-grid panels.  Called by the
	 * `quantlab.quantbookCellGridRefresh` command.  Returns the
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
	 * Compute the snapshot, generate a fresh nonce, AND set the
	 * webview's HTML.  Re-rendering blows away any prior webview
	 * script + state; the host's `onDidReceiveMessage` handler
	 * survives because it's attached to the panel, not the document.
	 *
	 * V3.2.b.2: nonce is regenerated each call so refreshes get a
	 * fresh script-src CSP token.
	 */
	render(): void {
		const snapshot = exportCellSnapshot(this.session, this.sheet);
		const nonce = buildPanelNonce();
		this.panel.webview.html = buildHtml(snapshot, { nonce });
	}

	/**
	 * Thin wrapper around the vscode-free {@link dispatchIncomingMessage}
	 * dispatcher.  Captures `this.session` / `this.sheet` / `this.render`
	 * / `this.panel.webview.postMessage` as closures.  Lives here
	 * (NOT in `cellGridLogic.ts`) because it references `this`.
	 */
	private handleIncoming(raw: unknown): void {
		dispatchIncomingMessage(raw, {
			session: this.session,
			sheet: this.sheet,
			onCommit: () => this.render(),
			onError: reply => { void this.panel.webview.postMessage(reply); },
		});
	}
}

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const NONCE_LENGTH = 32;

/**
 * 32-char alphanumeric nonce.  Matches `LoginWebviewPanel._nonce`'s
 * shape so any future audit reviewing webview security across the
 * extension sees consistent token shapes.
 *
 * `Math.random()` is adequate here.  The threat model is "prevent
 * inline `<script>` injection via snapshot data leaking past
 * `escapeHtml`", NOT "resist a determined attacker with crypto-grade
 * brute force."  62^32 ~= 10^57 possibilities; Math.random()'s 53
 * bits of entropy per call have well-over-cryptographic margin
 * against snapshot-content collisions.
 */
function buildPanelNonce(): string {
	let out = '';
	for (let i = 0; i < NONCE_LENGTH; i += 1) {
		out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
	}
	return out;
}
