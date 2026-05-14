/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the qviz extension↔webview message protocol (Phase 5 step
 * B.1, post-megaudit-cycle-2). The validators are the system boundary --
 * they MUST reject malformed messages with structured errors rather
 * than throw or accept silently.
 *
 * Coverage:
 *   - Envelope: protocolVersion / requestId / specHash discriminant.
 *   - Each ExtensionMessage variant: happy path + per-field rejection.
 *   - Each WebviewMessage variant: same.
 *   - Spec-bearing messages run the full QvizSpec validator.
 *   - specHash REQUIRED on every spec-attributed response.
 *   - Cross-field invariants: saveResult ok/failed exclusivity,
 *     daemonStatus retryInMs only with crashed/respawning, schemaChanged
 *     missingFields iff drift==='fields-missing'.
 *   - computeSpecHash: deterministic, key-order-independent, distinct
 *     for different specs, format-valid.
 *   - Validators freeze their successful results.
 */

import * as assert from 'assert';

import {
	PROTOCOL_VERSION,
	SPEC_HASH_PREFIX,
	SPEC_HASH_RE,
	computeSpecHash,
	validateExtensionMessage,
	validateWebviewMessage,
} from '../src/qviz/messageProtocol';
import type { QvizSpec } from '../src/qviz/spec';

function validSpec(overrides: Partial<QvizSpec> = {}): QvizSpec {
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

const VALID_SPEC_HASH = SPEC_HASH_PREFIX + 'deadbeefcafef00d';

/** Envelope skeleton (`protocolVersion: 1, requestId: 1`) merged into
 *  every test message so the cases focus on per-field validation. */
function env(extra: Record<string, unknown>): Record<string, unknown> {
	return { protocolVersion: PROTOCOL_VERSION, requestId: 1, ...extra };
}

/** Init envelope helper — fills in `lastSavedHash` defaulting to the
 *  spec's hash (fresh-open semantics). Tests that want to verify the
 *  divergence-between-current-and-saved branch override explicitly. */
function initEnv(extra: Record<string, unknown>): Record<string, unknown> {
	const spec = (extra as { spec?: unknown }).spec;
	const defaultSavedHash = typeof spec === 'object' && spec !== null && (spec as { qviz_version?: unknown }).qviz_version
		? computeSpecHash(spec as QvizSpec)
		: 'q1:0000000000000000';
	return env({
		lastSavedHash: defaultSavedHash,
		...extra,
	});
}

// ---------------------------------------------------------------------------
// envelope shape
// ---------------------------------------------------------------------------

suite('messageProtocol -- envelope shape', () => {

	test('rejects non-object payload', () => {
		const cases: unknown[] = [null, undefined, 42, 'string', [], true];
		for (const c of cases) {
			const r = validateExtensionMessage(c);
			assert.strictEqual(r.ok, false, `should reject ${JSON.stringify(c)}`);
		}
	});

	test('rejects missing or empty type', () => {
		assert.strictEqual(validateExtensionMessage(env({ requestId: 1 })).ok, false);
		assert.strictEqual(validateExtensionMessage(env({ type: '' })).ok, false);
		assert.strictEqual(validateExtensionMessage(env({ type: 42 })).ok, false);
	});

	test('rejects mismatched protocolVersion', () => {
		const r = validateExtensionMessage({
			type: 'theme', protocolVersion: 999, requestId: 1, tokens: themeTokens(),
		});
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/protocolVersion/.test(r.error), `expected protocolVersion error, got ${r.error}`); }
	});

	test('rejects missing protocolVersion', () => {
		const r = validateExtensionMessage({
			type: 'theme', requestId: 1, tokens: themeTokens(),
		});
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/protocolVersion/.test(r.error)); }
	});

	test('rejects missing or non-safe-integer requestId', () => {
		assert.strictEqual(validateExtensionMessage({ type: 'theme', protocolVersion: 1 }).ok, false);
		assert.strictEqual(validateExtensionMessage({ type: 'theme', protocolVersion: 1, requestId: -1 }).ok, false);
		assert.strictEqual(validateExtensionMessage({ type: 'theme', protocolVersion: 1, requestId: 1.5 }).ok, false);
		assert.strictEqual(validateExtensionMessage({ type: 'theme', protocolVersion: 1, requestId: '0' }).ok, false);
		// Above MAX_SAFE_INTEGER is rejected.
		assert.strictEqual(
			validateExtensionMessage({ type: 'theme', protocolVersion: 1, requestId: Number.MAX_SAFE_INTEGER + 1 }).ok,
			false,
		);
	});

	test('rejects malformed specHash', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: 'not-a-hash',
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/specHash/.test(r.error), `unexpected error: ${r.error}`); }
	});

	test('accepts omitted specHash on messages that do not need it', () => {
		const r = validateExtensionMessage(env({ type: 'theme', tokens: themeTokens() }));
		assert.strictEqual(r.ok, true);
	});

	test('accepts well-formed specHash on data', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH,
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('rejects unknown extension message type', () => {
		const r = validateExtensionMessage(env({ type: 'gibberish' }));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/unknown extension message type/.test(r.error)); }
	});

	test('rejects unknown webview message type', () => {
		const r = validateWebviewMessage(env({ type: 'gibberish' }));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/unknown webview message type/.test(r.error)); }
	});

	test('successful validation result is frozen (deep)', () => {
		// Step C megaudit C10: prior `Object.freeze` was shallow, so a
		// sender holding a reference to validated `newSchema.columns`
		// could mutate the array after dispatch and corrupt webview
		// state. Validator now deep-freezes nested arrays + objects.
		const r = validateExtensionMessage(env({ type: 'theme', tokens: themeTokens() }));
		assert.strictEqual(r.ok, true);
		assert.ok(Object.isFrozen(r), 'result envelope should be frozen');
		if (r.ok) {
			assert.ok(Object.isFrozen(r.value), 'validated message should be frozen');
			assert.ok(Object.isFrozen(
				(r.value as { tokens: { seriesPalette: readonly string[] } }).tokens,
			), 'nested theme.tokens should be frozen');
			assert.ok(Object.isFrozen(
				(r.value as { tokens: { seriesPalette: readonly string[] } }).tokens.seriesPalette,
			), 'deeply-nested seriesPalette array should be frozen');
		}
	});

	test('schemaChanged result has deep-frozen newSchema.columns array', () => {
		const baseHashes = {
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
		};
		const newSchema = validSchemaInfo(baseHashes.newHash);
		const r = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-preserved',
		}));
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		const ns = (r.value as unknown as { newSchema: { columns: { name: string }[] } }).newSchema;
		assert.ok(Object.isFrozen(ns), 'newSchema must be frozen');
		assert.ok(Object.isFrozen(ns.columns), 'newSchema.columns must be frozen');
		// Per-column object freeze.
		for (const col of ns.columns) {
			assert.ok(Object.isFrozen(col), `each column must be frozen: ${JSON.stringify(col)}`);
		}
	});

});

