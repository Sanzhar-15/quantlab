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

import { appendPutValueValidated, createSession, listSheets, quantbookEngineVersion, sessionFromSnapshot } from '../quantbook/session';
import { loadQuantbookEngine, quantbookHostInfo } from '../quantbook/loader';
import { connectOrSpawn, runMultiWindowDemo } from '../quantbook/multiWindowDemo';
import { CellGridPanel } from '../quantbook/cellGrid/cellGridPanel';
import { buildSheetQuickPickItems } from '../quantbook/cellGrid/cellGridLogic';
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
			// panels open, the switch operates on the FIRST one
			// (presumed most-recently focused / least surprising).
			// V3.x can add a panel-picker step if multi-panel use
			// becomes common.
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
}
