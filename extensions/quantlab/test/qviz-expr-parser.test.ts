/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the Visualise v2 expression parser.
 *
 * The parser produces an `ExprAst` from user-typed text. Tests cover:
 *   - Atoms (column refs, numeric literals, string literals, bool, null).
 *   - Operator precedence + associativity (Python-style ladder).
 *   - Function calls + arity (whitelisted fns).
 *   - `if (cond) then a else b` ternary.
 *   - Error reporting (position + message).
 *   - Hard caps (input length, AST depth, AST node count).
 *   - Reference collection (column refs deduplicated, in source order).
 */

import * as assert from 'assert';

import { parseExpression } from '../src/qviz/exprParser';
import { EXPR_LIMITS, printExpr, type ExprAst } from '../src/qviz/exprAst';

function parseOk(input: string): { ast: ExprAst; references: readonly string[] } {
	const r = parseExpression(input);
	if (!r.ok) {
		assert.fail(`expected parse to succeed: ${r.error} at position ${r.position}`);
	}
	return r;
}

suite('expression parser -- atoms', () => {

	test('numeric literal: integer', () => {
		const { ast } = parseOk('42');
		assert.deepStrictEqual(ast, { kind: 'num', value: 42 });
	});

	test('numeric literal: decimal + exponent', () => {
		const { ast } = parseOk('1.5e-3');
		assert.strictEqual(ast.kind, 'num');
		if (ast.kind !== 'num') { return; }
		assert.strictEqual(ast.value, 0.0015);
	});

	test('column reference: simple identifier', () => {
		const { ast, references } = parseOk('close');
		assert.deepStrictEqual(ast, { kind: 'col', name: 'close' });
		assert.deepStrictEqual([...references], ['close']);
	});

	test('string literal: single-quoted', () => {
		const { ast } = parseOk("'hello'");
		assert.deepStrictEqual(ast, { kind: 'str', value: 'hello' });
	});

	test('string literal: escapes', () => {
		const { ast } = parseOk("'a\\nb\\\\c'");
		assert.strictEqual(ast.kind, 'str');
		if (ast.kind !== 'str') { return; }
		assert.strictEqual(ast.value, 'a\nb\\c');
	});

	test('bool + null literals', () => {
		assert.deepStrictEqual(parseOk('true').ast, { kind: 'bool', value: true });
		assert.deepStrictEqual(parseOk('false').ast, { kind: 'bool', value: false });
		assert.deepStrictEqual(parseOk('null').ast, { kind: 'null' });
	});

});

suite('expression parser -- operators + precedence', () => {

	test('precedence: arithmetic left-associative, * before +', () => {
		// 2 + 3 * 4 should parse as 2 + (3 * 4).
		const { ast } = parseOk('2 + 3 * 4');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '+');
		assert.deepStrictEqual(ast.left, { kind: 'num', value: 2 });
		assert.strictEqual(ast.right.kind, 'binary');
		if (ast.right.kind !== 'binary') { return; }
		assert.strictEqual(ast.right.op, '*');
	});

	test('precedence: comparison binds tighter than logical', () => {
		// a > b && c > d should parse as (a > b) && (c > d).
		const { ast } = parseOk('a > b && c > d');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '&&');
		assert.strictEqual(ast.left.kind, 'binary');
		assert.strictEqual(ast.right.kind, 'binary');
		if (ast.left.kind !== 'binary' || ast.right.kind !== 'binary') { return; }
		assert.strictEqual(ast.left.op, '>');
		assert.strictEqual(ast.right.op, '>');
	});

	test('precedence: && binds tighter than ||', () => {
		// a || b && c should parse as a || (b && c).
		const { ast } = parseOk('a || b && c');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '||');
		assert.strictEqual(ast.right.kind, 'binary');
		if (ast.right.kind !== 'binary') { return; }
		assert.strictEqual(ast.right.op, '&&');
	});

	test('unary minus binds tighter than multiplication', () => {
		// -a * b should parse as (-a) * b.
		const { ast } = parseOk('-a * b');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '*');
		assert.strictEqual(ast.left.kind, 'unary');
	});

	test('parens override precedence', () => {
		// (2 + 3) * 4 should parse as ((2 + 3) * 4).
		const { ast } = parseOk('(2 + 3) * 4');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '*');
		assert.strictEqual(ast.left.kind, 'binary');
		if (ast.left.kind !== 'binary') { return; }
		assert.strictEqual(ast.left.op, '+');
	});

	test('all comparison ops parse', () => {
		for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
			const { ast } = parseOk(`a ${op} b`);
			assert.strictEqual(ast.kind, 'binary');
			if (ast.kind !== 'binary') { continue; }
			assert.strictEqual(ast.op, op);
		}
	});

	test('logical NOT prefix operator', () => {
		const { ast } = parseOk('!flag');
		assert.deepStrictEqual(ast, { kind: 'unary', op: '!', operand: { kind: 'col', name: 'flag' } });
	});

	test('modulo operator', () => {
		const { ast } = parseOk('a % 2');
		assert.strictEqual(ast.kind, 'binary');
		if (ast.kind !== 'binary') { return; }
		assert.strictEqual(ast.op, '%');
	});

});

