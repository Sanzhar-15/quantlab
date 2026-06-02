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
 * **FE-0a Part B (B1, 2026-06-02) -- grid migrated to the owning single-writer
 * `Session`.** The primary "Open Cell Grid" command now binds the owning
 * `Session` (createWorkbookSession) so the grid can consume the ENG-FUSION
 * fusion primitives and write text cells. The collaborative path
 * (`quantbookCellGridCollab`) is a loud stub (real-time collab is v1.5-deferred:
 * "CRDT built, transport unwired"). The sheet-management + .qbook persistence
 * commands (switch/add/rename/delete/move sheet, Save As, Open) are type-coupled
 * to the panel's session and need real rework on `Session`; they are loud B2
 * stubs until FE-0a Part B2. The CollabSession demo commands
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
import { addSheet, appendPutValueValidated, createSession, createWorkbookSession, quantbookEngineVersion, recalcDirtyChecked, sessionFromSnapshot, setValueValidated } from '../quantbook/session';
import { loadQuantbookEngine, quantbookHostInfo } from '../quantbook/loader';
import { runMultiWindowDemo } from '../quantbook/multiWindowDemo';
import { CellGridPanel } from '../quantbook/cellGrid/cellGridPanel';
import type { CollabSessionInstance } from '../quantbook/types';

let outputChannel: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
	if (outputChannel === undefined) {
		outputChannel = vscode.window.createOutputChannel('Quantbook');
	}
	return outputChannel;
}

/**
 * **FE-0a Part B (B1, 2026-06-02)** -- register a grid command that is being
 * migrated to the owning single-writer `Session` in B2 as a LOUD, intentional
 * placeholder. These commands (sheet switch/add/rename/delete/move, .qbook
 * save/open) are type-coupled to the panel's session and need real rework on
 * `Session`; until B2 they surface a visible "temporarily unavailable" message
 * rather than silently doing nothing (the No-Fallbacks system-boundary
 * exception: errors/limits must be visible). The command stays registered so
 * invoking it from the palette gives a clean message, not "command not found".
 */
function registerB2Stub(context: vscode.ExtensionContext, commandId: string, feature: string): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(commandId, () => {
			void vscode.window.showInformationMessage(
				`Quantbook: "${feature}" is being migrated to the single-writer session ` +
				`(FE-0a Part B2) and is temporarily unavailable.`,
			);
		}),
	);
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

	// --- Primary cell-grid command (FE-0a Part B / B1: owning Session). ---
	// Opens a single-writer Session-backed grid seeded with sample data so the
	// scaffold shows something. The user can edit number / text / `=formula`
	// cells; the host writes via Session.setValue/setFormula, recalcs, re-renders.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookCellGrid', () => {
			const log = getOutput();
			try {
				// FE-0a Part B (B1): bind the owning single-writer Session.
				const session = createWorkbookSession();
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
				log.appendLine('Cell Grid (sheet 0) opened with sample data on sheets 0/1/2.');
			} catch (err) {
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

	// FE-0a Part B (B1): these grid commands are type-coupled to the panel's
	// session and are being migrated to the owning Session in B2. Loud B2 stubs
	// (No-Fallbacks system-boundary exception: visible, intentional) until then.
	registerB2Stub(context, 'quantlab.quantbookCellGridSwitchSheet', 'Switch Cell Grid Sheet');
	registerB2Stub(context, 'quantlab.quantbookSaveAs', 'Save As (.qbook)');
	registerB2Stub(context, 'quantlab.quantbookOpen', 'Open (.qbook)');
	registerB2Stub(context, 'quantlab.quantbookSheetAdd', 'Add Sheet');
	registerB2Stub(context, 'quantlab.quantbookSheetRename', 'Rename Sheet');
	registerB2Stub(context, 'quantlab.quantbookSheetDelete', 'Delete Sheet');
	registerB2Stub(context, 'quantlab.quantbookSheetMove', 'Move Sheet');
}
