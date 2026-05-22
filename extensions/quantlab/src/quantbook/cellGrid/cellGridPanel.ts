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

import * as childProcess from 'child_process';
import * as vscode from 'vscode';

import { exportCellSnapshot, parseQuantbookError } from '../session';
import type { CollabSessionInstance, QuantbookNativeModule, TransportInstance } from '../types';
import { reconnectWithBackoff } from '../multiWindowDemo';
import { buildHtml } from './cellGridHtml';
import { classifyPollTick, dispatchIncomingMessage } from './cellGridLogic';

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
 * V3.2.c.3 (2026-05-22): everything the panel needs to drive the
 * collab lifecycle.  The collab command (`quantlab.quantbookCellGrid
 * Collab`) constructs this via {@link multiWindowDemo.connectOrSpawn}
 * and hands it to {@link CellGridPanel.show}.  The panel OWNS the
 * lifetime of all fields here:
 * - `transport` -> attached on open, detached on dispose
 * - `spawnedRelay` -> killed on dispose if this window spawned it
 * - `engine` -> retained for reconnect (`websocketConnect` calls)
 * - `log` -> for state-transition log lines (decision C4)
 */
export interface CollabAttachment {
	readonly engine: QuantbookNativeModule;
	readonly transport: TransportInstance;
	readonly spawnedRelay: childProcess.ChildProcess | undefined;
	readonly log: vscode.OutputChannel;
}

