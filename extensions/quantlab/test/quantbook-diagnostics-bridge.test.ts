/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 error-surface -- integration tests for the host-side QuantbookDiagnostics bridge, exercised over
// the minimal vscode shim (FakeDiagnosticCollection + Range/Diagnostic/Uri.from). Covers the merge of
// stored cell errors + sticky input rejections, the supersede + clear rules, the workbook-level reactive
// split, per-session uri isolation, and the virtual-doc content provider. Runs in the normal mocha suite.

import * as assert from 'assert';

// One import from the shim (no-duplicate-imports): pulls the install hook + the test-facing surface.
import { FakeDiagnosticCollection, Uri, installVscodeShim } from './helpers/vscode-shim';
// Install BEFORE the bridge import below resolves its `import * as vscode from 'vscode'`. TSC emits
// ordered CommonJS require()s, so this side-effect runs before the next import's require executes.
installVscodeShim();

import { QuantbookDiagnostics } from '../src/quantbook/diagnostics/quantbookDiagnostics';
import { cellDiagnosticsUriPath, reactiveDiagnosticsUriPath } from '../src/quantbook/diagnostics/diagnosticsLogic';
import type { QuantbookCellSnapshot, QuantbookCellValue, SessionInstance } from '../src/quantbook/types';

// The bridge keys sessions by IDENTITY (a WeakMap), so any object stands in for a SessionInstance.
function fakeSession(): SessionInstance {
	return {} as unknown as SessionInstance;
}

function snap(entries: Array<{ row: number; col: number; value: QuantbookCellValue; diagnostic?: string }>): QuantbookCellSnapshot {
	return { snapshot_format_version: 1, sheet: 0, entries };
}

/** Reach into the bridge's private collection (the shim's FakeDiagnosticCollection) for assertions. */
function collectionOf(bridge: QuantbookDiagnostics): FakeDiagnosticCollection {
	return (bridge as unknown as { collection: FakeDiagnosticCollection }).collection;
}

function cellUri(session: SessionInstance, bridge: QuantbookDiagnostics, sheet: number): Uri {
	// The bridge assigns session tags lazily in first-seen order; the FIRST session it sees is 's1'.
	void session;
	void bridge;
	const { authority, path } = cellDiagnosticsUriPath('s1', sheet);
	return Uri.from({ scheme: 'quantbook', authority, path });
}

// The shim's Uri lacks the full `vscode.Uri` surface (`with`/`toJSON`); the bridge's content-provider
// method is typed against the real vscode.Uri. Cast through unknown for the test call (the bridge only
// reads `.toString()`).
function provide(bridge: QuantbookDiagnostics, uri: Uri): string {
	return bridge.provideTextDocumentContent(uri as unknown as Parameters<QuantbookDiagnostics['provideTextDocumentContent']>[0]);
}

suite('W2 QuantbookDiagnostics -- stored cell errors from the render snapshot', () => {
	test('an error-valued cell produces one Error diagnostic at a single-cell range', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setSheetCellDiagnostics(session, 0, snap([
			{ row: 2, col: 1, value: { kind: 'error', value: '#CALC!' }, diagnostic: 'no Python worker' },
		]));
		const diags = collectionOf(bridge).get(cellUri(session, bridge, 0));
		assert.ok(diags !== undefined && diags.length === 1);
		assert.strictEqual(diags[0].range.start.line, 2);
		assert.strictEqual(diags[0].range.start.character, 1);
		assert.strictEqual(diags[0].range.end.character, 2);
		assert.strictEqual(diags[0].code, '#CALC!');
		assert.ok(diags[0].message.includes('no Python worker'));
		assert.ok(diags[0].message.includes('Sheet 0 B3'));
		bridge.dispose();
	});

	test('a recovered cell clears its diagnostic on the next render (No-Fallbacks auto-clear)', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#CALC!' } }]));
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0))?.length, 1);
		// Re-render: the cell is now a real number -> absent from the error list -> diagnostics cleared.
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'number', value: 7 } }]));
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0)), undefined);
		bridge.dispose();
	});
});