// ---------------------------------------------------------------------------
// extension → webview messages
// ---------------------------------------------------------------------------

suite('messageProtocol -- extension messages', () => {

	test('init: happy path with valid spec', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/ws/spec.qviz.json',
			spec,
		}));
		assert.strictEqual(r.ok, true, `init failed: ${(!r.ok && r.error) || ''}`);
	});

	test('init: rejects empty fsPath', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec), fsPath: '', spec,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('init: rejects spec failing QvizSpec validation', () => {
		// Missing required field -- the inner validator catches this.
		const malformed = { qviz_version: 1, dataset: { uri: 'x' } };
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: VALID_SPEC_HASH,
			fsPath: '/ws/x.qviz.json', spec: malformed,
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/init\.spec failed validation/.test(r.error), r.error); }
	});

	test('init: rejects non-object spec', () => {
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: VALID_SPEC_HASH,
			fsPath: '/ws/x.qviz.json', spec: 'string',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('init: rejects specHash that does NOT match computeSpecHash(spec)', () => {
		// Step C megaudit C11: prior validators only checked specHash
		// FORMAT, never compared envelope.specHash to computeSpecHash
		// of the validated spec. A hostile sender could send any
		// well-formed specHash and the validator accepted it.
		const spec = validSpec();
		const wrongHash = SPEC_HASH_PREFIX + 'deadbeefcafef00d';
		// Make sure the wrong hash actually IS wrong.
		assert.notStrictEqual(wrongHash, computeSpecHash(spec));
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: wrongHash,
			fsPath: '/ws/x.qviz.json', spec,
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/specHash does not match computeSpecHash/.test(r.error), r.error);
		}
	});

	test('init: ACCEPTS matching specHash', () => {
		const spec = validSpec();
		const correctHash = computeSpecHash(spec);
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: correctHash,
			fsPath: '/ws/x.qviz.json', spec,
		}));
		assert.strictEqual(r.ok, true, `expected ok; got ${r.ok ? '' : r.error}`);
	});

	test('init: requires specHash', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', fsPath: '/ws/x.qviz.json', spec,
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/init\.specHash/.test(r.error), r.error); }
	});

	test('Megaudit M-46: init rejects missing lastSavedHash', () => {
		const spec = validSpec();
		const sh = computeSpecHash(spec);
		// Build envelope manually to avoid initEnv's auto-fill of lastSavedHash.
		const r = validateExtensionMessage({
			type: 'init',
			protocolVersion: 1,
			requestId: 1,
			specHash: sh,
			fsPath: '/ws/x.qviz.json',
			spec,
			// lastSavedHash deliberately omitted.
		});
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.match(r.error, /lastSavedHash is required/,
				`expected lastSavedHash-required error, got: ${r.error}`);
		}
	});

	test('Megaudit M-46: init rejects malformed lastSavedHash', () => {
		const spec = validSpec();
		const sh = computeSpecHash(spec);
		const r = validateExtensionMessage({
			type: 'init',
			protocolVersion: 1,
			requestId: 1,
			specHash: sh,
			fsPath: '/ws/x.qviz.json',
			spec,
			lastSavedHash: 'not-a-spec-hash',
		});
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			// Megaudit-2 A5-MAJOR-6.3: previous regex was just
			// `/lastSavedHash/`, which would match ANY error mentioning
			// the field -- including ones unrelated to the malformed
			// value being tested. Pin to the actual malformed-value
			// signature in the error message.
			assert.match(
				r.error,
				/init\.lastSavedHash is required.*got "not-a-spec-hash"/,
				`expected init.lastSavedHash malformed error mentioning the rejected value, got: ${r.error}`,
			);
		}
	});

	test('init: validates schema field deeply', () => {
		const spec = validSpec();
		const goodSchema = {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
			row_count: 10,
			columns: [{ name: 'a', dtype: 'int64', nullable: false }],
		};
		assert.strictEqual(
			validateExtensionMessage(initEnv({
				type: 'init', specHash: computeSpecHash(spec),
				fsPath: '/x', spec, schema: goodSchema,
			})).ok,
			true,
		);
		// Bad: column missing dtype.
		const badSchema = {
			...goodSchema, columns: [{ name: 'a', nullable: false }],
		};
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec, schema: badSchema,
		}));
		assert.strictEqual(r.ok, false);
		// Megaudit Wave 11.4: pin the rejection reason. A future
		// regression that rejected for the WRONG reason (e.g., schema
		// validator stopped checking dtype) would silently pass the
		// previous bare `r.ok === false`.
		// Megaudit-2 A5-MAJOR-6.2: previous regex `/dtype|columns/` was
		// too loose -- any unrelated error mentioning the word "columns"
		// (e.g., "no columns array") would pass. Pin to the specific
		// error string the validator actually emits for missing dtype.
		if (!r.ok) {
			assert.match(
				r.error,
				/init\.schema\.columns\[0\]\.dtype must be a non-empty string/,
				`expected dtype-non-empty-string rejection at columns[0], got: ${r.error}`,
			);
		}
	});

	test('init: validates capabilities field deeply', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec,
			capabilities: { daemonVersion: -1, transformKinds: [], chartFamilies: [] },
		}));
		assert.strictEqual(r.ok, false);
	});

	test('data: requires specHash', () => {
		const r = validateExtensionMessage(env({
			type: 'data',
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/data\.specHash/.test(r.error), r.error); }
	});

	test('data: requires Uint8Array (rejects ArrayBuffer / string)', () => {
		const base = env({
			type: 'data', specHash: VALID_SPEC_HASH,
			elapsedMs: 5, cached: false, diagnostics: [],
		});
		assert.strictEqual(validateExtensionMessage({ ...base, arrow: new Uint8Array(8) }).ok, true);
		assert.strictEqual(validateExtensionMessage({ ...base, arrow: new ArrayBuffer(8) }).ok, false);
		assert.strictEqual(validateExtensionMessage({ ...base, arrow: 'bytes' }).ok, false);
		// Buffer: subclass of Uint8Array but explicitly rejected so the
		// extension host catches its own forgotten-Buffer-conversion.
		assert.strictEqual(
			validateExtensionMessage({ ...base, arrow: Buffer.from([0, 1, 2]) }).ok,
			false,
			'Buffer should be rejected even though Buffer instanceof Uint8Array',
		);
	});

	test('data: rejects non-finite or negative elapsedMs', () => {
		const base = env({
			type: 'data', specHash: VALID_SPEC_HASH,
			arrow: new Uint8Array(), cached: false, diagnostics: [],
		});
		assert.strictEqual(validateExtensionMessage({ ...base, elapsedMs: Number.NaN }).ok, false);
		assert.strictEqual(validateExtensionMessage({ ...base, elapsedMs: Infinity }).ok, false);
		assert.strictEqual(validateExtensionMessage({ ...base, elapsedMs: -1 }).ok, false);
	});

	test('data: rejects diagnostics with non-string entries', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: ['ok', 42, 'mixed'],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('data: accepts attribution absent (pre-Front-2 daemon)', () => {
		// Front 2 (2026-05-14): the optional field stays optional. Old
		// daemons that don't advertise transformAttributionV1 send
		// `data` messages without `attribution`; validator must accept.
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('data: accepts well-formed attribution', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
			attribution: [
				{ index: 0, kind: 'groupby', produces: [], drops: [],
					availableAfter: ['a', 'b', 'c'] },
				{ index: 1, kind: 'aggregate', produces: ['mean_close'],
					drops: ['open', 'high', 'low', 'close'],
					availableAfter: ['date', 'mean_close'] },
			],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('data: rejects attribution with non-integer index', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
			attribution: [{ index: 1.5, kind: 'filter',
				produces: [], drops: [], availableAfter: [] }],
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.match(r.error, /index must be a non-negative safe integer/); }
	});

	test('data: rejects attribution with missing kind', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
			attribution: [{ index: 0, produces: [], drops: [], availableAfter: [] }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('data: rejects attribution with non-string column entries', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
			attribution: [{ index: 0, kind: 'aggregate',
				produces: ['ok', 42], drops: [], availableAfter: [] }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('data: rejects attribution that is not an array', () => {
		const r = validateExtensionMessage(env({
			type: 'data', specHash: VALID_SPEC_HASH, arrow: new Uint8Array(),
			elapsedMs: 0, cached: false, diagnostics: [],
			attribution: 'not-an-array',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('error: requires specHash', () => {
		const r = validateExtensionMessage(env({
			type: 'error', error: 'boom', errorKind: 'compile',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/error\.specHash/.test(r.error), r.error); }
	});

	test('error: rejects unknown errorKind', () => {
		const r = validateExtensionMessage(env({
			type: 'error', specHash: VALID_SPEC_HASH,
			error: 'boom', errorKind: 'unknown-kind',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('error: accepts each documented errorKind', () => {
		for (const kind of ['compile', 'security', 'timeout', 'memory', 'internal', 'protocol']) {
			const r = validateExtensionMessage(env({
				type: 'error', specHash: VALID_SPEC_HASH, error: 'msg', errorKind: kind,
			}));
			assert.strictEqual(r.ok, true, `errorKind=${kind} must validate`);
		}
	});

	test('error: rejects negative transformIndex', () => {
		const r = validateExtensionMessage(env({
			type: 'error', specHash: VALID_SPEC_HASH, error: 'msg',
			errorKind: 'compile', transformIndex: -1,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('theme: happy path + missing field rejects', () => {
		assert.strictEqual(
			validateExtensionMessage(env({ type: 'theme', tokens: themeTokens() })).ok,
			true,
		);
		const partial = { ...themeTokens() } as Record<string, unknown>;
		delete partial.background;
		const r = validateExtensionMessage(env({ type: 'theme', tokens: partial }));
		assert.strictEqual(r.ok, false);
	});

	test('theme: rejects non-string seriesPalette entries', () => {
		const tokens = { ...themeTokens(), seriesPalette: ['#f00', 42, '#0f0'] };
		const r = validateExtensionMessage(env({ type: 'theme', tokens }));
		assert.strictEqual(r.ok, false);
	});

	test('daemonStatus: every documented status validates', () => {
		// Megaudit E8 (2026-05-13): include `disposing` so the loop
		// pins the full set; without this a regression that removes
		// 'disposing' from the validator would not be caught.
		for (const status of [
			'idle', 'starting', 'ready', 'crashed', 'respawning',
			'disposing', 'unavailable',
		]) {
			const extra: Record<string, unknown> = { type: 'daemonStatus', status };
			if (status === 'crashed' || status === 'respawning') {
				extra.retryInMs = 100;
			}
			const r = validateExtensionMessage(env(extra));
			assert.strictEqual(r.ok, true, `status=${status} must validate`);
		}
	});

	test('E8: daemonStatus rejects retryInMs on disposing (terminal-direction state)', () => {
		// `disposing` is a transient terminal-direction status; a
		// retryInMs field would be semantically meaningless (no
		// respawn after dispose). The existing validator rejects
		// `retryInMs` on non-crashed/respawning states.
		const r = validateExtensionMessage(env({
			type: 'daemonStatus', status: 'disposing', retryInMs: 100,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('daemonStatus: rejects retryInMs < 0 or non-finite', () => {
		const r = validateExtensionMessage(env({
			type: 'daemonStatus', status: 'crashed', retryInMs: -1,
		}));
		assert.strictEqual(r.ok, false);
		assert.strictEqual(
			validateExtensionMessage(env({ type: 'daemonStatus', status: 'crashed', retryInMs: Number.NaN })).ok,
			false,
		);
		assert.strictEqual(
			validateExtensionMessage(env({ type: 'daemonStatus', status: 'crashed', retryInMs: Infinity })).ok,
			false,
		);
	});

	test('daemonStatus: rejects retryInMs on non-transient status', () => {
		const r = validateExtensionMessage(env({
			type: 'daemonStatus', status: 'ready', retryInMs: 100,
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/retryInMs is only valid/.test(r.error), r.error); }
	});

	test('schemaChanged: drift fields-missing requires non-empty missingFields', () => {
		const baseHashes = {
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
		};
		const newSchema = validSchemaInfo(baseHashes.newHash);
		const ok = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-missing', missingFields: ['col_x'],
		}));
		assert.strictEqual(ok.ok, true, `expected ok; got ${ok.ok ? '' : ok.error}`);
		const empty = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-missing', missingFields: [],
		}));
		assert.strictEqual(empty.ok, false);
		const noField = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-missing',
		}));
		assert.strictEqual(noField.ok, false);
	});

	test('schemaChanged: drift !== fields-missing forbids missingFields', () => {
		const baseHashes = {
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
		};
		const r = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes,
			newSchema: validSchemaInfo(baseHashes.newHash),
			drift: 'same-hash', missingFields: ['col_x'],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('schemaChanged: rejects malformed hashes', () => {
		const r = validateExtensionMessage(env({
			type: 'schemaChanged',
			oldHash: 'not-a-hash',
			newHash: 'sha256:' + 'b'.repeat(64),
			newSchema: validSchemaInfo('sha256:' + 'b'.repeat(64)),
			drift: 'fields-preserved',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('schemaChanged: requires newSchema', () => {
		const r = validateExtensionMessage(env({
			type: 'schemaChanged',
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
			drift: 'same-hash',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/newSchema/.test(r.error), r.error); }
	});

	test('schemaChanged: rejects newSchema.schema_hash mismatch with newHash', () => {
		const newHash = 'sha256:' + 'b'.repeat(64);
		const r = validateExtensionMessage(env({
			type: 'schemaChanged',
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash,
			// schema_hash refers to a DIFFERENT hash than newHash:
			newSchema: validSchemaInfo('sha256:' + 'c'.repeat(64)),
			drift: 'fields-preserved',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/schema_hash must equal/.test(r.error), r.error);
		}
	});

	test('schemaChanged: same-hash drift requires oldHash === newHash (cross-field invariant)', () => {
		// Step C megaudit fix: prior validator allowed `same-hash` with
		// different hashes (incoherent: claims no change but hashes
		// differ).
		const r = validateExtensionMessage(env({
			type: 'schemaChanged',
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
			newSchema: validSchemaInfo('sha256:' + 'b'.repeat(64)),
			drift: 'same-hash',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/same-hash.*requires oldHash === newHash/.test(r.error), r.error);
		}
	});

	test('schemaChanged: non-same-hash drift requires oldHash !== newHash', () => {
		// `fields-preserved` with equal hashes is incoherent: claims
		// drift but hashes say no change.
		const sameHash = 'sha256:' + 'a'.repeat(64);
		const r = validateExtensionMessage(env({
			type: 'schemaChanged',
			oldHash: sameHash,
			newHash: sameHash,
			newSchema: validSchemaInfo(sameHash),
			drift: 'fields-preserved',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/requires oldHash !== newHash/.test(r.error), r.error);
		}
	});

	test('schemaChanged: missingFields rejects empty strings and duplicates', () => {
		const baseHashes = {
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
		};
		const newSchema = validSchemaInfo(baseHashes.newHash);
		const empty = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-missing', missingFields: ['col_a', '', 'col_b'],
		}));
		assert.strictEqual(empty.ok, false);
		const dupes = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes, newSchema,
			drift: 'fields-missing', missingFields: ['col_a', 'col_a'],
		}));
		assert.strictEqual(dupes.ok, false);
	});

	test('schemaChanged: validateSchemaInfo deeply rejects malformed newSchema', () => {
		const baseHashes = {
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
		};
		// Malformed newSchema (columns not an array).
		const r = validateExtensionMessage(env({
			type: 'schemaChanged', ...baseHashes,
			newSchema: {
				uri: 'data/x.parquet',
				schema_hash: baseHashes.newHash,
				mtime_ns: 1, row_count: 100,
				columns: 'not-an-array',
			},
			drift: 'fields-preserved',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/schemaChanged\.newSchema/.test(r.error), r.error);
		}
	});

	test('init/SchemaInfo: rejects duplicate column names', () => {
		const spec = validSpec();
		const dupeSchema = {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1, row_count: 100,
			columns: [
				{ name: 'a', dtype: 'float64', nullable: false },
				{ name: 'a', dtype: 'int64', nullable: false },  // DUPE
			],
		};
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec, schema: dupeSchema,
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/duplicates an earlier column/.test(r.error), r.error);
		}
	});

	test('saveResult: ok requires fsPath, no error; failed requires error, no fsPath', () => {
		// ok happy
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH, status: 'ok', fsPath: '/x',
			})).ok,
			true,
		);
		// ok missing fsPath
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH, status: 'ok',
			})).ok,
			false,
		);
		// ok with error -- mutually exclusive
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH,
				status: 'ok', fsPath: '/x', error: 'boom',
			})).ok,
			false,
		);
		// failed happy
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH,
				status: 'failed', error: 'boom',
			})).ok,
			true,
		);
		// failed missing error
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH, status: 'failed',
			})).ok,
			false,
		);
		// failed with fsPath -- mutually exclusive
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'saveResult', specHash: VALID_SPEC_HASH,
				status: 'failed', error: 'boom', fsPath: '/x',
			})).ok,
			false,
		);
	});

	test('saveResult: requires specHash', () => {
		const r = validateExtensionMessage(env({
			type: 'saveResult', status: 'ok', fsPath: '/x',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/saveResult\.specHash/.test(r.error), r.error); }
	});

	test('Megaudit M-47: saveResult ok rejects empty-string fsPath', () => {
		const r = validateExtensionMessage(env({
			type: 'saveResult', status: 'ok', fsPath: '',
			specHash: 'q1:0000000000000000',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.match(r.error, /fsPath required \(non-empty\)/); }
	});

	test('Megaudit M-47: saveResult failed rejects empty-string error', () => {
		const r = validateExtensionMessage(env({
			type: 'saveResult', status: 'failed', error: '',
			specHash: 'q1:0000000000000000',
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.match(r.error, /error required \(non-empty\)/); }
	});

	test('capabilities: happy path + bad chart family rejects', () => {
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'capabilities',
				capabilities: { daemonVersion: 1, transformKinds: ['filter'], chartFamilies: ['timeseries'] },
			})).ok,
			true,
		);
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'capabilities',
				capabilities: { daemonVersion: 1, transformKinds: ['filter'], chartFamilies: ['weird-family'] },
			})).ok,
			false,
		);
	});

	test('capabilities: rejects non-positive daemonVersion', () => {
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'capabilities',
				capabilities: { daemonVersion: 0, transformKinds: [], chartFamilies: ['general'] },
			})).ok,
			false,
		);
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'capabilities',
				capabilities: { daemonVersion: 1.5, transformKinds: [], chartFamilies: ['general'] },
			})).ok,
			false,
		);
	});

	// Step 5.J.1 — datasetStatus validator (Step 5.I.3 added the message
	// type but no protocol-level tests). Locks in: enum membership for
	// status, non-empty datasetUri, error string-or-omitted, and the
	// cross-field invariant that non-`ok` statuses MUST carry a non-empty
	// error message.
	test('datasetStatus: ok status validates without an error field', () => {
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'datasetStatus',
				status: 'ok',
				datasetUri: 'data/file.parquet',
			})).ok,
			true,
		);
	});

	test('datasetStatus: every non-ok status validates WITH an error string', () => {
		const kinds = [
			'missing', 'dangling-symlink', 'access-denied',
			'path-escape', 'extension-not-allowed', 'no-workspace',
		] as const;
		for (const status of kinds) {
			const r = validateExtensionMessage(env({
				type: 'datasetStatus',
				status, datasetUri: 'data/file.parquet',
				error: 'some explanation',
			}));
			assert.strictEqual(r.ok, true, `expected ${status} to validate`);
		}
	});

	test('datasetStatus: rejects unknown status enum', () => {
		const r = validateExtensionMessage(env({
			type: 'datasetStatus', status: 'banana',
			datasetUri: 'data/file.parquet',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('datasetStatus: rejects empty datasetUri', () => {
		const r = validateExtensionMessage(env({
			type: 'datasetStatus', status: 'ok', datasetUri: '',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('datasetStatus: cross-field — non-ok REQUIRES non-empty error', () => {
		// missing error
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'datasetStatus', status: 'missing',
				datasetUri: 'data/file.parquet',
			})).ok,
			false,
		);
		// empty error string
		assert.strictEqual(
			validateExtensionMessage(env({
				type: 'datasetStatus', status: 'access-denied',
				datasetUri: 'data/file.parquet', error: '',
			})).ok,
			false,
		);
	});

	test('datasetStatus: rejects non-string error field', () => {
		const r = validateExtensionMessage(env({
			type: 'datasetStatus', status: 'missing',
			datasetUri: 'data/file.parquet', error: 42,
		}));
		assert.strictEqual(r.ok, false);
	});

	// -----------------------------------------------------------------
	// Megaudit F1 (2026-05-13): anti-regression for the snake↔camel
	// capabilities transform. If a future provider refactor stops
	// calling `mapDaemonCapsForInit` and forwards the raw daemon
	// payload, snake_case keys reach `validateDaemonCapabilities` which
	// must refuse them with a targeted error message — NOT silently
	// pass them through as unknown extras.
	// -----------------------------------------------------------------
	test('F1: rejects init.capabilities with snake_case transform_kinds (second branch)', () => {
		// Cover the second alias in the loop — a regression that
		// short-circuits on the first match alone wouldn't catch this.
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec,
			capabilities: {
				daemonVersion: 7,
				transform_kinds: [], chartFamilies: [],
			},
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.match(r.error, /snake_case key 'transform_kinds'/);
		}
	});

	test('F1: rejects init.capabilities with snake_case daemon_version', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec,
			capabilities: {
				daemon_version: 7,
				transform_kinds: [], chart_families: [],
			},
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.match(r.error, /snake_case key 'daemon_version'/);
		}
	});

	test('F1: rejects init.capabilities.inspector with snake_case preview_offset', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec,
			capabilities: {
				daemonVersion: 7,
				transformKinds: [], chartFamilies: [],
				inspector: {
					preview_offset: true,
					column_stats: false,
					aggregate_filters: false,
				},
			},
		}));
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.match(r.error, /inspector.*snake_case key 'preview_offset'/);
		}
	});

	test('F1: accepts init.capabilities with proper camelCase shape', () => {
		const spec = validSpec();
		const r = validateExtensionMessage(initEnv({
			type: 'init', specHash: computeSpecHash(spec),
			fsPath: '/x', spec,
			capabilities: {
				daemonVersion: 7,
				transformKinds: ['filter'], chartFamilies: ['timeseries'],
				inspector: {
					previewOffset: true,
					columnStats: false,
					aggregateFilters: false,
				},
			},
		}));
		assert.strictEqual(r.ok, true,
			r.ok ? '' : `expected ok but failed: ${r.error}`);
	});

});

