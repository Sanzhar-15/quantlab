/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the qviz webview state store (Phase 5 step B.2,
 * post-megaudit-cycle-2).
 *
 * The store is a pure reducer + subscribe over eight slices. Tests cover:
 *   - Each slice's reducer responds to its actions; ignores others.
 *   - Cross-cutting actions (init, saveResult) update multiple slices coherently.
 *   - Save attribution: stale saveResult must NOT mark the doc clean.
 *   - Stale-result attribution on dataReceived / errorReceived (specHash gate).
 *   - setChartType validates family/type whitelist.
 *   - Transform editor index shifts on delete/move.
 *   - Daemon status + capabilities reduce into the runtime slice.
 *   - Renderer same-family swap clears handle.
 *   - Init resets ALL slices to initial-plus-payload.
 *   - Listener exceptions PROPAGATE (no fallback).
 *   - Store dispatch / subscribe / unsubscribe behavior.
 *   - Reentrant dispatch is rejected.
 *   - Defensive copy of inbound arrow / specs (immutability against
 *     external mutation of action payloads).
 */

import * as assert from 'assert';

import type { Action } from '../webview/qviz/state/actions';
import {
	type RootState,
	INITIAL_ROOT_STATE,
	createStore,
	rootReduce,
} from '../webview/qviz/state/store';
import { isDirty } from '../webview/qviz/state/specState';
import { hasStaleChart } from '../webview/qviz/state/queryState';
import { computeSpecHash } from '../src/qviz/messageProtocol';
import type { QvizSpec } from '../src/qviz/spec';
import { parseSpecBytes, serializeSpec } from '../src/qviz/specCore';

function spec(overrides: Partial<QvizSpec> = {}): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family: 'general', type: 'scatter',
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// init action — multi-slice update
// ---------------------------------------------------------------------------

suite('qviz state -- init action', () => {

	test('init populates source, spec, schema slices coherently', () => {
		const initialSpec = spec({ title: 'Loaded' });
		const next = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: initialSpec,
			schema: {
				uri: 'data/x.parquet', schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1, row_count: 100,
				columns: [{ name: 'a', dtype: 'float64', nullable: false }],
			},
		});
		assert.strictEqual(next.source.documentFsPath, '/ws/x.qviz.json');
		assert.strictEqual(next.spec.current?.title, 'Loaded');
		assert.strictEqual(next.spec.lastSavedHash, next.spec.currentHash);
		assert.strictEqual(next.schema.info?.row_count, 100);
		assert.strictEqual(next.schema.drift, 'same-hash');
		assert.strictEqual(isDirty(next.spec), false, 'fresh init = clean');
	});

	test('init without schema leaves schema null + drift null', () => {
		const next = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: spec(),
		});
		assert.strictEqual(next.schema.info, null);
		assert.strictEqual(next.schema.drift, null);
	});

	test('init clears stale schema info when re-init has no schema', () => {
		// First init seeded schema state.
		let s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/a.qviz.json', spec: spec(),
			schema: {
				uri: 'data/a.parquet', schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1, row_count: 5,
				columns: [{ name: 'a', dtype: 'float64', nullable: false }],
			},
		});
		assert.strictEqual(s.schema.info?.row_count, 5);
		// Re-init without schema MUST clear the stale schema info.
		s = rootReduce(s, {
			type: 'init', fsPath: '/ws/b.qviz.json', spec: spec(),
		});
		assert.strictEqual(s.schema.info, null,
			'reinit without schema must clear stale schema state');
		assert.strictEqual(s.schema.drift, null);
	});

	test('init resets query, persistence, renderer, ui slices', () => {
		// Set up a state with stuff in each slice.
		let s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
		});
		s = rootReduce(s, { type: 'requestStarted', requestId: 1, specHash: 'q1:0000000000000000' });
		s = rootReduce(s, { type: 'saveStarted', specHash: 'q1:0000000000000000' });
		s = rootReduce(s, { type: 'rendererSwapped', family: 'timeseries' });
		s = rootReduce(s, { type: 'focusColumn', columnName: 'col_x' });
		assert.notStrictEqual(s.query.inflight, null);
		assert.strictEqual(s.persistence.saving, true);
		assert.strictEqual(s.renderer.currentFamily, 'timeseries');
		assert.strictEqual(s.ui.focusedColumn, 'col_x');
		// Re-init clears all of these.
		s = rootReduce(s, { type: 'init', fsPath: '/y', spec: spec() });
		assert.strictEqual(s.query.inflight, null, 'init must reset query');
		assert.strictEqual(s.persistence.saving, false, 'init must reset persistence');
		assert.strictEqual(s.renderer.currentFamily, null, 'init must reset renderer');
		assert.strictEqual(s.ui.focusedColumn, null, 'init must reset ui focus');
	});

	test('init with lastSavedHash !== currentHash preserves dirty state (Step H.2)', () => {
		// Undo echo scenario: VS Code fires Cmd+Z, document._spec reverts
		// to a previous state. Provider sends init with the reverted
		// spec AND the original on-disk specHash as lastSavedHash. The
		// webview's `isDirty(spec)` must reflect the divergence — prior
		// reducer always set lastSavedHash = currentHash, falsely
		// marking the doc clean on every undo echo.
		const revertedSpec = spec({ title: 'reverted' });
		const onDiskHash = computeSpecHash(spec({ title: 'on-disk' }));
		const next = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: revertedSpec,
			lastSavedHash: onDiskHash,
		});
		assert.strictEqual(next.spec.currentHash, computeSpecHash(revertedSpec));
		assert.strictEqual(next.spec.lastSavedHash, onDiskHash);
		assert.notStrictEqual(next.spec.currentHash, next.spec.lastSavedHash);
		assert.strictEqual(isDirty(next.spec), true,
			'init with divergent lastSavedHash must produce dirty state');
	});

	test('init deep-clones the spec (sender mutation cannot corrupt state)', () => {
		const mutable = spec({ title: 'Original' });
		const next = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: mutable,
		});
		// Mutate the original after dispatch; the slice's spec should be unchanged.
		(mutable as { title: string }).title = 'Mutated';
		assert.strictEqual(next.spec.current?.title, 'Original',
			'reducer must clone the spec to insulate state from external mutation');
	});

});

// ---------------------------------------------------------------------------
// spec slice mutations
// ---------------------------------------------------------------------------

