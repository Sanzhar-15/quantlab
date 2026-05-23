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
 * Module-level registries of live panels keyed by sheet number.  Lets
 * the `quantlab.quantbookCellGridRefresh` command find the active
 * panel(s) without the user having to remember which window spawned
 * them.  Removed on panel dispose.
 *
 * **V3.2.a.1 enhancement (2026-05-22)** -- pre-enhancement the command
 * surface was "Open Cell Grid" only; closing + re-opening was the only
 * way to refresh the snapshot.  The registry + Refresh command lets
 * users re-render in place.
 *
 * **V3.2.d closure (HIGH-1, 2026-05-22)** -- pre-V3.2.d a SINGLE
 * `activePanels: Map<number, CellGridPanel>` keyed by sheet held BOTH
 * local + collab panels.  The V3.2.d audit (Opus Lane B HIGH-1 + Codex
 * Lane A MEDIUM-2 convergent) flagged three latent correctness gaps:
 *
 * 1. **collab-then-local**: user runs the LOCAL command after a collab
 *    panel exists; the cache check found the collab panel + revealed
 *    it, silently overriding the user's explicit local-mode intent +
 *    leaking the sample-data session created at command-invocation.
 * 2. **collab-then-collab**: pre-V3.2.d this overwrote the cache slot
 *    with a SECOND collab panel + left the first orphaned from
 *    refreshAll AND alive with its own session + transport.  Two
 *    concurrent collab sessions in one window flush under the SAME
 *    `peerId = BigInt(process.pid)` -- violating the V3.1.b PeerId-
 *    uniqueness contract (Loro CRDT accepts the merge but the per-peer
 *    VV math is now ambiguous between two writers).
 * 3. **local-then-collab**: pre-V3.2.d the local panel was silently
 *    evicted from refreshAll coverage even though it stayed visible.
 *
 * **Fix**: separate `Map`s for the two modes.  Local + collab CAN
 * coexist for the same sheet (different sessions, different intent).
 * Refresh iterates BOTH maps.  Collab-then-collab now reveals the
 * existing collab panel + surfaces an `showInformationMessage` rather
 * than spawning a duplicate -- preserving PeerId-uniqueness.
 */