// ---------------------------------------------------------------------------
// webview → extension messages
// ---------------------------------------------------------------------------

suite('messageProtocol -- webview messages', () => {

	test('ready: bare envelope validates', () => {
		assert.strictEqual(validateWebviewMessage(env({ type: 'ready' })).ok, true);
	});

	test('requestData: requires valid spec + specHash', () => {
		const spec = validSpec();
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'requestData', specHash: computeSpecHash(spec), spec,
			})).ok,
			true,
		);
		// Missing specHash
		assert.strictEqual(
			validateWebviewMessage(env({ type: 'requestData', spec })).ok,
			false,
		);
		// Non-object spec
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'requestData', specHash: VALID_SPEC_HASH, spec: 'string',
			})).ok,
			false,
		);
		// Invalid (per QvizSpec validator) spec
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'requestData', specHash: VALID_SPEC_HASH,
				spec: { qviz_version: 1 },
			})).ok,
			false,
		);
	});

	test('edit: requires valid spec + specHash + non-empty label', () => {
		const spec = validSpec();
		const sh = computeSpecHash(spec);
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'edit', specHash: sh, spec, label: 'add x',
			})).ok,
			true,
		);
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'edit', specHash: sh, spec,
			})).ok,
			false,
		);
		assert.strictEqual(
			validateWebviewMessage(env({
				type: 'edit', specHash: sh, spec, label: '',
			})).ok,
			false,
		);
	});

	test('edit / save / saveAs / requestData: REJECT specHash mismatch (recompute on receive)', () => {
		// Step C megaudit C11: each spec-bearing webview message MUST
		// have its envelope.specHash verified against computeSpecHash
		// of the actual spec.
		const spec = validSpec();
		const wrongHash = SPEC_HASH_PREFIX + '0123456789abcdef';
		assert.notStrictEqual(wrongHash, computeSpecHash(spec));
		for (const t of ['requestData', 'save', 'saveAs']) {
			const r = validateWebviewMessage(env({
				type: t, specHash: wrongHash, spec,
			}));
			assert.strictEqual(r.ok, false, `${t} must reject mismatched specHash`);
			if (!r.ok) {
				assert.ok(/specHash does not match/.test(r.error),
					`${t}: expected hash-mismatch error, got ${r.error}`);
			}
		}
		// edit also requires label.
		const editR = validateWebviewMessage(env({
			type: 'edit', specHash: wrongHash, spec, label: 'whatever',
		}));
		assert.strictEqual(editR.ok, false);
	});

	test('save / saveAs: happy path + invalid spec rejects', () => {
		const spec = validSpec();
		const sh = computeSpecHash(spec);
		for (const t of ['save', 'saveAs']) {
			assert.strictEqual(
				validateWebviewMessage(env({ type: t, specHash: sh, spec })).ok,
				true,
				`type=${t} must validate`,
			);
			assert.strictEqual(
				validateWebviewMessage(env({ type: t, specHash: sh, spec: { qviz_version: 1 } })).ok,
				false,
				`type=${t} must reject malformed spec`,
			);
		}
	});

	test('openSpec / discardChanges: bare envelope validates', () => {
		assert.strictEqual(validateWebviewMessage(env({ type: 'openSpec' })).ok, true);
		assert.strictEqual(validateWebviewMessage(env({ type: 'discardChanges' })).ok, true);
	});

	test('retryDaemon / recheckDataset: bare envelope validates (Phase 8 Step D)', () => {
		// New webview-to-host messages introduced for retry buttons on
		// the daemon-status / dataset-status banners. Bare envelopes —
		// no payload beyond protocolVersion + requestId.
		assert.strictEqual(validateWebviewMessage(env({ type: 'retryDaemon' })).ok, true);
		assert.strictEqual(validateWebviewMessage(env({ type: 'recheckDataset' })).ok, true);
	});

	test('promoteToChart: bare envelope validates (Visualise v2)', () => {
		// Visualise v2 introduces a webview -> host message that asks the
		// provider to scaffold a .py and open it in the Chart view.
		// Bare envelope -- the provider derives document context from
		// the panel that posted the message.
		assert.strictEqual(validateWebviewMessage(env({ type: 'promoteToChart' })).ok, true);
	});

});