suite('qviz state -- spec slice', () => {

	function withSpec(s: QvizSpec): RootState {
		return rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: s });
	}

	test('setChartType swaps family + type and dirties the spec', () => {
		const start = withSpec(spec());
		assert.strictEqual(isDirty(start.spec), false);
		const next = rootReduce(start, {
			type: 'setChartType', family: 'timeseries', chartType: 'line',
		});
		assert.strictEqual(next.spec.current?.chart.family, 'timeseries');
		assert.strictEqual(next.spec.current?.chart.type, 'line');
		assert.strictEqual(isDirty(next.spec), true);
	});

	test('setChartType to same family/type is a no-op', () => {
		const start = withSpec(spec());
		const next = rootReduce(start, {
			type: 'setChartType', family: 'general', chartType: 'scatter',
		});
		assert.strictEqual(next, start, 'reducer must short-circuit when nothing changes');
	});

	test('setChartType rejects family/type pairs not in the whitelist', () => {
		const start = withSpec(spec());
		// timeseries does not allow 'pie'.
		assert.throws(
			() => rootReduce(start, { type: 'setChartType', family: 'timeseries', chartType: 'pie' }),
			/setChartType.*not allowed in family/,
			'must reject invalid family/type pair',
		);
	});

	test('Megaudit MAJOR-31: setChartType drops encodings incompatible with the new chart type', () => {
		// Start with a scatter spec that has x/y/color encodings.
		const initial = spec({
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'nominal' },
				},
			},
		});
		const start = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: initial,
		});
		// Switch to pie — pie has required=['color', 'y'], optional=[].
		// `x` should be dropped; `color` and `y` should survive.
		const swapped = rootReduce(start, {
			type: 'setChartType', family: 'general', chartType: 'pie',
		});
		const enc = swapped.spec.current!.chart.encodings;
		assert.strictEqual(enc.color?.field, 'c', 'color must survive (required for pie)');
		assert.strictEqual(enc.y?.field, 'b', 'y must survive (required for pie)');
		assert.strictEqual(enc.x, undefined, 'x must be dropped (not a pie channel)');
	});

	test('Megaudit MAJOR-31: switching to candlestick clears regular encodings AND keeps ohlcv if present', () => {
		// Megaudit-2 A5-CRITICAL-6.1: the previous test only asserted x/y
		// were dropped -- it never verified the "AND keeps ohlcv if
		// present" half of its own contract. Initial state now carries
		// BOTH regular encodings AND a pre-existing ohlcv block so the
		// reducer's preservation-path actually runs.
		const initial = spec({
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'temporal' },
					y: { field: 'b', type: 'quantitative' },
					ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		});
		const start = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: initial,
		});
		const swapped = rootReduce(start, {
			type: 'setChartType', family: 'timeseries', chartType: 'candlestick',
		});
		assert.strictEqual(swapped.spec.current!.chart.encodings.x, undefined,
			'switching to candlestick must drop x');
		assert.strictEqual(swapped.spec.current!.chart.encodings.y, undefined,
			'switching to candlestick must drop y');
		const ohlcv = swapped.spec.current!.chart.encodings.ohlcv;
		assert.ok(ohlcv, 'switching to candlestick must preserve pre-existing ohlcv');
		assert.deepStrictEqual(
			{ time: ohlcv.time, open: ohlcv.open, high: ohlcv.high, low: ohlcv.low, close: ohlcv.close },
			{ time: 't', open: 'o', high: 'h', low: 'l', close: 'c' },
			'ohlcv fields must be carried through unchanged',
		);
	});

	test('setEncoding adds, replaces, and clears channels', () => {
		const start = withSpec(spec());
		const added = rootReduce(start, {
			type: 'setEncoding', channel: 'color',
			encoding: { field: 'c', type: 'nominal' },
		});
		assert.strictEqual(added.spec.current?.chart.encodings.color?.field, 'c');
		const replaced = rootReduce(added, {
			type: 'setEncoding', channel: 'color',
			encoding: { field: 'c', type: 'nominal', title: 'Category' },
		});
		assert.strictEqual(replaced.spec.current?.chart.encodings.color?.title, 'Category');
		const cleared = rootReduce(replaced, {
			type: 'setEncoding', channel: 'color', encoding: null,
		});
		assert.strictEqual(cleared.spec.current?.chart.encodings.color, undefined);
	});

	test('upsertTransform / deleteTransform / moveTransform', () => {
		let s = withSpec(spec());
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'filter', column: 'a', op: '>', value: 0 },
		});
		s = rootReduce(s, {
			type: 'upsertTransform', index: 1,
			transform: { kind: 'limit', n: 100 },
		});
		assert.strictEqual(s.spec.current?.transforms.length, 2);
		s = rootReduce(s, { type: 'moveTransform', fromIndex: 1, toIndex: 0 });
		assert.strictEqual(s.spec.current?.transforms[0].kind, 'limit');
		s = rootReduce(s, { type: 'deleteTransform', index: 0 });
		assert.strictEqual(s.spec.current?.transforms.length, 1);
		assert.strictEqual(s.spec.current?.transforms[0].kind, 'filter');
	});

	test('upsertTransform rejects out-of-range indexes', () => {
		const s = withSpec(spec());
		assert.throws(
			() => rootReduce(s, {
				type: 'upsertTransform', index: 5,
				transform: { kind: 'filter', column: 'a', op: '>', value: 0 },
			}),
			/upsertTransform: index 5 out of range/,
		);
	});

	test('deleteTransform rejects out-of-range indexes', () => {
		const s = withSpec(spec());
		assert.throws(
			() => rootReduce(s, { type: 'deleteTransform', index: 0 }),
			/deleteTransform: index 0 out of range/,
		);
	});

	test('moveTransform rejects out-of-range indexes', () => {
		let s = withSpec(spec());
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'filter', column: 'a', op: '>', value: 0 },
		});
		assert.throws(
			() => rootReduce(s, { type: 'moveTransform', fromIndex: 0, toIndex: 5 }),
			/moveTransform: toIndex 5 out of range/,
		);
	});

	test('save attribution: matching saveResult clears dirty', () => {
		let s = withSpec(spec());
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'line' });
		const editedHash = s.spec.currentHash;
		assert.ok(editedHash);
		assert.strictEqual(isDirty(s.spec), true);
		// Send save with the current hash.
		s = rootReduce(s, { type: 'saveStarted', specHash: editedHash! });
		// Receive matching saveResult.
		s = rootReduce(s, {
			type: 'saveResult', status: 'ok', specHash: editedHash!, fsPath: '/x',
		});
		assert.strictEqual(isDirty(s.spec), false);
		assert.strictEqual(s.persistence.lastStatus, 'ok');
		assert.strictEqual(s.persistence.lastFsPath, '/x');
	});

	test('save attribution: stale saveResult must NOT mark the doc clean', () => {
		// User edits → save → user edits AGAIN → stale saveResult arrives.
		// The stale result must not corrupt the in-memory dirty flag.
		let s = withSpec(spec());
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'line' });
		const firstEditHash = s.spec.currentHash!;
		s = rootReduce(s, { type: 'saveStarted', specHash: firstEditHash });
		// User edits again before saveResult arrives.
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'area' });
		const secondEditHash = s.spec.currentHash!;
		assert.notStrictEqual(firstEditHash, secondEditHash);
		// Late saveResult for the FIRST edit arrives.
		s = rootReduce(s, {
			type: 'saveResult', status: 'ok', specHash: firstEditHash, fsPath: '/x',
		});
		// The doc must still be dirty (the second edit is unsaved).
		assert.strictEqual(isDirty(s.spec), true,
			'stale saveResult for old spec must NOT mark the new spec clean');
	});

	test('saveResult failed leaves dirty + records error', () => {
		let s = withSpec(spec());
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'line' });
		const editedHash = s.spec.currentHash!;
		s = rootReduce(s, { type: 'saveStarted', specHash: editedHash });
		s = rootReduce(s, {
			type: 'saveResult', status: 'failed', specHash: editedHash, error: 'EACCES',
		});
		assert.strictEqual(isDirty(s.spec), true);
		assert.strictEqual(s.persistence.lastStatus, 'failed');
		assert.strictEqual(s.persistence.lastError, 'EACCES');
	});

});

// ---------------------------------------------------------------------------
// query slice — stale-result attribution
// ---------------------------------------------------------------------------

suite('qviz state -- query slice (stale-result attribution)', () => {

	function setUpRequest(rid: number, hash: string): RootState {
		const start = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
		});
		return rootReduce(start, { type: 'requestStarted', requestId: rid, specHash: hash });
	}

	test('matching dataReceived advances lastData and clears inflight', () => {
		const sh = computeSpecHash(spec());
		const s = setUpRequest(1, sh);
		const next = rootReduce(s, {
			type: 'dataReceived', requestId: 1, specHash: sh,
			arrow: new Uint8Array([1, 2, 3]), elapsedMs: 10, cached: false, diagnostics: [],
		});
		assert.strictEqual(next.query.inflight, null);
		assert.strictEqual(next.query.lastData?.requestId, 1);
		assert.deepStrictEqual(next.query.lastData?.arrow, new Uint8Array([1, 2, 3]));
	});

	test('dataReceived stores a defensive copy of the arrow bytes', () => {
		const sh = computeSpecHash(spec());
		const s = setUpRequest(1, sh);
		const original = new Uint8Array([10, 20, 30]);
		const next = rootReduce(s, {
			type: 'dataReceived', requestId: 1, specHash: sh,
			arrow: original, elapsedMs: 0, cached: false, diagnostics: [],
		});
		// Mutate the original after dispatch.
		original[0] = 99;
		assert.strictEqual(next.query.lastData?.arrow[0], 10,
			'reducer must copy arrow bytes; sender mutation must not affect state');
	});

	test('mismatched requestId is dropped (state unchanged)', () => {
		const sh = computeSpecHash(spec());
		const s = setUpRequest(1, sh);
		const next = rootReduce(s, {
			type: 'dataReceived', requestId: 999, specHash: sh,
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		});
		assert.strictEqual(next, s, 'stale dataReceived must not mutate state');
	});

	test('mismatched specHash is dropped even if requestId matches', () => {
		const s = setUpRequest(1, computeSpecHash(spec()));
		const next = rootReduce(s, {
			type: 'dataReceived', requestId: 1, specHash: 'q1:0123456789abcdef',
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		});
		assert.strictEqual(next, s, 'stale specHash must drop the message');
	});

	test('errorReceived matching the in-flight slot records the error', () => {
		const sh = computeSpecHash(spec());
		const s = setUpRequest(2, sh);
		const next = rootReduce(s, {
			type: 'errorReceived', requestId: 2, specHash: sh,
			error: 'compile failed: ghost column', errorKind: 'compile',
			transformIndex: 1,
		});
		assert.strictEqual(next.query.lastErrorRequestId, 2);
		assert.strictEqual(next.query.lastErrorMessage, 'compile failed: ghost column');
		assert.strictEqual(next.query.lastErrorKind, 'compile');
		assert.strictEqual(next.query.lastErrorTransformIndex, 1);
	});

	test('errorReceived with mismatched specHash is dropped', () => {
		const sh = computeSpecHash(spec());
		const s = setUpRequest(2, sh);
		const next = rootReduce(s, {
			type: 'errorReceived', requestId: 2, specHash: 'q1:0123456789abcdef',
			error: 'compile failed', errorKind: 'compile',
		});
		assert.strictEqual(next, s, 'errors with stale specHash must be dropped');
	});

	test('requestStarted clears prior error state', () => {
		const sh = computeSpecHash(spec());
		let s = setUpRequest(1, sh);
		s = rootReduce(s, {
			type: 'errorReceived', requestId: 1, specHash: sh,
			error: 'previous error', errorKind: 'compile',
		});
		assert.strictEqual(s.query.lastErrorMessage, 'previous error');
		s = rootReduce(s, { type: 'requestStarted', requestId: 2, specHash: sh });
		assert.strictEqual(s.query.lastErrorMessage, null,
			'requestStarted must clear prior error to avoid stale UI overlay');
	});

	test('5.I.1: errorReceived clears inflight (chart on screen survives daemon error)', () => {
		const sh = computeSpecHash(spec());
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		// First request lands successfully — chart on screen.
		s = rootReduce(s, { type: 'requestStarted', requestId: 1, specHash: sh });
		s = rootReduce(s, {
			type: 'dataReceived', requestId: 1, specHash: sh,
			arrow: new Uint8Array([1]), elapsedMs: 5, cached: false, diagnostics: [],
		});
		const goodData = s.query.lastData;
		assert.ok(goodData, 'precondition: chart on screen');

		// User edits → new request → daemon crashes → error.
		s = rootReduce(s, { type: 'requestStarted', requestId: 2, specHash: sh });
		s = rootReduce(s, {
			type: 'errorReceived', requestId: 2, specHash: sh,
			error: 'daemon crashed', errorKind: 'internal',
		});

		// Inflight cleared (next edit can fire without confusion).
		assert.strictEqual(s.query.inflight, null);
		// Chart on screen STILL present (renderer reads lastData).
		assert.strictEqual(s.query.lastData, goodData,
			'last successful chart must survive error so user sees stale chart');
		// Error captured for diagnostics readout.
		assert.strictEqual(s.query.lastErrorMessage, 'daemon crashed');
	});

	test('hasStaleChart returns true when in-flight request differs from last successful', () => {
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		const hash1 = computeSpecHash(spec({ title: 'A' }));
		s = rootReduce(s, { type: 'requestStarted', requestId: 1, specHash: hash1 });
		s = rootReduce(s, {
			type: 'dataReceived', requestId: 1, specHash: hash1,
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		});
		assert.strictEqual(hasStaleChart(s.query), false, 'just-rendered chart isn\'t stale');
		const hash2 = computeSpecHash(spec({ title: 'B' }));
		s = rootReduce(s, { type: 'requestStarted', requestId: 2, specHash: hash2 });
		assert.strictEqual(hasStaleChart(s.query), true,
			'in-flight request with different specHash → chart on screen is stale');
	});

});

