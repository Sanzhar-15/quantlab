/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- Quantbook commands.
 *
 * Registers the "Quantbook: Demo Round-Trip" command, which drives a
 * peer A -> bytes -> peer B round-trip via the engine binding. Uses
 * VS Code's native InformationMessage + Output Channel for UI rather
 * than a webview -- this is a smoke demo proving the engine works in
 * the extension host, NOT a real cell-grid UI.
 *
 * Per the V1 scope (`.plans/_active.md`):
 *   - One Op variant exposed (PutValue)
 *   - No Transport binding; sync is via exportBytes/mergeBytes
 *   - No persistence; sessions are per-command-invocation
 *
 * V2/V3 builds on this: real cell grid, Transport binding, persistence.
 */

import * as vscode from 'vscode';

import { addSheet, appendPutValueValidated, createSession, deleteSheet, exportToQbook, generateUuidPeerId, listSheets, moveSheet, quantbookEngineVersion, renameSheet, sessionFromQbook, sessionFromSnapshot, workbookSnapshot } from '../quantbook/session';
import { loadQuantbookEngine, quantbookHostInfo } from '../quantbook/loader';
import { connectOrSpawn, runMultiWindowDemo } from '../quantbook/multiWindowDemo';
import { CellGridPanel } from '../quantbook/cellGrid/cellGridPanel';
import { buildSheetMovePositionItems, buildSheetManagementQuickPickItems, buildSheetQuickPickItems } from '../quantbook/cellGrid/cellGridLogic';
import type { CollabSessionInstance } from '../quantbook/types';