suite('expression parser -- function calls', () => {

	test('unary numeric function: abs', () => {
		const { ast } = parseOk('abs(close - open)');
		assert.strictEqual(ast.kind, 'call');
		if (ast.kind !== 'call') { return; }
		assert.strictEqual(ast.fn, 'abs');
		assert.strictEqual(ast.args.length, 1);
		assert.strictEqual(ast.args[0].kind, 'binary');
	});

	test('two-arg function: min', () => {
		const { ast } = parseOk('min(a, b)');
		assert.strictEqual(ast.kind, 'call');
		if (ast.kind !== 'call') { return; }
		assert.strictEqual(ast.fn, 'min');
		assert.strictEqual(ast.args.length, 2);
	});

	test('variadic function: coalesce with 3 args', () => {
		const { ast } = parseOk('coalesce(a, b, c)');
		assert.strictEqual(ast.kind, 'call');
		if (ast.kind !== 'call') { return; }
		assert.strictEqual(ast.fn, 'coalesce');
		assert.strictEqual(ast.args.length, 3);
	});

	test('unknown function rejected with position', () => {
		const r = parseExpression('pow(a, b)');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.includes('unknown function'),
			`error must explain unknown fn, got: ${r.error}`);
		assert.strictEqual(r.position, 0);
	});

	test('H1: arity violation rejected at parser layer (abs takes 1, got 2)', () => {
		const r = parseExpression('abs(a, b)');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/expects 1 arg/.test(r.error),
			`error must explain expected arity, got: ${r.error}`);
	});

	test('H1: zero-arg call to a 1-arg fn rejected at parser layer', () => {
		const r = parseExpression('abs()');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/expects 1 arg/.test(r.error),
			`error must explain expected arity, got: ${r.error}`);
	});

	test('H1: coalesce with too many args rejected', () => {
		const args = Array.from({ length: 33 }, () => 'a').join(', ');
		const r = parseExpression(`coalesce(${args})`);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/1\.\.32/.test(r.error),
			`error must explain expected range, got: ${r.error}`);
	});

});

suite('expression parser -- if/then/else', () => {

	test('basic if-then-else', () => {
		const { ast } = parseOk('if (close > open) then 1 else -1');
		assert.strictEqual(ast.kind, 'if');
		if (ast.kind !== 'if') { return; }
		assert.strictEqual(ast.cond.kind, 'binary');
		assert.strictEqual(ast.then_.kind, 'num');
		assert.strictEqual(ast.else_.kind, 'unary');
	});

	test('nested if', () => {
		const { ast } = parseOk(
			'if (x > 0) then 1 else if (x < 0) then -1 else 0',
		);
		assert.strictEqual(ast.kind, 'if');
		if (ast.kind !== 'if') { return; }
		assert.strictEqual(ast.else_.kind, 'if');
	});

	test('if without then keyword is an error', () => {
		const r = parseExpression('if (x) 1 else 2');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.includes("expected 'then'"),
			`error must mention 'then', got: ${r.error}`);
	});

});