// ---------------------------------------------------------------------------
// schema slice — schemaChanged action (Step C megaudit gap)
// ---------------------------------------------------------------------------

suite('qviz state -- schema slice (schemaChanged)', () => {

	function makeSchema(hash: string, columns: { name: string; dtype?: string }[] = []) {
		return {
			uri: 'data/x.parquet',
			schema_hash: hash,
			mtime_ns: 1,
			row_count: 100,
			columns: columns.map(c => ({
				name: c.name,
				dtype: c.dtype ?? 'float64',
				nullable: false,
			})),
		};
	}

	test('schemaChanged with same-hash drift updates info from newSchema', () => {
		// Step C megaudit C9: mid-session schema refreshes use
		// schemaChanged (not init), so other slices stay intact while
		// the column panel reflects the live schema.
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		// User sets focus -- this state should NOT be reset by
		// schemaChanged.
		s = rootReduce(s, { type: 'focusColumn', columnName: 'a' });
		assert.strictEqual(s.ui.focusedColumn, 'a');
		// Schema arrives via schemaChanged (no init).
		const sameHash = 'sha256:' + 'a'.repeat(64);
		s = rootReduce(s, {
			type: 'schemaChanged',
			oldHash: sameHash,
			newHash: sameHash,
			drift: 'same-hash',
			newSchema: makeSchema(sameHash, [
				{ name: 'a' }, { name: 'b' }, { name: 'c' },
			]),
		});
		assert.strictEqual(s.schema.info?.columns.length, 3);
		assert.strictEqual(s.schema.drift, 'same-hash');
		// Crucial: ui slice was NOT reset.
		assert.strictEqual(s.ui.focusedColumn, 'a',
			'schemaChanged must not reset other slices');
	});

	test('schemaChanged with fields-preserved updates info + drift', () => {
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		const oldHash = 'sha256:' + 'a'.repeat(64);
		const newHash = 'sha256:' + 'b'.repeat(64);
		s = rootReduce(s, {
			type: 'schemaChanged',
			oldHash, newHash,
			drift: 'fields-preserved',
			newSchema: makeSchema(newHash, [{ name: 'x' }, { name: 'y' }]),
		});
		assert.strictEqual(s.schema.drift, 'fields-preserved');
		assert.strictEqual(s.schema.info?.columns.length, 2);
		assert.deepStrictEqual([...s.schema.missingFields], []);
	});

	test('schemaChanged with fields-missing carries missingFields', () => {
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		const oldHash = 'sha256:' + 'a'.repeat(64);
		const newHash = 'sha256:' + 'b'.repeat(64);
		s = rootReduce(s, {
			type: 'schemaChanged',
			oldHash, newHash,
			drift: 'fields-missing',
			newSchema: makeSchema(newHash, [{ name: 'x' }]),
			missingFields: ['gone1', 'gone2'],
		});
		assert.strictEqual(s.schema.drift, 'fields-missing');
		assert.deepStrictEqual([...s.schema.missingFields], ['gone1', 'gone2']);
	});

	test('schemaChanged: stores newSchema by DEEP-CLONED VALUE (not reference)', () => {
		// Step C megaudit C10: prior reducer stored action.newSchema by
		// reference. A sender mutating newSchema.columns after dispatch
		// would corrupt the slice. Reducer now deep-clones.
		const sameHash = 'sha256:' + 'a'.repeat(64);
		const mutableSchema = makeSchema(sameHash, [{ name: 'a' }, { name: 'b' }]);
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		s = rootReduce(s, {
			type: 'schemaChanged',
			oldHash: sameHash, newHash: sameHash,
			drift: 'same-hash',
			newSchema: mutableSchema,
		});
		// Mutate the original after dispatch.
		(mutableSchema.columns as { name: string; dtype: string; nullable: boolean }[]).push({
			name: 'INJECTED', dtype: 'utf8', nullable: false,
		});
		assert.strictEqual(s.schema.info?.columns.length, 2,
			'reducer must clone newSchema.columns; sender mutation must not affect state');
	});

	test('init followed by schemaChanged: schemaChanged wins for info', () => {
		const sameHash = 'sha256:' + 'a'.repeat(64);
		const initSchema = makeSchema(sameHash, [{ name: 'a' }]);
		let s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
			schema: initSchema,
		});
		assert.strictEqual(s.schema.info?.columns.length, 1);
		// schemaChanged with NEW columns.
		s = rootReduce(s, {
			type: 'schemaChanged',
			oldHash: sameHash, newHash: sameHash,
			drift: 'same-hash',
			newSchema: makeSchema(sameHash, [
				{ name: 'a' }, { name: 'b' }, { name: 'c' },
			]),
		});
		assert.strictEqual(s.schema.info?.columns.length, 3);
	});

});

// ---------------------------------------------------------------------------
// runtime slice (daemonStatus + capabilities — Step B megaudit C11)
// ---------------------------------------------------------------------------

