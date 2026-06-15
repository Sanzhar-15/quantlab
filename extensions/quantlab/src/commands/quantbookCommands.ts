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
import { addSheet, appendPutValueValidated, createSession, createWorkbookSession, openWorkbookFromQbook, quantbookEngineVersion, recalcDirtyChecked, saveSessionToQbook, sessionFromSnapshot, setFormulaValidated, setValueValidated } from '../quantbook/session';
import { loadQuantbookEngine, quantbookHostInfo } from '../quantbook/loader';
import { runMultiWindowDemo } from '../quantbook/multiWindowDemo';
import { CellGridPanel } from '../quantbook/cellGrid/cellGridPanel';
import { showRenderBenchPanel } from '../quantbook/bench/renderBenchPanel';
import { buildSheetManagementQuickPickItems, buildSheetMovePositionItems, buildSheetQuickPickItems, classifySwitchSheetTarget, defaultCsvFileName, resolveCommandTargetPanel } from '../quantbook/cellGrid/cellGridLogic';
import { FORMAT_PRESET_CHOICES, buildFormatUndoLabel, buildSetFormatOps, formatStringForPreset, presetLabel, type FormatPreset } from '../quantbook/cellGrid/formatPickerLogic';
// FE-4 W2 (2026-06-10): the pure, vscode-free sort core (read snapshot rect -> refuse-on-formula -> row
// permutation -> setValue batch). The command below is a thin vscode shell over it (the established N-1/N-2 split).
import { buildSortBatch, buildSortKeyChoices, buildSortUndoLabel, isAlreadySorted, readRectGrid, type SortDirection } from '../quantbook/cellGrid/sortLogic';
import { columnLabelA1, formatRangeTarget, normalizeSelectionRect } from '../quantbook/reactiveNotebook/bindVariableLogic';
// W3 (Wave 3, 2026-06-09): the pure structural-op planner (selection -> engine insert/delete call) + the
// data-vscode-context argument validator (Codex HIGH-1/HIGH-2 fold: plan from the carried selection,
// route by the carried panel token).
import { describeStructuralPlan, parseContextMenuArg, planStructuralOp, type StructuralOp } from '../quantbook/cellGrid/contextMenuLogic';
// FE-4 W1 (2026-06-10): the pure cores for Find/Replace-All (snapshot-read -> hit list + replace op
// batch) and Define Name (Excel name validation + selection -> CellRangeJson). The commands below are
// thin vscode shells over these (the established cellGrid logic/command split).
import { buildReplaceAllOps, findHitsInWorkbook, type FindHit, type FindReplaceQuery } from '../quantbook/cellGrid/findReplaceLogic';
import { buildDefineNameToast, buildNameRange, definedNameRejectionReason, isValidDefinedName } from '../quantbook/cellGrid/nameDefineLogic';
// FE-5 W-N (2026-06-12): the pure cores for the Name Manager (describe a name's target/scope + resolve its
// Go-To anchor) and the structured-table UI (identifier validation + selection -> TableSpecJson). The
// commands below are thin vscode shells over these (the established cellGrid logic/command split).
import { describeScope, describeTarget, goToAnchor, isGoToable } from '../quantbook/cellGrid/nameManagerLogic';
import { buildTableSpec, isValidTableIdentifier, planColumnNamesFromHeaders, planColumnRename, planTableResize, tableAtCell, tableColumnRejectionReason, tableIdentifierRejectionReason, tableQuickPickItems } from '../quantbook/cellGrid/tableUiLogic';
import type { CollabSessionInstance, NamedRangeJson, SessionInstance, TableSnapshotJson } from '../quantbook/types';

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
	//
	// **Demo-prep (2026-06-10)**: the seed is a compelling QUANT demo workbook (not
	// toy numbers): a monthly-returns sheet with a native-=SHARPE stats block, a
	// price sheet with =MAX_DRAWDOWN, and an empty Scratch sheet as the live-typing
	// demo surface. Function choices are pinned by a release-dylib smoke
	// (2026-06-10): SHARPE/SUM/AVERAGE/STDEV.S/MIN/MAX/MEDIAN bind literal ranges;
	// MAX_DRAWDOWN is defined over a PRICE series (it returns #NUM! on a returns
	// series, hence the dedicated Prices sheet); VOLATILITY does NOT bind literal
	// ranges and is deliberately absent (STDEV.S serves as the volatility stat).
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
				// Seed THREE sheets. addSheet MUST precede any setValue on a sheet (the
				// engine rejects a write to a sheet that does not exist yet). Sheet ids are
				// assigned in append order: 'Returns' -> 0, 'Prices' -> 1, 'Scratch' -> 2.
				session.addSheet('Returns', 1000);
				session.addSheet('Prices', 1000);
				session.addSheet('Scratch', 1000);
				// Local write helpers over the validated session wrappers (the helpers
				// capture the non-undefined binding so the closures stay narrow-typed).
				const s = session;
				const num = (sheet: number, row: number, col: number, n: number): void =>
					setValueValidated(s, sheet, row, col, { kind: 'number', number: n });
				const txt = (sheet: number, row: number, col: number, t: string): void =>
					setValueValidated(s, sheet, row, col, { kind: 'text', text: t });
				// Formula BODY without the leading '=' (engine convention -- setFormulaValidated
				// passes the text through; the grid renders it with the '=' prefix).
				const fx = (sheet: number, row: number, col: number, body: string): void =>
					setFormulaValidated(s, sheet, row, col, body);
				const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
				// --- Sheet 0 'Returns': a monthly return series (B2:B13) + a stats block in D/E. ---
				const RETURNS = [0.021, -0.013, 0.034, 0.008, -0.022, 0.041, 0.015, -0.007, 0.026, 0.012, -0.018, 0.029];
				txt(0, 0, 0, 'Month');
				txt(0, 0, 1, 'Return');
				MONTHS.forEach((month, i) => {
					txt(0, i + 1, 0, month);
					num(0, i + 1, 1, RETURNS[i]);
				});
				txt(0, 1, 3, 'Sharpe');
				fx(0, 1, 4, 'SHARPE(B2:B13)'); // 0.4959 on this series (smoke-verified)
				txt(0, 2, 3, 'Avg return');
				fx(0, 2, 4, 'AVERAGE(B2:B13)');
				txt(0, 3, 3, 'Volatility');
				fx(0, 3, 4, 'STDEV.S(B2:B13)');
				txt(0, 4, 3, 'Best month');
				fx(0, 4, 4, 'MAX(B2:B13)');
				txt(0, 5, 3, 'Worst month');
				fx(0, 5, 4, 'MIN(B2:B13)');
				txt(0, 6, 3, 'Total');
				fx(0, 6, 4, 'SUM(B2:B13)');
				// --- Sheet 1 'Prices': a price path (B2:B13) + the drawdown block in D/E. ---
				const PRICES = [100, 104, 109, 112, 106, 101, 97, 103, 110, 115, 113, 118];
				txt(1, 0, 0, 'Month');
				txt(1, 0, 1, 'Price');
				MONTHS.forEach((month, i) => {
					txt(1, i + 1, 0, month);
					num(1, i + 1, 1, PRICES[i]);
				});
				txt(1, 1, 3, 'Max drawdown');
				fx(1, 1, 4, 'MAX_DRAWDOWN(B2:B13)'); // -0.1339 on this path (smoke-verified; PRICES, not returns)
				txt(1, 2, 3, 'High');
				fx(1, 2, 4, 'MAX(B2:B13)');
				txt(1, 3, 3, 'Low');
				fx(1, 3, 4, 'MIN(B2:B13)');
				txt(1, 4, 3, 'Median');
				fx(1, 4, 4, 'MEDIAN(B2:B13)');
				// Sheet 2 'Scratch' stays EMPTY -- the live-typing demo surface.
				// --- Seed-time number formats: the same registerFormat -> buildSetFormatOps ->
				// batch pattern as the Set Cell Format command (the engine renders the formatted
				// string; the grid just paints `entry.rendered`). ONE batch per sheet = one undo
				// unit each; coordinates are 0-based (A2 = row 1, E2 = row 1 / col 4).
				const percentId = s.registerFormat(formatStringForPreset('Percent')); // 0.00%
				const ratioId = s.registerFormat(formatStringForPreset('Number')); // 0.00 (Sharpe is a ratio, not a percent)
				const thousandsId = s.registerFormat(formatStringForPreset('NumberThousands')); // #,##0.00
				s.batch([
					...buildSetFormatOps(0, normalizeSelectionRect(1, 1, 12, 1), percentId), // Returns!B2:B13
					...buildSetFormatOps(0, normalizeSelectionRect(1, 4, 1, 4), ratioId), // Returns!E2 (Sharpe)
					...buildSetFormatOps(0, normalizeSelectionRect(2, 4, 6, 4), percentId), // Returns!E3:E7 (stats are return-units)
				], { undoLabel: 'Seed demo formats on Returns' });
				s.batch([
					...buildSetFormatOps(1, normalizeSelectionRect(1, 1, 12, 1), thousandsId), // Prices!B2:B13
					...buildSetFormatOps(1, normalizeSelectionRect(1, 4, 1, 4), percentId), // Prices!E2 (drawdown is a fraction)
					...buildSetFormatOps(1, normalizeSelectionRect(2, 4, 4, 4), thousandsId), // Prices!E3:E5
				], { undoLabel: 'Seed demo formats on Prices' });
				recalcDirtyChecked(session);
				CellGridPanel.show(context, session, 0);
				// Ownership has transferred to the live registered panel (its ref-counted
				// dispose will close the session). Clear our binding NOW so that if any
				// post-show statement below throws, the catch does NOT close a session that
				// is owned by a live panel (Codex host-batch audit MED). Must come BEFORE
				// any further statement that can throw.
				session = undefined;
				log.appendLine('Cell Grid opened with the demo workbook: Returns (=SHARPE stats block) / Prices (=MAX_DRAWDOWN) / Scratch (empty), percent + number formats seeded.');
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

	// FE-8.2 (2026-06-15): Export the active workbook to CSV. Wires the live-but-unreachable
	// `session.export('csv')` napi method (data interchange, distinct from the `.qbook` SAVE path above).
	// The engine serializes a SINGLE live sheet and REFUSES a multi-sheet workbook with a loud BadArgument
	// ("export each sheet separately") -- we surface that verbatim (No-Fallbacks), never a silent partial
	// export. We serialize BEFORE prompting for a path so a multi-sheet workbook fails fast (the operator is
	// not made to pick a file only to error). XLSX is NOT offered: the dylib is not built with the
	// `xlsx-write` feature, so `export('xlsx')` returns not-implemented -- a later engine wave. Pure-IDE.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookExportCsv', async () => {
			const target = resolveTargetOrWarn();
			if (target === undefined) {
				return; // resolveTargetOrWarn already messaged
			}
			const log = getOutput();
			// Serialize FIRST: the engine throws here for a multi-sheet workbook, so we fail before the dialog.
			// Read the sheet name (for the default file name) inside the SAME guard -- both are session reads, so
			// a throw from either surfaces as one loud toast (No-Fallbacks), never an unhandled rejection.
			let bytes: Uint8Array;
			let sheetName: string | undefined;
			try {
				bytes = target.session.export('csv');
				sheetName = target.session.snapshot().sheets.find((s) => s.id === target.sheet)?.name;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL export CSV error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook export to CSV failed: ${detail}`);
				return;
			}
			const folder = vscode.workspace.workspaceFolders?.[0];
			const uri = await vscode.window.showSaveDialog({
				title: 'Export Quantbook to CSV',
				filters: { CSV: ['csv'] },
				saveLabel: 'Export',
				defaultUri: folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, defaultCsvFileName(sheetName)),
			});
			if (uri === undefined) {
				return; // dismissed
			}
			try {
				await vscode.workspace.fs.writeFile(uri, bytes);
				log.appendLine(`Exported workbook to CSV at ${uri.fsPath} (${bytes.length} bytes).`);
				if (bytes.length === 0) {
					// Honest about an empty export: the engine returns 0 bytes for a sheet with no values. The
					// file IS written (faithful), but a plain "exported" toast would imply data where there is none.
					void vscode.window.showWarningMessage(`Quantbook: exported to ${uri.fsPath}, but the sheet was empty (0 bytes written).`);
				} else {
					void vscode.window.showInformationMessage(`Quantbook exported to ${uri.fsPath}`);
				}
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL export CSV write error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook export to CSV failed: ${detail}`);
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
			let newId: number | undefined;
			try {
				newId = target.session.addSheet(name.trim(), 1000);
				log.appendLine(`Added sheet "${name.trim()}" (id ${newId}) to session.`);
				void vscode.window.showInformationMessage(`Sheet "${name.trim()}" added (id ${newId}).`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL addSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook add sheet failed: ${detail}`);
			}
			if (newId !== undefined) {
				try {
					// D6 (sheet-tabs, 2026-06-10): adding a sheet switches the workbook's single panel to it
					// (Excel behavior). show() reveals the session's panel + switches it IN PLACE (re-rendering,
					// which also repaints the bottom tab strip); under one-panel-per-session it never opens a
					// second tab. Replaces the prior bare refreshSession, which left you on the old sheet.
					CellGridPanel.show(context, target.session, newId);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`switch-to-new-sheet after addSheet failed: ${detail}`);
					void vscode.window.showWarningMessage(`Quantbook: sheet added, but the view could not switch to it -- run "Quantbook: Switch Cell Grid Sheet". (${detail})`);
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
			if (sheetInfos.length <= 1) {
				// D4 (sheet-tabs, 2026-06-10): a workbook must keep at least one live sheet -- under
				// one-panel-per-session, deleting the last sheet would leave an empty, unswitchable grid.
				void vscode.window.showInformationMessage('Cannot delete the last sheet of a workbook.');
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
					if (pick.sheet === target.sheet) {
						// D-active (sheet-tabs, 2026-06-10): the deleted sheet was the ACTIVE one -> switch the
						// workbook's single panel to the first survivor (the D4 guard above guaranteed >= 1 remains)
						// rather than stranding it on the empty tombstoned grid. show() switches in place.
						const survivors = target.session.listSheets();
						if (survivors.length > 0) {
							CellGridPanel.show(context, target.session, survivors[0].id);
						} else {
							CellGridPanel.refreshSession(target.session);
						}
					} else {
						// A background sheet was deleted; the active sheet is unaffected -- just repaint (the strip
						// drops the deleted tab). Megaudit M1: session-scoped, not refreshAll.
						const { failed } = CellGridPanel.refreshSession(target.session);
						if (failed > 0) {
							void vscode.window.showWarningMessage(`Quantbook: the sheet was deleted, but the panel failed to re-render -- run "Quantbook: Refresh Cell Grid".`);
						}
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refresh/switch after deleteSheet failed (non-fatal): ${detail}`);
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

	// **W3 (Codex re-audit HIGH + 2nd re-audit MED)** -- resolve the `{session, sheet, selection}` a
	// selection-driven command should act on, from EITHER the native-menu context argument (the authoritative
	// right-click-time payload: route to the EXACT panel by token + use the carried selection) OR -- when
	// invoked with NO argument (palette / keyboard) -- the focused grid's reported selection. This makes the
	// `Set Cell Format` menu item immune to the same stale-selection / wrong-panel race the W3 structural
	// commands already avoid, without breaking its palette/keyboard entry point.
	//
	// Returns a DISCRIMINATED result so the caller distinguishes (No-Fallbacks -- a malformed menu arg must
	// NOT silently fall back to the focused grid):
	//   - `ok`: a resolved selection.
	//   - `no-selection`: invoked with no arg and no focused-grid selection -> "select a cell first".
	//   - `invalid-arg`: invoked WITH a context arg that failed validation (tampered / version-skewed
	//     `data-vscode-context`) -> a distinct error, never a focused-grid fallback.
	//   - `panel-gone`: a valid arg whose raising panel has since closed.
	type MenuSelection = { session: SessionInstance; sheet: number; selection: { anchorRow: number; anchorCol: number; focusRow: number; focusCol: number } };
	const resolveMenuOrFocusedSelection = (
		hasArg: boolean,
		contextArg: unknown,
	): { kind: 'ok'; value: MenuSelection } | { kind: 'no-selection' } | { kind: 'invalid-arg' } | { kind: 'panel-gone' } => {
		if (hasArg) {
			// A context argument WAS provided (menu invocation): it MUST validate. A malformed one fails
			// visibly rather than formatting the focused grid (which may be a DIFFERENT panel/selection).
			const arg = parseContextMenuArg(contextArg);
			if (arg === undefined) {
				return { kind: 'invalid-arg' };
			}
			const panel = CellGridPanel.panelByToken(arg.panelToken);
			if (panel === undefined) {
				return { kind: 'panel-gone' };
			}
			const { session, sheet } = panel.target;
			return { kind: 'ok', value: { session, sheet, selection: arg.selection } };
		}
		// No argument (palette / keyboard): use the focused grid's reported selection.
		const focused = CellGridPanel.focusedGridSelection();
		if (focused === undefined) {
			return { kind: 'no-selection' };
		}
		return { kind: 'ok', value: { session: focused.session, sheet: focused.sheet, selection: focused.selection } };
	};

	// FE-1.5 W-G "Set Cell Format": apply an Excel number format to the focused grid's SELECTION. Pure
	// host UI -- the engine already renders the formatted string (the snapshot carries `entry.rendered`,
	// painted by canvasGrid.ts), so this command only registers the format + sets it on each selected
	// cell; the grid re-renders automatically via refreshSession. The pure preset->format-string map +
	// the setFormat op-builder live in formatPickerLogic.ts (unit-tested); this is a thin vscode shell.
	// **W3 (Codex re-audit HIGH)**: when invoked from the native context menu it receives the
	// `data-vscode-context` payload (token + authoritative selection) and acts on THAT exact panel+rect;
	// from the palette/keyboard it falls back to the focused grid's selection.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSetFormat', async (...args: unknown[]) => {
			// `args.length > 0` distinguishes a menu invocation (VS Code passes the parsed data-vscode-context)
			// from a palette/keyboard invocation (no argument) -- so a malformed menu arg fails visibly instead
			// of silently formatting the focused grid (Codex 2nd re-audit MED).
			const resolved = resolveMenuOrFocusedSelection(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: set format failed -- the right-click menu sent an invalid cell context. Try selecting the cell and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'no-selection') {
				void vscode.window.showInformationMessage('Select one or more cells in a Cell Grid first -- the format applies to the focused grid\'s selection.');
				return;
			}
			const sel = resolved.value;
			const presetPick = await vscode.window.showQuickPick(
				FORMAT_PRESET_CHOICES.map(c => ({ label: c.label, detail: c.detail, preset: c.preset })),
				{ title: 'Set Cell Format', placeHolder: 'Choose a number format for the selected cells' },
			);
			if (presetPick === undefined) {
				return; // operator dismissed the picker
			}
			const preset: FormatPreset = presetPick.preset;
			// Resolve the format string: a fixed map for every non-custom preset, or a free-text input box
			// for Custom. No-Fallbacks: an empty custom string is rejected in the box (never coerced).
			let formatString: string;
			let appliedLabel: string;
			if (preset === 'Custom') {
				const raw = await vscode.window.showInputBox({
					title: 'Custom Cell Format',
					prompt: 'Enter a raw Excel number-format string',
					placeHolder: 'e.g. 0.000 or #,##0;(#,##0)',
					validateInput: (value) => (value.trim().length === 0 ? 'A format string cannot be empty.' : null),
				});
				if (raw === undefined) {
					return; // operator dismissed the input box
				}
				formatString = raw;
				appliedLabel = raw;
			} else {
				formatString = formatStringForPreset(preset);
				appliedLabel = presetLabel(preset);
			}
			const log = getOutput();
			// Best-effort context for the undo label / toast: the selection's sheet NAME + A1 range. This
			// throws loud if the sheet id is gone (a valid-but-tombstoned selection -- mirrors the bind
			// command's activeSheetName), surfacing the failure rather than silently mis-labelling.
			let target: string;
			try {
				const found = sel.session.snapshot().sheets.find((s) => s.id === sel.sheet);
				if (found === undefined) {
					throw new Error(`the focused grid has no sheet with id ${sel.sheet}`);
				}
				const labelRect = normalizeSelectionRect(sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
				target = formatRangeTarget(found.name, labelRect.startRow, labelRect.startCol, labelRect.endRow, labelRect.endCol);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL setFormat sheet-name resolve error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook set format failed: ${detail}`);
				return;
			}
			const undoLabel = buildFormatUndoLabel(appliedLabel, target);
			// Register the format, build ONE batch of setFormat ops over the whole selection rect, apply it
			// atomically (one undo unit), recalc, and refresh THIS session's panels. Any throw surfaces as a
			// toast (No-Fallbacks) -- never swallowed.
			let opSucceeded = false;
			try {
				const formatId = sel.session.registerFormat(formatString);
				const rect = normalizeSelectionRect(sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
				const ops = buildSetFormatOps(sel.sheet, rect, formatId);
				sel.session.batch(ops, { undoLabel });
				recalcDirtyChecked(sel.session);
				opSucceeded = true;
				log.appendLine(`${undoLabel} (${ops.length} cell(s), format "${formatString}").`);
				void vscode.window.showInformationMessage(`${undoLabel}.`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL setFormat error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook set format failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					const { refreshed, failed } = CellGridPanel.refreshSession(sel.session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the format applied, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after setFormat failed (non-fatal): ${detail}`);
				}
			}
		}),
	);

	// **FE-4 W2 "Sort range by column" (2026-06-10)** -- sort the rows of the focused grid's SELECTION by a key
	// column, A->Z or Z->A. CORRUPTION-SENSITIVE + host-only: the pure core (sortLogic.ts) reads the OWNING
	// Session snapshot's rect, REFUSES (loud, ZERO writes) if any rect cell carries a formula (sort would move it
	// without translating its refs -> silent corruption; ref-translation is FE-5), computes the stable row
	// permutation (blanks-last in both directions; numbers < text < booleans), and emits ONE `setValue` batch
	// that rewrites the rect. This command is the thin vscode shell: resolve the selection (native-menu arg or
	// focused grid, via resolveMenuOrFocusedSelection -- same wrong-panel-immune path as Set Cell Format), pick
	// the key column (a QuickPick only when the selection spans >1 column), apply the batch -> recalc -> refresh.
	//
	// DOCUMENTED v1 LIMITATIONS (see sortLogic.ts): number-formats/styles do NOT travel with sorted rows;
	// external relative refs pointing INTO the rect are NOT translated; named ranges into the rect go stale.
	const runSortCommand = async (direction: SortDirection, args: unknown[]): Promise<void> => {
		// `args.length > 0` distinguishes a native-menu invocation (VS Code passes the parsed
		// data-vscode-context) from a palette/keyboard invocation -- so a malformed menu arg fails visibly
		// instead of silently sorting the focused grid (mirrors Set Cell Format).
		const resolved = resolveMenuOrFocusedSelection(args.length > 0, args[0]);
		if (resolved.kind === 'invalid-arg') {
			void vscode.window.showErrorMessage('Quantbook: sort failed -- the right-click menu sent an invalid cell context. Try selecting the range and re-running.');
			return;
		}
		if (resolved.kind === 'panel-gone') {
			void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
			return;
		}
		if (resolved.kind === 'no-selection') {
			void vscode.window.showInformationMessage('Select a range in a Cell Grid first -- the sort applies to the focused grid\'s selection.');
			return;
		}
		const sel = resolved.value;
		const rect = normalizeSelectionRect(sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
		// Pick the sort-KEY column: a single-column selection sorts itself (no pick); a multi-column selection
		// asks which column is the key, labelled by A1 letter. The QuickPick is dismissable (-> abort, no write).
		const keyChoices = buildSortKeyChoices(rect);
		let keyCol: number;
		if (keyChoices.length === 1) {
			keyCol = keyChoices[0].col;
		} else {
			const arrow = direction === 'asc' ? 'A to Z' : 'Z to A';
			const keyPick = await vscode.window.showQuickPick(
				keyChoices.map(c => ({ label: `Column ${c.label}`, col: c.col })),
				{ title: `Sort range ${arrow}`, placeHolder: 'Choose the column to sort by' },
			);
			if (keyPick === undefined) {
				return; // operator dismissed the picker -> no write
			}
			keyCol = keyPick.col;
		}
		const log = getOutput();
		// Best-effort sheet NAME for the undo label / toast (mirrors the setFormat command's resolve). Throws
		// loud if the sheet id is gone (a tombstoned selection), surfaced rather than silently mis-labelled.
		let target: string;
		try {
			const found = sel.session.snapshot().sheets.find((s) => s.id === sel.sheet);
			if (found === undefined) {
				throw new Error(`the focused grid has no sheet with id ${sel.sheet}`);
			}
			target = formatRangeTarget(found.name, rect.startRow, rect.startCol, rect.endRow, rect.endCol);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			log.appendLine(`FATAL sort sheet-name resolve error: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook sort failed: ${detail}`);
			return;
		}
		const undoLabel = buildSortUndoLabel(direction, columnLabelA1(keyCol), target);
		// Read the snapshot, build the ONE setValue batch (the refuse-on-formula guard fires INSIDE
		// buildSortBatch/readRectGrid BEFORE any op is built -> a loud throw, never a partial write), apply it
		// atomically (one undo unit), recalc, refresh. Any throw surfaces as a toast (No-Fallbacks).
		let opSucceeded = false;
		try {
			const snapshot = sel.session.snapshot();
			// Skip a no-op sort (already sorted) so we never push an empty undo unit. readRectGrid also enforces
			// the formula-refuse + validation; a throw here (e.g. [refuse_formula]) is surfaced below.
			const { keys } = readRectGrid(snapshot, sel.sheet, rect, keyCol);
			if (isAlreadySorted(keys, direction)) {
				void vscode.window.showInformationMessage(`Quantbook: ${target} is already sorted ${direction === 'asc' ? 'A->Z' : 'Z->A'} on column ${columnLabelA1(keyCol)}.`);
				log.appendLine(`${undoLabel} -- already sorted, no change.`);
				return;
			}
			const ops = buildSortBatch(sel.sheet, rect, keyCol, direction, snapshot);
			sel.session.batch(ops, { undoLabel });
			recalcDirtyChecked(sel.session);
			opSucceeded = true;
			log.appendLine(`${undoLabel} (${ops.length} cell(s) rewritten).`);
			void vscode.window.showInformationMessage(`${undoLabel}.`);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			log.appendLine(`FATAL sort error: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook sort failed: ${detail}`);
		}
		if (opSucceeded) {
			try {
				const { refreshed, failed } = CellGridPanel.refreshSession(sel.session);
				log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
				if (failed > 0) {
					void vscode.window.showWarningMessage(`Quantbook: the sort applied, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
				}
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`refreshSession after sort failed (non-fatal): ${detail}`);
			}
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSortRangeAsc', (...args: unknown[]) => runSortCommand('asc', args)),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSortRangeDesc', (...args: unknown[]) => runSortCommand('desc', args)),
	);

	// **W3 frozen panes (2026-06-09)** -- Excel "Freeze Panes": pin the rows above + columns left of the
	// focused grid's active cell so they stay visible on scroll. The freeze STATE lives in the webview (a
	// paint/geometry concern); these commands compute the counts from the focused grid's selection and post
	// them via the panel. Session-local (re-applied on a reload); DISK persistence is deferred.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookFreezePanes', () => {
			const result = CellGridPanel.freezeFocusedPanesAtSelection();
			if (!result.ok) {
				if (result.reason === 'no-panel') {
					void vscode.window.showInformationMessage('No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.');
				} else {
					void vscode.window.showInformationMessage(
						'Select a cell in a Cell Grid first -- "Freeze Panes" pins the rows above + columns left of the focused grid\'s active cell.',
					);
				}
				return;
			}
			const log = getOutput();
			if (result.rows === 0 && result.cols === 0) {
				// Active cell is A1 -> nothing above/left to freeze; Excel treats this as Unfreeze.
				void vscode.window.showInformationMessage('Quantbook: nothing to freeze (the active cell is A1). The grid is now unfrozen.');
				log.appendLine('Freeze Panes at A1 -> unfrozen (no rows/cols above/left of the active cell).');
				return;
			}
			void vscode.window.showInformationMessage(`Quantbook: froze ${result.rows} row(s) and ${result.cols} column(s).`);
			log.appendLine(`Froze panes: ${result.rows} row(s), ${result.cols} column(s).`);
		}),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookUnfreezePanes', () => {
			if (!CellGridPanel.unfreezeFocusedPanes()) {
				void vscode.window.showInformationMessage('No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.');
				return;
			}
			void vscode.window.showInformationMessage('Quantbook: unfroze all panes.');
			getOutput().appendLine('Unfroze panes.');
		}),
	);
	// --- W3 (Wave 3, 2026-06-09): the Cell Grid right-click context menu's host commands. ---------------
	//
	// **SHARED-FILE FLAG (conductor):** this additive block + the import above are the W3 footprint in
	// quantbookCommands.ts (the frozen-panes lead also adds a `Freeze Panes` command here -- distinct block).
	//
	// Each native menu item runs a host command invoked with the PARSED `data-vscode-context` the webview set
	// on right-click as its FIRST argument. That payload carries (Codex W3 HIGH-1 + HIGH-2):
	//   - `panelToken`: routes the action to the EXACT panel that raised the menu (not merely the focused one,
	//     which can differ in split editors / focus edge cases -> wrong grid).
	//   - `selection`: the authoritative right-click-time selection rect, so the insert/delete command plans
	//     from THIS rect, not the async-updated host selection (a fast menu command could read it stale).
	// `parseContextMenuArg` validates the payload; a malformed / missing arg is a clear toast (No-Fallbacks),
	// never a guessed action.
	//
	// Two kinds of command:
	//   1. Clipboard (Cut/Copy/Paste/Clear Contents) -- the clipboard state lives in the WEBVIEW, so these
	//      post a `contextMenuAction` to the raising panel's webview (the SAME code as the keyboard shortcuts);
	//      delivery is AWAITED + a failure toasts (No-Fallbacks). FULLY LIVE now.
	//   2. Insert/Delete row/column -- a TYPES-FIRST HANDSHAKE with the W1 engine window. The command plans
	//      the structural call (pure planStructuralOp) from the carried selection and invokes the typed
	//      `SessionInstance.insert/delete{Rows,Columns}` method + recalc + refresh (mirroring setValue ->
	//      recalcDirtyChecked -> refreshSession). TYPED now; the runtime lights up once W1's engine dylib
	//      merges (the conductor sequences this). No fakery: it calls the REAL typed method; if it is absent
	//      at runtime the command throws loud.

	// The toast for a missing / malformed context argument (right-click did not yield a valid grid cell).
	const contextArgToast = (): void => {
		void vscode.window.showInformationMessage('Quantbook: right-click a cell in a Cell Grid to use this action.');
	};

	// 1. CLIPBOARD: route the menu item to the RAISING panel's webview clipboard logic (by panelToken).
	const registerClipboardCommand = (commandId: string, action: 'cut' | 'copy' | 'paste' | 'clear', verb: string): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (contextArg?: unknown) => {
				const arg = parseContextMenuArg(contextArg);
				if (arg === undefined) {
					contextArgToast();
					return;
				}
				// AWAIT delivery (No-Fallbacks): a torn-down panel or an undelivered post is a clear toast, never
				// a silent no-op (the webview owns the clipboard, so a dropped message means the action did NOT run).
				const outcome = await CellGridPanel.postContextMenuAction(arg.panelToken, action);
				if (outcome === 'no-panel') {
					void vscode.window.showInformationMessage(`Quantbook: the Cell Grid for this menu is no longer open, so it could not ${verb}.`);
				} else if (outcome === 'undelivered') {
					void vscode.window.showWarningMessage(`Quantbook: could not ${verb} -- the Cell Grid did not receive the action. Try again.`);
				}
			}),
		);
	};
	registerClipboardCommand('quantlab.quantbookCellGridCut', 'cut', 'cut');
	registerClipboardCommand('quantlab.quantbookCellGridCopy', 'copy', 'copy');
	registerClipboardCommand('quantlab.quantbookCellGridPaste', 'paste', 'paste');
	// "Clear Contents" clears the SELECTION when a range is active (Codex MED-3): the webview's `clear` action
	// is range-aware so the label never overstates what happened.
	registerClipboardCommand('quantlab.quantbookCellGridClearContents', 'clear', 'clear contents');

	// 2. INSERT / DELETE rows + columns (types-first handshake with W1). One shared implementation over the
	// pure planStructuralOp; each command id binds a single StructuralOp. The structural call mutates ONE
	// sheet's row/column structure + dirties dependents -> recalc + refresh THIS session's panels, exactly
	// like setFormat. Any engine throw (out-of-range index, off-Ready session, or -- until W1 merges -- a
	// missing method) surfaces as a loud toast (No-Fallbacks).
	const registerStructuralCommand = (commandId: string, op: StructuralOp): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(commandId, (contextArg?: unknown) => {
				const arg = parseContextMenuArg(contextArg);
				if (arg === undefined) {
					contextArgToast();
					return;
				}
				// Codex HIGH-2: resolve the EXACT panel that raised the menu (by token), not the focused one.
				const panel = CellGridPanel.panelByToken(arg.panelToken);
				if (panel === undefined) {
					void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
					return;
				}
				const { session, sheet } = panel.target;
				const log = getOutput();
				// Codex HIGH-1: plan from the AUTHORITATIVE selection the payload carried (synchronous), not the
				// async-updated host selection.
				const plan = planStructuralOp(op, arg.selection);
				// Codex LOW-1: detect a missing engine capability BY DIRECT FEATURE-CHECK (not by parsing a
				// TypeError message, which is brittle across native/proxy error shapes). Still loud (No-Fallbacks).
				const method = (session as unknown as Record<string, unknown>)[plan.method];
				if (typeof method !== 'function') {
					const msg = `Quantbook ${plan.method} failed: the engine's insert/delete capability is not available in the loaded build yet.`;
					log.appendLine(`FATAL ${plan.method} unavailable: method is not a function on the loaded Session.`);
					void vscode.window.showErrorMessage(msg);
					return;
				}
				let opSucceeded = false;
				try {
					// Invoke the typed (W1-handshake) structural method. The method name is chosen by the plan; the
					// index is a row index (row ops) or column index (column ops).
					switch (plan.method) {
						case 'insertRows':
							session.insertRows(sheet, plan.index, plan.count);
							break;
						case 'deleteRows':
							// Conductor-reconciled (wave-3): the W1 engine `deleteRows` takes (start, end) INCLUSIVE,
							// not (index, count). Delete `count` rows from `index` -> [index, index + count - 1].
							session.deleteRows(sheet, plan.index, plan.index + plan.count - 1);
							break;
						case 'insertColumns':
							session.insertColumns(sheet, plan.index, plan.count);
							break;
						case 'deleteColumns':
							// Conductor-reconciled (wave-3): W1 `deleteColumns` is (start, end) INCLUSIVE.
							session.deleteColumns(sheet, plan.index, plan.index + plan.count - 1);
							break;
						default: {
							const unreachable: never = plan.method;
							throw new Error(`unhandled structural method ${String(unreachable)}`);
						}
					}
					recalcDirtyChecked(session);
					opSucceeded = true;
					const label = describeStructuralPlan(plan);
					log.appendLine(`${label} on sheet ${sheet} at index ${plan.index}.`);
					void vscode.window.showInformationMessage(`Quantbook: ${label}.`);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`FATAL ${plan.method} error: ${detail}`);
					void vscode.window.showErrorMessage(`Quantbook ${plan.method} failed: ${detail}`);
				}
				if (opSucceeded) {
					try {
						const { refreshed, failed } = CellGridPanel.refreshSession(session);
						log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
						if (failed > 0) {
							void vscode.window.showWarningMessage(`Quantbook: the structural change succeeded, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
						}
					} catch (err) {
						// Codex MED-2: the mutation landed but the repaint threw -> the grid on screen may be STALE.
						// Surface a VISIBLE warning (not just a log line), mirroring the dropped-render path elsewhere.
						const detail = err instanceof Error ? err.message : String(err);
						log.appendLine(`refreshSession after ${plan.method} failed: ${detail}`);
						void vscode.window.showWarningMessage(`Quantbook: the change applied, but the grid may be showing stale values (a repaint failed) -- run "Quantbook: Refresh Cell Grid".`);
					}
				}
			}),
		);
	};
	registerStructuralCommand('quantlab.quantbookInsertRowAbove', 'insertRowAbove');
	registerStructuralCommand('quantlab.quantbookInsertRowBelow', 'insertRowBelow');
	registerStructuralCommand('quantlab.quantbookInsertColumnLeft', 'insertColumnLeft');
	registerStructuralCommand('quantlab.quantbookInsertColumnRight', 'insertColumnRight');
	registerStructuralCommand('quantlab.quantbookDeleteRow', 'deleteRow');
	registerStructuralCommand('quantlab.quantbookDeleteColumn', 'deleteColumn');

	// 3. FREEZE PANES HERE (Codex HIGH, 2026-06-10) -- the context menu's freeze, over the SAME carried
	// `{panelToken, selection}` payload as the structural commands above. The earlier conductor-reconciled
	// wiring delegated to the palette `quantlab.quantbookFreezePanes`, which freezes from the FOCUSED
	// panel's async-updated `latestSelection` -- reintroducing exactly the stale-selection + wrong-grid
	// races (Codex HIGH-1 + HIGH-2) the structural commands solved by carrying the right-click-time
	// selection in the context arg. So this command parses the payload and freezes the EXACT raising panel
	// at the payload's focus cell via `CellGridPanel.freezePanesAtContextSelection` (same semantics as the
	// palette command: pin the rows above + columns left of the focus cell; a focus of A1 -> unfreeze,
	// matching Excel). The palette command stays selection-by-focus BY DESIGN (it has no context arg).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookFreezePanesHere', (contextArg?: unknown) => {
			const arg = parseContextMenuArg(contextArg);
			if (arg === undefined) {
				contextArgToast();
				return;
			}
			const result = CellGridPanel.freezePanesAtContextSelection(arg.panelToken, arg.selection);
			if (!result.ok) {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			const log = getOutput();
			if (result.rows === 0 && result.cols === 0) {
				// The right-clicked focus cell is A1 -> nothing above/left to freeze; Excel treats this as Unfreeze.
				void vscode.window.showInformationMessage('Quantbook: nothing to freeze (the active cell is A1). The grid is now unfrozen.');
				log.appendLine('Freeze Panes at A1 -> unfrozen (no rows/cols above/left of the active cell).');
				return;
			}
			void vscode.window.showInformationMessage(`Quantbook: froze ${result.rows} row(s) and ${result.cols} column(s).`);
			log.appendLine(`Froze panes: ${result.rows} row(s), ${result.cols} column(s).`);
		}),
	);

	// =====================================================================================================
	// FE-4 W1 (2026-06-10): Find / Replace-All in Workbook + Define Name.
	// =====================================================================================================

	// Shared QuickInput step: collect the FIND text + the three Excel-style options (match case, whole
	// cell, search formulas) from the operator. Returns the assembled options (find text NOT yet included
	// -- the caller passes it in) or `undefined` if dismissed. The booleans are gathered as a multi-select
	// QuickPick so the operator toggles them in one step (mirrors the format-picker QuickPick style).
	const promptFindOptions = async (): Promise<{ matchCase: boolean; wholeCell: boolean; inFormulas: boolean } | undefined> => {
		const OPTIONS = [
			{ label: 'Match case', key: 'matchCase' as const, detail: 'Case-sensitive search' },
			{ label: 'Match entire cell contents', key: 'wholeCell' as const, detail: 'The find text must equal the whole cell' },
			{ label: 'Search in formulas', key: 'inFormulas' as const, detail: 'Search (and replace in) formula source text, not just values' },
		];
		const picked = await vscode.window.showQuickPick(
			OPTIONS.map(o => ({ label: o.label, detail: o.detail, key: o.key })),
			{ title: 'Find Options', placeHolder: 'Toggle options, then press Enter (none selected = default match)', canPickMany: true },
		);
		if (picked === undefined) {
			return undefined; // dismissed
		}
		const keys = new Set(picked.map(p => p.key));
		return { matchCase: keys.has('matchCase'), wholeCell: keys.has('wholeCell'), inFormulas: keys.has('inFormulas') };
	};

	// Resolve the focused grid's session (the WHOLE-WORKBOOK target for find/replace) + a loud toast when
	// no grid is focused. Find/Replace operate on the entire workbook snapshot, so only the session is
	// needed (no selection rect). No-Fallbacks: no focused grid -> a clear "open/focus a grid" message.
	const resolveFocusedSessionForFind = (): SessionInstance | undefined => {
		const focused = CellGridPanel.focusedLocalPanel();
		if (focused === undefined) {
			void vscode.window.showInformationMessage('Quantbook: open and focus a Cell Grid first -- Find/Replace searches the focused workbook.');
			return undefined;
		}
		return focused.session;
	};

	// Build a short, decorated QuickPick label for a hit: the A1 address + sheet, a "(formula)" tag when
	// it matched the formula source, and a truncated preview of the matching string. Pure shaping for the
	// hit-list UI (the full preview lives on the FindHit; we truncate here so a long cell does not blow out
	// the QuickPick row).
	const hitQuickPickLabel = (hit: FindHit): { label: string; description: string; detail: string; hit: FindHit } => {
		const a1 = formatRangeTarget(hit.sheetName, hit.row, hit.col, hit.row, hit.col);
		const previewRaw = hit.preview.length > 80 ? `${hit.preview.slice(0, 77)}...` : hit.preview;
		// Tag formula-source hits and formula cells matched on their (read-only) cached value, so the
		// operator understands the latter are listed but a Replace All will NOT write to them.
		const tag = hit.field === 'formula' ? '(formula)' : (!hit.replaceable ? '(formula result -- not replaced)' : '');
		return {
			label: a1,
			description: tag,
			detail: previewRaw,
			hit,
		};
	};

	// FE-4 W1 "Find in Workbook": search the focused workbook's snapshot for the find text + options and
	// show the hits as a QuickPick. v1 is a HIT-LIST only (Find-Next/F3 navigation is FE-5 -- it needs a
	// navigateTo handler in the webview). Picking a hit just shows its address (selecting/scrolling the
	// grid to it is the FE-5 navigateTo work); the value here is the cross-sheet "where does X appear?"
	// answer the operator cannot get any other way today. Snapshot-READ only (No flagged queryRange --
	// that is a hard [not_implemented_in_v1_core] on the owning Session).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookFindInWorkbook', async () => {
			const session = resolveFocusedSessionForFind();
			if (session === undefined) {
				return;
			}
			const find = await vscode.window.showInputBox({
				title: 'Find in Workbook',
				prompt: 'Text to find across every sheet',
				placeHolder: 'e.g. #REF! or SHARPE or 1234',
				validateInput: (value) => (value.length === 0 ? 'Enter text to find.' : null),
			});
			if (find === undefined || find.length === 0) {
				return; // dismissed / empty (the box rejects empty, but guard anyway -- No-Fallbacks)
			}
			const opts = await promptFindOptions();
			if (opts === undefined) {
				return;
			}
			const query: FindReplaceQuery = { find, matchCase: opts.matchCase, wholeCell: opts.wholeCell, inFormulas: opts.inFormulas };
			const log = getOutput();
			let hits: FindHit[];
			try {
				// Snapshot the WHOLE workbook (the same DTO the renderer reads) and scan it in the pure core.
				hits = findHitsInWorkbook(session.snapshot(), query);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL findInWorkbook error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook find failed: ${detail}`);
				return;
			}
			if (hits.length === 0) {
				void vscode.window.showInformationMessage(`Quantbook: no cells match "${find}".`);
				return;
			}
			log.appendLine(`Find "${find}": ${hits.length} hit(s) (matchCase=${opts.matchCase}, wholeCell=${opts.wholeCell}, inFormulas=${opts.inFormulas}).`);
			// The hit-list QuickPick. Picking a hit is informational in v1 (FE-5 wires grid navigation); we
			// surface the chosen address as a toast so the pick is not a silent no-op.
			const chosen = await vscode.window.showQuickPick(
				hits.map(hitQuickPickLabel),
				{ title: `Find in Workbook -- ${hits.length} hit(s) for "${find}"`, placeHolder: 'Select a match to see its address (grid navigation lands in a later update)', matchOnDetail: true },
			);
			if (chosen === undefined) {
				return;
			}
			const a1 = formatRangeTarget(chosen.hit.sheetName, chosen.hit.row, chosen.hit.col, chosen.hit.row, chosen.hit.col);
			void vscode.window.showInformationMessage(`Quantbook: match at ${a1}.`);
		}),
	);

	// FE-4 W1 "Replace All in Workbook": find + replace EVERY match across the focused workbook in ONE
	// session.batch (one undo unit) -> recalcDirtyChecked -> refreshSession (the SAME mutate/recalc/refresh
	// path setFormat + the structural commands use). Bound to Ctrl/Cmd+H when the grid panel is focused
	// (Ctrl+F is owned by the webview's in-sheet find bar -- plan amendment 2026-06-10). Over-cap (> the
	// pure core's MAX_REPLACE_OPS) is refused loud by the core. Snapshot-READ for the matches; the replace
	// re-types each touched cell (value vs formula) per the core's locked rules.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookReplaceAll', async () => {
			const session = resolveFocusedSessionForFind();
			if (session === undefined) {
				return;
			}
			const find = await vscode.window.showInputBox({
				title: 'Replace All in Workbook (1/2): Find',
				prompt: 'Text to find across every sheet',
				placeHolder: 'e.g. #REF! or old_name',
				validateInput: (value) => (value.length === 0 ? 'Enter text to find.' : null),
			});
			if (find === undefined || find.length === 0) {
				return;
			}
			// The replacement MAY be empty (Replace All with an empty replacement deletes the matched text --
			// a valid Excel operation), so this input box does NOT reject an empty string.
			const replace = await vscode.window.showInputBox({
				title: 'Replace All in Workbook (2/2): Replace with',
				prompt: 'Replacement text (leave empty to delete the matched text)',
				placeHolder: 'e.g. new_name',
			});
			if (replace === undefined) {
				return; // dismissed (an empty string is allowed; undefined means cancelled)
			}
			const opts = await promptFindOptions();
			if (opts === undefined) {
				return;
			}
			const query: FindReplaceQuery = { find, replace, matchCase: opts.matchCase, wholeCell: opts.wholeCell, inFormulas: opts.inFormulas };
			const log = getOutput();
			// Build the op batch from the snapshot in the pure core (which enforces the over-cap refusal +
			// the value/formula re-typing rules). Any throw (empty find, over-cap, malformed snapshot,
			// formula-replaced-to-empty) surfaces as a toast (No-Fallbacks), never swallowed.
			let ops: ReturnType<typeof buildReplaceAllOps>;
			try {
				ops = buildReplaceAllOps(session.snapshot(), query);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL replaceAll build error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook replace all failed: ${detail}`);
				return;
			}
			if (ops.length === 0) {
				void vscode.window.showInformationMessage(`Quantbook: no cells match "${find}" -- nothing replaced.`);
				return;
			}
			// Confirm before a mutating bulk edit (it is one undo unit, but a workbook-wide replace warrants
			// an explicit OK -- mirrors VS Code's own "Replace All" confirmation discipline).
			const undoLabel = `Replace all: "${find}" -> "${replace}" (${ops.length} cell(s))`;
			const confirm = await vscode.window.showWarningMessage(
				`Replace all "${find}" with "${replace}" in ${ops.length} cell(s) across the workbook?`,
				{ modal: true },
				'Replace All',
			);
			if (confirm !== 'Replace All') {
				return;
			}
			let opSucceeded = false;
			try {
				session.batch(ops, { undoLabel });
				recalcDirtyChecked(session);
				opSucceeded = true;
				log.appendLine(`${undoLabel}.`);
				void vscode.window.showInformationMessage(`Quantbook: replaced ${ops.length} cell(s).`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL replaceAll batch error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook replace all failed: ${detail}`);
			}
			if (opSucceeded) {
				try {
					const { refreshed, failed } = CellGridPanel.refreshSession(session);
					log.appendLine(`Refreshed ${refreshed} panel(s)${failed > 0 ? ` (${failed} failed to render)` : ''}.`);
					if (failed > 0) {
						void vscode.window.showWarningMessage(`Quantbook: the replace applied, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`refreshSession after replaceAll failed: ${detail}`);
					void vscode.window.showWarningMessage('Quantbook: the replace applied, but the grid may be showing stale values (a repaint failed) -- run "Quantbook: Refresh Cell Grid".');
				}
			}
		}),
	);

	// FE-4 W1 "Define Name": bind a workbook name to the focused grid's current selection rect via
	// SessionInstance.setName. GROUND TRUTH: setName emits NO SessionChange (a defined name is
	// delta-invisible -- not in the snapshot/delta DTOs), so there is nothing to refresh; the confirmation
	// TOAST is the only feedback. v1 is DEFINE only (no list/delete/manager -- that is FE-5). Excel name
	// rules + the selection -> CellRangeJson normalization live in nameDefineLogic.ts (unit-tested). Both a
	// palette entry and a webview/context menu entry (group 6_names) invoke it; from the context menu it
	// uses the carried right-click selection (the EXACT panel + rect), else the focused grid's selection.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookDefineName', async (...args: unknown[]) => {
			const resolved = resolveMenuOrFocusedSelection(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: define name failed -- the right-click menu sent an invalid cell context. Try selecting the range and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'no-selection') {
				void vscode.window.showInformationMessage('Select a range in a Cell Grid first -- the name binds to the focused grid\'s selection.');
				return;
			}
			const sel = resolved.value;
			const name = await vscode.window.showInputBox({
				title: 'Define Name',
				prompt: 'Name for the selected range',
				placeHolder: 'e.g. returns or tax_rate',
				// Per-keystroke validation with a SPECIFIC reason (No-Fallbacks: the operator sees WHY).
				validateInput: (value) => definedNameRejectionReason(value),
			});
			if (name === undefined) {
				return; // dismissed
			}
			// Re-validate (defense in depth -- the box already enforced it, but never trust a single gate).
			if (!isValidDefinedName(name)) {
				void vscode.window.showErrorMessage(`Quantbook: "${name}" is not a valid name.`);
				return;
			}
			const log = getOutput();
			// Resolve the selection's sheet NAME for the toast/target (throws loud if the sheet id is gone --
			// a tombstoned selection -- surfacing the failure rather than mislabelling).
			let target: string;
			let range: ReturnType<typeof buildNameRange>;
			try {
				const found = sel.session.snapshot().sheets.find((s) => s.id === sel.sheet);
				if (found === undefined) {
					throw new Error(`the focused grid has no sheet with id ${sel.sheet}`);
				}
				range = buildNameRange(sel.sheet, sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
				target = formatRangeTarget(found.name, range.startRow, range.startCol, range.endRow, range.endCol);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL defineName range-resolve error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook define name failed: ${detail}`);
				return;
			}
			try {
				sel.session.setName(name, range);
				log.appendLine(buildDefineNameToast(name, target) + '.');
				// setName is delta-invisible -> the toast is the ONLY feedback (no grid refresh to do).
				void vscode.window.showInformationMessage(buildDefineNameToast(name, target) + '.');
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL setName error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook define name failed: ${detail}`);
			}
		}),
	);

	// ============================================================================
	// FE-5 W-N "Name Manager" + Go-To.
	//
	// A QuickPick-driven manager over the focused workbook's defined names (the lighter surface that fits
	// FE-4's QuickPick idiom -- Find/Sort/Switch-Sheet are all QuickPicks). It LISTS every name across BOTH
	// scopes via `session.listNames()`, then offers a per-name action menu (Go-To / Rename / Delete) plus a
	// "Define new name..." entry that defers to the existing `quantlab.quantbookDefineName` command.
	//
	// **REFRESH CONTRACT (engine GROUND TRUTH)**: `setName`/`deleteName` are delta-, epoch-, AND
	// token-INVISIBLE -- a `snapshotDelta` after a name change is EMPTY with an UNCHANGED token. So after a
	// rename/delete this command RE-READS via `listNames()` and re-opens the picker; it NEVER waits on a
	// delta/token change. The engine sorts the list (workbook-scoped first, then sheetId, then name), so the
	// re-render order is stable.
	//
	// **Go-To** resolves the name's target -> its anchor (top-left) cell (nameManagerLogic.goToAnchor); if
	// the name is on another sheet it switches the panel to that sheet FIRST (via CellGridPanel.show, which
	// reveals + switches in place), then posts the W-F `navigateTo` (CellGridPanel.navigateToCell). Only
	// Cell/Range targets are go-to-able; Constant/Formula names have no anchor and their Go-To action is
	// disabled (No-Fallbacks: no fabricated A1 landing).

	// Resolve the focused grid's session for the Name Manager (the whole workbook is the scope). A loud
	// "open/focus a grid" toast when none is focused (No-Fallbacks).
	const resolveFocusedSessionForNames = (): SessionInstance | undefined => {
		const focused = CellGridPanel.focusedLocalPanel();
		if (focused === undefined) {
			void vscode.window.showInformationMessage('Quantbook: open and focus a Cell Grid first -- the Name Manager lists the focused workbook\'s names.');
			return undefined;
		}
		return focused.session;
	};

	// Build a `(sheetId) -> sheetName` resolver from a fresh snapshot, for the manager's target/scope labels.
	// Returns `undefined` for a gone sheet (a dangling target/scope the engine still tracks -- the logic
	// surfaces `#<id>` rather than inventing a name).
	const buildSheetNameResolver = (session: SessionInstance): ((sheetId: number) => string | undefined) => {
		const sheets = session.snapshot().sheets;
		const byId = new Map<number, string>(sheets.map((s) => [s.id, s.name] as const));
		return (sheetId: number): string | undefined => byId.get(sheetId);
	};

	// FE-5 W-N: the Name Manager. Lists every defined name; a pick opens its per-name action menu.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookNameManager', async () => {
			const session = resolveFocusedSessionForNames();
			if (session === undefined) {
				return;
			}
			const log = getOutput();
			// Re-read on every (re)entry so the list reflects the latest define/rename/delete (the
			// token-invisible refresh contract -- listNames is the ONLY truth, never a cached delta).
			while (true) {
				let names: NamedRangeJson[];
				let sheetNameFor: (sheetId: number) => string | undefined;
				try {
					names = session.listNames();
					sheetNameFor = buildSheetNameResolver(session);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					log.appendLine(`FATAL nameManager listNames error: ${detail}`);
					void vscode.window.showErrorMessage(`Quantbook Name Manager failed: ${detail}`);
					return;
				}
				// A top "Define new name..." entry is always available; the named entries follow. A single
				// flat item shape (`name` optional, absent on the "define" row) so showQuickPick's overload
				// resolves to the object form (an intersection-with-union collapses to the string overload).
				// NB: `kind` is reserved by vscode.QuickPickItem (separator vs default) -- use `itemKind`.
				interface ManagerItem extends vscode.QuickPickItem {
					readonly itemKind: 'define' | 'name';
					readonly name?: NamedRangeJson;
				}
				const items: ManagerItem[] = [
					{ label: '$(add) Define new name...', detail: 'Bind a new name to the current selection', itemKind: 'define' },
					...names.map((nr): ManagerItem => ({
						label: nr.name,
						description: describeScope(nr, sheetNameFor),
						detail: describeTarget(nr.target, sheetNameFor),
						itemKind: 'name',
						name: nr,
					})),
				];
				const picked = await vscode.window.showQuickPick<ManagerItem>(
					items,
					{
						title: names.length === 0 ? 'Name Manager -- no names defined yet' : `Name Manager -- ${names.length} name(s)`,
						placeHolder: names.length === 0 ? 'Select "Define new name..." to create one' : 'Select a name to Go-To / Rename / Delete it',
						matchOnDescription: true,
						matchOnDetail: true,
					},
				);
				if (picked === undefined) {
					return; // dismissed -> close the manager
				}
				if (picked.itemKind === 'define' || picked.name === undefined) {
					// Defer to the existing Define-Name command (selection-based; its own validation + toast).
					await vscode.commands.executeCommand('quantlab.quantbookDefineName');
					continue; // re-read + re-open the manager so the new name shows
				}
				const action = await pickNameAction(picked.name, sheetNameFor);
				if (action === 'back') {
					continue; // re-open the list
				}
				if (action === 'closed') {
					return; // dismissed the action menu
				}
				// goto / rename / delete each handle their own re-read; loop to re-open the manager after.
				const outcome = await runNameAction(context, session, picked.name, action, log);
				if (outcome === 'closed') {
					return;
				}
				// 'reopen' (success or recoverable failure already surfaced) -> loop to re-read + re-render.
			}
		}),
	);

	// FE-5 W-N: a direct "Go to Name..." command (palette + keyboard-fast) -- pick a name, jump to its anchor.
	// Constant/Formula names are filtered OUT of this picker (they have no anchor to go to).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookGoToName', async () => {
			const session = resolveFocusedSessionForNames();
			if (session === undefined) {
				return;
			}
			const log = getOutput();
			let names: NamedRangeJson[];
			let sheetNameFor: (sheetId: number) => string | undefined;
			try {
				names = session.listNames();
				sheetNameFor = buildSheetNameResolver(session);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL goToName listNames error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook Go to Name failed: ${detail}`);
				return;
			}
			const goToable = names.filter((nr) => isGoToable(nr.target));
			if (goToable.length === 0) {
				void vscode.window.showInformationMessage(
					names.length === 0
						? 'Quantbook: no names defined yet -- run "Quantbook: Name Manager..." to define one.'
						: 'Quantbook: no names point to a cell/range to go to (only constant/formula names exist).',
				);
				return;
			}
			type NameItem = vscode.QuickPickItem & { name: NamedRangeJson };
			const picked = await vscode.window.showQuickPick<NameItem>(
				goToable.map((nr): NameItem => ({
					label: nr.name,
					description: describeScope(nr, sheetNameFor),
					detail: describeTarget(nr.target, sheetNameFor),
					name: nr,
				})),
				{ title: 'Go to Name', placeHolder: 'Select a name to select + reveal its range', matchOnDetail: true },
			);
			if (picked === undefined) {
				return;
			}
			await navigateToName(context, session, picked.name, log);
		}),
	);

	// FE-5 W-T "Structured Tables": create a table from the focused grid's selection (thin UI over the live
	// napi createTable). Rename / drop are QuickPick-driven over the existing names. A table op bumps the
	// epoch, so we refreshSession (reseed from a fresh snapshot) after a successful create/drop.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCreateTable', async (...args: unknown[]) => {
			const resolved = resolveMenuOrFocusedSelection(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: create table failed -- the right-click menu sent an invalid cell context. Try selecting the range and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'no-selection') {
				void vscode.window.showInformationMessage('Select the table\'s range in a Cell Grid first (including its header row).');
				return;
			}
			const sel = resolved.value;
			const name = await vscode.window.showInputBox({
				title: 'Create Table',
				prompt: 'Name for the new table (shares the defined-name namespace)',
				placeHolder: 'e.g. Returns or PriceHistory',
				validateInput: (value) => tableIdentifierRejectionReason(value),
			});
			if (name === undefined) {
				return; // dismissed
			}
			if (!isValidTableIdentifier(name)) {
				void vscode.window.showErrorMessage(`Quantbook: "${name}" is not a valid table name.`);
				return;
			}
			const log = getOutput();
			let spec;
			try {
				spec = buildTableSpec(name, sel.sheet, sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL createTable spec error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook create table failed: ${detail}`);
				return;
			}
			// **FE-8.5 (2026-06-15):** name the columns after the spreadsheet HEADER ROW (Excel parity) instead
			// of the legacy `Column1..N`. Read each header cell's display text from the session: a blank cell
			// surfaces as `null` (-> `planColumnNamesFromHeaders` assigns a `Column{N}` default); a text cell
			// uses its raw text; a number / formula header uses the engine's rendered display string (what the
			// grid shows). The pure helper validates each (full-parity column rules) + enforces case-insensitive
			// uniqueness -- on any reject it returns a LOUD reason and we abort WITHOUT creating the table.
			const headerTexts: (string | null)[] = [];
			for (let i = 0; i < spec.cols; i++) {
				const hc = sel.session.cell(spec.sheet, spec.topRow, spec.topCol + i);
				if (hc === null) {
					headerTexts.push(null);
				} else if (hc.value?.kind === 'text' && hc.value.text !== undefined) {
					headerTexts.push(hc.value.text);
				} else if (hc.rendered !== undefined && hc.rendered.length > 0) {
					headerTexts.push(hc.rendered);
				} else {
					headerTexts.push(null);
				}
			}
			const namesResult = planColumnNamesFromHeaders(headerTexts);
			if (namesResult.kind === 'error') {
				log.appendLine(`createTable header->name rejected: ${namesResult.reason}`);
				void vscode.window.showErrorMessage(`Quantbook create table failed: ${namesResult.reason}`);
				return;
			}
			spec.columnNames = namesResult.names;
			try {
				// `createTable` is ONE atomic op (one undo unit). **FE-8.5 (audit, Codex MEDIUM):** we deliberately
				// do NOT write `Column{N}` back into blank header cells here -- that would be N extra `setValue` ops
				// AFTER the create, so a single undo would only unwind the last one and leave the table + metadata
				// half-synced with the visible cells. A blank header therefore stays blank (its metadata column is
				// still `Column{N}`, so `Table[Column2]` works, and a later Rename-Column writes the name into the
				// cell atomically). Named headers already display their own text, so nothing to write back.
				sel.session.createTable(spec);
				log.appendLine(`Created table "${name}" (${spec.rows}x${spec.cols} at sheet ${spec.sheet}, top ${spec.topRow},${spec.topCol}); columns [${spec.columnNames.join(', ')}].`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL createTable error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook create table failed: ${detail}`);
				return;
			}
			// **CLOSURE F1 (2026-06-12)**: recalc BEFORE reseeding, mirroring the dropTable path, so any
			// dependent the table-create DID dirty is healed before the panel repaints. NB (engine ground
			// truth): the engine binds name references eagerly at setFormula time and REJECTS a formula over an
			// unresolved name (`formula_bind`), so there is no stored "#NAME? waiting for this table" formula to
			// heal on this engine -- the recalc is correct + cheap + harmless either way (we never skip it).
			recalcDirtyChecked(sel.session);
			// A table op bumps the epoch -> reseed the panel(s) from a fresh snapshot.
			const { failed } = CellGridPanel.refreshSession(sel.session);
			if (failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the table was created, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: created table "${name}".`);
		}),
	);

	// FE-8 (2026-06-14): Drop / Rename act on an EXISTING table. The operator reaches the target either by
	// right-clicking inside its footprint (the `data-vscode-context` payload carries the panel + clicked cell,
	// so we resolve the containing table via `tableAtCell` and pre-select it) or, from the palette, by picking
	// from a QuickPick of every table in the workbook (read from `snapshot().tables` -- listNames returns
	// DEFINED names, not tables, so the table set comes from the snapshot, not a name query).
	type TableTarget =
		| { kind: 'ok'; session: SessionInstance; preselect: TableSnapshotJson | undefined }
		| { kind: 'invalid-arg' }
		| { kind: 'panel-gone' }
		| { kind: 'none' };
	// Resolve which session a table command runs against + a pre-selected table when invoked from a
	// right-click inside one. No-Fallbacks: a context arg that was supplied but fails to validate is a LOUD
	// `invalid-arg` (never a silent fall-through to the focused grid, which could be a different panel); a
	// valid arg pointing OUTSIDE any table yields `preselect: undefined` (legitimate -> the picker opens).
	const resolveTableTarget = (hasArg: boolean, contextArg: unknown): TableTarget => {
		if (hasArg) {
			const arg = parseContextMenuArg(contextArg);
			// Require the hit `cell`: Drop/Rename resolve the table CONTAINING the right-clicked cell, which is
			// NOT the selection anchor when the click lands inside a pre-existing multi-cell selection (the
			// webview keeps that selection). Every grid-cell payload carries `cell`; its absence is a tampered /
			// version-skewed arg -> loud invalid-arg (No-Fallbacks: never silently key off the anchor instead).
			if (arg === undefined || arg.cell === undefined) {
				return { kind: 'invalid-arg' };
			}
			const panel = CellGridPanel.panelByToken(arg.panelToken);
			if (panel === undefined) {
				return { kind: 'panel-gone' };
			}
			const { session, sheet } = panel.target;
			// `tables` is absent on pre-tables fixtures and EMPTY (the live engine always sends it) when none
			// are defined -- an absent optional list legitimately means "no tables", not a swallowed error.
			const tables = session.snapshot().tables ?? [];
			const preselect = tableAtCell(tables, sheet, arg.cell.row, arg.cell.col);
			return { kind: 'ok', session, preselect };
		}
		const session = resolveFocusedSessionForNames(); // surfaces its own "open and focus a Cell Grid" message
		if (session === undefined) {
			return { kind: 'none' };
		}
		return { kind: 'ok', session, preselect: undefined };
	};
	// Resolve the concrete table a Drop/Rename will act on: the pre-selected one (right-clicked inside it) or
	// the operator's QuickPick over the whole workbook. Returns `undefined` when there are NO tables (a loud
	// info message -- never an empty picker / silent no-op) or the picker was dismissed.
	const pickTable = async (session: SessionInstance, preselect: TableSnapshotJson | undefined, purpose: 'drop' | 'rename' | 'rename-column'): Promise<TableSnapshotJson | undefined> => {
		if (preselect !== undefined) {
			return preselect;
		}
		const tables = session.snapshot().tables ?? [];
		if (tables.length === 0) {
			const verb = purpose === 'drop' ? 'drop' : purpose === 'rename' ? 'rename' : 'edit';
			void vscode.window.showInformationMessage(`Quantbook: this workbook has no tables to ${verb}.`);
			return undefined;
		}
		const sheetNameFor = buildSheetNameResolver(session);
		type TableItem = vscode.QuickPickItem & { table: TableSnapshotJson };
		const items: TableItem[] = tableQuickPickItems(tables).map((it) => ({
			label: it.label,
			description: `${sheetNameFor(it.table.sheet) ?? `#${it.table.sheet}`} - ${it.rangeLabel}`,
			detail: it.detail,
			table: it.table,
		}));
		const title = purpose === 'drop' ? 'Drop Table' : purpose === 'rename' ? 'Rename Table' : 'Rename Table Column';
		const placeHolder = purpose === 'drop' ? 'Select the table to drop' : purpose === 'rename' ? 'Select the table to rename' : 'Select the table whose column to rename';
		const picked = await vscode.window.showQuickPick(items, {
			title,
			placeHolder,
			matchOnDescription: true,
		});
		return picked?.table;
	};

	// FE-5 W-T (drop) + FE-8 (picker + context-aware): drop a table by name. The engine raises
	// `[table_not_found]` for an unknown one (surfaced loud); a successful drop turns referencing formulas
	// into `#NAME?` (warned in the confirm).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookDropTable', async (...args: unknown[]) => {
			const resolved = resolveTableTarget(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: drop table failed -- the right-click menu sent an invalid cell context. Try selecting a cell and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'none') {
				return; // resolveFocusedSessionForNames already messaged
			}
			const target = await pickTable(resolved.session, resolved.preselect, 'drop');
			if (target === undefined) {
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Drop table "${target.displayName}"? Its cells stay in place, but formulas referencing it will become #NAME?.`,
				{ modal: true },
				'Drop Table',
			);
			if (confirm !== 'Drop Table') {
				return;
			}
			const log = getOutput();
			try {
				resolved.session.dropTable(target.name); // canonical name is what the engine stores
				log.appendLine(`Dropped table "${target.name}".`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL dropTable error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook drop table failed: ${detail}`);
				return;
			}
			recalcDirtyChecked(resolved.session);
			const { failed } = CellGridPanel.refreshSession(resolved.session);
			if (failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the table was dropped, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: dropped table "${target.displayName}".`);
		}),
	);

	// FE-8: rename a table. The napi `renameTable(old, new)` exists (the engine rewrites referencing formulas
	// in the same op); this wires the UI. Pick the table (context-aware or picker) -> validate the new name
	// (shared defined-name rules) -> rename -> recalc + reseed. The engine raises `[table_create_rejected]` on
	// a name collision (with another table or defined name) and `[table_not_found]` if it vanished -- both
	// surfaced loud (per the SessionInstance.renameTable contract).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookRenameTable', async (...args: unknown[]) => {
			const resolved = resolveTableTarget(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: rename table failed -- the right-click menu sent an invalid cell context. Try selecting a cell and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'none') {
				return;
			}
			const target = await pickTable(resolved.session, resolved.preselect, 'rename');
			if (target === undefined) {
				return;
			}
			const newName = await vscode.window.showInputBox({
				title: `Rename Table "${target.displayName}"`,
				prompt: 'New table name (shares the defined-name namespace)',
				value: target.displayName,
				validateInput: (value) => tableIdentifierRejectionReason(value),
			});
			if (newName === undefined) {
				return; // dismissed
			}
			if (!isValidTableIdentifier(newName)) {
				void vscode.window.showErrorMessage(`Quantbook: "${newName}" is not a valid table name.`);
				return;
			}
			const log = getOutput();
			try {
				resolved.session.renameTable(target.name, newName);
				log.appendLine(`Renamed table "${target.name}" -> "${newName}".`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL renameTable error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename table failed: ${detail}`);
				return;
			}
			recalcDirtyChecked(resolved.session);
			const { failed } = CellGridPanel.refreshSession(resolved.session);
			if (failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the table was renamed, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: renamed table to "${newName}".`);
		}),
	);

	// FE-8.1 (2026-06-15): Resize a table to the current selection. The napi `resizeTable(name, newRows,
	// newCols, addedColumns, removedColumns)` re-ranges a table ANCHORED at its existing top-left (a table can
	// be resized but never moved). SELECTION-driven (like Create, not Drop/Rename): the target is the table
	// whose top-left equals the selection's top-left. The pure `planTableResize` decides resize / noop / error
	// (anchor-match, extent, column add/drop); this is the thin vscode shell. Scope: row grow/shrink + column
	// GROW (auto-named) + column SHRINK (FE-8.3: we read the live roster via `tableColumns` and pass the
	// trailing names to drop as `removedColumns`).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookResizeTable', (...args: unknown[]) => {
			const resolved = resolveMenuOrFocusedSelection(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: resize table failed -- the right-click menu sent an invalid cell context. Try selecting the range and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'no-selection') {
				void vscode.window.showInformationMessage('Select the table\'s new range in a Cell Grid first (starting at the table\'s top-left cell).');
				return;
			}
			const sel = resolved.value;
			// `tables` is absent on pre-tables fixtures and EMPTY (the live engine always sends it) when none are
			// defined -- an absent optional list legitimately means "no tables", not a swallowed error.
			const tables = sel.session.snapshot().tables ?? [];
			// Find the table the resize acts on: the one whose TOP-LEFT the selection starts at (the engine
			// freezes the anchor, so only a top-left-anchored table can be resized to this selection). Use the
			// selection's MIN corner -- not the raw anchor, which may be the bottom-right corner of the drag.
			const topRow = Math.min(sel.selection.anchorRow, sel.selection.focusRow);
			const topCol = Math.min(sel.selection.anchorCol, sel.selection.focusCol);
			const target = tableAtCell(tables, sel.sheet, topRow, topCol);
			if (target === undefined) {
				// No-Fallbacks: never silently open a picker over an arbitrary table (the engine would reject a
				// non-anchored target); tell the operator exactly what to select.
				void vscode.window.showInformationMessage('Quantbook: select a range starting at a table\'s top-left cell, then run Resize Table to Selection.');
				return;
			}
			// FE-8.3: read the live column roster so `planTableResize` can compute the trailing names to drop
			// on a column shrink. A throw (table vanished / off a Ready session) surfaces loud (No-Fallbacks).
			let columnNames: string[];
			try {
				columnNames = sel.session.tableColumns(target.name);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				getOutput().appendLine(`FATAL tableColumns error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook resize table failed: ${detail}`);
				return;
			}
			const action = planTableResize(target, columnNames, sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
			if (action.kind === 'noop') {
				void vscode.window.showInformationMessage(`Quantbook: "${target.displayName}" already matches the selection.`);
				return;
			}
			if (action.kind === 'error') {
				void vscode.window.showErrorMessage(`Quantbook resize table: ${action.reason}`);
				return;
			}
			const log = getOutput();
			try {
				sel.session.resizeTable(target.name, action.newRows, action.newCols, action.addedColumns, action.removedColumns);
				log.appendLine(`Resized table "${target.name}" to ${action.newRows}x${action.newCols}${action.addedColumns.length > 0 ? ` (+cols ${action.addedColumns.join(', ')})` : ''}.`);
			} catch (err) {
				// Engine throws (footprint overlap, spill-anchor collision, loaded-table name collision on an
				// appended column) surface loud (No-Fallbacks) -- the table is unchanged on a rejected resize.
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL resizeTable error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook resize table failed: ${detail}`);
				return;
			}
			// A table op bumps the epoch -> recalc dependents, then reseed the panel(s) from a fresh snapshot.
			recalcDirtyChecked(sel.session);
			const { failed } = CellGridPanel.refreshSession(sel.session);
			if (failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the table was resized, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: resized "${target.displayName}" to ${action.newRows} rows x ${action.newCols} columns.`);
		}),
	);

	// FE-8.3 (2026-06-15): rename a table COLUMN. The napi `renameColumn(table, oldCol, newCol)` exists (the
	// engine rewrites referencing structured-ref formula text in the same undo unit) but was unreachable --
	// the IDE couldn't read a table's column names. With `tableColumns(name)` (FE-8.3) we list them, let the
	// operator pick one + type the new name, validate via the COLUMN identifier rules (FE-8.4/8.5/8.6: relaxed to
	// full OOXML parity -- spaces like `Order Date`, digit-leading, cell-ref/R1C1 shapes, UTF-8, AND the OOXML
	// escape chars `[ ] # @ '` which the engine `'`-escapes in structured refs) + `planColumnRename` (mirrors the
	// engine's checks), then call the
	// engine. Table picked context-aware or from a QuickPick, exactly like Rename/Drop Table.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookRenameColumn', async (...args: unknown[]) => {
			const resolved = resolveTableTarget(args.length > 0, args[0]);
			if (resolved.kind === 'invalid-arg') {
				void vscode.window.showErrorMessage('Quantbook: rename column failed -- the right-click menu sent an invalid cell context. Try selecting a cell and re-running.');
				return;
			}
			if (resolved.kind === 'panel-gone') {
				void vscode.window.showInformationMessage('Quantbook: the Cell Grid for this menu is no longer open.');
				return;
			}
			if (resolved.kind === 'none') {
				return;
			}
			const target = await pickTable(resolved.session, resolved.preselect, 'rename-column');
			if (target === undefined) {
				return;
			}
			// Read the live column roster (the names live in engine metadata, not the snapshot). A throw
			// (table vanished / off a Ready session) surfaces loud (No-Fallbacks).
			let columns: string[];
			try {
				columns = resolved.session.tableColumns(target.name);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				getOutput().appendLine(`FATAL tableColumns error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename column failed: ${detail}`);
				return;
			}
			if (columns.length === 0) {
				// A table always has >=1 column by construction; an empty roster means stale/broken state.
				void vscode.window.showErrorMessage(`Quantbook: "${target.displayName}" reports no columns -- refresh the Cell Grid and retry.`);
				return;
			}
			const oldCol = await vscode.window.showQuickPick(columns, {
				title: `Rename Column in "${target.displayName}"`,
				placeHolder: 'Select the column to rename',
			});
			if (oldCol === undefined) {
				return; // dismissed
			}
			const newCol = await vscode.window.showInputBox({
				title: `Rename Column "${oldCol}"`,
				// FE-8.4/8.5/8.6: column names use the RELAXED, full-OOXML-parity rule -- they MAY contain spaces
				// (`Order Date`), be digit-leading (`2026`), cell-ref-shaped (`Q3`) or R1C1-form, non-ASCII, OR
				// contain the OOXML escape chars `[ ] # @ '` (the engine `'`-escapes them in structured refs),
				// unlike table/defined names, because a column is only ever referenced as `Table[<name>]`. Only
				// empty / over-cap / control chars / edge-whitespace are rejected.
				prompt: 'New column name (may include spaces and [ ] # @ \' -- e.g. "Net [Margin]")',
				value: oldCol,
				validateInput: (value) => tableColumnRejectionReason(value),
			});
			if (newCol === undefined) {
				return; // dismissed
			}
			const action = planColumnRename(columns, oldCol, newCol);
			if (action.kind === 'noop') {
				void vscode.window.showInformationMessage(`Quantbook: "${oldCol}" is already named that.`);
				return;
			}
			if (action.kind === 'error') {
				void vscode.window.showErrorMessage(`Quantbook rename column: ${action.reason}`);
				return;
			}
			const log = getOutput();
			try {
				resolved.session.renameColumn(target.name, action.oldCol, action.newCol);
				log.appendLine(`Renamed column "${action.oldCol}" -> "${action.newCol}" in table "${target.name}".`);
			} catch (err) {
				// Engine rejections (unknown column / collision / invalid name) surface loud (No-Fallbacks) --
				// the column is unchanged on a rejected rename.
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL renameColumn error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename column failed: ${detail}`);
				return;
			}
			// A table op bumps the epoch -> recalc dependents, then reseed the panel(s) from a fresh snapshot.
			recalcDirtyChecked(resolved.session);
			const { failed } = CellGridPanel.refreshSession(resolved.session);
			if (failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the column was renamed, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: renamed column to "${action.newCol}" in "${target.displayName}".`);
		}),
	);
}