// ---------------------------------------------------------------------------
// computeSpecHash
// ---------------------------------------------------------------------------

suite('messageProtocol.computeSpecHash', () => {

	test('matches the documented format', () => {
		const h = computeSpecHash(validSpec());
		assert.ok(SPEC_HASH_RE.test(h), `'${h}' should match ${SPEC_HASH_RE}`);
	});

	test('is deterministic for the same spec', () => {
		const a = computeSpecHash(validSpec({ title: 'X' }));
		const b = computeSpecHash(validSpec({ title: 'X' }));
		assert.strictEqual(a, b);
	});

	test('is property-order independent (canonical hashing)', () => {
		// Build the same logical spec with different property insertion
		// orders. Step B megaudit C12 + Step A's serializedEqual bug.
		const a = validSpec({ title: 'X', description: 'Y' });
		// A new object with reversed key insertion order on the chart.
		const reversed: QvizSpec = {
			...a,
			chart: {
				options: undefined,
				encodings: a.chart.encodings,
				type: a.chart.type,
				family: a.chart.family,
			} as QvizSpec['chart'],
		};
		const ha = computeSpecHash(a);
		const hb = computeSpecHash(reversed);
		assert.strictEqual(ha, hb, 'key insertion order must not affect hash');
	});

	test('differs for different specs', () => {
		const a = computeSpecHash(validSpec({ title: 'A' }));
		const b = computeSpecHash(validSpec({ title: 'B' }));
		assert.notStrictEqual(a, b);
	});

	test('changes when transforms change', () => {
		const a = computeSpecHash(validSpec());
		const b = computeSpecHash(validSpec({
			transforms: [{ kind: 'filter', column: 'a', op: '>', value: 0 }],
		}));
		assert.notStrictEqual(a, b);
	});

	test('hash format is acceptable to the envelope validator', () => {
		const h = computeSpecHash(validSpec());
		const r = validateExtensionMessage(env({
			type: 'data', specHash: h,
			arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		}));
		assert.strictEqual(r.ok, true, `hash ${h} should validate as envelope.specHash`);
	});

});