suite('expression parser -- error reporting', () => {

	test('empty input', () => {
		const r = parseExpression('');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.strictEqual(r.position, 0);
	});

	test('unmatched paren reports position', () => {
		const r = parseExpression('(1 + 2');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.position >= 5,
			`position should be at end of input, got ${r.position}`);
	});

	test('trailing input rejected', () => {
		const r = parseExpression('1 + 2 garbage');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.includes('unexpected trailing input'),
			`error should mention trailing input, got: ${r.error}`);
	});

	test('input over length cap rejected', () => {
		const longInput = 'a'.repeat(EXPR_LIMITS.maxInputLength + 1);
		const r = parseExpression(longInput);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.includes(String(EXPR_LIMITS.maxInputLength)),
			`error should mention the cap, got: ${r.error}`);
	});

	test('AST depth cap rejects deeply-nested input', () => {
		// Parens evaporate; binary nodes are what add depth. Build a
		// right-associative chain by forcing parens on the rhs:
		// 1+(1+(1+(1+(...)))). Each layer adds one binary node depth.
		const depth = EXPR_LIMITS.maxAstDepth + 5;
		let input = '1';
		for (let i = 0; i < depth; i += 1) {
			input = `1+(${input})`;
		}
		const r = parseExpression(input);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.toLowerCase().includes('depth'),
			`error should mention depth, got: ${r.error}`);
	});

});

suite('expression parser -- backtick-quoted identifiers (M1/L1)', () => {

	test('backtick wraps a non-ASCII name', () => {
		const r = parseExpression('`price_€`');
		assert.ok(r.ok, !r.ok ? r.error : '');
		if (!r.ok) { return; }
		assert.deepStrictEqual(r.ast, { kind: 'col', name: 'price_€' });
		assert.deepStrictEqual([...r.references], ['price_€']);
	});

	test('backtick wraps a name with a space', () => {
		const r = parseExpression('`mid price`');
		assert.ok(r.ok, !r.ok ? r.error : '');
		if (!r.ok) { return; }
		assert.deepStrictEqual(r.ast, { kind: 'col', name: 'mid price' });
	});

	test('backtick reaches a reserved-word column name (L1)', () => {
		const r = parseExpression('`if` + `null`');
		assert.ok(r.ok, !r.ok ? r.error : '');
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'binary');
		assert.deepStrictEqual([...r.references], ['if', 'null']);
	});

	test('doubled backtick escapes a literal backtick in the name', () => {
		const r = parseExpression('`weird``name`');
		assert.ok(r.ok, !r.ok ? r.error : '');
		if (!r.ok) { return; }
		assert.deepStrictEqual(r.ast, { kind: 'col', name: 'weird`name' });
	});

	test('empty backticks rejected', () => {
		const r = parseExpression('``');
		assert.strictEqual(r.ok, false);
	});

	test('unterminated backtick rejected', () => {
		const r = parseExpression('`mid price + 1');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/unterminated/.test(r.error));
	});

});

suite('expression parser -- numeric edge cases (M6/L5)', () => {

	test('M6: trailing dot rejected', () => {
		const r = parseExpression('5.');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/decimal point/.test(r.error),
			`error must mention decimal point, got: ${r.error}`);
	});

	test('M6: `5.0` parses fine', () => {
		const r = parseExpression('5.0');
		assert.ok(r.ok);
	});

	test('L5: parser preserves source form for decimals', () => {
		const r = parseExpression('5.0');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'num');
		if (r.ast.kind !== 'num') { return; }
		assert.strictEqual(r.ast.source, '5.0');
	});

	test('L5: integer literal has no source field (compact)', () => {
		const r = parseExpression('42');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'num');
		if (r.ast.kind !== 'num') { return; }
		assert.strictEqual(r.ast.source, undefined);
	});

	test('Codex 2nd-pass MEDIUM: leading-dot `.5` round-trips through parser AND validator', () => {
		// Parser produces `.5` source from `parsePrimary`'s leading-dot
		// lookahead. The validator regex must accept the same grammar.
		const r = parseExpression('.5');
		assert.ok(r.ok, !r.ok ? r.error : '');
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'num');
		if (r.ast.kind !== 'num') { return; }
		assert.strictEqual(r.ast.value, 0.5);
		assert.strictEqual(r.ast.source, '.5');

		// And the validator must accept this same AST shape.
		const { validate } = require('../src/qviz/validate');
		const spec = {
			qviz_version: 1,
			dataset: { uri: 'data/x.parquet', schema_hash: 'sha256:' + 'a'.repeat(64), mtime_ns: 1 },
			transforms: [{
				kind: 'expr', as: 'half',
				expression: { kind: 'num', value: 0.5, source: '.5' },
				references: [],
			}],
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
		const r2 = validate(spec);
		assert.strictEqual(r2.ok, true,
			`validator must accept leading-dot decimal, got: ${!r2.ok ? JSON.stringify(r2.issues) : ''}`);
	});

	test('Codex 2nd-pass MEDIUM: `.5e2` (leading dot + exponent) round-trips', () => {
		const r = parseExpression('.5e2');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'num');
		if (r.ast.kind !== 'num') { return; }
		assert.strictEqual(r.ast.value, 50);
	});

	test('Codex 2nd-pass LOW: parser caps source-form length at 64', () => {
		// 65-char decimal literal: `0.` + 63 nines.
		const longLit = '0.' + '9'.repeat(63);
		assert.strictEqual(longLit.length, 65);
		const r = parseExpression(longLit);
		assert.strictEqual(r.ok, false, 'parser must reject literals over 64 chars');
		if (r.ok) { return; }
		assert.ok(/too long|cap 64/.test(r.error),
			`error must mention the cap, got: ${r.error}`);
	});

});

