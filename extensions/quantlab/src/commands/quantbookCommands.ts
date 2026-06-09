/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- Quantbook commands.
 *
 * Registers the demo round-trip command (engine smoke), the multi-window demo,
 * and the cell-grid commands.
 *
 * **FE-0a Part B (B1+B2, 2026-06-02) -- grid on the owning single-writer
 * `Session`.** The primary "Open Cell Grid" command binds the owning `Session`
 * (createWorkbookSession) so the grid can consume the ENG-FUSION fusion
 * primitives and write text cells. **B2** un-stubbed the sheet-management +
 * `.qbook` persistence commands on `Session`: switch/add/rename/delete/move sheet
 * (via `Session.listSheets`/`addSheet`/`renameSheet`/`deleteSheet`/`moveSheet`),
 * Save As (`Session.save` via {@link saveSessionToQbook}), and Open
 * (`Session.open` via {@link openWorkbookFromQbook}; Open is ADDITIVE as of the
 * 2026-06-05 host fix -- it shows the opened workbook in a new tab and never closes
 * the others). The collaborative path
 * (`quantbookCellGridCollab`) is a loud stub (real-time collab is v1.5-deferred:
 * "CRDT built, transport unwired"). The CollabSession demo commands
 * (quantbookDemo / quantbookDemoMultiWindow) remain dormant on `CollabSession`.
 */

import * as vscode from 'vscode';

// FE-0a Part B (B1, 2026-06-02): the cell grid migrated to the owning
// single-writer `Session` (createWorkbookSession + setValueValidated +
// recalcDirtyChecked). The CollabSession helpers (createSession / addSheet /
// appendPutValueValidated / sessionFromSnapshot) remain imported for the DORMANT
// demo commands (quantbookDemo / quantbookDemoMultiWindow). The .qbook + sheet-
// management helpers (exportToQbook / sessionFromQbook / listSheets / renameSheet
// / deleteSheet / moveSheet / workbookSnapshot, the buildSheet* quickpick
// builders, connectOrSpawn) belong to the B2-stubbed grid commands and are no
// longer imported here.
import { addSheet, appendPutValueValidated, createSession, createWorkbookSession, openWorkbookFromQbook, quantbookEngineVersion, recalcDirtyChecked, saveSessionToQbook, sessionFromSnapshot, setValueValidated } from '../quantbook/session';
import { loadQuantbookEngine, quantbookHostInfo } from '../quantbook/loader';
import { runMultiWindowDemo } from '../quantbook/multiWindowDemo';
import { CellGridPanel } from '../quantbook/cellGrid/cellGridPanel';
import { showRenderBenchPanel } from '../quantbook/bench/renderBenchPanel';
import { buildSheetManagementQuickPickItems, buildSheetMovePositionItems, buildSheetQuickPickItems, classifySwitchSheetTarget, resolveCommandTargetPanel } from '../quantbook/cellGrid/cellGridLogic';
import type { CollabSessionInstance, SessionInstance } from '../quantbook/types';

let outputChannel: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
	if (outputChannel === undefined) {
		outputChannel = vscode.window.createOutputChannel('Quantbook');
	}
	return outputChannel;
}

/**
 * Close an owning `Session`, logging (never swallowing) any close failure. Used on
 * the Open command's error / workbook-replace paths where the session is being
 * discarded: a close failure must not mask the primary outcome, but it MUST stay
 * VISIBLE (No-Fallbacks -- the underlying error is written to the Quantbook output
 * channel rather than dropped).
 */
function closeSessionQuietly(session: SessionInstance, log: vscode.OutputChannel, when: string): void {
	try {
		session.close();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		log.appendLine(`(non-fatal) closing session failed during ${when}: ${detail}`);
	}
}

/**
 * Resolve the (session, sheet) a sheet-management / Save-As command should act on,
 * surfacing the no-panel / ambiguous cases as user-facing messages and returning
 * `undefined` so the caller aborts.
 *
 * **Smoke-megaudit host MED (2026-06-05)**: consolidates the per-command no-panel
 * check + the `focusedLocalPanel() ?? localPanels[0]` fallback into one place that
 * NEVER silently picks an arbitrary workbook. With several workbooks open and none
 * focused, {@link resolveCommandTargetPanel} returns `ambiguous`; we ask the user to
 * focus the grid they mean rather than mutate/save the oldest one (No-Fallbacks).
 */