const localPanels: Map<number, CellGridPanel> = new Map();
const collabPanels: Map<number, CellGridPanel> = new Map();

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
		// V3.2.a.1 single-tab-per-sheet + V3.2.d HIGH-1 closure
		// (2026-05-22): two separate cache maps for local + collab
		// modes.  A local + a collab panel for the SAME sheet are
		// LEGITIMATELY distinct surfaces (different sessions,
		// different intent) and CAN coexist; the cache returns the
		// existing same-mode panel (reveal + refresh) and NEVER
		// silently swaps mode under the user.
		//
		// Specifically:
		//   - LOCAL open + LOCAL panel exists: reveal + refresh.
		//   - LOCAL open + only COLLAB panel exists: create new local.
		//   - COLLAB open + COLLAB panel exists: reveal existing +
		//     showInformationMessage (V3.1.b PeerId-uniqueness:
		//     don't spawn a second concurrent collab session under
		//     the same PID).
		//   - COLLAB open + only LOCAL panel exists: create new collab.
		const mode = attachment === undefined ? 'local' : 'collab';
		const panels = mode === 'local' ? localPanels : collabPanels;
		const existing = panels.get(sheet);
		if (existing !== undefined) {
			if (mode === 'collab') {
				// V3.2.d HIGH-1 closure: surface that the collab
				// panel is already open in this window.  The local
				// mode silently reuses (it's a fast-start dev
				// surface; less noise wanted).
				void vscode.window.showInformationMessage(
					`Cell Grid (Collab) is already open for sheet ${sheet} in this window.`,
				);
			}
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			existing.render();
			return existing;
		}
		// V3.3.0.5 (2026-05-22): include sheet count in the title when
		// the session has multiple sheets ("Sheet N of M" reads as
		// "you're on sheet N, M total in this session").  Single-sheet
		// sessions show just "Sheet N" (avoids "of 1" noise).
		// Title is point-in-time; if the user later appends to a new
		// sheet, this panel's title stays "of M" until the panel is
		// re-rendered (V3.x can wire a dynamic title update if the
		// stale display becomes a real ergonomic issue).
		//
		// **V3.3.0.X audit closure (HIGH-2, 2026-05-23, Opus
		// adversarial lane)**: pre-closure this call was wrapped in
		// `try { ... } catch { /* best-effort fall-through */ }`
		// which violated CLAUDE.md "No Fallbacks -- Errors Must Be
		// Visible" hard rule: silently swallowing a `listSheets()`
		// failure hid a corrupt-op-log signal that the user needed
		// to see.  Now: errors propagate; `show()` callers wrap in
		// try/catch and surface via `showErrorMessage`.  The user
		// gets the diagnostic immediately rather than seeing a
		// healthy-looking "Sheet N" title on a broken session.
		//
		// **Cost note**: this is ONE napi roundtrip per `show()`
		// (bounded by user action).  Post-V3.3.0.X audit MEDIUM-3
		// closure, `listSheets()` reads from the V3.3.0.3 cache so
		// the cost is O(cells-in-cache) instead of O(N) in op count.
		const totalSheets = session.listSheets().length;
		const titleSuffix = totalSheets > 1 ? ` of ${totalSheets}` : '';
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			attachment !== undefined
				? `Cell Grid -- Collab (Sheet ${sheet}${titleSuffix})`
				: `Cell Grid (Sheet ${sheet}${titleSuffix})`,
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
		panels.set(sheet, instance);
		panel.onDidDispose(() => {
			// V3.2.b.3: set _disposed BEFORE disposeAttachment so any
			// postMessage racing with disposal early-returns from the
			// onError guard added at V3.2.d Opus MEDIUM-1 closure.
			instance._disposed = true;
			instance.disposeAttachment();
			// Only clear the cache entry if we still own it (a fresh
			// open for the same sheet + mode may have replaced us).
			if (panels.get(sheet) === instance) {
				panels.delete(sheet);
			}
		});
		context.subscriptions.push(panel);
		return instance;
	}

	/**
	 * Refresh ALL currently-open cell-grid panels (both local + collab
	 * modes).  Called by the `quantlab.quantbookCellGridRefresh`
	 * command.  Returns the number of panels refreshed (0 if none open).
	 *
	 * V3.2.d HIGH-1 closure: iterates BOTH maps so panels of either
	 * mode are covered.  Pre-V3.2.d this iterated a single
	 * `activePanels` map that silently lost the previously-evicted
	 * panel on local-then-collab / collab-then-collab transitions.
	 */
	static refreshAll(): number {
		let count = 0;
		for (const instance of localPanels.values()) {
			instance.render();
			count += 1;
		}
		for (const instance of collabPanels.values()) {
			instance.render();
			count += 1;
		}
		return count;
	}

	/**
	 * V3.3.0.5 (2026-05-22) -- enumerate active LOCAL panels for the
	 * switch-sheet command.
	 *
	 * Returns a snapshot of `{ session, sheet }` for every currently-
	 * open LOCAL panel.  Collab panels are NOT included (per V3.2.d
	 * HIGH-1 mode-split rationale: collab sessions have their own
	 * peerId + transport state; switching sheets within a collab
	 * session needs different UX considerations and is deferred to
	 * V3.x).
	 *
	 * The returned array's `session` references are live -- mutations
	 * on the session via the original panel are visible through these
	 * references.  Callers should NOT cache the array across event
	 * loop ticks (panels can dispose at any time).
	 *
	 * Empty array if no local panels are open.
	 */
	static activeLocalPanels(): Array<{ session: CollabSessionInstance; sheet: number }> {
		const result: Array<{ session: CollabSessionInstance; sheet: number }> = [];
		for (const instance of localPanels.values()) {
			result.push({ session: instance.session, sheet: instance.sheet });
		}
		return result;
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

	/**
	 * V3.2.d Opus MEDIUM-1 closure (2026-05-22): tracks whether
	 * `panel.dispose()` has fired.  `webview.postMessage` to a
	 * disposed panel returns a rejected/no-op Thenable and the
	 * message is silently lost; the user typed a value + saw no
	 * error decoration.  The errorReply path checks this flag + falls
	 * back to `vscode.window.showWarningMessage` so the user gets a
	 * surface for late-arriving validation errors.
	 *
	 * Public-readonly because `show()`'s `onDidDispose` handler sets
	 * it BEFORE calling `disposeAttachment` (so any in-flight
	 * postMessage early-returns).  Could be `#private` but TS
	 * downlevel + the existing JSDoc style use `private`/`readonly`
	 * conventions.
	 */
	_disposed: boolean = false;

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
			onError: reply => {
				// V3.2.d Opus MEDIUM-1 closure (2026-05-22): if the
				// panel has been disposed (or is hidden with
				// retainContextWhenHidden: false, which the V3.2
				// panel config is), `webview.postMessage` silently
				// drops the message.  Fall back to
				// `showWarningMessage` so the user sees the error.
				if (this._disposed) {
					void vscode.window.showWarningMessage(
						`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
					);
					return;
				}
				void this.panel.webview.postMessage(reply);
			},
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
				// V3.2.d Codex M3 closure (2026-05-22): wrap render()
				// in try/catch.  exportCellSnapshot can throw at the
				// engine boundary (op log iteration / JSON decode of
				// a maliciously-formed merged blob).  Pre-V3.2.d a
				// throw here bubbled into setInterval which silently
				// swallowed it AND kept ticking -- the panel
				// continued to fire merged ticks that did no visible
				// work.  Now: log the structured code; on a
				// `bad_argument` / `session_oplog` (semantic engine
				// failure) tear down the panel cleanly via
				// handleTransportClosed-style dispose; on transient
				// errors skip this tick.
				try {
					this.render();
				} catch (err) {
					const info = parseQuantbookError(err);
					state.log.appendLine(`[collab] render() failed after merged tick: code=${info.code} msg=${info.message}`);
					if (info.code === 'bad_argument' || info.code === 'session_oplog') {
						state.log.appendLine('[collab] render() error is fatal; disposing panel');
						void vscode.window.showWarningMessage(
							`Cell Grid (Collab) failed to render after a remote merge: [${info.code}] ${info.message}.`,
							'Restart Cell Grid (Collab)',
						).then(choice => {
							if (choice === 'Restart Cell Grid (Collab)') {
								void vscode.commands.executeCommand('quantlab.quantbookCellGridCollab');
							}
						});
						this.panel.dispose();
					}
				}
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
			// V3.2.d Codex M1 closure (2026-05-22): engine contract
			// is mutate-then-flush -- if a cell commit's OnAppend
			// auto-flush failed with `transport_closed` BEFORE this
			// reconnect, the local PutValue op is already in the log
			// but unflushed.  Just attaching a fresh transport does
			// NOT flush pending ops (see
			// `crates/ql-collab/src/session.rs:723-736`).  Check
			// `hasPendingFlush()` and explicitly flush after attach
			// so the local commit reaches the peer rather than
			// staying buffered until the next user mutation.
			if (this.session.hasPendingFlush()) {
				try {
					const flushed = this.session.flushDeltaToTransport();
					state.log.appendLine(`[collab] post-reconnect flushDeltaToTransport returned ${flushed} (cleared pending op)`);
				} catch (flushErr) {
					const flushInfo = parseQuantbookError(flushErr);
					state.log.appendLine(`[collab] post-reconnect flush failed: code=${flushInfo.code} msg=${flushInfo.message}`);
					// Don't escalate: the next pollRemote / user
					// edit cycle has another chance.  If the
					// transport is closed again, handleTransportClosed
					// re-fires on the next tick.
				}
			}
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