let outputChannel: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
	if (outputChannel === undefined) {
		outputChannel = vscode.window.createOutputChannel('Quantbook');
	}
	return outputChannel;
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
	// src/quantbook/multiWindowDemo.ts for the orchestration.
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

	// Phase 5.7 V3.2.a.1 (2026-05-22) -- refresh active cell-grid
	// panels in place. Replaces the close + re-open cycle for
	// refreshing the snapshot. V3.2.b will replace this manual
	// refresh with auto-refresh on remote-op observed.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridRefresh', () => {
			const count = CellGridPanel.refreshAll();
			if (count === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panels are open. Run "Quantbook: Open Cell Grid" first.',
				);
			} else {
				const log = getOutput();
				log.appendLine(`Refreshed ${count} cell-grid panel(s).`);
			}
		}),
	);

	// Phase 5.7 V3.2.a scaffold (2026-05-22) -- read-only cell-grid
	// webview. Opens a static HTML table showing the current snapshot
	// of sheet 0. Sample data is appended at command-invocation time
	// so the empty-session case doesn't show a blank table on first
	// use. V3.2.b will add live editing + auto-refresh.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGrid', () => {
			const log = getOutput();
			try {
				// Use process.pid as peerId so multiple opens in the
				// same window distinguish themselves. Engine rejects 0
				// at the napi boundary; pid is always positive.
				const session = createSession(BigInt(process.pid));
				// Sample data so the scaffold actually shows something
				// at V3.2.a. V3.2.b will source data from a live
				// session attached to a real workbook.
				//
				// V3.3.0.5 (2026-05-22): seed sample data on THREE
				// sheets (0, 1, 2) so the
				// `quantlab.quantbookCellGridSwitchSheet` command has
				// something to switch between.  Sheet 0 keeps the
				// original V3.2.a sample; sheets 1 + 2 carry small
				// distinct samples so the user sees that switching
				// sheets actually changes the displayed values.
				//
				// V3.4.0.X HIGH-3 closure (2026-05-24, cross-lane
				// convergent Codex+Opus): `addSheet` MUST be called
				// before any `appendPutValueValidated` on a sheet,
				// because `quantlab.quantbookSaveAs` routes through
				// `to_qbook` -> `rebuild_workbook` -> `replay_into`,
				// which rejects `Op::PutValue { sheet, .. }` if the
				// sheet doesn't exist in the workbook yet (returns
				// `session_replay -- invalid sheet at op index 0
				// (workbook has 0 sheets)`).  Without these `addSheet`
				// calls, the default Save As path on the sample
				// workbook FAILS visibly to the user.  Sheet ids are
				// assigned deterministically in append order: first
				// `addSheet` -> sheet 0, second -> 1, third -> 2.
				addSheet(session, 'S0');
				addSheet(session, 'S1');
				addSheet(session, 'S2');
				appendPutValueValidated(session, 0, 0, 0, 42);
				appendPutValueValidated(session, 0, 0, 1, 100);
				appendPutValueValidated(session, 0, 1, 0, 3.14);
				appendPutValueValidated(session, 0, 1, 1, 2.718);
				appendPutValueValidated(session, 0, 2, 0, 0);
				appendPutValueValidated(session, 1, 0, 0, 11);
				appendPutValueValidated(session, 1, 0, 1, 12);
				appendPutValueValidated(session, 1, 1, 0, 13);
				appendPutValueValidated(session, 2, 0, 0, 99);
				CellGridPanel.show(context, session, 0);
				log.appendLine('Cell Grid (sheet 0) opened with sample data on sheets 0/1/2.');
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL cell-grid error: ${detail}`);
				vscode.window.showErrorMessage(`Quantbook cell grid failed: ${detail}`);
			}
		}),
	);

	// Phase 5.7 V3.2.c.4 (2026-05-22) -- live multi-window cell-grid.
	// Mirrors quantbookDemoMultiWindow's connectOrSpawn flow but opens
	// a CellGridPanel with the attached transport instead of running
	// the periodic-append demo loop.  Each window invocation tries to
	// connect to ws://127.0.0.1:7117 first; spawns the V3.1.a
	// relay binary on failure; race-retry on spawn loss.  AutoFlush =
	// OnAppend so every cell commit auto-syncs; 1s pollRemote loop
	// merges peer ops and re-renders.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridCollab', async () => {
			const log = getOutput();
			log.show(true);
			try {
				const engine = loadQuantbookEngine();
				log.appendLine('[collab] starting cell-grid collab (sheet 0)...');
				const { transport, spawnedRelay } = await connectOrSpawn(engine, log);
				const session = createSession(BigInt(process.pid));
				// V3.4.0.X HIGH-3 carry: seed sheet 0 so user edits via
				// the V3.2.b PESSIMISTIC dispatcher (which calls
				// appendPutValue directly) can later be saved via
				// quantlab.quantbookSaveAs.  Without this, the user's
				// first edit on the collab panel produces a PutValue op
				// on a sheet the workbook doesn't have, and Save As
				// fails replay with session_replay -- invalid sheet.
				addSheet(session, 'S0');
				CellGridPanel.show(context, session, 0, { engine, transport, spawnedRelay, log });
				log.appendLine('[collab] cell grid open + attached.');
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL cell-grid collab error: ${detail}`);
				vscode.window.showErrorMessage(`Quantbook cell grid collab failed: ${detail}`);
			}
		}),
	);

	// Phase 5.7 V3.3.0.5 (2026-05-22) -- multi-sheet UX command.
	// Pops a QuickPick of sheets currently present in a local
	// CellGridPanel's session (per V3.3.0.1 decision D2 panel-per-
	// sheet model); on selection, opens a new panel for that sheet.
	// COLLAB panels are not eligible (V3.x scope; collab sessions
	// have their own peerId/transport state + the per-sheet
	// switching UX needs different design).  If no LOCAL panel is
	// open or the session has only one sheet, surface an info
	// message + return.
	//
	// **Multi-panel selection semantic (V3.3.0.5 audit closure)**:
	// when >1 local panel is open with different sessions, this
	// command operates on `panels[0]` (the FIRST entry in
	// activeLocalPanels()).  Map iteration order in V8 is
	// chronological-insertion-order, so `panels[0]` = the OLDEST
	// open local panel, NOT the currently-focused one.  This may
	// surprise users who expect "switch the sheet of the panel I
	// just clicked".  V3.x can add either: (a) a panel-picker step
	// before the sheet picker, or (b) a `vscode.window.activeTextEditor`-
	// style "active panel" accessor.  V3.3.0.5 ships with the
	// oldest-panel semantic for simplicity; the multi-panel-local
	// usage is rare today.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGridSwitchSheet', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			// V3.3.0.5 multi-panel handling: with multiple local
			// panels open, the switch operates on the FIRST entry
			// in `activeLocalPanels()` iteration order, which is
			// `localPanels.values()` -- V8 `Map.values()` is
			// INSERTION ORDER, so `panels[0]` = the OLDEST open
			// local panel, NOT the most-recently-focused.  V3.x
			// can add a panel-picker step or active-panel tracking
			// (V3.3.0.X audit closure MEDIUM-4, 2026-05-23 -- the
			// prior inline comment incorrectly described this as
			// "most-recently focused").
			const target = panels[0];
			const sheets = listSheets(target.session);
			if (sheets.length === 0) {
				void vscode.window.showInformationMessage(
					'This session has no sheets yet.  Append a value first to create one.',
				);
				return;
			}
			if (sheets.length === 1) {
				void vscode.window.showInformationMessage(
					`Only sheet ${sheets[0]} has data in this session; nothing to switch to.`,
				);
				return;
			}
			const items = buildSheetQuickPickItems(sheets, target.sheet);
			const selection = await vscode.window.showQuickPick(items, {
				title: 'Switch Cell Grid Sheet',
				placeHolder: `Currently on Sheet ${target.sheet} (${sheets.length} sheets total)`,
			});
			if (selection === undefined) {
				return; // user cancelled
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

	// Phase 5.7 V3.4.0.4b (2026-05-23) -- .qbook persistence commands.
	//
	// Save As: requires an open local CellGridPanel as the source
	// session.  showSaveDialog filters .qbook extension.  Engine's
	// to_qbook calls rebuild_workbook internally so the saved file is
	// a standard Tier D3 envelope (workbook.toml + oplog.bin) readable
	// by any future Quantbook tool.
	//
	// Open: showOpenDialog filters .qbook directories.  Generates a
	// fresh UUID PeerId via generateUuidPeerId (V3.4.0.4b D5 deviation
	// from V3.4.0.1: fresh-UUID-per-session is CRDT-correct + closes
	// R-V3.3-5 without the two-windows-same-workspace collision risk
	// that persisted-PeerId had).  Opens the loaded session in a new
	// CellGridPanel on sheet 0.
	//
	// **V3.4.0.4b limitation**: NO save-on-edit auto-save; user must
	// invoke Save As after edits.  V3.4.1+ may add auto-save +
	// last-saved-time indicator.  NO multi-sheet support in the Open
	// UX -- always lands on sheet 0; user runs "Switch Cell Grid
	// Sheet" if they want a different sheet.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSaveAs', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			// V3.4.0.4b: same panels[0]-arbitrary-pick semantic as
			// switch-sheet (V3.3.0.5 + V3.3.0.6 docs).  OLDEST open
			// local panel; V3.x can add a picker step if multi-panel
			// usage becomes common.
			const target = panels[0];
			const uri = await vscode.window.showSaveDialog({
				title: 'Save Quantbook As',
				filters: { 'Quantbook': ['qbook'] },
				saveLabel: 'Save',
			});
			if (uri === undefined) {
				return; // user cancelled
			}
			const log = getOutput();
			try {
				exportToQbook(target.session, uri.fsPath);
				log.appendLine(`Saved Cell Grid (sheet ${target.sheet}) to ${uri.fsPath}.`);
				void vscode.window.showInformationMessage(`Quantbook saved to ${uri.fsPath}`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL Save As error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook save failed: ${detail}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookOpen', async () => {
			const uris = await vscode.window.showOpenDialog({
				title: 'Open Quantbook',
				filters: { 'Quantbook': ['qbook'] },
				canSelectFiles: false,
				canSelectFolders: true, // .qbook is a directory
				canSelectMany: false,
				openLabel: 'Open',
			});
			if (uris === undefined || uris.length === 0) {
				return; // user cancelled
			}
			const path = uris[0].fsPath;
			const log = getOutput();
			try {
				// Fresh UUID PeerId per open: V3.4.0.4b D5 simplified
				// (per generateUuidPeerId docstring).
				const peerId = generateUuidPeerId();
				const session = sessionFromQbook(path, peerId);
				log.appendLine(`Opened Quantbook from ${path} (peerId=0x${peerId.toString(16)}).`);
				CellGridPanel.show(context, session, 0);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL Open error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook open failed: ${detail}`);
			}
		}),
	);

	// Phase 5.7 V3.5.0.4a (2026-05-24) -- sheet management commands.
	//
	// Four commands that wrap the V3.5.0.3 engine sheet ops:
	//   - quantbookSheetAdd    -> addSheet(session, name, 1000)
	//   - quantbookSheetRename -> renameSheet(session, id, newName)
	//   - quantbookSheetDelete -> deleteSheet(session, id) (with confirm)
	//   - quantbookSheetMove   -> moveSheet(session, id, newIndex)
	//
	// All four follow the V3.4.0.4b Save As pattern:
	//   1. Find oldest local panel via CellGridPanel.activeLocalPanels()
	//      (panels[0] arbitrary-pick; same semantic as switch-sheet +
	//      Save As per V3.3.0.5 / V3.3.0.6 docs).
	//   2. Build UI choice (InputBox / QuickPick / WarningMessage).
	//   3. Call engine napi (already validated at the engine layer
	//      for bad_argument / session_oplog cases per V3.5.0.3a/b/c).
	//   4. Log success or surface error via showErrorMessage.
	//
	// **NO automatic panel re-render after sheet op**: this is
	// intentional for V3.5.0.4a scope.  The cell-grid panel's
	// pollRemote tick (V3.2.c, 1s cadence) picks up the new sheet
	// state at next render via the existing snapshot path.  V3.5.0.4b
	// will migrate the render path to workbookSnapshot()-driven
	// rendering, which will naturally reflect sheet ops immediately.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetAdd', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			const target = panels[0];
			const name = await vscode.window.showInputBox({
				title: 'Add Quantbook Sheet',
				prompt: 'Enter a name for the new sheet',
				placeHolder: 'e.g., "Q4 Returns" or "Sheet3"',
				validateInput: (value) => {
					if (value.trim() === '') {
						return 'Sheet name cannot be empty';
					}
					return null;
				},
			});
			if (name === undefined) {
				return; // user cancelled
			}
			const log = getOutput();
			try {
				// chunkRows=1000 matches the V3.4.0.X sample-data
				// command's seed pattern; appropriate for typical
				// workbook sizes per Phase 2A column-store doc.
				addSheet(target.session, name.trim(), 1000);
				log.appendLine(`Added sheet "${name.trim()}" to session.`);
				void vscode.window.showInformationMessage(`Sheet "${name.trim()}" added.`);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL addSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook add sheet failed: ${detail}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetRename', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			const target = panels[0];
			const log = getOutput();
			let snap;
			try {
				snap = workbookSnapshot(target.session);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL workbookSnapshot error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename sheet failed: ${detail}`);
				return;
			}
			if (snap.sheets.length === 0) {
				void vscode.window.showInformationMessage(
					'This session has no sheets yet.  Add a sheet first via "Quantbook: Add Sheet...".',
				);
				return;
			}
			const items = buildSheetManagementQuickPickItems(snap.sheets, target.sheet);
			const pick = await vscode.window.showQuickPick(items, {
				title: 'Rename Quantbook Sheet',
				placeHolder: 'Select a sheet to rename',
			});
			if (pick === undefined) {
				return; // user cancelled
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
				return; // user cancelled
			}
			try {
				renameSheet(target.session, pick.sheet, newName.trim());
				log.appendLine(`Renamed sheet ${pick.sheet} from "${pick.name}" to "${newName.trim()}".`);
				void vscode.window.showInformationMessage(
					`Sheet ${pick.sheet} renamed to "${newName.trim()}".`,
				);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL renameSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook rename sheet failed: ${detail}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetDelete', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			const target = panels[0];
			const log = getOutput();
			let snap;
			try {
				snap = workbookSnapshot(target.session);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL workbookSnapshot error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook delete sheet failed: ${detail}`);
				return;
			}
			if (snap.sheets.length === 0) {
				void vscode.window.showInformationMessage(
					'This session has no sheets to delete.',
				);
				return;
			}
			const items = buildSheetManagementQuickPickItems(snap.sheets, target.sheet);
			const pick = await vscode.window.showQuickPick(items, {
				title: 'Delete Quantbook Sheet',
				placeHolder: 'Select a sheet to delete (this cannot be undone)',
			});
			if (pick === undefined) {
				return; // user cancelled
			}
			// V3.5.0.3b tombstone semantic: delete is destructive at
			// the user-facing level (the sheet disappears from
			// workbookSnapshot + cell-grid view).  Engine-side cell
			// data is preserved internally but unreachable.  Confirm
			// before applying.
			const confirm = await vscode.window.showWarningMessage(
				`Delete sheet ${pick.sheet} ("${pick.name}")?  This cannot be undone via the UI (no restore command exists today).`,
				{ modal: true },
				'Delete',
			);
			if (confirm !== 'Delete') {
				return; // user cancelled
			}
			try {
				deleteSheet(target.session, pick.sheet);
				log.appendLine(`Deleted sheet ${pick.sheet} ("${pick.name}").`);
				void vscode.window.showInformationMessage(
					`Sheet ${pick.sheet} ("${pick.name}") deleted.`,
				);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL deleteSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook delete sheet failed: ${detail}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSheetMove', async () => {
			const panels = CellGridPanel.activeLocalPanels();
			if (panels.length === 0) {
				void vscode.window.showInformationMessage(
					'No Cell Grid panel is open.  Run "Quantbook: Open Cell Grid" first.',
				);
				return;
			}
			const target = panels[0];
			const log = getOutput();
			let snap;
			try {
				snap = workbookSnapshot(target.session);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL workbookSnapshot error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook move sheet failed: ${detail}`);
				return;
			}
			if (snap.sheets.length < 2) {
				void vscode.window.showInformationMessage(
					'This session needs at least 2 sheets to move one.',
				);
				return;
			}
			const sourceItems = buildSheetManagementQuickPickItems(snap.sheets, target.sheet);
			const sourcePick = await vscode.window.showQuickPick(sourceItems, {
				title: 'Move Quantbook Sheet (1 of 2)',
				placeHolder: 'Select a sheet to move',
			});
			if (sourcePick === undefined) {
				return; // user cancelled
			}
			const positionItems = buildSheetMovePositionItems(snap.sheets, sourcePick.sheet);
			const positionPick = await vscode.window.showQuickPick(positionItems, {
				title: `Move "${sourcePick.name}" (2 of 2)`,
				placeHolder: 'Select the target display position',
			});
			if (positionPick === undefined) {
				return; // user cancelled
			}
			try {
				moveSheet(target.session, sourcePick.sheet, positionPick.sheet);
				log.appendLine(
					`Moved sheet ${sourcePick.sheet} ("${sourcePick.name}") to display position ${positionPick.sheet}.`,
				);
				void vscode.window.showInformationMessage(
					`Sheet "${sourcePick.name}" moved to position ${positionPick.sheet}.`,
				);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				log.appendLine(`FATAL moveSheet error: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook move sheet failed: ${detail}`);
			}
		}),
	);
}
