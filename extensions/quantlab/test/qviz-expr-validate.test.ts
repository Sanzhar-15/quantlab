/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Validator tests for the Visualise v2 `expr` transform.
 *
 * Step B in `Visualise v2 -- Expression language for calculated fields`.
 * Confirms that `validate()` enforces every contract the daemon-side
 * compiler relies on:
 *   - AST shape (only known kinds, ops, fns)
 *   - Function arity
 *   - String/number literal safety (NUL-free strings, finite numbers)
 *   - Depth + node-count caps (defense in depth vs the parser)
 *   - `references` field matches `collectColumnRefs(ast)` exactly
 *   - `as` non-empty + acceptable string
 */

import * as assert from 'assert';

import { validate } from '../src/qviz/validate';
import { EXPR_LIMITS, type ExprAst } from '../src/qviz/exprAst';
import type { QvizSpec, Transform } from '../src/qviz/spec';

function validSpec(transforms: Transform[]): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms,
		chart: {
			family: 'general', type: 'scatter',
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-12T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

/** Build a spec with one `expr` transform; the validator sees raw JSON
 *  so we accept `unknown` -- the round-trip through `validate(...)` enforces
 *  the contract under test. No default parameters: an explicit `undefined`
 *  argument MUST reach the validator (a default would swallow it).  */
function specWithExpr(opts: { expression: unknown; references: unknown; as: unknown }): unknown {
	const spec = validSpec([]);
	const transforms: unknown[] = [
		{ kind: 'expr', as: opts.as, expression: opts.expression, references: opts.references },
	];
	return { ...spec, transforms };
}

const midExpr: ExprAst = {
	kind: 'binary', op: '/',
	left: {
		kind: 'binary', op: '+',
		left: { kind: 'col', name: 'high' },
		right: { kind: 'col', name: 'low' },
	},
	right: { kind: 'num', value: 2 },
};

suite('validate -- expr transform happy paths', () => {

	test('accepts a simple arithmetic AST', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'low'], as: 'mid' }));
		assert.strictEqual(r.ok, true, `expected ok, got: ${!r.ok ? JSON.stringify(r.issues) : ''}`);
	});

	test('accepts a CASE/if-then-else AST', () => {
		const ast: ExprAst = {
			kind: 'if',
			cond: { kind: 'binary', op: '>', left: { kind: 'col', name: 'close' }, right: { kind: 'col', name: 'open' } },
			then_: { kind: 'num', value: 1 },
			else_: { kind: 'unary', op: '-', operand: { kind: 'num', value: 1 } },
		};
		const r = validate(specWithExpr({ expression: ast, references: ['close', 'open'], as: 'signal' }));
		assert.strictEqual(r.ok, true);
	});

	test('accepts a whitelisted function call', () => {
		const ast: ExprAst = {
			kind: 'call', fn: 'coalesce',
			args: [{ kind: 'col', name: 'a' }, { kind: 'col', name: 'b' }, { kind: 'num', value: 0 }],
		};
		const r = validate(specWithExpr({ expression: ast, references: ['a', 'b'], as: 'first_nonnull' }));
		assert.strictEqual(r.ok, true);
	});

});