suite('expression parser -- Unicode whitespace tolerance', () => {

	test('L2: integer literal beyond Number.MAX_SAFE_INTEGER is rejected', () => {
		// `9999999999999999` (16 9s) rounds to 10000000000000000 in IEEE-754.
		const r = parseExpression('9999999999999999');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/safe range|2\^53/.test(r.error),
			`error must explain safe-range, got: ${r.error}`);
	});

	test('L2: same magnitude as exponent literal IS accepted', () => {
		// User opts into precision loss with exponent notation.
		const r = parseExpression('1e16');
		assert.ok(r.ok, 'exponent form must be accepted even if value is large');
	});

	test('L3: NBSP between tokens is treated as whitespace', () => {
		// NBSP (U+00A0) often slips in via Word/web copy-paste.
		const r = parseExpression('close + open');
		assert.ok(r.ok, `NBSP-separated tokens must parse: ${!r.ok ? r.error : ''}`);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'binary');
	});

	test('L3: EN/EM/THIN/NARROW/IDEOGRAPHIC space all tolerated', () => {
		for (const sep of [' ', ' ', ' ', ' ', '　']) {
			const r = parseExpression(`a${sep}+${sep}b`);
			assert.ok(r.ok, `separator U+${sep.charCodeAt(0).toString(16).toUpperCase()} should be whitespace`);
		}
	});

});

suite('expression parser -- column-ref collection', () => {

	test('refs deduplicate, preserve source order', () => {
		const { references } = parseOk('close - open + close');
		assert.deepStrictEqual([...references], ['close', 'open']);
	});

	test('refs include columns from nested function call', () => {
		const { references } = parseOk('abs(close - open) + min(high, low)');
		assert.deepStrictEqual([...references], ['close', 'open', 'high', 'low']);
	});

	test('refs do not include reserved words', () => {
		const { references } = parseOk(
			'if (close > open) then close else open',
		);
		assert.deepStrictEqual([...references], ['close', 'open']);
		// 'if', 'then', 'else', 'true', 'false', 'null' must NOT appear.
		assert.ok(!references.includes('if'));
		assert.ok(!references.includes('then'));
	});

});