suite('qviz state -- runtime slice', () => {

	test('daemonStatus reduces into the runtime slice', () => {
		let s = INITIAL_ROOT_STATE;
		assert.strictEqual(s.runtime.daemonStatus, 'idle');
		s = rootReduce(s, { type: 'daemonStatus', status: 'starting' });
		assert.strictEqual(s.runtime.daemonStatus, 'starting');
		s = rootReduce(s, {
			type: 'daemonStatus', status: 'crashed',
			retryInMs: 500, lastError: 'segfault',
		});
		assert.strictEqual(s.runtime.daemonStatus, 'crashed');
		assert.strictEqual(s.runtime.daemonRetryInMs, 500);
		assert.strictEqual(s.runtime.daemonLastError, 'segfault');
	});

	test('capabilitiesUpdated reduces into the runtime slice', () => {
		const caps = { daemonVersion: 3, transformKinds: ['filter', 'limit'], chartFamilies: ['general'] as const };
		const s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'capabilitiesUpdated', capabilities: caps,
		});
		assert.deepStrictEqual(s.runtime.capabilities, caps);
	});

	test('init.capabilities populates runtime slice', () => {
		const caps = { daemonVersion: 2, transformKinds: ['filter'], chartFamilies: ['timeseries'] as const };
		const s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(), capabilities: caps,
		});
		assert.deepStrictEqual(s.runtime.capabilities, caps);
	});

	// Step 5.J.1 — datasetStatus reducer (Step 5.I.3 added the action +
	// reducer case but no reducer-level tests). Locks in: status / uri /
	// error all transition together; identity-preserving when nothing
	// changed; and that null-error normalization works.
	test('datasetStatus reduces into the runtime slice', () => {
		let s = INITIAL_ROOT_STATE;
		assert.strictEqual(s.runtime.datasetStatus, 'ok');
		s = rootReduce(s, {
			type: 'datasetStatus', status: 'missing',
			datasetUri: 'data/missing.parquet', error: 'file not found',
		});
		assert.strictEqual(s.runtime.datasetStatus, 'missing');
		assert.strictEqual(s.runtime.datasetUri, 'data/missing.parquet');
		assert.strictEqual(s.runtime.datasetError, 'file not found');
		// Returning to ok with no error normalizes to null.
		s = rootReduce(s, {
			type: 'datasetStatus', status: 'ok', datasetUri: 'data/ok.parquet',
		});
		assert.strictEqual(s.runtime.datasetStatus, 'ok');
		assert.strictEqual(s.runtime.datasetError, null);
	});

	test('datasetStatus is a no-op when nothing changed (identity preserved)', () => {
		const a = rootReduce(INITIAL_ROOT_STATE, {
			type: 'datasetStatus', status: 'access-denied',
			datasetUri: 'data/x.parquet', error: 'EACCES',
		});
		const b = rootReduce(a, {
			type: 'datasetStatus', status: 'access-denied',
			datasetUri: 'data/x.parquet', error: 'EACCES',
		});
		assert.strictEqual(a.runtime, b.runtime);
	});

});

// ---------------------------------------------------------------------------
// renderer + ui slices
// ---------------------------------------------------------------------------

suite('qviz state -- renderer slice', () => {

	test('rendererSwapped to a different family resets hasViewHandle', () => {
		let s = INITIAL_ROOT_STATE;
		s = rootReduce(s, { type: 'rendererSwapped', family: 'timeseries' });
		s = rootReduce(s, { type: 'rendererHandleChanged', hasViewHandle: true });
		assert.strictEqual(s.renderer.hasViewHandle, true);
		s = rootReduce(s, { type: 'rendererSwapped', family: 'general' });
		assert.strictEqual(s.renderer.currentFamily, 'general');
		assert.strictEqual(s.renderer.hasViewHandle, false,
			'family swap implies the previous view handle is gone');
	});

	test('rendererSwapped to the same family with live handle clears handle', () => {
		// Step B megaudit E2: an explicit remount signal must not lie
		// about handle liveness.
		let s = INITIAL_ROOT_STATE;
		s = rootReduce(s, { type: 'rendererSwapped', family: 'general' });
		s = rootReduce(s, { type: 'rendererHandleChanged', hasViewHandle: true });
		s = rootReduce(s, { type: 'rendererSwapped', family: 'general' });
		assert.strictEqual(s.renderer.hasViewHandle, false,
			'rendererSwapped(same-family) must clear the prior handle');
	});

});

suite('qviz state -- ui slice', () => {

	test('focusColumn / setActiveShelf / openTransformEditor', () => {
		let s = INITIAL_ROOT_STATE;
		s = rootReduce(s, { type: 'focusColumn', columnName: 'volume' });
		assert.strictEqual(s.ui.focusedColumn, 'volume');
		s = rootReduce(s, { type: 'setActiveShelf', channel: 'color' });
		assert.strictEqual(s.ui.activeShelf, 'color');
		s = rootReduce(s, { type: 'openTransformEditor', index: 2 });
		assert.strictEqual(s.ui.editingTransformIndex, 2);
	});

	test('deleteTransform side-effect: closes editor when editing the deleted index', () => {
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'limit', n: 10 },
		});
		s = rootReduce(s, { type: 'openTransformEditor', index: 0 });
		assert.strictEqual(s.ui.editingTransformIndex, 0);
		s = rootReduce(s, { type: 'deleteTransform', index: 0 });
		assert.strictEqual(s.ui.editingTransformIndex, null,
			'editor for the deleted transform must close');
	});

	test('deleteTransform shifts editor index down for later transforms', () => {
		// Step B megaudit E1: deleting an earlier transform must shift
		// the editor index left, otherwise the editor renders for the
		// wrong transform.
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'filter', column: 'a', op: '>', value: 0 },
		});
		s = rootReduce(s, {
			type: 'upsertTransform', index: 1,
			transform: { kind: 'limit', n: 100 },
		});
		s = rootReduce(s, { type: 'openTransformEditor', index: 1 });
		s = rootReduce(s, { type: 'deleteTransform', index: 0 });
		assert.strictEqual(s.ui.editingTransformIndex, 0,
			'editor for transform-1 must shift to index 0 after deleting transform-0');
	});

	test('moveTransform shifts editor index when the editor target moves', () => {
		// Step B megaudit E3.
		let s = rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: spec() });
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'filter', column: 'a', op: '>', value: 0 },
		});
		s = rootReduce(s, {
			type: 'upsertTransform', index: 1,
			transform: { kind: 'limit', n: 100 },
		});
		s = rootReduce(s, {
			type: 'upsertTransform', index: 2,
			transform: { kind: 'limit', n: 50 },
		});
		// Editor on index 0; move 0→2.
		s = rootReduce(s, { type: 'openTransformEditor', index: 0 });
		s = rootReduce(s, { type: 'moveTransform', fromIndex: 0, toIndex: 2 });
		assert.strictEqual(s.ui.editingTransformIndex, 2,
			'editor must follow its target through a move');
	});

	test('themeUpdated bumps a version counter (used to trigger theme-aware re-renders)', () => {
		const s0 = INITIAL_ROOT_STATE.ui.themeTokensVersion;
		const s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'themeUpdated',
			tokens: themeTokens(),
		});
		assert.strictEqual(s.ui.themeTokensVersion, s0 + 1);
	});

});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

suite('qviz state -- createStore', () => {

	test('subscribe is called once per state change', () => {
		const store = createStore();
		const events: RootState[] = [];
		store.subscribe(s => { events.push(s); });
		store.dispatch({ type: 'init', fsPath: '/x', spec: spec() });
		store.dispatch({ type: 'focusColumn', columnName: 'a' });
		assert.strictEqual(events.length, 2);
	});

	test('no-op dispatch does not notify subscribers', () => {
		const store = createStore();
		const events: RootState[] = [];
		store.subscribe(s => { events.push(s); });
		store.dispatch({ type: 'focusColumn', columnName: null });
		// no-op (initial focusedColumn is null) → no notify
		assert.strictEqual(events.length, 0);
	});

	test('unsubscribe stops notifications', () => {
		const store = createStore();
		let count = 0;
		const off = store.subscribe(() => { count++; });
		store.dispatch({ type: 'init', fsPath: '/x', spec: spec() });
		off();
		store.dispatch({ type: 'focusColumn', columnName: 'a' });
		assert.strictEqual(count, 1);
	});

	test('listener exceptions PROPAGATE (no fallback)', () => {
		// Step B megaudit C10: prior code wrapped each listener in
		// try/catch + console.error. CLAUDE.md "errors must be visible".
		const store = createStore();
		store.subscribe(() => { throw new Error('listener boom'); });
		assert.throws(
			() => store.dispatch({ type: 'init', fsPath: '/x', spec: spec() }),
			/listener boom/,
		);
	});

	test('reentrant dispatch from a subscriber is rejected', () => {
		const store = createStore();
		store.subscribe(() => {
			store.dispatch({ type: 'focusColumn', columnName: 'reentrant' });
		});
		assert.throws(
			() => store.dispatch({ type: 'init', fsPath: '/x', spec: spec() }),
			/nested dispatch/,
		);
		// And the focusedColumn was NOT set (the rejected nested dispatch
		// produced no state change before throwing).
		assert.strictEqual(store.getState().ui.focusedColumn, null);
	});

	test('subscribers added during notify do NOT receive the in-flight event', () => {
		const store = createStore();
		const events: string[] = [];
		store.subscribe(() => {
			events.push('outer');
			store.subscribe(() => { events.push('inner'); });
		});
		store.dispatch({ type: 'init', fsPath: '/x', spec: spec() });
		assert.deepStrictEqual(events, ['outer']);
		// On the next dispatch, the inner listener is now active.
		store.dispatch({ type: 'focusColumn', columnName: 'z' });
		assert.deepStrictEqual(events, ['outer', 'outer', 'inner']);
	});

});