function resolveTargetOrWarn(): { session: SessionInstance; sheet: number } | undefined {
	const localPanels = CellGridPanel.activeLocalPanels();
	if (localPanels.length === 0) {
		void vscode.window.showInformationMessage('No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.');
		return undefined;
	}
	const resolution = resolveCommandTargetPanel(localPanels, CellGridPanel.focusedLocalPanel());
	if (resolution.kind === 'ambiguous') {
		void vscode.window.showInformationMessage(
			'Multiple Cell Grids are open and none is focused. Click the Cell Grid you want, then re-run this command.',
		);
		return undefined;
	}
	return { session: resolution.session, sheet: resolution.sheet };
}

function describe(label: string, session: CollabSessionInstance): string {
	return `${label}: peerId=${session.peerId()}, opCount=${session.opCount()}, pending=${session.pendingOpCount()}, hasPendingFlush=${session.hasPendingFlush()}`;
}

/**
 * Demo state held across the run. Two peers; peer B is created on
 * first "Sync to Peer B" action and reused thereafter.
 */
interface DemoState {
	peerA: CollabSessionInstance;
	peerB: CollabSessionInstance | undefined;
}

async function runDemoLoop(state: DemoState, log: vscode.OutputChannel): Promise<void> {
	while (true) {
		const status = describe('peer A', state.peerA) +
			(state.peerB !== undefined ? `\n${describe('peer B', state.peerB)}` : '\n(peer B not yet created)');

		const choice = await vscode.window.showInformationMessage(
			`Quantbook demo round-trip\n\n${status}`,
			{ modal: true },
			'Add Random PutValue (peer A)',
			'Sync A -> B',
			'Sync B -> A',
			'Append on peer B',
			'Close',
		);

		if (choice === undefined || choice === 'Close') {
			log.appendLine('Demo closed.');
			return;
		}

		try {
			if (choice === 'Add Random PutValue (peer A)') {
				const sheet = 0;
				const row = Math.floor(Math.random() * 100);
				const col = Math.floor(Math.random() * 10);
				const value = Math.round(Math.random() * 10000) / 100;
				// V1 audit closure (Opus H2 + Codex H3): route through
				// the validating wrapper so any future demo with
				// out-of-range / non-finite inputs surfaces a precise
				// error instead of silently corrupting workbook state.
				appendPutValueValidated(state.peerA, sheet, row, col, value);
				log.appendLine(`peer A appendPutValue(${sheet}, ${row}, ${col}, ${value}) -> opCount=${state.peerA.opCount()}`);
			} else if (choice === 'Sync A -> B') {
				const bytes = state.peerA.exportBytes();
				log.appendLine(`peer A exportBytes() -> ${bytes.length} bytes`);
				if (state.peerB === undefined) {
					state.peerB = sessionFromSnapshot(2n, bytes);
					log.appendLine(`peer B created via fromSnapshot(2n, ${bytes.length} bytes) -> opCount=${state.peerB.opCount()}`);
				} else {
					const merged = state.peerB.mergeBytes(bytes);
					log.appendLine(`peer B mergeBytes(${bytes.length} bytes) -> merged=${merged}, opCount=${state.peerB.opCount()}`);
				}
			} else if (choice === 'Sync B -> A') {
				if (state.peerB === undefined) {
					vscode.window.showWarningMessage('Peer B does not exist yet. Run "Sync A -> B" first.');
					continue;
				}
				const bytes = state.peerB.exportBytes();
				log.appendLine(`peer B exportBytes() -> ${bytes.length} bytes`);
				const merged = state.peerA.mergeBytes(bytes);
				log.appendLine(`peer A mergeBytes(${bytes.length} bytes) -> merged=${merged}, opCount=${state.peerA.opCount()}`);
			} else if (choice === 'Append on peer B') {
				if (state.peerB === undefined) {
					vscode.window.showWarningMessage('Peer B does not exist yet. Run "Sync A -> B" first.');
					continue;
				}
				const sheet = 0;
				const row = Math.floor(Math.random() * 100);
				const col = Math.floor(Math.random() * 10);
				const value = Math.round(Math.random() * 10000) / 100;
				appendPutValueValidated(state.peerB, sheet, row, col, value);
				log.appendLine(`peer B appendPutValue(${sheet}, ${row}, ${col}, ${value}) -> opCount=${state.peerB.opCount()}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.appendLine(`ERROR: ${message}`);
			vscode.window.showErrorMessage(`Quantbook demo error: ${message}`);
		}
	}
}

export function registerQuantbookCommands(context: vscode.ExtensionContext): void {
	// --- DORMANT CollabSession demo commands (engine smoke; kept for v1.5). ---
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookDemo', async () => {
			const log = getOutput();
			log.show(true);
			log.appendLine('=== Quantbook Demo Round-Trip ===');
			log.appendLine(`Host: ${quantbookHostInfo()}`);
			try {
				const version = quantbookEngineVersion();
				log.appendLine(`Engine binding version: ${version}`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL: failed to load engine binding -- ${detail}`);
				vscode.window.showErrorMessage(`Quantbook engine binding failed to load: ${detail}`);
				return;
			}
			let peerA: CollabSessionInstance;
			try {
				peerA = createSession(1n);
				// V3.4.0.X HIGH-3 carry: seed sheet 0 so demo PutValue
				// ops have a sheet to land on at replay time (the demo
				// loop writes via appendPutValueValidated).
				addSheet(peerA, 'S0');
				log.appendLine(`peer A created: peerId=${peerA.peerId()}`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL: failed to create peer A -- ${detail}`);
				vscode.window.showErrorMessage(`Quantbook demo: failed to create session: ${detail}`);
				return;
			}
			await runDemoLoop({ peerA, peerB: undefined }, log);
		}),
	);

	// Phase 5.7 V3.1.b (2026-05-22) -- multi-window demo command.
	// Each VS Code window's invocation joins (or spawns) the localhost
	// relay binary and runs a periodic append + pollRemote loop. See
	// src/quantbook/multiWindowDemo.ts for the orchestration. (Dormant collab.)
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookDemoMultiWindow', async () => {
			const log = getOutput();
			log.show(true);
			try {
				const engine = loadQuantbookEngine();
				const disposable = await runMultiWindowDemo(engine, log);
				context.subscriptions.push(disposable);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL multi-window demo error: ${detail}`);
				vscode.window.showErrorMessage(`Quantbook multi-window demo failed: ${detail}`);
			}
		}),
	);

	// Phase 5.7 V3.2.a.1 (2026-05-22) -- refresh active cell-grid panels in place.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridRefresh', () => {
			const { refreshed, failed } = CellGridPanel.refreshAll();
			if (refreshed === 0 && failed === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panels are open. Run "Quantbook: Open Cell Grid" first.',
				);
			} else {
				const log = getOutput();
				log.appendLine(`Refreshed ${refreshed} cell-grid panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
				if (failed > 0) {
					void vscode.window.showWarningMessage(`Quantbook: ${failed} panel(s) failed to re-render -- check the Quantbook output for details.`);
				}
			}
		}),
	);

	// --- Primary cell-grid command (FE-0a Part B / B1: owning Session). ---
	// Opens a single-writer Session-backed grid seeded with sample data so the
	// scaffold shows something. The user can edit number / text / `=formula`
	// cells; the host writes via Session.setValue/setFormula, recalcs, re-renders.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGrid', () => {
			const log = getOutput();
			// Smoke-megaudit host LOW (2026-06-05): hold the session in an outer binding
			// so a seed-write / recalc / initial-show failure can close it (the native
			// Session owns an engine handle). On the happy path `CellGridPanel.show` takes
			// ownership and the panel's ref-counted dispose closes it later.
			let session: SessionInstance | undefined;
			try {
				// FE-0a Part B (B1): bind the owning single-writer Session.
				session = createWorkbookSession();
				// Seed sample data on THREE sheets (0, 1, 2). addSheet MUST precede
				// any setValue on a sheet (the engine rejects a write to a sheet that
				// does not exist yet). Sheet ids are assigned in append order: first
				// addSheet -> 0, second -> 1, third -> 2.
				session.addSheet('S0', 1000);
				session.addSheet('S1', 1000);
				session.addSheet('S2', 1000);
				const num = (n: number): { kind: 'number'; number: number } => ({ kind: 'number', number: n });
				setValueValidated(session, 0, 0, 0, num(42));
				setValueValidated(session, 0, 0, 1, num(100));
				setValueValidated(session, 0, 1, 0, num(3.14));
				setValueValidated(session, 0, 1, 1, num(2.718));
				setValueValidated(session, 0, 2, 0, num(0));
				setValueValidated(session, 1, 0, 0, num(11));
				setValueValidated(session, 1, 0, 1, num(12));
				setValueValidated(session, 1, 1, 0, num(13));
				setValueValidated(session, 2, 0, 0, num(99));
				recalcDirtyChecked(session);
				CellGridPanel.show(context, session, 0);
				// Ownership has transferred to the live registered panel (its ref-counted
				// dispose will close the session). Clear our binding NOW so that if any
				// post-show statement below throws, the catch does NOT close a session that
				// is owned by a live panel (Codex host-batch audit MED). Must come BEFORE
				// any further statement that can throw.
				session = undefined;
				log.appendLine('Cell Grid (sheet 0) opened with sample data on sheets 0/1/2.');
			} catch (err) {
				// Close the session only if the failure happened BEFORE the panel took
				// ownership (seed write / recalc / show-before-registration) -- on success
				// `session` was cleared above. If show() failed AFTER registering the panel,
				// its dispose path already closed the session and this is a benign idempotent
				// no-op -- same contract as the Open command (No-Fallbacks: closeSessionQuietly
				// logs, never swallows).
				if (session !== undefined) {
					closeSessionQuietly(session, log, 'cell-grid seed/display failure');
				}
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL cell-grid error: ${detail}`);
				vscode.window.showErrorMessage(`Quantbook cell grid failed: ${detail}`);
			}
		}),
	);

	// FE-0a Part B (B1): real-time collab is deferred to v1.5 ("CRDT built,
	// transport unwired"); the grid is single-writer in v1. The CollabSession +
	// Transport + LoopbackPair primitives remain in the codebase, dormant.
	// Registered as a loud stub so the command gives a clean message.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridCollab', () => {
			void vscode.window.showInformationMessage(
				'Quantbook: real-time collaborative editing is deferred to v1.5. ' +
				'The cell grid is single-writer in v1.',
			);
		}),
	);

	// --- FE-2 BAKEOFF (2026-06-09): the render-bench panel. Drives the REAL paint path (the extracted
	// RenderOrchestrator + CanvasGridRenderer) against synthetic datasets to measure the FE-2 perf gates,
	// so the Canvas2D-vs-GPU decision rests on evidence. No session/write path -- the bench synthesizes
	// its own data webview-side; the host only loads the shell + logs the posted results.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookRenderBench', () => {
			showRenderBenchPanel(context, getOutput());
		}),
	);

	// --- FE-0a Part B2 (2026-06-02): sheet-management + .qbook persistence on the
	// owning single-writer Session. Each command targets the panel via
	// {@link resolveTargetOrWarn} (smoke-megaudit host MED, 2026-06-05): the FOCUSED
	// panel wins; with no focus it falls back to the sole workbook ONLY when every open
	// panel shares one session, otherwise it aborts and asks the user to focus a grid
	// (it NEVER silently mutates an arbitrary "oldest" workbook). Engine ops fail loud
	// (No-Fallbacks); the refreshAll repaint is in a SEPARATE try so a render failure is
	// not misreported as an engine-op failure.

	// Switch the active panel to another sheet of the same session.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridSwitchSheet', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			// SessionInstance.listSheets() returns SheetInfoJson[]; the number-only
			// switch builder takes ids -> map to ids (FE-0a Part B2 reviewer fix).
			// listSheets() can throw off an unreadable lifecycle state -> report loud
			// (consistent with rename/delete/move; No-Fallbacks).
			let sheetInfos;
			try {
				sheetInfos = target.session.listSheets();
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				getOutput().appendLine(`FATAL listSheets error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook cell grid switch failed: ${detail}`);
				return;
			}
			const plan = classifySwitchSheetTarget(sheetInfos.map(s => s.id), target.sheet);
			if (plan.kind === 'no-sheets') {
				void vscode.window.showInformationMessage('This session has no sheets yet.');
				return;
			}
			if (plan.kind === 'only-current') {
				void vscode.window.showInformationMessage(`Only sheet ${target.sheet} exists in this session; nothing to switch to.`);
				return;
			}
			if (plan.kind === 'auto') {
				// Smoke-megaudit host MED (2026-06-05): the active sheet was deleted out from
				// under the panel and exactly one live sheet remains -- switch straight to it.
				// The prior `length === 1` branch dead-ended with "nothing to switch to",
				// stranding the panel on an empty tombstoned grid. No quick-pick: one destination.
				try {
					CellGridPanel.show(context, target.session, plan.sheet);
					getOutput().appendLine(`Switched Cell Grid view to the only remaining sheet ${plan.sheet} (active sheet ${target.sheet} was deleted).`);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					getOutput().appendLine(`FATAL switch-sheet error: ${detail}`);
					void vscode.window.showErrorMessage(`Quantbook cell grid switch failed: ${detail}`);
				}
				return;
			}
			// plan.kind === 'pick': two or more live sheets -- show the quick-pick.
			const items = buildSheetQuickPickItems(sheetInfos.map(s => s.id), target.sheet);
			const selection = await vscode.window.showQuickPick(items, {
				title: 'Switch Cell Grid Sheet',
				placeHolder: `Currently on Sheet ${target.sheet} (${sheetInfos.length} sheets total)`,
			});
			if (selection === undefined) {
				return;
			}
			try {
				CellGridPanel.show(context, target.session, selection.sheet);
				getOutput().appendLine(`Switched Cell Grid view to sheet ${selection.sheet}.`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				getOutput().appendLine(`FATAL switch-sheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook cell grid switch failed: ${detail}`);
			}
		}),
	);

	// Save As: persist the active panel's Session to a `.qbook` directory.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSaveAs', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			const uri = await vscode.window.showSaveDialog({
				title: 'Save Quantbook As',
				filters: { Quantbook: ['qbook'] },
				saveLabel: 'Save',
			});
			if (uri === undefined) {
				return;
			}
			const log = getOutput();
			try {
				saveSessionToQbook(target.session, uri.fsPath);
				log.appendLine(`Saved Cell Grid (sheet ${target.sheet}) to ${uri.fsPath}.`);
				void vscode.window.showInformationMessage(`Quantbook saved to ${uri.fsPath}`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL Save As error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook save failed: ${detail}`);
			}
		}),
	);

	// Open: load a `.qbook` into a fresh Session shown in its OWN new Cell Grid tab.
	// **Smoke-megaudit host HIGH fix (2026-06-05): additive open.** Open used to call
	// `CellGridPanel.disposeAll()`, which closed EVERY open workbook (not just the one
	// being replaced) -- multi-workbook data loss. It is now additive: it disposes
	// nothing and shows the opened workbook alongside the others, matching Excel/Sheets
	// (Open adds a window; it never closes your current file). This is safe because the
	// FE megaudit F2 panel registry keys by SESSION IDENTITY, so `show(newSession, ...)`
	// for the brand-new session always creates a fresh tab and can never reveal a stale
	// panel of another workbook (the original reason disposeAll was added -- a
	// sheet-id-keyed registry collision -- no longer exists).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookOpen', async () => {
			const uris = await vscode.window.showOpenDialog({
				title: 'Open Quantbook',
				filters: { Quantbook: ['qbook'] },
				canSelectFiles: false,
				canSelectFolders: true, // .qbook is a directory
				canSelectMany: false,
				openLabel: 'Open',
			});
			if (uris === undefined || uris.length === 0) {
				return;
			}
			const path = uris[0].fsPath;
			const log = getOutput();
			// 1) Open the new workbook FIRST. A failed open leaves the current workbook
			// + its panels intact (nothing has been disposed yet).
			let session;
			try {
				session = openWorkbookFromQbook(path);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL Open error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook open failed: ${detail}`);
				return;
			}
			// 2) The opened workbook MUST have a live sheet -- never show a phantom
			// sheet 0 for an empty/corrupt workbook (No-Fallbacks). listSheets() can also
			// throw off an unreadable state -> close the new session + report loud.
			let firstSheet: number;
			try {
				const sheetInfos = session.listSheets();
				if (sheetInfos.length === 0) {
					closeSessionQuietly(session, log, 'empty-workbook open');
					log.appendLine(`Open aborted: "${path}" has no live sheets.`);
					void vscode.window.showErrorMessage(`Quantbook open failed: "${path}" has no live sheets.`);
					return;
				}
				firstSheet = sheetInfos[0].id;
				log.appendLine(`Opened Quantbook from ${path} (${sheetInfos.length} sheet(s)).`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				closeSessionQuietly(session, log, 'open read-sheets failure');
				log.appendLine(`FATAL Open (read sheets) error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook open failed: ${detail}`);
				return;
			}
			// 3) Show the opened workbook in a NEW tab (additive -- no other workbook is
			// touched). The new session has no panel yet, so show() creates a fresh one
			// (F2 keys by session identity -- no collision with the tabs of other open
			// workbooks). A display failure is reported AS a display failure and the new,
			// never-shown session is closed so its engine handle is not leaked.
			try {
				CellGridPanel.show(context, session, firstSheet);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				closeSessionQuietly(session, log, 'open display failure');
				log.appendLine(`FATAL Open (display) error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook opened the workbook but failed to display it: ${detail}`);
			}
		}),
	);

	// Add a sheet to the active panel's session.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetAdd', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			const name = await vscode.window.showInputBox({
				title: 'Add Quantbook Sheet',
				prompt: 'Enter a name for the new sheet',
				placeHolder: 'e.g., "Q4 Returns" or "Sheet3"',
				validateInput: (value) => (value.trim() === '' ? 'Sheet name cannot be empty' : null),
			});
			if (name === undefined) {
				return;
			}
			const log = getOutput();
			let opSucceeded = false;
			try {
				const newId = target.session.addSheet(name.trim(), 1000);
				opSucceeded = true;
				log.appendLine(`Added sheet "${name.trim()}" (id ${newId}) to session.`);
				void vscode.window.showInformationMessage(`Sheet "${name.trim()}" added (id ${newId}).`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL addSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook add sheet failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					// Megaudit (2026-06-05) M1: refresh THIS session's panels, not every open workbook's
					// (refreshAll) -- matches the session-scoped onCommit path + stops misattributing an unrelated
					// workbook's render failure to this sheet op.
					const { refreshed, failed } = CellGridPanel.refreshSession(target.session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the sheet change succeeded, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after addSheet failed (non-fatal): ${detail}`);
				}
			}
		}),
	);

	// Rename a sheet of the active panel's session.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetRename', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			const log = getOutput();
			let sheetInfos;
			try {
				sheetInfos = target.session.listSheets();
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL listSheets error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename sheet failed: ${detail}`);
				return;
			}
			if (sheetInfos.length === 0) {
				void vscode.window.showInformationMessage('This session has no sheets yet.  Add a sheet first via "Quantbook: Add Sheet...".');
				return;
			}
			const pick = await vscode.window.showQuickPick(buildSheetManagementQuickPickItems(sheetInfos, target.sheet), {
				title: 'Rename Quantbook Sheet',
				placeHolder: 'Select a sheet to rename',
			});
			if (pick === undefined) {
				return;
			}
			const newName = await vscode.window.showInputBox({
				title: `Rename Sheet "${pick.name}"`,
				prompt: `Enter a new name for sheet ${pick.sheet}`,
				value: pick.name,
				validateInput: (value) => {
					if (value.trim() === '') {
						return 'Sheet name cannot be empty';
					}
					if (value.trim() === pick.name) {
						return 'New name is the same as the current name';
					}
					return null;
				},
			});
			if (newName === undefined) {
				return;
			}
			let opSucceeded = false;
			try {
				target.session.renameSheet(pick.sheet, newName.trim());
				opSucceeded = true;
				log.appendLine(`Renamed sheet ${pick.sheet} from "${pick.name}" to "${newName.trim()}".`);
				void vscode.window.showInformationMessage(`Sheet ${pick.sheet} renamed to "${newName.trim()}".`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL renameSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename sheet failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					// Megaudit (2026-06-05) M1: refresh THIS session's panels, not every open workbook's
					// (refreshAll) -- matches the session-scoped onCommit path + stops misattributing an unrelated
					// workbook's render failure to this sheet op.
					const { refreshed, failed } = CellGridPanel.refreshSession(target.session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the sheet change succeeded, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after renameSheet failed (non-fatal): ${detail}`);
				}
			}
		}),
	);

	// Delete (tombstone) a sheet of the active panel's session.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetDelete', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			const log = getOutput();
			let sheetInfos;
			try {
				sheetInfos = target.session.listSheets();
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL listSheets error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook delete sheet failed: ${detail}`);
				return;
			}
			if (sheetInfos.length === 0) {
				void vscode.window.showInformationMessage('This session has no sheets to delete.');
				return;
			}
			const pick = await vscode.window.showQuickPick(buildSheetManagementQuickPickItems(sheetInfos, target.sheet), {
				title: 'Delete Quantbook Sheet',
				placeHolder: 'Select a sheet to delete',
			});
			if (pick === undefined) {
				return;
			}
			// Tombstone semantic (engine preserves cells internally); the sheet
			// disappears from the grid. restoreSheet exists on the engine but has no
			// UI yet, so confirm before applying.
			const confirm = await vscode.window.showWarningMessage(
				`Delete sheet ${pick.sheet} ("${pick.name}")?  It is tombstoned (cells preserved internally) but disappears from the grid; no restore command exists yet.`,
				{ modal: true },
				'Delete',
			);
			if (confirm !== 'Delete') {
				return;
			}
			let opSucceeded = false;
			try {
				target.session.deleteSheet(pick.sheet);
				opSucceeded = true;
				log.appendLine(`Deleted sheet ${pick.sheet} ("${pick.name}").`);
				void vscode.window.showInformationMessage(`Sheet ${pick.sheet} ("${pick.name}") deleted.`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL deleteSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook delete sheet failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					// Megaudit (2026-06-05) M1: refresh THIS session's panels, not every open workbook's
					// (refreshAll) -- matches the session-scoped onCommit path + stops misattributing an unrelated
					// workbook's render failure to this sheet op.
					const { refreshed, failed } = CellGridPanel.refreshSession(target.session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the sheet change succeeded, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after deleteSheet failed (non-fatal): ${detail}`);
				}
			}
		}),
	);

	// Move (reorder) a sheet of the active panel's session.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetMove', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return;
			}
			const log = getOutput();
			let sheetInfos;
			try {
				sheetInfos = target.session.listSheets();
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL listSheets error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook move sheet failed: ${detail}`);
				return;
			}
			if (sheetInfos.length < 2) {
				void vscode.window.showInformationMessage('This session needs at least 2 sheets to move one.');
				return;
			}
			const sourcePick = await vscode.window.showQuickPick(buildSheetManagementQuickPickItems(sheetInfos, target.sheet), {
				title: 'Move Quantbook Sheet (1 of 2)',
				placeHolder: 'Select a sheet to move',
			});
			if (sourcePick === undefined) {
				return;
			}
			const positionPick = await vscode.window.showQuickPick(buildSheetMovePositionItems(sheetInfos, sourcePick.sheet), {
				title: `Move "${sourcePick.name}" (2 of 2)`,
				placeHolder: 'Select the target display position',
			});
			if (positionPick === undefined) {
				return;
			}
			let opSucceeded = false;
			try {
				target.session.moveSheet(sourcePick.sheet, positionPick.sheet);
				opSucceeded = true;
				log.appendLine(`Moved sheet ${sourcePick.sheet} ("${sourcePick.name}") to display position ${positionPick.sheet}.`);
				void vscode.window.showInformationMessage(`Sheet "${sourcePick.name}" moved to position ${positionPick.sheet}.`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL moveSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook move sheet failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					// Megaudit (2026-06-05) M1: refresh THIS session's panels, not every open workbook's
					// (refreshAll) -- matches the session-scoped onCommit path + stops misattributing an unrelated
					// workbook's render failure to this sheet op.
					const { refreshed, failed } = CellGridPanel.refreshSession(target.session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the sheet change succeeded, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after moveSheet failed (non-fatal): ${detail}`);
				}
			}
		}),
	);
}