suite('validate -- expr transform rejects malformed AST', () => {

	test('unknown AST kind rejected', () => {
		const bad = { kind: 'subquery', sql: 'SELECT 1' };
		const r = validate(specWithExpr({ expression: bad, references: [], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /unknown ExprAst kind/.test(i.message)),
			`expected unknown-kind issue, got: ${JSON.stringify(r.issues)}`);
	});

	test('unknown binary op rejected', () => {
		const bad: unknown = {
			kind: 'binary', op: 'NOT IN',
			left: { kind: 'col', name: 'a' },
			right: { kind: 'num', value: 1 },
		};
		const r = validate(specWithExpr({ expression: bad, references: ['a'], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /unknown binary op/.test(i.message)));
	});

	test('unknown function rejected', () => {
		const bad: unknown = {
			kind: 'call', fn: 'exec',
			args: [{ kind: 'str', value: 'DROP TABLE foo' }],
		};
		const r = validate(specWithExpr({ expression: bad, references: [], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /unknown function/.test(i.message)));
	});

	test('function arity violation rejected', () => {
		const bad: unknown = {
			// abs expects exactly 1 arg; give it 2.
			kind: 'call', fn: 'abs',
			args: [{ kind: 'col', name: 'a' }, { kind: 'col', name: 'b' }],
		};
		const r = validate(specWithExpr({ expression: bad, references: ['a', 'b'], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /expects 1 arg/.test(i.message)));
	});

	test('non-finite numeric literal rejected', () => {
		const bad: unknown = { kind: 'num', value: Number.NaN };
		const r = validate(specWithExpr({ expression: bad, references: [], as: 'x' }));
		assert.strictEqual(r.ok, false);
	});

	test('string literal with NUL byte rejected', () => {
		const bad: unknown = { kind: 'str', value: 'evil\x00drop' };
		const r = validate(specWithExpr({ expression: bad, references: [], as: 'x' }));
		assert.strictEqual(r.ok, false);
	});

	test('M3: AST node with __proto__ own-key rejected', () => {
		// JSON.parse produces own-keys when source has `"__proto__":`.
		// We construct the same shape directly to bypass parse.
		const bad: Record<string, unknown> = {};
		Object.defineProperty(bad, 'kind', { value: 'col', enumerable: true });
		Object.defineProperty(bad, 'name', { value: 'high', enumerable: true });
		Object.defineProperty(bad, '__proto__', { value: 'evil', enumerable: true, configurable: true });
		const r = validate(specWithExpr({ expression: bad, references: ['high'], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /__proto__|forbidden/.test(i.message)),
			`expected proto-poll defense, got: ${JSON.stringify(r.issues)}`);
	});

	test('AST that exceeds depth cap rejected (defense in depth)', () => {
		// Build a binary chain that exceeds maxAstDepth without
		// going through the parser.
		let ast: ExprAst = { kind: 'num', value: 1 };
		for (let i = 0; i < EXPR_LIMITS.maxAstDepth + 2; i += 1) {
			ast = { kind: 'binary', op: '+', left: { kind: 'num', value: 1 }, right: ast };
		}
		const r = validate(specWithExpr({ expression: ast, references: [], as: 'x' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /depth/i.test(i.message)));
	});

});

suite('validate -- expr references field cross-check', () => {

	test('references mismatch (extra column) rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'low', 'ghost'], as: 'mid' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /references .* != AST refs/.test(i.message)),
			`expected set-equality mismatch issue, got: ${JSON.stringify(r.issues)}`);
	});

	// Megaudit Theme B (B5, 2026-05-13): references compared as a SET,
	// not an ordered list. Non-Quantlab spec emitters (Python presets,
	// AI codegen, hand-edits) may produce alphabetic / insertion order;
	// the daemon recomputes from the AST anyway.
	test('B5: references in different order ACCEPTED (set equality)', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['low', 'high'], as: 'mid' }));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

	test('B5: duplicate references rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'high', 'low'], as: 'mid' }));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /duplicate references/.test(i.message)));
	});

	test('references mismatch (missing column) rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high'], as: 'mid' }));
		assert.strictEqual(r.ok, false);
	});

	test('empty references with non-col AST accepted', () => {
		const r = validate(specWithExpr({ expression: { kind: 'num', value: 42 }, references: [], as: 'forty_two' }));
		assert.strictEqual(r.ok, true, `expected ok, got: ${!r.ok ? JSON.stringify(r.issues) : ''}`);
	});

});

suite('validate -- expr as-field invariants', () => {

	test('missing as rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'low'], as: undefined }));
		assert.strictEqual(r.ok, false);
	});

	test('non-string as rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'low'], as: 42 }));
		assert.strictEqual(r.ok, false);
	});

	test('as with NUL byte rejected', () => {
		const r = validate(specWithExpr({ expression: midExpr, references: ['high', 'low'], as: 'mi\x00d' }));
		assert.strictEqual(r.ok, false);
	});

});