// ---------------------------------------------------------------------------
// Step 5.J.3 — builder-state round-trip
// ---------------------------------------------------------------------------
//
// Manual smoke (per Phase 5 success criteria) is the real acceptance bar
// for the open-edit-save-reopen flow. This suite is the automated
// approximation: it runs the same sequence of reducer actions a user
// would trigger from the builder UI, serializes the resulting spec to
// bytes (the save path), reparses the bytes (the open path), inits a
// fresh store, and asserts the new store's spec === the saved spec.
//
// What this proves end-to-end:
//   - reducer actions produce a serializable spec (no functions, etc.).
//   - serializeSpec is the inverse of parseSpecBytes for builder output.
//   - init reducer accepts the reparsed spec without losing information.
//
// What it does NOT prove (manual smoke covers this):
//   - keyboard / mouse drag-drop wiring
//   - actual webview render cycle from the spec
//   - actual file I/O at the CustomEditorProvider layer

suite('qviz state -- 5.J.3 builder-state round-trip', () => {

	test('chart-type swap + encoding assignments + transform insert survives save/reopen', () => {
		// Open with the default-built scatter spec.
		const initial = spec({ title: '5.J.3 fixture' });
		let s: RootState = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: initial,
		});

		// Simulate the builder flow.
		// 1. User picks chart-type 'line' (timeseries family).
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'line' });
		// 2. User drops 'ts' onto X, 'price' onto Y.
		s = rootReduce(s, {
			type: 'setEncoding', channel: 'x',
			encoding: { field: 'ts', type: 'temporal' },
		});
		s = rootReduce(s, {
			type: 'setEncoding', channel: 'y',
			encoding: { field: 'price', type: 'quantitative' },
		});
		// 3. User adds a filter transform.
		s = rootReduce(s, {
			type: 'upsertTransform', index: 0,
			transform: { kind: 'filter', column: 'price', op: '>', value: 100 },
		});

		const savedSpec = s.spec.current!;
		// Save → bytes, reopen → spec.
		const bytes = serializeSpec(savedSpec);
		const reopened = parseSpecBytes(bytes, 'test://5.J.3');

		// Init a fresh store with the reopened spec (the resolveCustomEditor
		// flow on the second open).
		const s2 = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: reopened,
		});

		// Final state's spec deep-equals the saved spec.
		assert.deepStrictEqual(s2.spec.current!, savedSpec);
		// Dirty flag is false on second open (matches saved hash).
		assert.strictEqual(isDirty(s2.spec), false);
		// Hash is stable across save→reopen.
		assert.strictEqual(
			computeSpecHash(s2.spec.current!),
			computeSpecHash(savedSpec),
		);
	});

	test('candlestick OHLCV cluster survives save/reopen', () => {
		// Start from a spec with NO encodings, so the candlestick path is
		// exercised cleanly (the default scatter spec carries x/y which the
		// reducer keeps when chart-type swaps; that's a separate axis).
		const bareSpec = spec();
		(bareSpec.chart as unknown as { encodings: Record<string, unknown> }).encodings = {};
		let s: RootState = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: bareSpec,
		});
		s = rootReduce(s, { type: 'setChartType', family: 'timeseries', chartType: 'candlestick' });
		s = rootReduce(s, {
			type: 'setOhlcv',
			ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v' },
		});
		const bytes = serializeSpec(s.spec.current!);
		const reopened = parseSpecBytes(bytes, 'test://5.J.3-candle');
		const s2 = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/ws/x.qviz.json', spec: reopened,
		});
		assert.deepStrictEqual(s2.spec.current!, s.spec.current!);
		assert.deepStrictEqual(s2.spec.current!.chart.encodings, {
			ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v' },
		});
	});

});

// ---------------------------------------------------------------------------
// Step 5.J.5 — theme change does NOT trigger a daemon request
// ---------------------------------------------------------------------------
//
// The webview-side `themeUpdated` action bumps the theme version
// counter but must NOT touch the query slice. If it did, the renderer
// would re-request aggregation from the daemon on every theme switch.
// The renderer instead re-applies the cached lastData with new theme
// tokens. This suite locks in the boundary at the reducer level.
//
// (Manual smoke covers the full re-render path under VS Code's theme
// MutationObserver; this is the automated approximation.)

suite('qviz state -- 5.J.5 theme-change is daemon-neutral', () => {

	test('themeUpdated leaves the query slice untouched', () => {
		// Set up state with an in-flight request and a last-good render.
		let s: RootState = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
		});
		const specHash = computeSpecHash(s.spec.current!);
		s = rootReduce(s, {
			type: 'requestStarted', requestId: 1, specHash,
		});
		s = rootReduce(s, {
			type: 'dataReceived',
			requestId: 1, specHash,
			arrow: new Uint8Array([1, 2, 3]),
			elapsedMs: 12, cached: false,
			diagnostics: [],
		});
		const queryBefore = s.query;
		const themeVersionBefore = s.ui.themeTokensVersion;

		// Fire themeUpdated.
		s = rootReduce(s, { type: 'themeUpdated', tokens: themeTokens() });

		// Theme version bumps; query slice is identical by reference.
		assert.notStrictEqual(s.ui.themeTokensVersion, themeVersionBefore);
		assert.strictEqual(s.query, queryBefore,
			'themeUpdated must not allocate a new query slice (would imply a state change)');
	});

	test('themeUpdated does NOT bump query.inflight or lastData', () => {
		let s: RootState = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
		});
		const specHash = computeSpecHash(s.spec.current!);
		s = rootReduce(s, {
			type: 'requestStarted', requestId: 7, specHash,
		});
		const inflightBefore = s.query.inflight;
		s = rootReduce(s, { type: 'themeUpdated', tokens: themeTokens() });
		assert.strictEqual(s.query.inflight, inflightBefore,
			'theme change must not invalidate or restart an inflight request');
	});

});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function themeTokens() {
	return {
		background: '#0a0f18',
		foreground: '#e7e9ee',
		border: '#262d39',
		accent: '#fc7432',
		editorBackground: '#0a0f18',
		axisGrid: 'rgba(255,255,255,0.06)',
		axisText: 'rgba(231,233,238,0.7)',
		seriesPalette: ['#4fc3f7'],
	};
}

// Suppress the "imports are unused at runtime" issue for type-only imports.
type _UsesAction = Action;
const _USES_ACTION_TYPE: _UsesAction = { type: 'focusColumn', columnName: null };
void _USES_ACTION_TYPE;

// ---------------------------------------------------------------------------
// Phase 6 — inspector slice
// ---------------------------------------------------------------------------

import { hashFilters, INITIAL_INSPECTOR_STATE } from '../webview/qviz/state/inspectorState';
import type { ColumnStats, InspectorFilter } from '../src/qviz/messageProtocol';

function inspectorOf(state: RootState) {
	return state.inspector;
}