suite('W2 QuantbookDiagnostics -- sticky errorReply (input rejections)', () => {
	test('an errorReply is surfaced as a sticky cell diagnostic, merged with stored errors', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		// A stored error on B1...
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 1, value: { kind: 'error', value: '#CALC!' } }]));
		// ...and an input rejection on A1 (which never got written, so it is NOT in the snapshot).
		bridge.setCellErrorReply(session, 0, 0, 0, 'formula_parse', 'unexpected token');
		const diags = collectionOf(bridge).get(cellUri(session, bridge, 0));
		assert.strictEqual(diags?.length, 2);
		const codes = diags.map(d => d.code).sort();
		assert.deepStrictEqual(codes, ['#CALC!', 'formula_parse']);
		bridge.dispose();
	});

	test('a stored error on the SAME cell supersedes a sticky errorReply (no duplicate)', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setCellErrorReply(session, 0, 0, 0, 'formula_parse', 'unexpected token');
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0))?.length, 1);
		// A later render shows A1 now holds a STORED error -> the sticky is superseded, only one diagnostic.
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#NAME?' } }]));
		const diags = collectionOf(bridge).get(cellUri(session, bridge, 0));
		assert.strictEqual(diags?.length, 1);
		assert.strictEqual(diags[0].code, '#NAME?');
		bridge.dispose();
	});

	test('clearCellErrorReply removes the sticky entry but preserves a stored error on another cell', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 1, value: { kind: 'error', value: '#CALC!' } }]));
		bridge.setCellErrorReply(session, 0, 0, 0, 'formula_parse', 'unexpected token');
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0))?.length, 2);
		// The rejected cell now commits cleanly -> its sticky clears; the B1 stored error remains.
		bridge.clearCellErrorReply(session, 0, 0, 0);
		const diags = collectionOf(bridge).get(cellUri(session, bridge, 0));
		assert.strictEqual(diags?.length, 1);
		assert.strictEqual(diags[0].code, '#CALC!');
		bridge.dispose();
	});

	test('Codex HIGH: sticky -> stored (supersede) -> recovered clears ALL (no resurrection)', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		// 1. A1 is rejected (sticky).
		bridge.setCellErrorReply(session, 0, 0, 0, 'formula_parse', 'unexpected token');
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0))?.length, 1);
		// 2. A render shows A1 now holds a STORED error -> the sticky must be DELETED, not just hidden.
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#NAME?' } }]));
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0))?.length, 1);
		// 3. A later render shows A1 RECOVERED (a dependent recompute cleared it -- NO clearCellErrorReply
		//    was ever called for A1). The stored error drops out; the sticky must NOT resurrect.
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'number', value: 5 } }]));
		assert.strictEqual(collectionOf(bridge).get(cellUri(session, bridge, 0)), undefined);
		assert.strictEqual(collectionOf(bridge)._uriCount(), 0);
		bridge.dispose();
	});

	test('clearing the only diagnostic removes the uri entirely', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setCellErrorReply(session, 0, 5, 5, 'bad_argument', 'nope');
		assert.strictEqual(collectionOf(bridge)._uriCount(), 1);
		bridge.clearCellErrorReply(session, 0, 5, 5);
		assert.strictEqual(collectionOf(bridge)._uriCount(), 0);
		bridge.dispose();
	});
});

suite('W2 QuantbookDiagnostics -- workbook-level reactive errors', () => {
	test('a reactive error pins to a (0,0) range under the per-session reactive uri, NOT a guessed cell', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setReactiveError(session, 'NameError: x is not defined');
		const { authority, path } = reactiveDiagnosticsUriPath('s1');
		const diags = collectionOf(bridge).get(Uri.from({ scheme: 'quantbook', authority, path }));
		assert.strictEqual(diags?.length, 1);
		assert.strictEqual(diags[0].range.start.line, 0);
		assert.strictEqual(diags[0].range.start.character, 0);
		assert.strictEqual(diags[0].code, 'reactive');
		assert.ok(diags[0].message.includes('NameError'));
		bridge.dispose();
	});

	test('clearReactiveError removes the reactive uri (kernel recovered / stopped)', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setReactiveError(session, 'boom');
		assert.strictEqual(collectionOf(bridge)._uriCount(), 1);
		bridge.clearReactiveError(session);
		assert.strictEqual(collectionOf(bridge)._uriCount(), 0);
		bridge.dispose();
	});

	test('latest-wins: a second reactive error replaces the first', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setReactiveError(session, 'first');
		bridge.setReactiveError(session, 'second');
		const { authority, path } = reactiveDiagnosticsUriPath('s1');
		const diags = collectionOf(bridge).get(Uri.from({ scheme: 'quantbook', authority, path }));
		assert.strictEqual(diags?.length, 1);
		assert.ok(diags[0].message.includes('second'));
		bridge.dispose();
	});
});

suite('W2 QuantbookDiagnostics -- per-session isolation + lifecycle clears', () => {
	test('two sessions on the same sheet id never collide (distinct uris)', () => {
		const bridge = new QuantbookDiagnostics();
		const a = fakeSession();
		const b = fakeSession();
		bridge.setSheetCellDiagnostics(a, 0, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#CALC!' } }]));
		bridge.setSheetCellDiagnostics(b, 0, snap([{ row: 1, col: 1, value: { kind: 'error', value: '#NAME?' } }]));
		// Both present, under different uris -> two uri entries.
		assert.strictEqual(collectionOf(bridge)._uriCount(), 2);
		bridge.dispose();
	});

	test('clearSheet drops one sheet, clearSessionAll drops every sheet + reactive', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setSheetCellDiagnostics(session, 0, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#CALC!' } }]));
		bridge.setSheetCellDiagnostics(session, 1, snap([{ row: 0, col: 0, value: { kind: 'error', value: '#REF!' } }]));
		bridge.setReactiveError(session, 'boom');
		assert.strictEqual(collectionOf(bridge)._uriCount(), 3);
		bridge.clearSheet(session, 0);
		assert.strictEqual(collectionOf(bridge)._uriCount(), 2);
		bridge.clearSessionAll(session);
		assert.strictEqual(collectionOf(bridge)._uriCount(), 0);
		bridge.dispose();
	});
});

suite('W2 QuantbookDiagnostics -- virtual-doc content provider', () => {
	test('provideTextDocumentContent renders the current errors for a cell uri', () => {
		const bridge = new QuantbookDiagnostics();
		const session = fakeSession();
		bridge.setSheetCellDiagnostics(session, 0, snap([
			{ row: 0, col: 0, value: { kind: 'error', value: '#CALC!' }, diagnostic: 'no Python worker' },
		]));
		const body = provide(bridge, cellUri(session, bridge, 0));
		assert.ok(body.includes('Sheet 0'));
		assert.ok(body.includes('A1'));
		assert.ok(body.includes('no Python worker'));
		bridge.dispose();
	});

	test('an unknown uri yields a safe empty-state body (not a throw)', () => {
		const bridge = new QuantbookDiagnostics();
		const body = provide(bridge, Uri.from({ scheme: 'quantbook', authority: 'workbook', path: '/sX/sheet/9' }));
		assert.ok(body.includes('No current errors'));
		bridge.dispose();
	});
});