const POLL_REMOTE_INTERVAL_MS = 1000;

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
		attachment?: CollabAttachment,
	): CellGridPanel {
		// V3.2.a.1: single tab per sheet (reveal + refresh on
		// re-open).  V3.2.b inherits this convention -- the existing
		// panel keeps its session reference + onDidReceiveMessage
		// handler intact across reveal.
		//
		// V3.2.c.3: collab-attached panels DO NOT reuse a cached
		// panel.  Two open commands (local + collab) on the same
		// sheet must produce DIFFERENT panels because they reference
		// different sessions.  If a panel for this sheet is already
		// open AND the new call has no attachment, reuse it (legacy
		// V3.2.a.1 path).  Otherwise force a new panel; the existing
		// one (if any) gets disposed in `onDidDispose` -> stale
		// activePanels entry replaced.
		if (attachment === undefined) {
			const existing = activePanels.get(sheet);
			if (existing !== undefined) {
				existing.panel.reveal(vscode.ViewColumn.Active, false);
				existing.render();
				return existing;
			}
		}
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			attachment !== undefined
				? `Cell Grid -- Collab (sheet ${sheet})`
				: `Cell Grid (sheet ${sheet})`,
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
		const instance = new CellGridPanel(panel, session, sheet, attachment);
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
		// V3.2.c.3: wire transport (if collab-attached) BEFORE first
		// render so the panel starts in a fully-attached state.
		// `wireAttachment` calls setAutoFlushPolicy + attachTransport
		// + starts the pollRemote timer.  Any error here is fatal --
		// surface via showErrorMessage + dispose the panel.
		if (attachment !== undefined) {
			try {
				instance.wireAttachment(attachment);
			} catch (err) {
				const info = parseQuantbookError(err);
				attachment.log.appendLine(`[collab] FATAL wireAttachment: code=${info.code} msg=${info.message}`);
				void vscode.window.showErrorMessage(`Cell Grid collab attach failed: ${info.message}`);
				panel.dispose();
				throw err;
			}
		}
		instance.render();
		activePanels.set(sheet, instance);
		panel.onDidDispose(() => {
			instance.disposeAttachment();
			// Only clear the cache entry if we still own it (a fresh
			// open for the same sheet may have replaced us).
			if (activePanels.get(sheet) === instance) {
				activePanels.delete(sheet);
			}
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

	/**
	 * V3.2.c.3: when the panel is collab-attached, this holds the
	 * current Transport + the pollRemote timer + spawned-relay
	 * handle + engine ref for reconnect.  Mutable across reconnects:
	 * `attachment.transport` changes (via {@link reconnectWithBackoff})
	 * but `attachment.engine` + `attachment.log` + `attachment.spawnedRelay`
	 * stay constant for the panel's lifetime.
	 *
	 * `undefined` for local-mode (V3.2.a / V3.2.b unattached) panels.
	 */
	private attachmentState: {
		engine: QuantbookNativeModule;
		transport: TransportInstance;
		spawnedRelay: childProcess.ChildProcess | undefined;
		log: vscode.OutputChannel;
		pollTimer: NodeJS.Timeout;
		reconnectInFlight: boolean;
		disposed: boolean;
	} | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly session: CollabSessionInstance,
		private readonly sheet: number,
		_attachment: CollabAttachment | undefined,
	) {
		// attachment wiring happens in show() after construction so
		// dispose() flow can call disposeAttachment() consistently
		// even if wireAttachment throws.
		this.attachmentState = undefined;
	}

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

	/**
	 * V3.2.c.3: set auto-flush + attach transport + start the 1s
	 * pollRemote timer.  Called by `show()` AFTER the panel +
	 * message handler are constructed so the dispose flow can run
	 * cleanly even on partial wireup.
	 *
	 * Throws only on the engine-side calls (`setAutoFlushPolicy` /
	 * `attachTransport`); the timer setup itself is infallible.
	 * `show()` translates a throw here into showErrorMessage + panel
	 * dispose.
	 */
	private wireAttachment(attachment: CollabAttachment): void {
		this.session.setAutoFlushPolicy('onAppend');
		this.session.attachTransport(attachment.transport);
		attachment.log.appendLine(`[collab] attached transport (sheet ${this.sheet}); pollRemote every ${POLL_REMOTE_INTERVAL_MS}ms`);
		const pollTimer = setInterval(() => this.tickPollRemote(), POLL_REMOTE_INTERVAL_MS);
		this.attachmentState = {
			engine: attachment.engine,
			transport: attachment.transport,
			spawnedRelay: attachment.spawnedRelay,
			log: attachment.log,
			pollTimer,
			reconnectInFlight: false,
			disposed: false,
		};
	}

	/**
	 * V3.2.c.3: tick of the pollRemote loop.  Called every
	 * POLL_REMOTE_INTERVAL_MS by the setInterval timer.
	 *
	 * - If a reconnect is in flight: skip (cheap idempotency).
	 * - Try `session.pollRemote()`; if `n > 0`, re-render the panel
	 *   so freshly-merged remote ops surface in the grid.
	 * - On `transport_closed` from pollRemote or its observation
	 *   path: trigger {@link handleTransportClosed} (reconnect with
	 *   backoff per decision C6).
	 * - On any other error: log + skip the tick.  Pollloop survives
	 *   one bad tick.
	 */
	private tickPollRemote(): void {
		const state = this.attachmentState;
		if (state === undefined || state.disposed || state.reconnectInFlight) {
			return;
		}
		const result = classifyPollTick(this.session);
		switch (result.kind) {
			case 'idle':
				return;
			case 'merged':
				state.log.appendLine(`[collab] pollRemote merged ${result.count} remote blob(s); re-rendering`);
				this.render();
				return;
			case 'transportClosed':
				state.log.appendLine(`[collab] pollRemote saw transport_closed; reconnecting`);
				void this.handleTransportClosed();
				return;
			case 'error':
				state.log.appendLine(`[collab] pollRemote error (skipping tick): code=${result.code} msg=${result.message}`);
				return;
		}
	}

	/**
	 * V3.2.c.3 + decision C6: reconnect on transport_closed via the
	 * V3.1.c {@link reconnectWithBackoff} contract.  Reuses the
	 * multiWindowDemo.ts implementation verbatim (exported via
	 * V3.2.c.2).
	 *
	 * - Detach the dead transport from the session.
	 * - Run reconnectWithBackoff (3 tries at 500/1000/2000ms).
	 * - On success: attach the fresh transport, log, resume polling.
	 * - On exhaustion: log, dispose the panel + spawned relay,
	 *   surface `showWarningMessage('Restart Cell Grid (Collab)')`.
	 */
	private async handleTransportClosed(): Promise<void> {
		const state = this.attachmentState;
		if (state === undefined || state.disposed || state.reconnectInFlight) {
			return;
		}
		state.reconnectInFlight = true;
		try {
			this.session.detachTransport();
		} catch { /* best-effort */ }
		try {
			const fresh = await reconnectWithBackoff(state.engine, state.log);
			if (state.disposed) {
				return;
			}
			this.session.attachTransport(fresh);
			state.transport = fresh;
			state.log.appendLine(`[collab] reconnect succeeded; resuming pollRemote`);
		} catch (err) {
			const info = parseQuantbookError(err);
			state.log.appendLine(`[collab] reconnect EXHAUSTED: ${info.message}`);
			// Dispose BEFORE prompting so the panel stops ticking
			// before the user makes a choice (same pattern as
			// multiWindowDemo's V3.1.c handler).
			this.panel.dispose();
			const choice = await vscode.window.showWarningMessage(
				`Cell Grid collab lost connection: ${info.message}.`,
				'Restart Cell Grid (Collab)',
			);
			if (choice === 'Restart Cell Grid (Collab)') {
				void vscode.commands.executeCommand('quantlab.quantbookCellGridCollab');
			}
		} finally {
			state.reconnectInFlight = false;
		}
	}

	/**
	 * V3.2.c.3: tear down the collab lifecycle.  Idempotent.
	 *
	 * - Clear the pollRemote timer.
	 * - Detach transport (best-effort -- session may already have a
	 *   dead transport).
	 * - Kill the spawned relay child process IF this window spawned
	 *   it (mirrors multiWindowDemo's V3.1.e signal-aware predicate).
	 *
	 * Called from `panel.onDidDispose`.  Safe to call on a panel
	 * that was never wired (no-op via `attachmentState === undefined`
	 * guard).
	 */
	private disposeAttachment(): void {
		const state = this.attachmentState;
		if (state === undefined || state.disposed) {
			return;
		}
		state.disposed = true;
		clearInterval(state.pollTimer);
		try {
			this.session.detachTransport();
		} catch { /* best-effort */ }
		if (
			state.spawnedRelay !== undefined &&
			state.spawnedRelay.exitCode === null &&
			state.spawnedRelay.signalCode === null &&
			!state.spawnedRelay.killed
		) {
			state.log.appendLine('[collab] killing spawned relay child process');
			try {
				state.spawnedRelay.kill();
			} catch { /* best-effort */ }
		}
		state.log.appendLine(`[collab] disposed (sheet ${this.sheet}).`);
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
