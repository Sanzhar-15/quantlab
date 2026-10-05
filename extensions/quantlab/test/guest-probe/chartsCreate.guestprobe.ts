/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The extension-host half of the two guest rows of desktop PLAN-FINAL §3.8, run inside the BUILT app's
// workbench. The driver (the host's Playwright `_electron` driver: launch / show(view) / terminal-evaluate /
// capturePage) owns the window; this probe owns what only the extension host can do or see. They meet in
// ONE directory, QL_PROBE_DIR, by files — the probe never returns state through a product command.
//
//   driver, before launch   QL_PROBE_DIR=<empty dir>; the workspace folder holds `strategy.py` and
//                           `bars.csv` (OHLCV: date,open,high,low,close,volume); a fresh profile.
//   CHART   probe           selects bars.csv as the data source, opens strategy.py in `quantlab.chartView`,
//                           writes chart-open.json when that editor is the active tab.
//           driver          shows the workbench, lets the chart draw, captures it, writes chart-captured.
//   CREATE  probe           writes create-ready.json (the untitled documents open BEFORE the intent).
//           driver          in the TERMINAL view: navigates to /create (or calls app.openQuantlab).
//           probe           waits for exactly one NEW untitled document to be the active editor, writes
//                           create-result.json, and asserts it is the new-strategy document.
//
// A step the other side never takes is a timeout, by name. Verdicts: this suite's failures (the host's
// exit code) and `probe-result-check.py <QL_PROBE_DIR>` on the files.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { NEW_STRATEGY_TEMPLATE } from '../../src/commands/newStrategy';

const CHART_VIEW_TYPE = 'quantlab.chartView';
const STEP_BUDGET_MS = 120000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(read: () => T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + STEP_BUDGET_MS;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) {
			return value;
		}
		await delay(100);
	}
	throw new Error(`guest probe: timed out after ${STEP_BUDGET_MS} ms waiting for: ${label}`);
}

function untitledDocuments(): string[] {
	return vscode.workspace.textDocuments.filter((doc) => doc.isUntitled).map((doc) => doc.uri.toString());
}

function activeChartTab(resource: vscode.Uri): vscode.Tab | undefined {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (tab && tab.input instanceof vscode.TabInputCustom
		&& tab.input.viewType === CHART_VIEW_TYPE && tab.input.uri.toString() === resource.toString()) {
		return tab;
	}
	return undefined;
}

suite('desktop guest probe: strategy chart and Create (built app)', () => {
	let probeDir: string;
	let folder: vscode.Uri;

	function write(name: string, value: unknown): void {
		const target = path.join(probeDir, name);
		fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 1));
		fs.renameSync(`${target}.tmp`, target);
	}

	suiteSetup(async () => {
		const dir = process.env.QL_PROBE_DIR;
		assert.ok(dir, 'QL_PROBE_DIR is required (the driver sets it to an empty directory)');
		probeDir = dir;
		assert.deepStrictEqual(fs.readdirSync(probeDir), [], `QL_PROBE_DIR ${probeDir} must be empty at the start`);
		const ext = vscode.extensions.getExtension('quantlab.quantlab');
		assert.ok(ext, 'the quantlab extension must be installed in the host');
		await ext.activate();
		const first = vscode.workspace.workspaceFolders?.[0];
		assert.ok(first, 'a workspace folder holding strategy.py and bars.csv is required');
		folder = first.uri;
	});

	test('CHART: a strategy opens in the Chart editor with a local data source', async () => {
		const strategy = vscode.Uri.joinPath(folder, 'strategy.py');
		const bars = vscode.Uri.joinPath(folder, 'bars.csv');
		await vscode.workspace.fs.stat(strategy);
		await vscode.workspace.fs.stat(bars);

		await vscode.commands.executeCommand('quantlab.setGlobalDataSource', bars.fsPath);
		await vscode.commands.executeCommand('vscode.openWith', strategy, CHART_VIEW_TYPE);
		await pollUntil(() => activeChartTab(strategy), `the active tab to be ${CHART_VIEW_TYPE} on strategy.py`);
		write('chart-open.json', { viewType: CHART_VIEW_TYPE, uri: strategy.toString(), dataSource: bars.fsPath });

		await pollUntil(
			() => (fs.existsSync(path.join(probeDir, 'chart-captured')) ? true : undefined),
			'the driver to capture the chart and write chart-captured',
		);
		assert.ok(activeChartTab(strategy), 'the Chart editor must still be the active tab when it was captured');
	});

	test('CREATE: the terminal intent leaves one new strategy document open', async () => {
		const before = untitledDocuments();
		write('create-ready.json', { untitledBefore: before });

		const created = await pollUntil(() => {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.isUntitled && !before.includes(editor.document.uri.toString())) {
				return editor.document;
			}
			return undefined;
		}, 'a new untitled document to become the active editor (the driver triggers Create in the terminal view)');

		// Let a second document appear if the intent wrongly fired twice, before counting.
		await delay(2000);
		const added = untitledDocuments().filter((uri) => !before.includes(uri));
		const result = {
			isUntitled: created.isUntitled,
			languageId: created.languageId,
			textIsTemplate: created.getText() === NEW_STRATEGY_TEMPLATE,
			newUntitledDocuments: added.length,
		};
		write('create-result.json', result);
		assert.deepStrictEqual(result, { isUntitled: true, languageId: 'python', textIsTemplate: true, newUntitledDocuments: 1 });
	});
});