suite('expression parser -- printExpr round-trip', () => {

	const inputs = [
		'42',
		'1.5e-3',
		'5.0',
		'close',
		"'AAPL'",
		"'with \\'quote\\' inside'",
		"'with \\\\ backslash'",
		'true',
		'null',
		'(close - open) / open',
		'abs(close - open)',
		'min(high, low)',
		'coalesce(volume, 0)',
		'if (close > open) then 1 else -1',
		'if (x > 0) then 1 else if (x < 0) then -1 else 0',
		'!flag && (a > b || c == d)',
		'a % 2 == 0',
		// M1: backtick-quoted column names round-trip.
		'`mid price`',
		'`weird``name` + 1',
		'`if` * `null`',
	];

	for (const input of inputs) {
		test(`round-trip stable: ${input}`, () => {
			const r1 = parseExpression(input);
			assert.ok(r1.ok, `first parse failed: ${!r1.ok ? r1.error : ''}`);
			if (!r1.ok) { return; }
			const printed = printExpr(r1.ast);
			const r2 = parseExpression(printed);
			assert.ok(r2.ok,
				`printed form not re-parseable: ${!r2.ok ? r2.error : ''}\nprinted: ${printed}`);
			if (!r2.ok) { return; }
			assert.deepStrictEqual(r2.ast, r1.ast,
				`round-trip changed AST. printed: ${printed}`);
		});
	}

	test('M9: precedence-aware printer drops redundant parens', () => {
		// User-typed: ((close - open) / open) -- parser drops outer paren
		// since it's around a primary; AST = binary(/, binary(-, close, open), open).
		// Printer should emit `(close - open) / open` -- inner parens kept
		// because `-` is lower precedence than `/`, but no outer parens.
		const r = parseExpression('(close - open) / open');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		const printed = printExpr(r.ast);
		assert.strictEqual(printed, '(close - open) / open',
			`printer should preserve minimal parens, got: ${printed}`);
	});

	test('M9: same-precedence left-associative chain prints without redundant parens', () => {
		// a + b + c is left-associative: parser produces binary(+, binary(+, a, b), c).
		// Printer should emit `a + b + c` -- no parens.
		const r = parseExpression('a + b + c');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(printExpr(r.ast), 'a + b + c');
	});

	test('M9: comparison vs logical precedence', () => {
		const r = parseExpression('a > b && c > d');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		// No parens needed: comparison binds tighter than &&.
		assert.strictEqual(printExpr(r.ast), 'a > b && c > d');
	});

	test('M9: explicit grouping that lowers precedence is preserved', () => {
		const r = parseExpression('a * (b + c)');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		// Inner `b + c` must keep its parens because + < *.
		assert.strictEqual(printExpr(r.ast), 'a * (b + c)');
	});

	// Codex audit findings (2026-05-12): the precedence printer had
	// three holes that broke round-trip stability. Each of these
	// expressions must print to text that re-parses to the SAME AST.

	test('Codex MEDIUM-1: (!a) == b round-trips with explicit parens', () => {
		// AST: binary(==, unary(!, a), b).
		// Previous buggy printer: `!a == b` (parser reads as !(a == b)).
		const r1 = parseExpression('(!a) == b');
		assert.ok(r1.ok);
		if (!r1.ok) { return; }
		const printed = printExpr(r1.ast);
		const r2 = parseExpression(printed);
		assert.ok(r2.ok, `printed form must re-parse: ${!r2.ok ? r2.error : ''} (got: ${printed})`);
		if (!r2.ok) { return; }
		assert.deepStrictEqual(r2.ast, r1.ast);
	});

	test('Codex MEDIUM-2: (a < b) == true round-trips (comparison non-chainable)', () => {
		// AST: binary(==, binary(<, a, b), bool(true)).
		// Previous buggy printer: `a < b == true` (parser rejects: comparison non-chainable).
		const r1 = parseExpression('(a < b) == true');
		assert.ok(r1.ok);
		if (!r1.ok) { return; }
		const printed = printExpr(r1.ast);
		const r2 = parseExpression(printed);
		assert.ok(r2.ok, `printed form must re-parse: ${!r2.ok ? r2.error : ''} (got: ${printed})`);
		if (!r2.ok) { return; }
		assert.deepStrictEqual(r2.ast, r1.ast);
	});

	test('Codex MEDIUM-3: (if (c) then a else b) + d round-trips with grouping', () => {
		// AST: binary(+, if(c, a, b), d).
		// Previous buggy printer: `if (c) then a else b + d`
		//   (parser reads as: if (c) then a else (b + d)).
		const r1 = parseExpression('(if (c) then a else b) + d');
		assert.ok(r1.ok);
		if (!r1.ok) { return; }
		const printed = printExpr(r1.ast);
		const r2 = parseExpression(printed);
		assert.ok(r2.ok, `printed form must re-parse: ${!r2.ok ? r2.error : ''} (got: ${printed})`);
		if (!r2.ok) { return; }
		assert.deepStrictEqual(r2.ast, r1.ast);
	});

	test('Codex MEDIUM: !a == b parses as !(a == b) and round-trips', () => {
		// Make sure the OTHER grouping (which the previous buggy printer
		// AGREED with) still works after the fix.
		const r1 = parseExpression('!a == b');
		assert.ok(r1.ok);
		if (!r1.ok) { return; }
		assert.strictEqual(r1.ast.kind, 'unary');  // outer is !
		const printed = printExpr(r1.ast);
		const r2 = parseExpression(printed);
		assert.ok(r2.ok);
		if (!r2.ok) { return; }
		assert.deepStrictEqual(r2.ast, r1.ast);
	});

});