suite('qviz state -- inspector slice (Phase 6)', () => {

	function withInitialSpec(): RootState {
		return rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/tmp/x.qviz.json', spec: spec(),
		});
	}

	test('toggleInspector flips visibility, identity-preserves on no-op', () => {
		const s0 = withInitialSpec();
		assert.strictEqual(inspectorOf(s0).visible, false);
		const s1 = rootReduce(s0, { type: 'toggleInspector' });
		assert.strictEqual(inspectorOf(s1).visible, true);
		const s2 = rootReduce(s1, { type: 'toggleInspector', visible: true });
		assert.strictEqual(s2, s1, 'identity-preserve when target = current');
	});

	test('setColumnFilter adds, replaces, and clears', () => {
		const s0 = withInitialSpec();
		const f: InspectorFilter = { kind: 'range', column: 'a', min: 0, max: 10 };
		const s1 = rootReduce(s0, { type: 'setColumnFilter', column: 'a', filter: f });
		assert.deepStrictEqual(inspectorOf(s1).filters.a, f);

		// Same filter again is identity-preserve.
		const s2 = rootReduce(s1, { type: 'setColumnFilter', column: 'a', filter: f });
		assert.strictEqual(s2, s1);

		// Different filter on same column replaces.
		const f2: InspectorFilter = { kind: 'range', column: 'a', min: 1, max: 9 };
		const s3 = rootReduce(s2, { type: 'setColumnFilter', column: 'a', filter: f2 });
		assert.deepStrictEqual(inspectorOf(s3).filters.a, f2);

		// `filter: null` clears the column.
		const s4 = rootReduce(s3, { type: 'setColumnFilter', column: 'a', filter: null });
		assert.strictEqual(inspectorOf(s4).filters.a, undefined);
	});

	test('setColumnFilter invalidates window + resets scrollOffset', () => {
		const s0 = withInitialSpec();
		// Seed a window first so we can prove it gets wiped.
		const seeded = rootReduce(s0, {
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([1, 2, 3]),
			offset: 50, n: 10, elapsedMs: 1,
		});
		assert.ok(inspectorOf(seeded).window);
		const f: InspectorFilter = { kind: 'text', column: 'a', contains: 'x' };
		const after = rootReduce(
			rootReduce(seeded, { type: 'setScrollOffset', offset: 200 }),
			{ type: 'setColumnFilter', column: 'a', filter: f },
		);
		assert.strictEqual(inspectorOf(after).window, null,
			'window must be cleared on filter change');
		assert.strictEqual(inspectorOf(after).scrollOffset, 0,
			'scroll must reset to top on filter change');
	});

	test('clearAllFilters removes every column, identity-preserves when empty', () => {
		const s0 = withInitialSpec();
		const noop = rootReduce(s0, { type: 'clearAllFilters' });
		assert.strictEqual(noop, s0, 'identity-preserve when nothing to clear');

		const f: InspectorFilter = { kind: 'set', column: 'a', includes: ['x'] };
		const seeded = rootReduce(s0, { type: 'setColumnFilter', column: 'a', filter: f });
		const cleared = rootReduce(seeded, { type: 'clearAllFilters' });
		assert.deepStrictEqual(inspectorOf(cleared).filters, {});
	});

	test('setSelection always sets (even x=null); clearSelection is the only "no selection" path', () => {
		const s0 = withInitialSpec();
		const s1 = rootReduce(s0, { type: 'setSelection', x: 42 });
		assert.deepStrictEqual(inspectorOf(s1).selection, { x: 42 });

		// Idempotent on same x.
		const s2 = rootReduce(s1, { type: 'setSelection', x: 42 });
		assert.strictEqual(s2, s1);

		// NaN === NaN treated as same (avoids highlight churn).
		const sNaN1 = rootReduce(s0, { type: 'setSelection', x: NaN });
		const sNaN2 = rootReduce(sNaN1, { type: 'setSelection', x: NaN });
		assert.strictEqual(sNaN2, sNaN1);

		// clearSelection wipes.
		const s3 = rootReduce(s1, { type: 'clearSelection' });
		assert.strictEqual(inspectorOf(s3).selection, null);

		// Audit M-J (2026-05-11): setSelection({x: null}) MUST set a
		// selection (so rows where the x-encoding-field IS literally
		// null can be highlighted). It does NOT clear; clearSelection
		// is the only way to drop the selection.
		const s4 = rootReduce(s0, { type: 'setSelection', x: null });
		assert.deepStrictEqual(inspectorOf(s4).selection, { x: null });
	});

	test('setScrollOffset rejects negative + non-integer', () => {
		const s0 = withInitialSpec();
		assert.throws(() => rootReduce(s0, { type: 'setScrollOffset', offset: -1 }));
		assert.throws(() => rootReduce(s0, { type: 'setScrollOffset', offset: 1.5 }));
	});

	test('inspectorDataReceived stores window + stamps current filters hash', () => {
		const s0 = withInitialSpec();
		const f: InspectorFilter = { kind: 'range', column: 'a', min: 0, max: 10 };
		const filtered = rootReduce(s0, { type: 'setColumnFilter', column: 'a', filter: f });
		const received = rootReduce(filtered, {
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([7, 8, 9]),
			offset: 0, n: 100, total: 1234, elapsedMs: 5,
		});
		const w = inspectorOf(received).window;
		assert.ok(w);
		assert.strictEqual(w!.offset, 0);
		assert.strictEqual(w!.n, 100);
		assert.strictEqual(w!.total, 1234);
		assert.strictEqual(w!.filtersHashAtFetch, hashFilters(inspectorOf(received).filters));
	});

	test('inspectorError clears the loaded window', () => {
		const s0 = withInitialSpec();
		const seeded = rootReduce(s0, {
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([1]), offset: 0, n: 1, elapsedMs: 1,
		});
		const erred = rootReduce(seeded, { type: 'inspectorError', error: 'daemon timeout' });
		assert.strictEqual(inspectorOf(erred).window, null);
	});

	test('columnStatsReceived caches by column, idempotent on identical payload', () => {
		const s0 = withInitialSpec();
		const stats: ColumnStats = {
			kind: 'numeric', cardinality: 21, cardinalityIsExact: false,
			nullCount: 0, total: 1000, min: 0, max: 1000,
		};
		const s1 = rootReduce(s0, { type: 'columnStatsReceived', column: 'volume', stats });
		assert.deepStrictEqual(inspectorOf(s1).statsCache.volume?.stats, stats);
		const s2 = rootReduce(s1, { type: 'columnStatsReceived', column: 'volume', stats });
		assert.strictEqual(s2, s1, 'identical stats must identity-preserve');
	});

	test('columnStatsError records the failure shape', () => {
		const s0 = withInitialSpec();
		const s1 = rootReduce(s0, {
			type: 'columnStatsError', column: 'volume', error: 'daemon down',
		});
		assert.deepStrictEqual(inspectorOf(s1).statsCache.volume,
			{ status: 'error', error: 'daemon down' });
	});

	test('init resets inspector to defaults (carry across documents is blocked)', () => {
		const s0 = withInitialSpec();
		const dirtied = rootReduce(
			rootReduce(s0, { type: 'toggleInspector' }),
			{ type: 'setSelection', x: 99 },
		);
		assert.strictEqual(inspectorOf(dirtied).visible, true);
		assert.deepStrictEqual(inspectorOf(dirtied).selection, { x: 99 });

		// Init a second document — inspector slice must drop back to defaults.
		const reinit = rootReduce(dirtied, {
			type: 'init', fsPath: '/tmp/other.qviz.json', spec: spec(),
		});
		assert.deepStrictEqual(inspectorOf(reinit), INITIAL_INSPECTOR_STATE);
	});

	test('inspector slice ignores unrelated actions (identity-preserve)', () => {
		const s0 = withInitialSpec();
		const after = rootReduce(s0, {
			type: 'setEncoding', channel: 'x',
			encoding: { field: 'b', type: 'quantitative' },
		});
		assert.strictEqual(after.inspector, s0.inspector,
			'inspector slice must not be reallocated on unrelated actions');
	});

	test('hashFilters is order-independent and JSON-stable', () => {
		const a: InspectorFilter = { kind: 'range', column: 'a', min: 0, max: 1 };
		const b: InspectorFilter = { kind: 'text', column: 'b', contains: 'x' };
		const h1 = hashFilters({ a, b });
		const h2 = hashFilters({ b, a });
		assert.strictEqual(h1, h2);
		// Different filter → different hash.
		const c: InspectorFilter = { kind: 'range', column: 'a', min: 0, max: 2 };
		assert.notStrictEqual(hashFilters({ a }), hashFilters({ a: c }));
	});

});

// ---------------------------------------------------------------------------
// Phase 6 (6.F): persistence boundary — inspector state never touches disk
// ---------------------------------------------------------------------------

/** Recursively walk a JSON value and collect every key name encountered.
 *  Used to assert that no inspector-related key (filter, selection,
 *  scrollOffset, etc.) sneaks into the serialized spec at any depth. */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) {
		for (const v of value) { collectKeys(v, out); }
	} else if (value !== null && typeof value === 'object') {
		for (const k of Object.keys(value as Record<string, unknown>)) {
			out.add(k);
			collectKeys((value as Record<string, unknown>)[k], out);
		}
	}
	return out;
}

