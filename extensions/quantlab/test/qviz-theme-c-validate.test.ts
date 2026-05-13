/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Theme C — stack/resource/framing tests (TS side: C1 only).
 *
 * C1: parseExpr stack-blow vector — iterative pre-flight depth/node check
 *     BEFORE recursive validateExprAst. Other Theme C items are
 *     Python-side (C2/C3/C4/C5/C6/C7/C8) and have their own tests.
 */

import * as assert from 'assert';

import { validate } from '../src/qviz/validate';
import type { QvizSpec } from '../src/qviz/spec';
import { EXPR_LIMITS } from '../src/qviz/exprAst';

function base(): QvizSpec {
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
			generated_at: '2026-05-13T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

function buildDeepUnary(depth: number): unknown {
	let ast: unknown = { kind: 'col', name: 'x' };
	for (let i = 0; i < depth; i += 1) {
		ast = { kind: 'unary', op: '-', operand: ast };
	}
	return ast;
}

suite('Theme C C1: iterative AST pre-flight rejects 10k-deep input', () => {

	test('AST with 10k nested unaries rejected with depth error', () => {
		const deep = buildDeepUnary(10_000);
		const spec = {
			...base(),
			transforms: [{
				kind: 'expr',
				as: 'evil',
				expression: deep,
				references: ['x'],
			}],
		};
		const r = validate(spec);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /depth exceeds cap/.test(i.message)),
			`expected depth-cap message, got: ${JSON.stringify(r.issues)}`);
	});

	test('AST with maxAstDepth+5 nested binaries rejected (defense in depth)', () => {
		let ast: unknown = { kind: 'num', value: 1 };
		for (let i = 0; i < EXPR_LIMITS.maxAstDepth + 5; i += 1) {
			ast = {
				kind: 'binary', op: '+',
				left: { kind: 'num', value: 1 },
				right: ast,
			};
		}
		const spec = {
			...base(),
			transforms: [{
				kind: 'expr',
				as: 'x',
				expression: ast,
				references: [],
			}],
		};
		const r = validate(spec);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /depth/i.test(i.message)));
	});

	test('AST with 500 args in a single call rejected on node-count', () => {
		const args: unknown[] = [];
		for (let i = 0; i < 500; i += 1) {
			args.push({ kind: 'col', name: `c${i}` });
		}
		const spec = {
			...base(),
			transforms: [{
				kind: 'expr', as: 'x',
				expression: { kind: 'call', fn: 'coalesce', args },
				references: args.map((_, i) => `c${i}`),
			}],
		};
		const r = validate(spec);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /node count|arity/i.test(i.message)),
			`expected node-count or arity rejection, got: ${JSON.stringify(r.issues)}`);
	});

});