// ---------------------------------------------------------------------------
// Phase 6 — inspector message validators
// ---------------------------------------------------------------------------

suite('messageProtocol -- Phase 6 inspector messages', () => {

	// --- ext → webview: inspectorData ---

	test('inspectorData: minimal valid envelope', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorData',
			arrow: new Uint8Array([1, 2, 3]),
			offset: 0, n: 1, elapsedMs: 5,
		}));
		assert.strictEqual(r.ok, true);
	});

	test('inspectorData: total may be omitted', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorData',
			arrow: new Uint8Array(0), offset: 100, n: 0, elapsedMs: 1,
		}));
		assert.strictEqual(r.ok, true);
	});

	test('inspectorData: rejects non-Uint8Array arrow', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorData',
			arrow: [1, 2, 3], offset: 0, n: 1, elapsedMs: 1,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('inspectorData: rejects negative offset', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorData',
			arrow: new Uint8Array(0), offset: -1, n: 0, elapsedMs: 0,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('inspectorData: rejects non-integer total', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorData',
			arrow: new Uint8Array(0), offset: 0, n: 0, total: 1.5, elapsedMs: 0,
		}));
		assert.strictEqual(r.ok, false);
	});

	// --- ext → webview: inspectorError ---

	test('inspectorError: valid', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorError', error: 'daemon down', errorKind: 'timeout',
		}));
		assert.strictEqual(r.ok, true);
	});

	test('inspectorError: rejects unknown errorKind', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorError', error: 'x', errorKind: 'banana',
		}));
		assert.strictEqual(r.ok, false);
	});

	test('inspectorError: rejects empty error string', () => {
		const r = validateExtensionMessage(env({
			type: 'inspectorError', error: '', errorKind: 'internal',
		}));
		assert.strictEqual(r.ok, false);
	});

	// --- ext → webview: columnStats ---

	test('columnStats: numeric stats validate', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStats', column: 'volume',
			stats: {
				kind: 'numeric', cardinality: 21, cardinalityIsExact: false,
				nullCount: 0, total: 1000, min: 0, max: 999,
			},
		}));
		assert.strictEqual(r.ok, true);
	});

	test('columnStats: low-card includes distinct array', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStats', column: 'ticker',
			stats: {
				kind: 'nominal', cardinality: 3, cardinalityIsExact: true,
				nullCount: 0, total: 300, distinct: ['AAPL', 'MSFT', 'GOOG'],
			},
		}));
		assert.strictEqual(r.ok, true);
	});

	test('columnStats: rejects unknown stats.kind', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStats', column: 'x',
			stats: {
				kind: 'banana', cardinality: 0, cardinalityIsExact: true,
				nullCount: 0, total: 0,
			},
		}));
		assert.strictEqual(r.ok, false);
	});

	test('columnStats: rejects negative cardinality', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStats', column: 'x',
			stats: {
				kind: 'numeric', cardinality: -1, cardinalityIsExact: false,
				nullCount: 0, total: 0,
			},
		}));
		assert.strictEqual(r.ok, false);
	});

	// --- ext → webview: columnStatsError ---

	test('columnStatsError: valid', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStatsError', column: 'x', error: 'not in schema',
		}));
		assert.strictEqual(r.ok, true);
	});

	test('columnStatsError: rejects empty column', () => {
		const r = validateExtensionMessage(env({
			type: 'columnStatsError', column: '', error: 'oops',
		}));
		assert.strictEqual(r.ok, false);
	});

	// --- webview → ext: requestInspectorData ---

	test('requestInspectorData: minimal valid', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
		}));
		assert.strictEqual(r.ok, true);
	});

	test('requestInspectorData: rejects negative offset', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: -1, n: 50,
		}));
		assert.strictEqual(r.ok, false);
	});

	test('requestInspectorData: rejects zero/negative n', () => {
		const rZero = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 0,
		}));
		assert.strictEqual(rZero.ok, false);
		const rNeg = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: -1,
		}));
		assert.strictEqual(rNeg.ok, false);
	});

	test('requestInspectorData: validates inspectorFilters when present', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [
				{ kind: 'range', column: 'a', min: 0, max: 10 },
				{ kind: 'text', column: 'b', contains: 'foo' },
				{ kind: 'set', column: 'c', includes: ['x', 'y'] },
			],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('requestInspectorData: rejects unknown filter kind', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'banana', column: 'a' }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('requestInspectorData: rejects empty column on a filter', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'text', column: '', contains: 'x' }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('requestInspectorData: rejects non-string text.contains', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'text', column: 'a', contains: 42 }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('requestInspectorData: rejects non-array set.includes', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'set', column: 'a', includes: 'oops' }],
		}));
		assert.strictEqual(r.ok, false);
	});

	test('requestInspectorData: rejects non-scalar set.includes entry', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'set', column: 'a', includes: [{ nested: 1 }] }],
		}));
		assert.strictEqual(r.ok, false);
	});

	// Megaudit D8 (2026-05-13): null is a legitimate set member for
	// nullable columns; the validator must let it through. The daemon
	// translates null in the IN-list into `col IS NULL` so SQL NULL
	// rows match without colliding with the literal string `"null"`.
	test('D8: requestInspectorData accepts null in set.includes', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{
				kind: 'set', column: 'a', includes: [null, 'x', 1, true],
			}],
		}));
		assert.strictEqual(r.ok, true,
			r.ok ? '' : `expected ok; got ${r.error}`);
	});

	test('D8: requestInspectorData accepts set with only null', () => {
		const r = validateWebviewMessage(env({
			type: 'requestInspectorData', offset: 0, n: 50,
			inspectorFilters: [{ kind: 'set', column: 'a', includes: [null] }],
		}));
		assert.strictEqual(r.ok, true);
	});

	// --- webview → ext: requestColumnStats ---

	test('requestColumnStats: valid', () => {
		const r = validateWebviewMessage(env({
			type: 'requestColumnStats', column: 'volume',
		}));
		assert.strictEqual(r.ok, true);
	});

	test('requestColumnStats: rejects empty column', () => {
		const r = validateWebviewMessage(env({
			type: 'requestColumnStats', column: '',
		}));
		assert.strictEqual(r.ok, false);
	});

	// --- requestData with inspectorFilters ---

	test('requestData: accepts inspectorFilters: []', () => {
		const spec = validSpec();
		const r = validateWebviewMessage(env({
			type: 'requestData',
			specHash: computeSpecHash(spec),
			spec,
			inspectorFilters: [],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('requestData: accepts a populated inspectorFilters', () => {
		const spec = validSpec();
		const r = validateWebviewMessage(env({
			type: 'requestData',
			specHash: computeSpecHash(spec),
			spec,
			inspectorFilters: [
				{ kind: 'range', column: 'a', min: 0, max: 1 },
			],
		}));
		assert.strictEqual(r.ok, true);
	});

	test('requestData: rejects malformed inspectorFilters entry', () => {
		const spec = validSpec();
		const r = validateWebviewMessage(env({
			type: 'requestData',
			specHash: computeSpecHash(spec),
			spec,
			inspectorFilters: [{ kind: 'range', column: 'a' /* min/max missing */ }],
		}));
		assert.strictEqual(r.ok, false);
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
		seriesPalette: ['#4fc3f7', '#81c784'],
	};
}

function validSchemaInfo(hash: string) {
	return {
		uri: 'data/x.parquet',
		schema_hash: hash,
		mtime_ns: 1,
		row_count: 100,
		columns: [{ name: 'a', dtype: 'float64', nullable: false }],
	};
}