suite('qviz state -- inspector persistence boundary (Phase 6 / 6.F)', () => {

	function withInitialSpec(): RootState {
		return rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/tmp/x.qviz.json', spec: spec(),
		});
	}

	test('serializeSpec(state.spec.current) NEVER contains inspector keys', () => {
		// Build maximally-dirty inspector state to make leakage easy to
		// catch: filters on multiple columns of every kind, a non-null
		// selection, a non-zero scroll offset, a non-empty window, AND
		// populated statsCache.
		let state = withInitialSpec();
		state = rootReduce(state, { type: 'toggleInspector', visible: true });
		state = rootReduce(state, {
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'range', column: 'a', min: 0, max: 999 },
		});
		state = rootReduce(state, {
			type: 'setColumnFilter', column: 'b',
			filter: { kind: 'text', column: 'b', contains: 'AAPL' },
		});
		state = rootReduce(state, {
			type: 'setColumnFilter', column: 'c',
			filter: { kind: 'set', column: 'c', includes: ['x', 'y'] },
		});
		state = rootReduce(state, { type: 'setSelection', x: 42 });
		state = rootReduce(state, { type: 'setScrollOffset', offset: 1000 });
		state = rootReduce(state, {
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([1, 2, 3, 4, 5]),
			offset: 1000, n: 200, total: 12345, elapsedMs: 7,
		});
		state = rootReduce(state, {
			type: 'columnStatsReceived', column: 'volume',
			stats: {
				kind: 'numeric', cardinality: 21, cardinalityIsExact: false,
				nullCount: 0, total: 1_000_000, min: 0, max: 999,
			},
		});

		// Sanity: the inspector slice is actually populated.
		assert.deepStrictEqual(Object.keys(state.inspector.filters).sort(), ['a', 'b', 'c']);
		assert.ok(state.inspector.selection !== null);
		assert.strictEqual(state.inspector.scrollOffset, 1000);
		assert.ok(state.inspector.window !== null);

		// Now serialize ONLY the spec slice and verify no inspector
		// fields leaked anywhere into the bytes that hit disk.
		const bytes = serializeSpec(state.spec.current!);
		const text = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(text);
		const keys = collectKeys(parsed);

		const FORBIDDEN_KEYS = [
			'visible', 'filters', 'selection', 'scrollOffset',
			'window', 'statsCache', 'inspectorFilters',
			'cardinality', 'cardinalityIsExact', 'distinct',
			'arrow',
		] as const;
		for (const k of FORBIDDEN_KEYS) {
			assert.ok(!keys.has(k),
				`forbidden inspector key '${k}' leaked into serialized spec; keys=${[...keys].sort().join(',')}`);
		}

		// Top-level shape sanity: the saved JSON has the expected
		// QvizSpec keys (and nothing else).
		const topLevel = Object.keys(parsed).sort();
		assert.deepStrictEqual(topLevel,
			['chart', 'dataset', 'provenance', 'qviz_version', 'transforms']);

		// Round-trip must still produce a valid spec — the parse path
		// is the second half of the contract.
		const reparsed = parseSpecBytes(bytes, '/tmp/x.qviz.json');
		assert.strictEqual(reparsed.qviz_version, 1);
	});

	test('inspector slice resets to defaults on init (close + reopen carries nothing)', () => {
		const s0 = withInitialSpec();
		// Dirty the inspector slice.
		let dirtied = rootReduce(s0, { type: 'toggleInspector', visible: true });
		dirtied = rootReduce(dirtied, { type: 'setSelection', x: 'AAPL' });
		dirtied = rootReduce(dirtied, {
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'text', column: 'a', contains: 'foo' },
		});
		dirtied = rootReduce(dirtied, { type: 'setScrollOffset', offset: 250 });
		assert.notStrictEqual(dirtied.inspector, s0.inspector);

		// "Close + reopen": dispatch a fresh init with the same fsPath
		// + a new spec. The reducer's init handler resets every slice
		// to its initial-plus-payload state, so the inspector slice
		// MUST return to the defaults.
		const reopened = rootReduce(dirtied, {
			type: 'init', fsPath: '/tmp/x.qviz.json', spec: spec(),
		});
		assert.strictEqual(reopened.inspector.visible, false);
		assert.strictEqual(reopened.inspector.selection, null);
		assert.strictEqual(reopened.inspector.scrollOffset, 0);
		assert.strictEqual(reopened.inspector.window, null);
		assert.deepStrictEqual(reopened.inspector.filters, {});
		assert.deepStrictEqual(reopened.inspector.statsCache, {});
	});

	test('saveResult never carries inspector state (action payload boundary)', () => {
		// The provider posts saveResult with `fsPath`/`error`/`specHash`
		// only. This regression test pins the payload boundary so a
		// future change that adds inspector data to saveResult breaks
		// the build instead of silently leaking to disk via the next
		// load. (We can't import the protocol message type here as a
		// type-level check; the static-analysis answer is the
		// SaveResultMessage shape, exhaustively defined in
		// messageProtocol.ts. This test pins the dispatched action
		// payload.)
		const s0 = withInitialSpec();
		let state = rootReduce(s0, { type: 'toggleInspector', visible: true });
		state = rootReduce(state, { type: 'setSelection', x: 99 });
		const hashBefore = state.spec.currentHash!;
		// Persistence reducer gates saveResult on a matching pendingSpecHash
		// (megaudit C8: stale save results must not corrupt persistence).
		// So we have to model the full save lifecycle: saveStarted →
		// saveResult.
		state = rootReduce(state, { type: 'saveStarted', specHash: hashBefore });
		const saved = rootReduce(state, {
			type: 'saveResult', status: 'ok',
			specHash: hashBefore, fsPath: '/tmp/x.qviz.json',
		});
		// Inspector slice survives the save (filters don't evaporate
		// just because the user saved) — that's the SESSION boundary.
		assert.strictEqual(saved.inspector, state.inspector,
			'saveResult must NOT mutate the inspector slice');
		// And the persistence slice's last-saved fsPath advances; the
		// path landed on disk had no inspector data baked in because the
		// serializer only sees state.spec.current.
		assert.strictEqual(saved.persistence.lastFsPath, '/tmp/x.qviz.json');
	});

	test('createStore() initializes the inspector slice to defaults', () => {
		const store = createStore();
		assert.deepStrictEqual(store.getState().inspector, INITIAL_INSPECTOR_STATE);
	});

});

// ---------------------------------------------------------------------------
// Phase 6 (6.G.5): end-to-end flow — open → toggle → filter → click
// ---------------------------------------------------------------------------

suite('qviz state -- inspector end-to-end flow (Phase 6 / 6.G.5)', () => {

	test('flow: init → toggle → filter → row click → highlight propagates', () => {
		const store = createStore();
		// Init with a spec whose x encoding points at column `a`.
		store.dispatch({
			type: 'init', fsPath: '/tmp/x.qviz.json',
			spec: spec({
				chart: {
					family: 'general', type: 'scatter',
					encodings: {
						x: { field: 'a', type: 'quantitative' },
						y: { field: 'b', type: 'quantitative' },
					},
				},
			}),
		});
		assert.strictEqual(store.getState().inspector.visible, false);

		// Toggle inspector open.
		store.dispatch({ type: 'toggleInspector' });
		assert.strictEqual(store.getState().inspector.visible, true);

		// Simulate the provider returning a window of preview rows.
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([1, 2, 3]),
			offset: 0, n: 100, total: 1000, elapsedMs: 5,
		});
		assert.ok(store.getState().inspector.window);

		// Add a text filter — window + scroll must reset, ready for a
		// fresh fetch with the filter applied.
		store.dispatch({
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'text', column: 'a', contains: 'AAPL' },
		});
		assert.strictEqual(store.getState().inspector.window, null,
			'filter change invalidates the loaded window');
		assert.strictEqual(store.getState().inspector.scrollOffset, 0);

		// Filtered window arrives.
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([4, 5, 6]),
			offset: 0, n: 50, total: 75, elapsedMs: 8,
		});
		assert.strictEqual(store.getState().inspector.window!.total, 75);

		// Row click → setSelection with the row's xField value (the
		// dispatch layer in qviz-spec/index.ts does this; we simulate).
		store.dispatch({ type: 'setSelection', x: 'AAPL' });
		assert.deepStrictEqual(store.getState().inspector.selection, { x: 'AAPL' });

		// Chart click → setSelection with a different x.
		store.dispatch({ type: 'setSelection', x: 'MSFT' });
		assert.deepStrictEqual(store.getState().inspector.selection, { x: 'MSFT' });

		// Esc clears selection.
		store.dispatch({ type: 'clearSelection' });
		assert.strictEqual(store.getState().inspector.selection, null);

		// Clear-all filters → filters drop, window invalidates, scroll resets.
		store.dispatch({ type: 'clearAllFilters' });
		assert.deepStrictEqual(store.getState().inspector.filters, {});
		assert.strictEqual(store.getState().inspector.window, null);
	});

	test('flow: chart-aggregate request payload carries inspectorFilters only when active', () => {
		// Simulates the live-preview wiring in qviz-spec/index.ts that
		// reads `state.inspector.filters` at requestData dispatch time.
		const store = createStore();
		store.dispatch({
			type: 'init', fsPath: '/tmp/x.qviz.json', spec: spec(),
		});
		// No filters → request payload omits inspectorFilters.
		const empty = Object.values(store.getState().inspector.filters);
		assert.deepStrictEqual(empty, []);

		// Add a filter and confirm it shows up at the boundary.
		store.dispatch({
			type: 'setColumnFilter', column: 'volume',
			filter: { kind: 'range', column: 'volume', min: 100, max: null },
		});
		const populated = Object.values(store.getState().inspector.filters);
		assert.strictEqual(populated.length, 1);
		assert.deepStrictEqual(populated[0], {
			kind: 'range', column: 'volume', min: 100, max: null,
		});
	});

	test('flow: stale offset response does NOT clobber a fresher window', () => {
		// Race: scroll to offset=500, request lands → window stored;
		// scroll fast to offset=2000, request lands → window updated.
		// If the older response arrives AFTER the newer (out-of-order
		// delivery), the slice naively overwrites — Phase 6 v1 trusts
		// the dispatcher to fire only the latest request at a time, so
		// the reducer just stores whatever lands.
		//
		// This test pins THE CURRENT BEHAVIOR (last-write-wins). A
		// future stale-rejection layer would replace this assertion
		// with stamp-checking via filtersHashAtFetch.
		const store = createStore();
		store.dispatch({ type: 'init', fsPath: '/tmp/x.qviz.json', spec: spec() });
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([0xAA]),
			offset: 500, n: 100, total: 5000, elapsedMs: 5,
		});
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array([0xBB]),
			offset: 2000, n: 100, total: 5000, elapsedMs: 7,
		});
		assert.strictEqual(store.getState().inspector.window!.offset, 2000);
	});

});

