/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 formula intelligence -- unit tests for the HOST dispatcher arms (validateFormula / listFunctions).
// These are REQUEST/REPLY (no engine mutation), so they are driven with a minimal fake session that only
// implements the two read methods + a throwing variant (for the No-Fallbacks error-surfacing assertion).
// The full panel wiring (postMessage back to the webview) is covered by the panel; this pins the dispatch
// validation + the ok/error shaping the webview relies on.

import * as assert from 'assert';

import {
	dispatchIncomingMessage,
	type DispatchDeps,
	type FunctionListMessage,
	type ValidateFormulaResultMessage,
} from '../src/quantbook/cellGrid/cellGridLogic';
import type { DiagnosticJson, FunctionMetadataJson, SessionInstance } from '../src/quantbook/types';

const META: FunctionMetadataJson = {
	canonicalName: 'SUM',
	aliases: [],
	arity: { kind: 'range', min: 1 },
	volatility: 'pure',
	determinism: true,
	depShape: 'value_deps',
	batchShape: 'scalar',
	argPolicy: 'strict',
	cancellation: 'none',
	argContext: 'scalar',
	provenanceTags: [],
};

const DIAG: DiagnosticJson = { severity: 'error', code: 'formula_parse', message: 'unexpected token' };

/** Build DispatchDeps with a fake session whose validateFormula/listFunctions are programmable. */
function makeDeps(opts: {
	validate?: (sheet: number, row: number, col: number, text: string) => DiagnosticJson[];
	list?: () => FunctionMetadataJson[];
	captureValidate?: (r: ValidateFormulaResultMessage) => void;
	captureList?: (r: FunctionListMessage) => void;
}): DispatchDeps {
	const session = {
		validateFormula: opts.validate ?? ((): DiagnosticJson[] => []),
		listFunctions: opts.list ?? ((): FunctionMetadataJson[] => [META]),
	} as unknown as SessionInstance;
	return {
		session,
		sheet: 0,
		onCommit: () => undefined,
		onError: () => undefined,
		onValidateFormula: opts.captureValidate,
		onListFunctions: opts.captureList,
	};
}

suite('W2 dispatcher -- validateFormula', () => {
	test('a valid formula returns ok:true with empty diagnostics', () => {
		let captured: ValidateFormulaResultMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 'A1+B1', reqId: 7 },
			makeDeps({ validate: () => [], captureValidate: r => (captured = r) }),
		);
		assert.ok(captured);
		assert.strictEqual(captured!.reqId, 7);
		assert.strictEqual(captured!.ok, true);
		assert.deepStrictEqual(captured!.diagnostics, []);
	});

	test('a malformed formula returns ok:true WITH the engine diagnostics (data, not a throw)', () => {
		let captured: ValidateFormulaResultMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 'A1+', reqId: 1 },
			makeDeps({ validate: () => [DIAG], captureValidate: r => (captured = r) }),
		);
		assert.strictEqual(captured!.ok, true);
		assert.deepStrictEqual(captured!.diagnostics, [DIAG]);
	});

	test('an engine THROW surfaces as ok:false with the structured error (No-Fallbacks)', () => {
		let captured: ValidateFormulaResultMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 'A1', reqId: 2 },
			makeDeps({
				validate: () => {
					throw new Error('[invalid_state] session not ready');
				},
				captureValidate: r => (captured = r),
			}),
		);
		assert.strictEqual(captured!.ok, false);
		assert.strictEqual(captured!.diagnostics, undefined);
		assert.ok((captured!.error ?? '').includes('invalid_state'));
	});

	test('a sheet mismatch is dropped (no reply)', () => {
		let called = false;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 9, row: 0, col: 0, text: 'A1', reqId: 3 },
			makeDeps({ captureValidate: () => (called = true) }),
		);
		assert.strictEqual(called, false);
	});

	test('an off-extent coordinate is dropped (no reply)', () => {
		let called = false;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: -1, col: 0, text: 'A1', reqId: 4 },
			makeDeps({ captureValidate: () => (called = true) }),
		);
		assert.strictEqual(called, false);
	});

	test('a non-string text is dropped (no reply)', () => {
		let called = false;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 42 as unknown as string, reqId: 5 },
			makeDeps({ captureValidate: () => (called = true) }),
		);
		assert.strictEqual(called, false);
	});

	test('an over-limit text returns ok:false WITHOUT calling the engine', () => {
		let engineCalled = false;
		let captured: ValidateFormulaResultMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 'x'.repeat(9000), reqId: 6 },
			makeDeps({
				validate: () => {
					engineCalled = true;
					return [];
				},
				captureValidate: r => (captured = r),
			}),
		);
		assert.strictEqual(engineCalled, false);
		assert.strictEqual(captured!.ok, false);
		assert.ok((captured!.error ?? '').includes('limit'));
	});

	test('a non-integer reqId is dropped', () => {
		let called = false;
		dispatchIncomingMessage(
			{ type: 'validateFormula', sheet: 0, row: 0, col: 0, text: 'A1', reqId: 1.5 },
			makeDeps({ captureValidate: () => (called = true) }),
		);
		assert.strictEqual(called, false);
	});
});

suite('W2 dispatcher -- listFunctions', () => {
	test('returns ok:true with the catalog, echoing reqId + webviewId', () => {
		let captured: FunctionListMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'listFunctions', reqId: 11, webviewId: 'wv-abc' },
			makeDeps({ list: () => [META], captureList: r => (captured = r) }),
		);
		assert.strictEqual(captured!.ok, true);
		assert.strictEqual(captured!.reqId, 11);
		assert.strictEqual(captured!.webviewId, 'wv-abc');
		assert.deepStrictEqual(captured!.functions, [META]);
	});

	test('an engine THROW surfaces as ok:false (No-Fallbacks -- no fabricated list)', () => {
		let captured: FunctionListMessage | undefined;
		dispatchIncomingMessage(
			{ type: 'listFunctions', reqId: 12 },
			makeDeps({
				list: () => {
					throw new Error('[invalid_state] closed');
				},
				captureList: r => (captured = r),
			}),
		);
		assert.strictEqual(captured!.ok, false);
		assert.strictEqual(captured!.functions, undefined);
		assert.ok((captured!.error ?? '').includes('invalid_state'));
	});

	test('a non-integer reqId is dropped', () => {
		let called = false;
		dispatchIncomingMessage(
			{ type: 'listFunctions', reqId: NaN },
			makeDeps({ captureList: () => (called = true) }),
		);
		assert.strictEqual(called, false);
	});
});
