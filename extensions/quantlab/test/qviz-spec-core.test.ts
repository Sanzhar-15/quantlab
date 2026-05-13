/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for qviz/specCore.
 *
 * The core (load/validate/serialize) is intentionally vscode-free so it can
 * be exhaustively tested from plain mocha. The vscode-side QvizSpecDocument
 * is a thin adapter; its lifecycle (applyEdit / undo / saveAs / revert /
 * dispose) is tested in qviz-spec-doc-core.test.ts via the same vscode-free
 * core class.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { parseSpecBytes, serializeSpec, validateEdit } from '../src/qviz/specCore';
import type { QvizSpec, Transform } from '../src/qviz/spec';

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

function bytesOf(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// parseSpecBytes
// ---------------------------------------------------------------------------

suite('specCore.parseSpecBytes', () => {

	test('round-trips a valid spec', () => {
		const spec = validSpec({ title: 'round-trip' });
		const bytes = serializeSpec(spec);
		const reloaded = parseSpecBytes(bytes, 'test://round-trip');
		assert.strictEqual(reloaded.title, 'round-trip');
		assert.strictEqual(reloaded.chart.type, 'scatter');
		assert.deepStrictEqual(reloaded.dataset.uri, 'data/x.parquet');
	});

	test('rejects malformed JSON loudly', () => {
		assert.throws(
			() => parseSpecBytes(bytesOf('{ this is not json'), 'test://bad'),
			(e: Error) => /not valid JSON/.test(e.message) && /test:\/\/bad/.test(e.message)
		);
	});

	test('rejects invalid UTF-8 loudly', () => {
		const bytes = new Uint8Array([0xC0, 0xC0, 0xC0]);
		assert.throws(
			() => parseSpecBytes(bytes, 'test://bad-utf8'),
			(e: Error) => /not valid UTF-8/.test(e.message)
		);
	});

	test('rejects semantically invalid spec via the validator', () => {
		const broken = { ...validSpec(), provenance: undefined };
		const bytes = bytesOf(JSON.stringify(broken));
		assert.throws(
			() => parseSpecBytes(bytes, 'test://invalid'),
			(e: Error) => /invalid qviz spec/.test(e.message) && /provenance/.test(e.message)
		);
	});

	test('rejects wrong qviz_version', () => {
		const wrongVersion = { ...validSpec(), qviz_version: 2 };
		const bytes = bytesOf(JSON.stringify(wrongVersion));
		assert.throws(
			() => parseSpecBytes(bytes, 'test://v2'),
			/qviz_version/
		);
	});

	test('audit-fix M13: accepts BOM-prefixed UTF-8', () => {
		// Windows editors prepend U+FEFF (encoded as 0xEF 0xBB 0xBF). A
		// strict UTF-8 decoder normally strips it; this test pins the
		// behavior so a future Node bump that surfaces the BOM as a
		// SyntaxError ("Unexpected token  in JSON at position 0") doesn't
		// silently break Windows-edited files.
		const json = JSON.stringify(validSpec());
		const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
		const body = new TextEncoder().encode(json);
		const buf = new Uint8Array(bom.length + body.length);
		buf.set(bom, 0); buf.set(body, bom.length);
		const reloaded = parseSpecBytes(buf, 'test://bom');
		assert.strictEqual(reloaded.qviz_version, 1);
	});

	test('audit-fix M13: validator failure-path coverage', () => {
		// Each entry: (mutator, regex of expected error message). A spec
		// that fails validation must throw with a message naming the
		// path. Add new validator branches here to keep this matrix
		// comprehensive.
		const cases: Array<{ name: string; mutate: (s: QvizSpec) => unknown; expect: RegExp }> = [
			{ name: 'absolute dataset uri', mutate: s => ({ ...s, dataset: { ...s.dataset, uri: '/abs/path.parquet' } }), expect: /uri.*workspace-relative/ },
			{ name: 'dataset uri with ..', mutate: s => ({ ...s, dataset: { ...s.dataset, uri: '../escape.parquet' } }), expect: /uri.*escape/ },
			{ name: 'empty dataset uri', mutate: s => ({ ...s, dataset: { ...s.dataset, uri: '' } }), expect: /uri.*empty/ },
			{ name: 'malformed schema_hash', mutate: s => ({ ...s, dataset: { ...s.dataset, schema_hash: 'not-a-hash' } }), expect: /schema_hash/ },
			{ name: 'unknown transform kind', mutate: s => ({ ...s, transforms: [{ kind: 'invent_a_transform' }] }), expect: /unknown transform kind/ },
			{ name: 'empty groupby columns', mutate: s => ({ ...s, transforms: [{ kind: 'groupby', columns: [] }] }), expect: /columns.*not be empty/ },
			{ name: 'aggregate with empty aggs', mutate: s => ({ ...s, transforms: [{ kind: 'aggregate', aggs: [] }] }), expect: /aggs.*at least one/ },
			{ name: 'bin n_bins out of range (low)', mutate: s => ({ ...s, transforms: [{ kind: 'bin', column: 'x', n_bins: 1, as: 'b' }] }), expect: /n_bins.*2..1000/ },
			{ name: 'bin n_bins out of range (high)', mutate: s => ({ ...s, transforms: [{ kind: 'bin', column: 'x', n_bins: 9999, as: 'b' }] }), expect: /n_bins/ },
			{ name: 'limit n out of range', mutate: s => ({ ...s, transforms: [{ kind: 'limit', n: 0 }] }), expect: /n.*1..10000000/ },
			{ name: 'chart type not allowed in family', mutate: s => ({ ...s, chart: { ...s.chart, family: 'general', type: 'candlestick' } }), expect: /not allowed in family/ },
			// Smoke-test fix (2026-05-11): per-chart-type encoding completeness
			// checks (e.g. "line chart requires x and y", "candlestick requires
			// ohlcv") moved from the validator to the compiler / renderer. The
			// validator-level cases that used to live here (candlestick missing
			// ohlcv, heatmap missing color, pie missing color) are now covered
			// by `qviz-render-timeseries.test.ts` and `qviz-render-general.test.ts`
			// which assert `CompilePlanError` / `CompileGeneralPlanError` are
			// raised at render time. Keeping them at the validator level created
			// a UX hazard: every intermediate state during column-drag building
			// (line chart with x but not yet y) toasted an error to the user.
			{ name: 'missing provenance', mutate: s => { const c = { ...s } as Record<string, unknown>; delete c.provenance; return c; }, expect: /provenance/ },
		];
		for (const c of cases) {
			const bytes = bytesOf(JSON.stringify(c.mutate(validSpec())));
			assert.throws(
				() => parseSpecBytes(bytes, `test://${c.name.replace(/\s/g, '-')}`),
				(e: Error) => c.expect.test(e.message),
				`case "${c.name}" did not throw with expected message`
			);
		}
	});

});

// ---------------------------------------------------------------------------
// validateEdit
// ---------------------------------------------------------------------------

suite('specCore.validateEdit', () => {

	test('accepts a valid spec', () => {
		const r = validateEdit(validSpec({ title: 'edited' }));
		assert.strictEqual(r.ok, true);
		if (r.ok) { assert.strictEqual(r.spec.title, 'edited'); }
	});

	test('rejects a spec with an invalid version', () => {
		const broken = { ...validSpec(), qviz_version: 99 } as unknown as QvizSpec;
		const r = validateEdit(broken);
		assert.strictEqual(r.ok, false);
		if (!r.ok) { assert.ok(/qviz_version/.test(r.error)); }
	});

	test('rejects a spec with chart-type/family incompatibility', () => {
		const broken: QvizSpec = {
			...validSpec(),
			chart: {
				family: 'general',
				type: 'candlestick',
				encodings: {
					ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		};
		const r = validateEdit(broken);
		assert.strictEqual(r.ok, false);
	});

	test('audit-fix M13: accepts an unchanged spec (no monotonicity check)', () => {
		// validateEdit is concerned only with "is this a valid spec?", not
		// "is this different from the previous one?". The webview reducer
		// is the gatekeeper for changes; the document layer enforces
		// validity.
		const same = validSpec();
		const r = validateEdit(same);
		assert.strictEqual(r.ok, true);
	});

});

// ---------------------------------------------------------------------------
// serializeSpec
// ---------------------------------------------------------------------------

suite('specCore.serializeSpec', () => {

	test('emits 2-space-indented JSON with trailing newline', () => {
		const spec = validSpec({ title: 'indent test' });
		const bytes = serializeSpec(spec);
		const text = new TextDecoder().decode(bytes);
		assert.ok(text.endsWith('\n'), 'serialized output must end with \\n');
		assert.ok(/\n  "qviz_version":/.test(text), 'must use 2-space indent');
	});

	test('audit-fix M13: serialization is deterministic', () => {
		// Same input MUST produce byte-identical output, otherwise saving
		// a freshly-loaded spec would create unnecessary git churn.
		const spec = validSpec({ title: 'determinism' });
		const a = serializeSpec(spec);
		const b = serializeSpec(spec);
		assert.deepStrictEqual(Array.from(a), Array.from(b));
	});

	test('round-trip preserves a representative spec', () => {
		const spec = validSpec({
			title: 'rich',
			description: 'a description',
			transforms: [
				{ kind: 'date_trunc', column: 't', unit: 'day', as: 'day' },
				{ kind: 'groupby', columns: ['day'] },
				{ kind: 'aggregate', aggs: [{ column: 'b', fn: 'sum', as: 'b_sum' }] },
			],
			trading_options: { timezone: 'America/New_York', session: 'regular' },
		});
		const bytes = serializeSpec(spec);
		const reloaded = parseSpecBytes(bytes, 'test://rich');
		assert.strictEqual(reloaded.title, 'rich');
		assert.strictEqual(reloaded.description, 'a description');
		assert.strictEqual(reloaded.transforms.length, 3);
		assert.strictEqual(reloaded.trading_options?.timezone, 'America/New_York');
	});

	test('audit-fix M13: round-trip every IMPLEMENTED transform kind', () => {
		// Each transform kind must round-trip: serialize -> parse produces
		// the same canonical form, twice over. The validator normalizes
		// optional fields (e.g. adds `periods: undefined` to math), so we
		// canonicalize once, then assert canonical == round-tripped.
		//
		// `resample` is excluded: validator-compiler coordination (Step C
		// follow-up) rejects it until the daemon compiler implements it.
		// Same for `window.fn='ema'` and `bin.strategy='equal_freq'`.
		// When those land in the compiler, add them back to this matrix.
		// Megaudit M-30: pipeline-order validation now also runs at
		// parseSpecBytes (was UI-only). A standalone `groupby` is no
		// longer round-trip valid because it has no following
		// `aggregate`. Group `groupby` + `aggregate` together; every
		// other kind round-trips solo.
		const transforms: Transform[][] = [
			[{ kind: 'filter', column: 'x', op: '>', value: 5 }],
			[{ kind: 'date_trunc', column: 't', unit: 'day', as: 'day' }],
			[{ kind: 'bin', column: 'x', n_bins: 50, strategy: 'equal_width', as: 'b' }],
			[
				{ kind: 'groupby', columns: ['day'] },
				{ kind: 'aggregate', aggs: [{ column: 'x', fn: 'mean', as: 'x_avg' }] },
			],
			[{ kind: 'window', column: 'x', fn: 'rolling_mean', window: 5, order_by: 't', as: 'roll' }],
			[{ kind: 'math', column: 'x', fn: 'log_returns', order_by: 't', as: 'r' }],
			[{ kind: 'tz_convert', column: 't', to_tz: 'America/New_York' }],
			[{ kind: 'sort', columns: [{ column: 't' }] }],
			[{ kind: 'limit', n: 1000, offset: 0 }],
			[{
				kind: 'expr',
				as: 'mid',
				expression: {
					kind: 'binary',
					op: '/',
					left: {
						kind: 'binary',
						op: '+',
						left: { kind: 'col', name: 'high' },
						right: { kind: 'col', name: 'low' },
					},
					right: { kind: 'num', value: 2 },
				},
				references: ['high', 'low'],
			}],
		];
		for (const ts of transforms) {
			const label = ts.map(t => t.kind).join('+');
			const spec = validSpec({ transforms: ts });
			const canonical = parseSpecBytes(serializeSpec(spec), `test://canon-${label}`);
			const reloaded = parseSpecBytes(serializeSpec(canonical), `test://rt-${label}`);
			assert.deepStrictEqual(reloaded, canonical,
				`transform sequence ${label} did not round-trip stably`);
		}
	});

	test('audit-fix M13: round-trip every example spec on disk', () => {
		// The example specs in src/qviz/examples/ are part of the public
		// surface; users build new specs from them. Each MUST round-trip
		// through validate -> serialize -> validate.
		// __dirname at runtime is out/test/ (not test/), so we need TWO
		// `..` segments to climb back to the package root before descending
		// into src/qviz/examples.
		const examplesDir = path.resolve(__dirname, '..', '..', 'src', 'qviz', 'examples');
		const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.qviz.json'));
		assert.ok(files.length > 0, `expected example specs in ${examplesDir}`);
		for (const f of files) {
			const buf = fs.readFileSync(path.join(examplesDir, f));
			const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			const reloaded = parseSpecBytes(bytes, `test://${f}`);
			const re = parseSpecBytes(serializeSpec(reloaded), `test://${f}-rt`);
			assert.deepStrictEqual(re, reloaded, `${f} did not round-trip`);
		}
	});

});
