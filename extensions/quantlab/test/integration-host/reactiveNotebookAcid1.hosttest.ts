/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-1) -- acid#1 through the REAL NotebookController, in a real extension host.
//
// The N-1 green-gate: a `.qnb` notebook code cell -> the controller's executeHandler ->
// ReactiveKernelManager.executeCell -> a real ipykernel publishes a variable -> the bound grid's
// dependent cell recomputes live. This is the same moat as the W-T acid#1, but driven through the
// notebook surface (controller selection via Preferred affinity, the per-session serialization, and the
// bind-on-first-execute to the focused grid) instead of the programmatic command. Ground truth is the
// engine Session; teardown asserts 0 NEW ipykernels leaked.
//
// The binding/lifetime (Codex HIGH-1) + serialization (MED-1) invariants are proven deterministically in
// the vscode-free unit suite (quantbook-reactive-notebook-registry.test.ts); this test proves the live
// controller->manager->grid wiring end-to-end, which a unit test cannot.

import * as assert from 'assert';
import * as vscode from 'vscode';

import { CellGridPanel } from '../../src/quantbook/cellGrid/cellGridPanel';
import { TrustManager } from '../../src/core/trust/TrustManager';
import { QNB_NOTEBOOK_TYPE } from '../../src/quantbook/reactiveNotebook/qnbSerializer';
import type { SessionInstance } from '../../src/quantbook/types';
import { ipykernelPids, newIpykernelPids, reactiveEnvBlocker } from './helpers/hostEnv';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('Quantbook reactive acid#1 via NotebookController (real extension host)', () => {
	let session: SessionInstance;
	let sheetId: number;
	let sheetName: string;
	let notebook: vscode.NotebookDocument;
	let kernelPidsBefore: Set<number>;

	function numAt(row: number, col: number): number | undefined {
		const c = session.cell(sheetId, row, col);
		if (c !== null && c.value !== undefined && c.value.kind === 'number') {
			return c.value.number;
		}
		return undefined;
	}

	async function pollUntil(predicate: () => boolean, label: string, budgetMs = 15000): Promise<void> {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (predicate()) {
				return;
			}
			await delay(50);
		}
		throw new Error(`timed out waiting for: ${label} (B1=${numAt(0, 1)} C1=${numAt(0, 2)})`);
	}

	// Run notebook cell `index` through the real execution dispatch (which routes to our Preferred
	// controller) and resolve once the command returns. The cell's effect on the grid is then polled.
	async function runCell(index: number): Promise<void> {
		await vscode.commands.executeCommand('notebook.cell.execute', {
			ranges: [{ start: index, end: index + 1 }],
			document: notebook.uri,
		});
	}

	suiteSetup(async function () {
		this.timeout(120000);
		if (reactiveEnvBlocker() !== undefined) {
			this.skip(); // honest green-skip: engine dylib / kernel interpreter absent
			return;
		}
		kernelPidsBefore = ipykernelPids();
		const ext = vscode.extensions.getExtension('quantlab.quantlab');
		assert.ok(ext, 'the quantlab extension must be installed in the host');
		await ext.activate();
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'a workspace folder is required (the wrapper passes a temp dir)');
		await TrustManager.getInstance().trustWorkspace(folder.uri.toString());

		// Self-isolate: a sibling hosttest (acid1) may leave its grid open. Close all editors so this
		// suite opens exactly one grid -> a single, focused, unambiguous bind target.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const drainDeadline = Date.now() + 5000;
		while (CellGridPanel.activeLocalPanels().length > 0 && Date.now() < drainDeadline) {
			await delay(50);
		}
	});

	test('a notebook cell publishes a variable; the dependent grid cell recomputes live', async function () {
		this.timeout(120000);

		// Open one grid; bind-on-first-execute targets the FOCUSED grid, so read ground truth from the
		// same focused panel the controller will resolve (robust even if a stray grid lingers).
		await vscode.commands.executeCommand('quantlab.quantbookCellGrid');
		await delay(150); // let the new panel become the focused/active grid
		const focused = CellGridPanel.focusedLocalPanel();
		assert.ok(focused, 'the opened Cell Grid must be the focused panel (the controller bind target)');
		session = focused.session;
		const snap = session.snapshot();
		assert.ok(snap.sheets.length > 0, 'the workbook must have at least one sheet');
		sheetId = snap.sheets[0].id;
		sheetName = snap.sheets[0].name; // S0, not Sheet1

		// C1 = B1*2 (the dependent cell); E1 = 999 (read-only witness).
		session.setFormula(sheetId, 0, 2, 'B1*2');
		session.setFormula(sheetId, 0, 4, '999');
		session.recalcDirty();

		// Open a reactive notebook with three code cells and show it (fires the controller's affinity).
		const cells = [
			new vscode.NotebookCellData(vscode.NotebookCellKind.Code, `x = 0; qb.publish("x", x, "${sheetName}!B1")`, 'python'),
			new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 7', 'python'),
			new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'z = x + 1', 'python'),
		];
		notebook = await vscode.workspace.openNotebookDocument(QNB_NOTEBOOK_TYPE, new vscode.NotebookData(cells));
		await vscode.window.showNotebookDocument(notebook);
		await delay(250); // let onDidOpenNotebookDocument set Preferred affinity before the first run

		// Cell 0 binds x -> B1 (initial publish writes 0). Lazy-spawns the real ipykernel via the notebook path.
		await runCell(0);
		await pollUntil(() => numAt(0, 1) === 0 && numAt(0, 2) === 0, 'B1=0 and C1=0 after the publish cell');

		// The cell must carry a rendered status output (proves the executeHandler output path, not just the grid).
		await pollUntil(() => notebook.cellAt(0).outputs.length > 0, 'cell 0 has output');
		const out0 = notebook.cellAt(0).outputs[0];
		const item0 = out0.items.find((it) => it.mime === 'text/plain');
		assert.ok(item0, 'the publish cell must render a text/plain status output');
		assert.ok(Buffer.from(item0.data).toString('utf8').length > 0, 'the status output must be non-empty');

		// ACID#1 POSITIVE: cell 1 reassigns x -> the dependent cell recomputes live with no grid action.
		await runCell(1);
		await pollUntil(() => numAt(0, 1) === 7 && numAt(0, 2) === 14, 'B1=7 and C1=14 after x=7 (acid#1 via notebook)');

		// NEGATIVE (T5): cell 2 publishes nothing -> the witness + B1/C1 stay put after a settle.
		const witnessBefore = numAt(0, 4);
		await runCell(2);
		await delay(1000); // settle: prove no spurious republish lands
		assert.strictEqual(numAt(0, 4), witnessBefore, 'the read-only witness E1 must not change');
		assert.strictEqual(numAt(0, 1), 7, 'B1 must stay 7 after a read-only cell');
		assert.strictEqual(numAt(0, 2), 14, 'C1 must stay 14 after a read-only cell');
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		if (reactiveEnvBlocker() !== undefined) {
			return;
		}
		try {
			await vscode.commands.executeCommand('quantlab.quantbookReactiveStop');
		} catch (e) {
			console.error(`[notebook-acid1] Stop failed during teardown: ${e instanceof Error ? e.message : String(e)}`);
		}
		await delay(1500); // SIGTERM-grace teardown of the supervisor + ipykernel
		const leaked = newIpykernelPids(kernelPidsBefore);
		assert.strictEqual(leaked.length, 0, `no orphan ipykernels may survive teardown (leaked PIDs: ${leaked.join(', ')})`);
	});
});