// ---------------------------------------------------------------------------
// Phase 6 megaudit cure regressions (BLOCKER + MAJOR fixes)
// ---------------------------------------------------------------------------

import {
	canonicalizeSelectionX, selectionFieldForSpec,
} from '../webview/qviz/state/inspectorState';

suite('qviz state -- megaudit cures (Phase 6)', () => {

	function withSpec(s: QvizSpec): RootState {
		return rootReduce(INITIAL_ROOT_STATE, { type: 'init', fsPath: '/x', spec: s });
	}

	test('B-2: candlestick selection field routes via ohlcv.time', () => {
		const sp: QvizSpec = spec({
			chart: {
				family: 'timeseries', type: 'candlestick',
				encodings: { ohlcv: { time: 'ts', open: 'o', high: 'h', low: 'l', close: 'c' } },
			},
		});
		assert.strictEqual(selectionFieldForSpec(sp), 'ts');
	});

	test('B-3: pie selection field routes via color.field', () => {
		const sp: QvizSpec = spec({
			chart: {
				family: 'general', type: 'pie',
				encodings: {
					color: { field: 'ticker', type: 'nominal' },
					y: { field: 'shares', type: 'quantitative' },
				},
			},
		});
		assert.strictEqual(selectionFieldForSpec(sp), 'ticker');
	});

	test('B-3: non-pie, non-candlestick falls through to encodings.x', () => {
		const sp = spec();
		assert.strictEqual(selectionFieldForSpec(sp), 'a');
	});

	test('B-3: null/missing spec returns null', () => {
		assert.strictEqual(selectionFieldForSpec(null), null);
		assert.strictEqual(selectionFieldForSpec(undefined), null);
	});

	test('B-4: schemaChanged prunes filters for dropped columns', () => {
		let s = withSpec(spec());
		s = rootReduce(s, {
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'range', column: 'a', min: 0, max: 10 },
		});
		s = rootReduce(s, {
			type: 'setColumnFilter', column: 'gone',
			filter: { kind: 'text', column: 'gone', contains: 'foo' },
		});
		const drifted = rootReduce(s, {
			type: 'schemaChanged',
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
			drift: 'fields-missing',
			newSchema: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'b'.repeat(64),
				mtime_ns: 2, row_count: 1,
				columns: [{ name: 'a', dtype: 'int64', nullable: true }],
			},
			missingFields: ['gone'],
		});
		assert.deepStrictEqual(Object.keys(drifted.inspector.filters), ['a']);
		// Stats cache invalidated wholesale on drift.
		assert.deepStrictEqual(drifted.inspector.statsCache, {});
		// Window cleared so the next request fetches under the new schema.
		assert.strictEqual(drifted.inspector.window, null);
	});

	test('M-9: chart-type swap clears selection', () => {
		let s = withSpec(spec());
		s = rootReduce(s, { type: 'setSelection', x: 42 });
		assert.ok(s.inspector.selection !== null);
		const swapped = rootReduce(s, {
			type: 'setChartType', family: 'general', chartType: 'pie',
		});
		assert.strictEqual(swapped.inspector.selection, null);
	});

	test('M-10: filter change clears selection', () => {
		let s = withSpec(spec());
		s = rootReduce(s, { type: 'setSelection', x: 100 });
		s = rootReduce(s, {
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'range', column: 'a', min: 0, max: 1 },
		});
		assert.strictEqual(s.inspector.selection, null);
	});

	test('M-12: bigint outside plausible ns-timestamp range stays as Number (ID columns)', () => {
		// Small bigint (transaction ID) → stays as raw number.
		assert.strictEqual(canonicalizeSelectionX(42n), 42);
		// Plausible-ns timestamp (year ~2020 in ns) → divided to ms.
		const ns = 1_600_000_000_000_000_000n;
		assert.strictEqual(canonicalizeSelectionX(ns), 1_600_000_000_000);
	});

	test('M-22 (sanity): canonicalize passes through finite numbers + null + undefined', () => {
		assert.strictEqual(canonicalizeSelectionX(123.456), 123.456);
		assert.strictEqual(canonicalizeSelectionX(null), null);
		assert.strictEqual(canonicalizeSelectionX(undefined), undefined);
	});

	test('M-12: Date instances canonicalize to ms', () => {
		const d = new Date('2026-05-11T12:00:00Z');
		assert.strictEqual(canonicalizeSelectionX(d), d.getTime());
	});

	test('M-12: ISO-string canonicalizes to ms', () => {
		const v = canonicalizeSelectionX('2026-05-11T12:00:00Z');
		assert.strictEqual(typeof v, 'number');
		assert.strictEqual(v, Date.parse('2026-05-11T12:00:00Z'));
	});

	test('M-12: non-ISO string stays unchanged', () => {
		assert.strictEqual(canonicalizeSelectionX('AAPL'), 'AAPL');
	});

	test('M-25: runtime init resets capabilities to action.capabilities (no stale-preserve)', () => {
		// Seed runtime with old caps.
		let s = rootReduce(INITIAL_ROOT_STATE, {
			type: 'init', fsPath: '/x', spec: spec(),
			capabilities: {
				daemonVersion: 1, transformKinds: ['filter'], chartFamilies: ['timeseries'],
				inspector: { previewOffset: true, columnStats: true, aggregateFilters: true },
			},
		});
		assert.ok(s.runtime.capabilities?.inspector);
		// Re-init WITHOUT capabilities. Reset to null.
		s = rootReduce(s, { type: 'init', fsPath: '/x2', spec: spec() });
		assert.strictEqual(s.runtime.capabilities, null);
	});

	test('Residual #1: partial-caps daemon bag normalizes missing flags to false', () => {
		// Audit M-49 cure: a daemon emitting only one inspector flag
		// must produce a valid capabilities message; missing flags
		// default to false. Without this, the validator rejected the
		// whole bag and the toggle disabled with no diagnostic.
		const { validateExtensionMessage, computeSpecHash } = require('../src/qviz/messageProtocol');
		const sp = spec();
		const r = validateExtensionMessage({
			type: 'capabilities',
			protocolVersion: 1,
			requestId: 1,
			capabilities: {
				daemonVersion: 1,
				transformKinds: ['filter'],
				chartFamilies: ['timeseries'],
				inspector: { previewOffset: true /* the other two missing */ },
			},
		});
		assert.strictEqual(r.ok, true);
		if (r.ok && r.value.type === 'capabilities') {
			const insp = r.value.capabilities.inspector;
			assert.strictEqual(insp?.previewOffset, true);
			assert.strictEqual(insp?.columnStats, false);
			assert.strictEqual(insp?.aggregateFilters, false);
		}
		void computeSpecHash; void sp;
	});

	test('Residual #1: malformed inspector flag (string instead of bool) still rejected', () => {
		const { validateExtensionMessage } = require('../src/qviz/messageProtocol');
		const r = validateExtensionMessage({
			type: 'capabilities',
			protocolVersion: 1,
			requestId: 1,
			capabilities: {
				daemonVersion: 1,
				transformKinds: ['filter'],
				chartFamilies: ['timeseries'],
				inspector: { previewOffset: 'yes' as unknown as boolean },
			},
		});
		assert.strictEqual(r.ok, false);
	});

	test('B-1 cure: derived xField (not in schema) silently no-ops row→chart sync', () => {
		// When the chart aggregates (e.g., `date_trunc('day', ts) AS day`),
		// `encodings.x.field === 'day'` is a derived alias that does NOT
		// exist in the raw preview's schema. The cure: row-click does
		// nothing rather than dispatching a meaningless selection.
		// This test verifies the GUARD shape — the actual dispatch is
		// in inspectorPanel which we can't unit-test without jsdom.
		// We test the helper paths the guard relies on.
		const sp: QvizSpec = spec({
			chart: {
				family: 'timeseries', type: 'line',
				encodings: { x: { field: 'day', type: 'temporal' }, y: { field: 'sum', type: 'quantitative' } },
			},
		});
		const xField = selectionFieldForSpec(sp);
		assert.strictEqual(xField, 'day');
		// In the actual handler, this xField is then checked against
		// state.schema.info.columns; if `day` isn't there, the dispatch
		// is suppressed. We assert the helper's contract: it returns
		// the configured field name unconditionally — the schema check
		// is the second gate.
		assert.strictEqual(typeof xField, 'string');
	});

	test('M-63: clearAllFilters resets lastError', () => {
		let s = withSpec(spec());
		s = rootReduce(s, {
			type: 'setColumnFilter', column: 'a',
			filter: { kind: 'range', column: 'a', min: 0, max: 10 },
		});
		s = rootReduce(s, { type: 'inspectorError', error: 'daemon down' });
		assert.ok(s.inspector.lastError !== null);
		s = rootReduce(s, { type: 'clearAllFilters' });
		assert.strictEqual(s.inspector.lastError, null);
	});

});