// FE-5 W-N: present the per-name action menu (Go-To / Rename / Delete). Go-To is DISABLED (and labelled so)
// for a Constant/Formula name (no anchor). Returns the chosen action, `'back'` to return to the list, or
// `'closed'` when dismissed.
async function pickNameAction(
	name: NamedRangeJson,
	sheetNameFor: (sheetId: number) => string | undefined,
): Promise<'goto' | 'rename' | 'delete' | 'back' | 'closed'> {
	type ActionItem = vscode.QuickPickItem & { action: 'goto' | 'rename' | 'delete' | 'back' };
	const goToable = isGoToable(name.target);
	const items: ActionItem[] = [];
	items.push({
		label: goToable ? '$(go-to-file) Go to' : '$(go-to-file) Go to (unavailable)',
		description: goToable ? describeTarget(name.target, sheetNameFor) : 'constant/formula names have no cell to go to',
		action: 'goto',
	});
	items.push({ label: '$(edit) Rename...', action: 'rename' });
	items.push({ label: '$(trash) Delete', action: 'delete' });
	items.push({ label: '$(arrow-left) Back to list', action: 'back' });
	const picked = await vscode.window.showQuickPick(items, {
		title: `Name: ${name.name}`,
		placeHolder: `Action for "${name.name}"`,
	});
	if (picked === undefined) {
		return 'closed';
	}
	if (picked.action === 'goto' && !goToable) {
		void vscode.window.showInformationMessage(`Quantbook: "${name.name}" is a ${name.target.kind} name -- it has no cell to go to.`);
		return 'back';
	}
	return picked.action;
}

