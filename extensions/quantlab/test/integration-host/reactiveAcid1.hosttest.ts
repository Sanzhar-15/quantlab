/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-T -- acid#1 END-TO-END in a REAL extension host, no GUI clicking.
//
// This is the automated kill-gate that replaces the manual 1d-3 operator smoke. It boots the real
// extension host (real `vscode` API), opens a Cell Grid, starts the reactive kernel (a real
// ipykernel), executes Python cells via the programmatic `quantbookExecuteReactiveCode` command, and
// asserts the GRID recomputed: publish x -> dependent C1 recomputes live; a read-only cell does not
// move. Ground truth is read from the engine Session (`session.cell`), not pixels. Teardown asserts
// 0 NEW ipykernels leaked (delta vs a pre-test snapshot -- robust to unrelated kernels).

import * as assert from 'assert';
import * as vscode from 'vscode';

import { CellGridPanel } from '../../src/quantbook/cellGrid/cellGridPanel';
import { TrustManager } from '../../src/core/trust/TrustManager';
import type { ReactiveOpResult } from '../../src/quantbook/reactiveKernel/reactiveKernelClient';
import type { SessionInstance } from '../../src/quantbook/types';
import { ipykernelPids, newIpykernelPids, reactiveEnvBlocker } from './helpers/hostEnv';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('Quantbook reactive acid#1 (real extension host)', () => {
	let session: SessionInstance;
	let sheetId: number;
	let sheetName: string;
	let kernelPidsBefore: Set<number>;

	// Numeric value at (row,col) on the bound sheet, or undefined if the cell is not a number yet.
	function numAt(row: number, col: number): number | undefined {
		const c = session.cell(sheetId, row, col);
		if (c !== null && c.value !== undefined && c.value.kind === 'number') {
			return c.value.number;
		}
		return undefined;
	}

	// Poll a predicate up to `budgetMs`; throw with `label` if it never holds (No-Fallbacks).
	async function pollUntil(predicate: () => boolean, label: string, budgetMs = 10000): Promise<void> {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (predicate()) {
				return;
			}
			await delay(50);
		}
		throw new Error(`timed out waiting for: ${label} (B1=${numAt(0, 1)} C1=${numAt(0, 2)})`);
	}

	suiteSetup(async function () {
		this.timeout(120000);
		const blocker = reactiveEnvBlocker();
		if (blocker !== undefined) {
			// Honest green-skip: the engine dylib / kernel interpreter is not present in this env.
			this.skip();
			return;
		}
		kernelPidsBefore = ipykernelPids();
		const ext = vscode.extensions.getExtension('quantlab.quantlab');
		assert.ok(ext, 'the quantlab extension must be installed in the host');
		await ext.activate();
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'a workspace folder is required (the wrapper passes a temp dir)');
		// Grant QuantLab workspace trust programmatically (the reactive kernel is trust-gated).
		await TrustManager.getInstance().trustWorkspace(folder.uri.toString());
	});

	test('publish x -> dependent cell recomputes live; read-only cell stays', async function () {
		this.timeout(120000);

		// Open exactly ONE Cell Grid so the command target resolves without focus.
		await vscode.commands.executeCommand('quantlab.quantbookCellGrid');
		const panels = CellGridPanel.activeLocalPanels();
		assert.strictEqual(panels.length, 1, 'exactly one Cell Grid panel must be open');
		session = panels[0].session;

		// The grid seeds sheets S0/S1/S2 (NOT "Sheet1") -- resolve the real first sheet.
		const snap = session.snapshot();
		assert.ok(snap.sheets.length > 0, 'the workbook must have at least one sheet');
		sheetId = snap.sheets[0].id;
		sheetName = snap.sheets[0].name;

		// C1 = B1*2 (the dependent cell the kernel publish will drive); E1 = 999 (read-only witness).
		session.setFormula(sheetId, 0, 2, 'B1*2');
		session.setFormula(sheetId, 0, 4, '999');
		session.recalcDirty();

		// Start the reactive kernel (trust passes; lazy-spawns the real ipykernel).
		await vscode.commands.executeCommand('quantlab.quantbookReactiveStart');

		// Bind x -> B1 (initial publish writes 0). Programmatic command rethrows on failure.
		await vscode.commands.executeCommand(
			'quantlab.quantbookExecuteReactiveCode',
			`x = 0; qb.publish("x", x, "${sheetName}!B1")`,
		);
		await pollUntil(() => numAt(0, 1) === 0 && numAt(0, 2) === 0, 'B1=0 and C1=0 after the initial publish');

		// ACID#1 POSITIVE: reassign x -> the dependent cell recomputes live, no grid action.
		await vscode.commands.executeCommand('quantlab.quantbookExecuteReactiveCode', 'x = 7');
		await pollUntil(() => numAt(0, 1) === 7 && numAt(0, 2) === 14, 'B1=7 and C1=14 after x=7 (acid#1)');

		// ACID#1 NEGATIVE (T5): a cell that publishes nothing must not repaint anything. Assert on the
		// op result (republishCount/refused/stale all 0) -- this is the load-bearing check: a spurious
		// same-value republish would leave B1/C1 unchanged yet still be a real defect (Codex MED fold).
		const witnessBefore = numAt(0, 4);
		const negResult = await vscode.commands.executeCommand<ReactiveOpResult>(
			'quantlab.quantbookExecuteReactiveCode',
			'z = x + 1',
		);
		assert.ok(negResult, 'the programmatic command must return a result');
		assert.strictEqual(negResult.republishCount, 0, 'a read-only cell must republish nothing');
		assert.strictEqual(negResult.refused.length, 0, 'a read-only cell must refuse nothing');
		assert.strictEqual(negResult.stale.length, 0, 'a read-only cell must mark nothing stale');
		await delay(750); // settle: prove no spurious republish lands
		assert.strictEqual(numAt(0, 4), witnessBefore, 'the read-only witness E1 must not change');
		assert.strictEqual(numAt(0, 1), 7, 'B1 must stay 7 after a read-only cell');
		assert.strictEqual(numAt(0, 2), 14, 'C1 must stay 14 after a read-only cell');
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		if (reactiveEnvBlocker() !== undefined) {
			return; // suite was skipped; nothing to tear down
		}
		try {
			await vscode.commands.executeCommand('quantlab.quantbookReactiveStop');
		} catch (e) {
			// Best-effort cleanup at a test boundary -- log, never swallow silently, and still run the
			// orphan assertion below (a failed Stop must not hide a leaked kernel).
			console.error(`[acid1] Stop failed during teardown: ${e instanceof Error ? e.message : String(e)}`);
		}
		await delay(1500); // allow SIGTERM-grace teardown of the supervisor + ipykernel
		const leaked = newIpykernelPids(kernelPidsBefore);
		assert.strictEqual(leaked.length, 0, `no orphan ipykernels may survive teardown (leaked PIDs: ${leaked.join(', ')})`);
	});
});
