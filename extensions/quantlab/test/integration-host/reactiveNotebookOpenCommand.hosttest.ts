/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-2a) -- the "Open Reactive Notebook" command end-to-end in a real extension host.
//
// The N-2a green-gate: "Quantbook: Open Reactive Notebook" resolves the focused grid, opens a `.qnb`
// pre-seeded with a runnable publish template that targets the grid's REAL active sheet (the operator
// no longer has to guess "S0" vs "Sheet1"), and EAGER-binds it. Running the seeded code cell then drives
// the dependent grid cell live. The registry bind/tombstone semantics are proven deterministically in the
// vscode-free unit suite (quantbook-reactive-notebook-registry.test.ts); this proves the command wiring
// (open -> bind -> a seeded cell recomputes the grid) which a unit test cannot. Teardown asserts 0 leaks.

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

suite('Quantbook "Open Reactive Notebook" command (real extension host)', () => {
	let session: SessionInstance;
	let sheetId: number;
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

		// Self-isolate: sibling hosttests leave grids/notebooks open. Close all editors so this suite opens
		// exactly one grid -> a single, focused, unambiguous bind target for the Open command.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const drainDeadline = Date.now() + 5000;
		while (CellGridPanel.activeLocalPanels().length > 0 && Date.now() < drainDeadline) {
			await delay(50);
		}
	});

	test('Open Reactive Notebook seeds a bound notebook whose cell recomputes the grid', async function () {
		this.timeout(120000);

		// One grid; the Open command binds to the FOCUSED grid, so read ground truth from the focused panel.
		await vscode.commands.executeCommand('quantlab.quantbookCellGrid');
		await delay(150);
		const focused = CellGridPanel.focusedLocalPanel();
		assert.ok(focused, 'the opened Cell Grid must be the focused panel (the Open command bind target)');
		session = focused.session;
		const snap = session.snapshot();
		assert.ok(snap.sheets.length > 0, 'the workbook must have at least one sheet');
		sheetId = snap.sheets[0].id;

		// Rename the active sheet to a NON-default name so "the seed uses the REAL sheet name" is proven
		// non-vacuously: a hardcoded "S0!B1" template would now be wrong (Codex N-2 re-audit LOW).
		session.renameSheet(sheetId, 'Calc');
		session.recalcDirty();
		const sheetName = session.snapshot().sheets.find((s) => s.id === sheetId)?.name;
		assert.strictEqual(sheetName, 'Calc', 'the sheet rename must take effect before opening the notebook');

		// C1 = B1*2 (the dependent witness for the seeded publish to B1).
		session.setFormula(sheetId, 0, 2, 'B1*2');
		session.recalcDirty();

		// Run the command under test. It opens + eager-binds a `.qnb` seeded with a publish template that
		// targets THIS grid's active sheet. On return the notebook is shown and active.
		await vscode.commands.executeCommand('quantlab.quantbookOpenReactiveNotebook');

		let notebook: vscode.NotebookDocument | undefined;
		await pollUntil(() => {
			notebook = vscode.workspace.notebookDocuments.find((d) => d.notebookType === QNB_NOTEBOOK_TYPE);
			return notebook !== undefined;
		}, 'a reactive notebook (.qnb) is open after the command');
		assert.ok(notebook, 'the command must open a quantlab-reactive-notebook');

		// The seed is [markdown intro, python publish cell]; the code cell is the runnable one.
		const codeCellIndex = notebook.getCells().findIndex((c) => c.kind === vscode.NotebookCellKind.Code);
		assert.ok(codeCellIndex >= 0, 'the seeded notebook must contain a code cell');
		const seededCode = notebook.cellAt(codeCellIndex).document.getText();
		assert.ok(/qb\.publish\(/.test(seededCode), 'the seeded code cell must call qb.publish');
		// Prove the template uses the grid's REAL active sheet name (a hardcoded "S0!B1" would be wrong on a
		// renamed sheet) -- not just that some "!B1" is present (Codex N-2 LOW).
		assert.ok(seededCode.includes(`${sheetName}!B1`), `the seeded publish target must use the real active sheet (${sheetName}!B1)`);

		// Execute the seeded cell -> the real ipykernel publishes x=42 to B1 -> C1 recomputes to 84.
		await vscode.commands.executeCommand('notebook.cell.execute', {
			ranges: [{ start: codeCellIndex, end: codeCellIndex + 1 }],
			document: notebook.uri,
		});
		await pollUntil(() => numAt(0, 1) === 42 && numAt(0, 2) === 84, 'B1=42 and C1=84 after running the seeded publish cell');

		// The cell must carry a rendered status output (proves the executeHandler output path, not just the grid).
		await pollUntil(() => notebook!.cellAt(codeCellIndex).outputs.length > 0, 'the seeded cell has output');
		const item = notebook.cellAt(codeCellIndex).outputs[0].items.find((it) => it.mime === 'text/plain');
		assert.ok(item, 'the seeded cell must render a text/plain status output');
		assert.ok(Buffer.from(item.data).toString('utf8').length > 0, 'the status output must be non-empty');
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		if (reactiveEnvBlocker() !== undefined) {
			return;
		}
		try {
			await vscode.commands.executeCommand('quantlab.quantbookReactiveStop');
		} catch (e) {
			console.error(`[notebook-open-cmd] Stop failed during teardown: ${e instanceof Error ? e.message : String(e)}`);
		}
		await delay(1500); // SIGTERM-grace teardown of the supervisor + ipykernel
		const leaked = newIpykernelPids(kernelPidsBefore);
		assert.strictEqual(leaked.length, 0, `no orphan ipykernels may survive teardown (leaked PIDs: ${leaked.join(', ')})`);
		// Leave the shared extension host clean for any later suite (defense-in-depth alongside the runner's
		// deterministic sort -- this suite opens a grid + notebook it must not bequeath, Codex N-2 MED).
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});
});