// FE-5 W-N: run a Go-To / Rename / Delete action on a name. Returns `'reopen'` to re-read + re-open the
// manager (the token-invisible refresh contract), or `'closed'` when the manager should close.
async function runNameAction(
	context: vscode.ExtensionContext,
	session: SessionInstance,
	name: NamedRangeJson,
	action: 'goto' | 'rename' | 'delete',
	log: vscode.OutputChannel,
): Promise<'reopen' | 'closed'> {
	if (action === 'goto') {
		await navigateToName(context, session, name, log);
		return 'closed'; // navigating closes the manager (the user wants the grid now)
	}
	if (action === 'delete') {
		const confirm = await vscode.window.showWarningMessage(
			`Delete name "${name.name}"?`,
			{ modal: true },
			'Delete',
		);
		if (confirm !== 'Delete') {
			return 'reopen';
		}
		try {
			// scope: undefined for workbook-scoped, the sheet id for sheet-scoped (the same value listNames reported).
			session.deleteName(name.name, name.scope);
			log.appendLine(`Deleted name "${name.name}"${name.scope === undefined ? ' (workbook)' : ` (sheet ${name.scope})`}.`);
			// **CLOSURE F1 (2026-06-12)**: recalc + refresh THIS session's panels after a name delete, mirroring
			// the dropTable path. The refresh reseeds the panel from a fresh snapshot; the recalc heals any
			// dependent the engine DID dirty. NB (engine ground truth, pinned in the engine test): the current
			// engine resolves a name reference at setFormula time and does NOT re-bind a deleted name, so a
			// =SUM(<deleted name>) formula keeps its cached value -- the recalc cannot turn it into #NAME?
			// (a tracked ENGINE limitation, not an IDE bug). This recalc is still correct + cheap + harmless and
			// will heal dependents once the engine re-binds; we never silently skip it.
			recalcDirtyChecked(session);
			const deleteRefresh = CellGridPanel.refreshSession(session);
			if (deleteRefresh.failed > 0) {
				void vscode.window.showWarningMessage('Quantbook: the name was deleted, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
			}
			void vscode.window.showInformationMessage(`Quantbook: deleted name "${name.name}".`);
		} catch (err) {
			// `[name_not_found]` (e.g. another window deleted it) surfaces loud -- never swallowed.
			const detail = err instanceof Error ? err.message : String(err);
			log.appendLine(`FATAL deleteName error: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook delete name failed: ${detail}`);
		}
		return 'reopen'; // re-read via listNames (the token-invisible refresh contract)
	}
	// action === 'rename'
	const newName = await vscode.window.showInputBox({
		title: `Rename "${name.name}"`,
		prompt: 'New name',
		value: name.name,
		validateInput: (value) => definedNameRejectionReason(value),
	});
	if (newName === undefined) {
		return 'reopen';
	}
	if (!isValidDefinedName(newName)) {
		void vscode.window.showErrorMessage(`Quantbook: "${newName}" is not a valid name.`);
		return 'reopen';
	}
	if (newName === name.name) {
		return 'reopen'; // no-op rename
	}
	// Rename is NOT a native engine op for a defined name: it is define-new + delete-old. Only a Range/Cell
	// name can be re-created from the IDE's `setName` (which takes a CellRangeJson); a Constant/Formula name
	// has no setName path, so we refuse rather than silently dropping its target (No-Fallbacks).
	if (name.target.kind !== 'range' && name.target.kind !== 'cell') {
		void vscode.window.showWarningMessage(`Quantbook: renaming a ${name.target.kind} name is not supported (only cell/range names can be renamed in this version).`);
		return 'reopen';
	}
	// **CLOSURE F2 (2026-06-12)**: REFUSE renaming a SHEET-SCOPED name. The IDE's `setName(newName, range)`
	// is workbook-scoped ONLY (the engine's `set_name` always emits `scope: None`), so a define-new +
	// delete-old rename of a sheet-scoped name (reachable: surfaced from a loaded `.qbook`) would silently
	// re-create the name at WORKBOOK scope -- a silent scope change. Refuse loud, the same way a
	// Constant/Formula target is refused above (No-Fallbacks: never silently change a name's scope).
	if (name.scope !== undefined) {
		void vscode.window.showWarningMessage(`Quantbook: renaming a sheet-scoped name is not supported (the rename would silently move "${name.name}" to workbook scope). Delete it and re-define it on the sheet instead.`);
		return 'reopen';
	}
	const range = namedTargetToCellRange(name.target);
	if (range === undefined) {
		void vscode.window.showErrorMessage('Quantbook rename failed: the name\'s target could not be resolved to a range.');
		return 'reopen';
	}
	// **CLOSURE F4 (2026-06-12)**: pre-check for a name COLLISION with the rename target. `NameTable::set` is
	// a REPLACE, so renaming A -> B when B already exists would silently DESTROY B's binding (define-new
	// clobbers B, then delete-old removes A). Match the engine's case-INSENSITIVE `lookup_ci` (it stores a
	// canonical-cased name) -- compare uppercased, excluding the name being renamed itself. On a hit, confirm
	// before clobbering rather than destroying B's binding silently. (NB: Define-Name -- the
	// `quantlab.quantbookDefineName` command -- has the SAME latent clobber issue; the rename path is fixed
	// here, the Define path is a tracked follow-up.)
	try {
		const existing = session.listNames();
		const targetUpper = newName.toUpperCase();
		const oldUpper = name.name.toUpperCase();
		const collides = existing.some((nr) => nr.name.toUpperCase() === targetUpper && nr.name.toUpperCase() !== oldUpper);
		if (collides) {
			const proceed = await vscode.window.showWarningMessage(
				`Quantbook: a name "${newName}" already exists. Renaming "${name.name}" to it will REPLACE the existing "${newName}" binding. Continue?`,
				{ modal: true },
				'Replace',
			);
			if (proceed !== 'Replace') {
				return 'reopen';
			}
		}
	} catch (err) {
		// A failed collision read must NOT silently let the rename proceed (it could clobber). Surface loud.
		const detail = err instanceof Error ? err.message : String(err);
		log.appendLine(`FATAL rename collision-check (listNames) error: ${detail}`);
		void vscode.window.showErrorMessage(`Quantbook rename failed: ${detail}`);
		return 'reopen';
	}
	// **CLOSURE F3 (2026-06-12)** -- HONEST non-atomic reporting. Rename is define-new + delete-old. We do
	// NOT reorder (delete-first would risk data loss if setName then fails): define the new name FIRST so a
	// `setName` failure leaves the old name intact (no window with neither name). But if `setName` SUCCEEDS
	// and `deleteName` then THROWS, BOTH names persist (orphan/duplicate) -- a "rename failed" toast would be
	// a LIE. Track which step committed and report the true outcome.
	let setNameCommitted = false;
	try {
		session.setName(newName, range);
		setNameCommitted = true;
		session.deleteName(name.name, name.scope);
		log.appendLine(`Renamed name "${name.name}" -> "${newName}".`);
		void vscode.window.showInformationMessage(`Quantbook: renamed "${name.name}" to "${newName}".`);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		if (setNameCommitted) {
			// setName landed; deleteName threw -> BOTH names now exist. Report honestly (No-Fallbacks: do not
			// claim the rename failed when the new name was in fact created). The re-read on 'reopen' shows
			// both names, so the operator can delete the leftover old one manually.
			log.appendLine(`PARTIAL rename: setName("${newName}") committed but deleteName("${name.name}") failed: ${detail}`);
			void vscode.window.showWarningMessage(`Quantbook: renamed to "${newName}", but the old name "${name.name}" could not be removed -- BOTH now exist. Delete "${name.name}" manually. (${detail})`);
		} else {
			log.appendLine(`FATAL rename (setName) error: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook rename failed: ${detail}`);
		}
		return 'reopen';
	}
	// **CLOSURE F1 (2026-06-12)**: recalc + refresh THIS session's panels after a name rename, mirroring the
	// dropTable / delete-name paths. The refresh reseeds the panel from a fresh snapshot. NB (engine ground
	// truth): the current engine resolves a name reference at setFormula time and does NOT re-bind on a
	// define-new/delete-old rename, so a formula referencing the OLD name keeps its cached value (a tracked
	// ENGINE limitation, not an IDE bug). The recalc is correct + cheap + harmless and heals dependents the
	// engine DID dirty; we never silently skip it.
	recalcDirtyChecked(session);
	const renameRefresh = CellGridPanel.refreshSession(session);
	if (renameRefresh.failed > 0) {
		void vscode.window.showWarningMessage('Quantbook: the name was renamed, but a panel failed to re-render -- run "Quantbook: Refresh Cell Grid".');
	}
	return 'reopen';
}

// FE-5 W-N: project a Cell/Range named target back into the CellRangeJson `setName` expects (for rename).
// A single-cell target becomes a 1x1 range. Returns `undefined` for a non-cell/range kind (the caller
// guards before calling, but this stays total).
function namedTargetToCellRange(target: NamedRangeJson['target']): import('../quantbook/types').CellRangeJson | undefined {
	if (target.kind === 'cell' && target.cell !== undefined) {
		return { sheet: target.cell.sheet, startRow: target.cell.row, startCol: target.cell.col, endRow: target.cell.row, endCol: target.cell.col };
	}
	if (target.kind === 'range' && target.range !== undefined) {
		return { sheet: target.range.sheet, startRow: target.range.startRow, startCol: target.range.startCol, endRow: target.range.endRow, endCol: target.range.endCol };
	}
	return undefined;
}

// FE-5 W-N: GO-TO a name's anchor. Resolves the target's top-left cell; if it lives on another sheet,
// switches the panel to that sheet FIRST (CellGridPanel.show reveals + switches in place), then posts the
// W-F `navigateTo`. Constant/Formula names have no anchor -> a loud info toast (No-Fallbacks: never a
// fabricated A1 landing). A non-delivery of the navigate message is surfaced loud.
async function navigateToName(
	context: vscode.ExtensionContext,
	session: SessionInstance,
	name: NamedRangeJson,
	log: vscode.OutputChannel,
): Promise<void> {
	let anchor;
	try {
		anchor = goToAnchor(name.target);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		log.appendLine(`FATAL goToName anchor-resolve error: ${detail}`);
		void vscode.window.showErrorMessage(`Quantbook go to name failed: ${detail}`);
		return;
	}
	if (anchor === undefined) {
		void vscode.window.showInformationMessage(`Quantbook: "${name.name}" is a ${name.target.kind} name -- it has no cell to go to.`);
		return;
	}
	// Reveal the panel for this session, switching it to the anchor's sheet IN PLACE (show() is a no-op
	// reveal+render when already on that sheet). This is the cross-sheet focus the navigateTo contract
	// requires the host to do BEFORE posting.
	let panel: CellGridPanel;
	try {
		panel = CellGridPanel.show(context, session, anchor.sheet);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		log.appendLine(`FATAL goToName panel-reveal error: ${detail}`);
		void vscode.window.showErrorMessage(`Quantbook go to name failed: ${detail}`);
		return;
	}
	try {
		const delivered = await panel.navigateToCell(anchor.row, anchor.col);
		if (!delivered) {
			void vscode.window.showWarningMessage('Quantbook: could not navigate to the name (the grid did not accept the message). Try clicking the grid first, then retry.');
			return;
		}
		log.appendLine(`Go to name "${name.name}" -> sheet ${anchor.sheet} (${anchor.row},${anchor.col}).`);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		log.appendLine(`FATAL goToName navigate error: ${detail}`);
		void vscode.window.showErrorMessage(`Quantbook go to name failed: ${detail}`);
	}
}
