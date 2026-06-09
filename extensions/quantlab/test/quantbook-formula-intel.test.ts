/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 formula intelligence -- unit tests for the pure formula-assist core (completion-prefix extraction,
// the prefix filter + ranking, dropdown index navigation, the signature-context scan, and the signature
// label builder). The webview wiring (debounce, dropdown DOM, keyboard interception) is operator smoke;
// this pins the lexical logic the dropdown + hint depend on.

import * as assert from 'assert';

import {
	buildSignatureLabel,
	extractCompletionPrefix,
	filterFunctions,
	findSignatureContext,
	moveActiveIndex,
	type CompletionFunction,
} from '../webview/sheets-webview/formulaIntel';

function fn(canonicalName: string, aliases: string[] = []): CompletionFunction {
	return { canonicalName, aliases };
}

suite('W2 formulaIntel -- extractCompletionPrefix', () => {
	test('non-formula text never completes', () => {
		assert.strictEqual(extractCompletionPrefix('123', 3), null);
		assert.strictEqual(extractCompletionPrefix('hello', 5), null);
		assert.strictEqual(extractCompletionPrefix('', 0), null);
	});

	test('caret right after = yields an empty prefix at the right offsets', () => {
		const r = extractCompletionPrefix('=', 1);
		assert.deepStrictEqual(r, { prefix: '', start: 1, end: 1 });
	});

	test('a function-name run ending at the caret is the prefix', () => {
		assert.deepStrictEqual(extractCompletionPrefix('=SH', 3), { prefix: 'SH', start: 1, end: 3 });
		assert.deepStrictEqual(extractCompletionPrefix('=SUM(A1)+SHARP', 14), { prefix: 'SHARP', start: 9, end: 14 });
	});

	test('lowercase is preserved (the filter upper-cases)', () => {
		assert.deepStrictEqual(extractCompletionPrefix('=sha', 4), { prefix: 'sha', start: 1, end: 4 });
	});

	test('dotted names (T.DIST) are a single token', () => {
		assert.deepStrictEqual(extractCompletionPrefix('=T.DI', 5), { prefix: 'T.DI', start: 1, end: 5 });
	});

	test('caret in the MIDDLE of a name does not complete', () => {
		// "=SUM" caret after "SU" -> next char "M" is a name char -> no completion (would rewrite the tail).
		assert.strictEqual(extractCompletionPrefix('=SUM', 3), null);
	});

	test('a digit-initial run is not a function name', () => {
		assert.strictEqual(extractCompletionPrefix('=2x', 3), null);
		assert.strictEqual(extractCompletionPrefix('=12', 3), null);
	});

	test('leading spaces before = still count as a formula', () => {
		assert.deepStrictEqual(extractCompletionPrefix('  =SH', 5), { prefix: 'SH', start: 3, end: 5 });
	});

	test('an out-of-range caret returns null', () => {
		assert.strictEqual(extractCompletionPrefix('=SH', 99), null);
		assert.strictEqual(extractCompletionPrefix('=SH', -1), null);
	});

	test('caret after an open paren is an empty prefix (post-paren position)', () => {
		assert.deepStrictEqual(extractCompletionPrefix('=SUM(', 5), { prefix: '', start: 5, end: 5 });
	});

	test('inside a double-quoted string literal does NOT complete (Codex MED fold)', () => {
		// ="SU  -- caret after SU but inside the open string -> no completion.
		assert.strictEqual(extractCompletionPrefix('="SU', 4), null);
		// A string that re-closes restores completion AFTER it.
		assert.deepStrictEqual(extractCompletionPrefix('="text"&SU', 10), { prefix: 'SU', start: 8, end: 10 });
	});

	test('inside a single-quoted sheet name does NOT complete (Codex MED fold)', () => {
		assert.strictEqual(extractCompletionPrefix('=\'My Sh', 7), null);
	});

	test('a caret before the = is not a completion position (Codex MED fold)', () => {
		// Leading whitespace before '=' -- caret at offset 1 is before the '='.
		assert.strictEqual(extractCompletionPrefix('  =SH', 1), null);
	});

	test('a doubled-quote escape inside a string keeps the scan INSIDE the string (Codex re-audit LOW)', () => {
		// ="a""b -- the "" is an escaped quote, so the string is still OPEN; SU after would be inside it.
		// caret at end of `="a""bSU` (length 8): still inside the open string -> no completion.
		assert.strictEqual(extractCompletionPrefix('="a""bSU', 8), null);
	});

	test('after a string with an escaped quote properly closes, completion resumes (Codex re-audit LOW)', () => {
		// ="a""b"&SU -- the "" is escaped, the final " closes; &SU is outside -> complete SU.
		assert.deepStrictEqual(extractCompletionPrefix('="a""b"&SU', 10), { prefix: 'SU', start: 8, end: 10 });
	});
});

suite('W2 formulaIntel -- filterFunctions', () => {
	const fns: CompletionFunction[] = [
		fn('SUM'),
		fn('SUMIF'),
		fn('SHARPE'),
		fn('AVERAGE', ['AVG']),
		fn('STDEV'),
	];

	test('prefix match on canonical names, alphabetized', () => {
		const out = filterFunctions(fns, 'SU', 10).map(i => i.matchedName);
		assert.deepStrictEqual(out, ['SUM', 'SUMIF']);
	});

	test('case-insensitive', () => {
		const out = filterFunctions(fns, 'sh', 10).map(i => i.matchedName);
		assert.deepStrictEqual(out, ['SHARPE']);
	});

	test('when the canonical name matches, the function surfaces ONCE under the canonical (no alias dup)', () => {
		// "AV" matches canonical AVERAGE; alias AVG also starts with "AV" but the function is offered once.
		const out = filterFunctions(fns, 'AV', 10);
		assert.deepStrictEqual(out.map(i => i.matchedName), ['AVERAGE']);
		assert.strictEqual(out[0].viaAlias, false);
	});

	test('an alias-only match surfaces the function under the matched alias, ranked after canonical hits', () => {
		const list: CompletionFunction[] = [fn('AVERAGE', ['AVG']), fn('AVGPRICE')];
		// "AVG" does NOT prefix-match canonical AVERAGE, but does match alias AVG (-> AVERAGE) and canonical
		// AVGPRICE. The canonical hit (AVGPRICE) ranks above the alias-only hit (AVG -> AVERAGE).
		const out = filterFunctions(list, 'AVG', 10);
		assert.deepStrictEqual(out.map(i => i.matchedName), ['AVGPRICE', 'AVG']);
		assert.strictEqual(out[0].viaAlias, false);
		assert.strictEqual(out[1].viaAlias, true);
		assert.strictEqual(out[1].fn.canonicalName, 'AVERAGE');
	});

	test('an empty prefix matches everything (capped by limit)', () => {
		assert.strictEqual(filterFunctions(fns, '', 3).length, 3);
		assert.strictEqual(filterFunctions(fns, '', 100).length >= fns.length, true);
	});

	test('no match yields an empty list (no fabrication)', () => {
		assert.deepStrictEqual(filterFunctions(fns, 'ZZZ', 10), []);
	});

	test('an empty function list yields no completions (No-Fallbacks)', () => {
		assert.deepStrictEqual(filterFunctions([], 'SUM', 10), []);
	});

	test('a function with an empty canonical name is skipped', () => {
		const out = filterFunctions([fn(''), fn('SUM')], '', 10).map(i => i.matchedName);
		assert.deepStrictEqual(out, ['SUM']);
	});
});

suite('W2 formulaIntel -- moveActiveIndex', () => {
	test('down/up step within range', () => {
		assert.strictEqual(moveActiveIndex(0, 1, 3), 1);
		assert.strictEqual(moveActiveIndex(2, -1, 3), 1);
	});

	test('down past the end wraps to 0; up past the start wraps to the end', () => {
		assert.strictEqual(moveActiveIndex(2, 1, 3), 0);
		assert.strictEqual(moveActiveIndex(0, -1, 3), 2);
	});

	test('a stale/out-of-range current normalizes before stepping', () => {
		// No current selection (-1), Down -> first item.
		assert.strictEqual(moveActiveIndex(-1, 1, 3), 0);
		// No current selection (-1), Up -> last item.
		assert.strictEqual(moveActiveIndex(-1, -1, 3), 2);
	});

	test('an empty list returns -1', () => {
		assert.strictEqual(moveActiveIndex(0, 1, 0), -1);
	});
});

suite('W2 formulaIntel -- findSignatureContext', () => {
	test('inside FN( reports the name and arg 0', () => {
		assert.deepStrictEqual(findSignatureContext('=SUM(', 5), { name: 'SUM', argIndex: 0 });
	});

	test('after a comma the arg index advances', () => {
		assert.deepStrictEqual(findSignatureContext('=SUM(A1,', 8), { name: 'SUM', argIndex: 1 });
		assert.deepStrictEqual(findSignatureContext('=SUM(A1,B1,', 11), { name: 'SUM', argIndex: 2 });
	});

	test('a closed call no longer encloses the caret', () => {
		assert.strictEqual(findSignatureContext('=SUM(A1)+', 9), null);
	});

	test('nested calls report the INNERMOST function', () => {
		// =IF(SUM(A1, | -> caret inside SUM, arg 1
		assert.deepStrictEqual(findSignatureContext('=IF(SUM(A1,', 11), { name: 'SUM', argIndex: 1 });
	});

	test('a comma inside a string literal does not advance the arg index', () => {
		assert.deepStrictEqual(findSignatureContext('=CONCAT("a,b",', 14), { name: 'CONCAT', argIndex: 1 });
		assert.deepStrictEqual(findSignatureContext('=CONCAT("a,b"', 13), { name: 'CONCAT', argIndex: 0 });
	});

	test('a paren inside a quoted sheet name does not open a call', () => {
		// 'My(Sheet'!A1 -- the ( is inside the quote, so the enclosing call is still SUM at arg 0.
		assert.deepStrictEqual(findSignatureContext('=SUM(\'My(Sheet\'!A1', 18), { name: 'SUM', argIndex: 0 });
	});

	test('a bare grouping paren (no function name) is not a signature context', () => {
		assert.strictEqual(findSignatureContext('=(A1+', 5), null);
	});

	test('top level (no enclosing call) is null', () => {
		assert.strictEqual(findSignatureContext('=A1+B1', 6), null);
	});

	test('non-formula text is null', () => {
		assert.strictEqual(findSignatureContext('SUM(', 4), null);
	});
});

suite('W2 formulaIntel -- buildSignatureLabel', () => {
	test('fixed arity lists n positional args', () => {
		assert.deepStrictEqual(buildSignatureLabel('NPV', { kind: 'fixed', n: 2 }), {
			name: 'NPV',
			params: ['arg1', 'arg2'],
			unbounded: false,
		});
	});

	test('fixed arity 0 has no params', () => {
		assert.deepStrictEqual(buildSignatureLabel('PI', { kind: 'fixed', n: 0 }), {
			name: 'PI',
			params: [],
			unbounded: false,
		});
	});

	test('range arity with a max marks the optional tail with ?', () => {
		assert.deepStrictEqual(buildSignatureLabel('ROUND', { kind: 'range', min: 1, max: 2 }), {
			name: 'ROUND',
			params: ['arg1', 'arg2?'],
			unbounded: false,
		});
	});

	test('range arity with no max is unbounded', () => {
		const out = buildSignatureLabel('SUM', { kind: 'range', min: 1 });
		assert.deepStrictEqual(out.params, ['arg1']);
		assert.strictEqual(out.unbounded, true);
	});

	test('variadic shows one arg + unbounded', () => {
		const out = buildSignatureLabel('CONCAT', { kind: 'variadic' });
		assert.deepStrictEqual(out.params, ['arg1']);
		assert.strictEqual(out.unbounded, true);
	});
});