suite('expression parser -- Codex second-pass coverage', () => {

	// Nested unaries and unary-of-clause round-trip.
	const cases = [
		'--a',
		'!(if (c) then a else b)',
		'if (c) then !a else b',
		'coalesce(if (c) then a else b, 0)',
		'min(a, if (c) then b else d)',
		'!!flag',
		'-(-a)',
		'-abs(a)',
		'if (close > open) then abs(close - open) else 0',
	];
	for (const input of cases) {
		test(`Codex coverage: round-trip ${input}`, () => {
			const r1 = parseExpression(input);
			assert.ok(r1.ok, `parse 1 failed: ${!r1.ok ? r1.error : ''}`);
			if (!r1.ok) { return; }
			const printed = printExpr(r1.ast);
			const r2 = parseExpression(printed);
			assert.ok(r2.ok, `parse 2 failed for printed="${printed}": ${!r2.ok ? r2.error : ''}`);
			if (!r2.ok) { return; }
			assert.deepStrictEqual(r2.ast, r1.ast,
				`AST changed via printed="${printed}"`);
		});
	}

	test('Codex Q4: single backtick inside name without doubling produces trailing-input error', () => {
		// `a`b` parses up to first closing backtick → col{a}, then
		// rejects trailing `b` ` with a clear error. NOT silent
		// truncation.
		const r = parseExpression('`a`b`');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		// Position should be past the first closing backtick.
		assert.ok(r.position >= 3,
			`error should point past the first closing backtick, got pos=${r.position}`);
	});

});

suite('expression parser -- num.source validation (Codex HIGH)', () => {

	test('validator rejects num.source that does not parse to value', () => {
		// Crafted AST: value=1 but source='close' (would render as `close`
		// in the form but bind `1` at the daemon). The validator MUST
		// reject this divergence at the wire boundary.
		const { validate } = require('../src/qviz/validate');
		const spec = {
			qviz_version: 1,
			dataset: { uri: 'data/x.parquet', schema_hash: 'sha256:' + 'a'.repeat(64), mtime_ns: 1 },
			transforms: [{
				kind: 'expr', as: 'evil',
				expression: { kind: 'num', value: 1, source: 'close' },
				references: [],
			}],
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
		const r = validate(spec);
		assert.strictEqual(r.ok, false, 'value-source divergence must be rejected');
	});

	test('validator accepts num.source that DOES parse to value', () => {
		const { validate } = require('../src/qviz/validate');
		const spec = {
			qviz_version: 1,
			dataset: { uri: 'data/x.parquet', schema_hash: 'sha256:' + 'a'.repeat(64), mtime_ns: 1 },
			transforms: [{
				kind: 'expr', as: 'half',
				expression: { kind: 'num', value: 0.5, source: '0.5' },
				references: [],
			}],
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
		const r = validate(spec);
		assert.strictEqual(r.ok, true, `expected ok, got: ${!r.ok ? JSON.stringify(r.issues) : ''}`);
	});

});

suite('expression parser -- realistic quant expressions', () => {

	test('pnl_pct = (close - open) / open', () => {
		const r = parseExpression('(close - open) / open');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'binary');
	});

	test('regime: if (vol > 0.3) then 1 else 0', () => {
		const r = parseExpression('if (vol > 0.3) then 1 else 0');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.ast.kind, 'if');
	});

	test('signed_volume = if (close > open) then volume else -volume', () => {
		const r = parseExpression('if (close > open) then volume else -volume');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.deepStrictEqual([...r.references], ['close', 'open', 'volume']);
	});

	test('mid = (high + low) / 2', () => {
		const r = parseExpression('(high + low) / 2');
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.deepStrictEqual([...r.references], ['high', 'low']);
	});

});
