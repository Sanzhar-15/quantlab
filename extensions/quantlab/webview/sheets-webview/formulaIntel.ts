/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 formula intelligence -- the vscode-free core of the lightweight formula-bar assist (inline
// validation hint, function-completion dropdown, signature hint). Kept DOM-free + pure so it is
// unit-testable in isolation (the webview UI is not headlessly testable); the wiring in index.ts
// reads the caret/value off the live <input> and drives these pure functions.
//
// Three concerns live here:
//   1. {@link extractCompletionPrefix} -- given the formula text + caret offset, find the function-name
//      token the caret is in (an A-Z/0-9/dot identifier run, only inside a `=`-formula), or null.
//   2. {@link filterFunctions} -- a prefix filter over the engine's function metadata (canonical name
//      AND aliases), ranked so a prefix HIT on the canonical name beats an alias hit, then alphabetical.
//   3. {@link findSignatureContext} -- given the formula text + caret, find the innermost enclosing
//      `FN(` call so the caller can show that function's parameter list.
//
// These are intentionally lexical (not a full parser): the engine owns real parse/bind validation via
// `session.validateFormula`; this module only powers the *editor affordances* (what to complete, where
// the caret sits). The filter never fabricates entries -- an empty function list yields no completions.

/** A function the engine exposes (the fields this module needs from the engine's FunctionMetadataJson). */
export interface CompletionFunction {
	/** ASCII-uppercase canonical name (e.g. `SHARPE`). */
	readonly canonicalName: string;
	/** Optional human display name; unused for matching but carried for the UI. */
	readonly displayName?: string;
	/** Alternate names that also resolve to this function (e.g. legacy spellings). */
	readonly aliases: readonly string[];
}

/** One completion candidate, already ranked. `matchedName` is the name (canonical or alias) the prefix hit. */
export interface CompletionItem {
	readonly fn: CompletionFunction;
	/** The name the user's prefix matched -- what gets inserted (canonical or the matched alias). */
	readonly matchedName: string;
	/** True when `matchedName` is an alias (not the canonical name) -- the UI can annotate it. */
	readonly viaAlias: boolean;
}

/**
 * Is `ch` an identifier character for a function name? Function names are ASCII letters, digits, and the
 * dotted segments the engine uses (e.g. `T.DIST.2T`). Underscore is permitted (some UDF names use it).
 * Deliberately ASCII-only (the engine canonicalizes to ASCII-uppercase).
 */
function isNameChar(ch: string): boolean {
	const c = ch.charCodeAt(0);
	return (
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		(c >= 48 && c <= 57) || // 0-9
		ch === '.' ||
		ch === '_'
	);
}

/**
 * Find the function-name prefix the caret is currently typing, for the completion dropdown.
 *
 * Rules (lexical, Excel-like):
 *  - Only inside a formula: the trimmed text must start with `=`. A literal value never completes.
 *  - The token is the maximal run of {@link isNameChar} characters ending exactly AT the caret. A caret
 *    in the MIDDLE of a name (chars after it) does NOT complete -- you complete what you are appending to,
 *    matching how every editor's "type-ahead" works and avoiding surprise replacement.
 *  - A leading digit is not a function name (e.g. `=2x`), so a run that starts with a digit is rejected:
 *    the engine has no digit-initial function names; this avoids offering completions inside numbers.
 *  - An EMPTY run (caret right after `=`, `(`, an operator, etc.) yields `{ prefix: '', ... }` so the
 *    caller MAY show the full list on an explicit trigger -- callers that only want non-empty prefixes
 *    can check `prefix.length`.
 *
 * Returns the prefix plus its `[start, end)` offsets in `text` (end === caret), or null when the caret is
 * not in a completable position (not a formula, or sitting just after a name character run that begins
 * with a digit).
 */
export function extractCompletionPrefix(
	text: string,
	caret: number,
): { prefix: string; start: number; end: number } | null {
	if (caret < 0 || caret > text.length) {
		return null;
	}
	// Only complete inside a formula. `trimStart` so leading spaces before `=` still count (Excel allows it).
	if (!text.trimStart().startsWith('=')) {
		return null;
	}
	// **Codex MED fold**: do not complete inside a string literal ("...") or a single-quoted sheet name
	// ('...'). Typing `="SU` must NOT open function completion (Enter/Tab would then insert `SUM(` into the
	// string instead of committing). Scan from the formula's '=' to the caret tracking quote state; bail if
	// the caret lands inside an open quote. Also requires the caret to be at/after the '=' offset (a caret
	// before the '=', e.g. in leading whitespace, is not a completion position).
	const eq = text.indexOf('=');
	if (eq < 0 || caret <= eq) {
		return null;
	}
	// Codex re-audit LOW: model Excel's DOUBLED-quote escape (`""` inside a string, `''` inside a quoted
	// sheet name is the escaped quote, NOT a close) -- mirrors `a1FormulaRefs.ts`. When inside a quote and the
	// closing quote is immediately doubled, consume both and stay inside.
	let i = eq + 1;
	let inString = false;
	let inQuote = false;
	while (i < caret) {
		const c = text.charAt(i);
		if (inString) {
			if (c === '"') {
				if (text.charAt(i + 1) === '"') {
					i += 2;
					continue;
				}
				inString = false;
			}
		} else if (inQuote) {
			if (c === '\'') {
				if (text.charAt(i + 1) === '\'') {
					i += 2;
					continue;
				}
				inQuote = false;
			}
		} else if (c === '"') {
			inString = true;
		} else if (c === '\'') {
			inQuote = true;
		}
		i++;
	}
	if (inString || inQuote) {
		return null;
	}
	// Do not complete when the character immediately AFTER the caret is also a name char -- the caret is in
	// the middle of an existing name; completing there would silently rewrite the tail.
	if (caret < text.length && isNameChar(text.charAt(caret))) {
		return null;
	}
	let start = caret;
	while (start > 0 && isNameChar(text.charAt(start - 1))) {
		start--;
	}
	const prefix = text.slice(start, caret);
	// A run that begins with a digit is part of a number / not a function name.
	if (prefix.length > 0 && prefix.charAt(0) >= '0' && prefix.charAt(0) <= '9') {
		return null;
	}
	return { prefix, start, end: caret };
}

/**
 * Prefix-filter the function list for completion. Case-insensitive (the user may type lowercase; names are
 * ASCII-uppercase). An entry matches when its canonical name OR any alias starts with `prefix`. Ranking:
 *  1. canonical-name matches before alias-only matches (the common case first);
 *  2. then ascending by the matched name (stable, predictable ordering).
 * The matched name (canonical or the specific alias) is what the caller inserts. An EMPTY prefix matches
 * everything (the "show all functions" affordance) -- but the caller caps how many it renders.
 *
 * No-Fallbacks: an empty `functions` array yields an empty result (no fabricated list); a function with an
 * empty canonical name is skipped (it could never be inserted meaningfully).
 */
export function filterFunctions(
	functions: readonly CompletionFunction[],
	prefix: string,
	limit: number,
): CompletionItem[] {
	const needle = prefix.toUpperCase();
	const items: CompletionItem[] = [];
	for (const fn of functions) {
		const canon = fn.canonicalName;
		if (typeof canon !== 'string' || canon.length === 0) {
			continue;
		}
		if (canon.toUpperCase().startsWith(needle)) {
			items.push({ fn, matchedName: canon, viaAlias: false });
			continue;
		}
		// No canonical hit -- try the aliases. Pick the FIRST alias that matches (deterministic) so a function
		// surfaces once, under the alias the user is actually typing toward.
		let aliasHit: string | null = null;
		if (Array.isArray(fn.aliases)) {
			for (const alias of fn.aliases) {
				if (typeof alias === 'string' && alias.length > 0 && alias.toUpperCase().startsWith(needle)) {
					aliasHit = alias;
					break;
				}
			}
		}
		if (aliasHit !== null) {
			items.push({ fn, matchedName: aliasHit, viaAlias: true });
		}
	}
	items.sort((a, b) => {
		// Canonical matches rank above alias-only matches.
		if (a.viaAlias !== b.viaAlias) {
			return a.viaAlias ? 1 : -1;
		}
		const an = a.matchedName.toUpperCase();
		const bn = b.matchedName.toUpperCase();
		if (an < bn) {
			return -1;
		}
		if (an > bn) {
			return 1;
		}
		return 0;
	});
	return limit >= 0 ? items.slice(0, limit) : items;
}

/**
 * Clamp a dropdown's active index into `[0, count)` when navigating by `delta` (Up = -1, Down = +1) with
 * WRAP-AROUND (Excel/VS Code list behavior: Down past the last item wraps to the first). A non-positive
 * `count` returns -1 (no selection -- the dropdown is empty / should be closed). Pure so the keyboard
 * interception logic is unit-tested without a DOM list.
 */
export function moveActiveIndex(current: number, delta: number, count: number): number {
	if (count <= 0) {
		return -1;
	}
	// Normalize a stale/out-of-range current into range first, then step + wrap.
	const base = current < 0 || current >= count ? (delta >= 0 ? -1 : 0) : current;
	const next = base + delta;
	// JS `%` keeps the sign of the dividend, so add `count` before the final modulo to wrap negatives.
	return ((next % count) + count) % count;
}

/**
 * Find the innermost unmatched `FN(` enclosing the caret, for the signature hint. Walks the formula left of
 * the caret tracking parenthesis depth and (Excel-like) the comma-separated argument index of the caret
 * within that call. Skips parens/commas inside string literals (`"..."`) and single-quoted sheet names
 * (`'...'`) so a comma in a text arg or a `(` in a quoted name does not confuse the scan.
 *
 * Returns the enclosing function name (the identifier run immediately before its `(`) and the zero-based
 * `argIndex` of the caret, or null when the caret is not inside any `FN(` (top level, or inside a bare
 * `(` group with no function name before it).
 */
export function findSignatureContext(
	text: string,
	caret: number,
): { name: string; argIndex: number } | null {
	if (caret < 0 || caret > text.length) {
		return null;
	}
	if (!text.trimStart().startsWith('=')) {
		return null;
	}
	// A stack of open calls: each entry is the function name before its `(` (or '' for a bare group) and the
	// arg index accumulated so far. We push on `(`, pop on `)`, and bump the top's argIndex on a `,`.
	const stack: { name: string; argIndex: number }[] = [];
	let inString = false;
	let inQuote = false; // single-quoted sheet name
	// Codex re-audit LOW: honor Excel's doubled-quote escape (`""` / `''`) so a `(` or `,` after an escaped
	// quote inside a literal is not mis-read as structure (mirrors extractCompletionPrefix + a1FormulaRefs).
	for (let i = 0; i < caret; i++) {
		const ch = text.charAt(i);
		if (inString) {
			if (ch === '"') {
				if (text.charAt(i + 1) === '"') {
					i++; // consume the escaped pair; stay in the string
					continue;
				}
				inString = false;
			}
			continue;
		}
		if (inQuote) {
			if (ch === '\'') {
				if (text.charAt(i + 1) === '\'') {
					i++;
					continue;
				}
				inQuote = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '\'') {
			inQuote = true;
			continue;
		}
		if (ch === '(') {
			// The function name is the identifier run ending right before this `(` (skipping no spaces:
			// Excel does not allow a space between a function name and its open paren).
			const nameEnd = i;
			let nameStart = nameEnd;
			while (nameStart > 0 && isNameChar(text.charAt(nameStart - 1))) {
				nameStart--;
			}
			const name = text.slice(nameStart, nameEnd);
			// A name that begins with a digit is not a function (a bare grouping paren after a number); push
			// an empty name so depth stays balanced but it is not reported as a signature context.
			const valid = name.length > 0 && !(name.charAt(0) >= '0' && name.charAt(0) <= '9');
			stack.push({ name: valid ? name : '', argIndex: 0 });
			continue;
		}
		if (ch === ')') {
			stack.pop();
			continue;
		}
		if (ch === ',' && stack.length > 0) {
			stack[stack.length - 1].argIndex++;
			continue;
		}
	}
	// Walk DOWN the stack to the innermost entry that has a real function name.
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].name.length > 0) {
			return { name: stack[i].name, argIndex: stack[i].argIndex };
		}
	}
	return null;
}

/**
 * Build a human signature string for the hint, e.g. `SHARPE(arg1, arg2)` with the current arg emphasized by
 * the caller (this returns the parts so the UI decides emphasis). `arity` mirrors the engine `ArityJson`:
 *  - `fixed { n }` -> `n` positional args;
 *  - `range { min, max? }` -> `min` required then optional up to `max` (or `...` when unbounded);
 *  - `variadic` -> `arg1, ...`.
 * Generic names (`arg1`, `arg2`, ...) are used -- the engine metadata carries no per-parameter names in v1.
 */
export function buildSignatureLabel(
	name: string,
	arity: { kind: string; n?: number; min?: number; max?: number },
): { name: string; params: string[]; unbounded: boolean } {
	const params: string[] = [];
	let unbounded = false;
	if (arity.kind === 'fixed') {
		const n = typeof arity.n === 'number' && arity.n >= 0 ? arity.n : 0;
		for (let i = 0; i < n; i++) {
			params.push('arg' + (i + 1));
		}
	} else if (arity.kind === 'range') {
		const min = typeof arity.min === 'number' && arity.min >= 0 ? arity.min : 0;
		const hasMax = typeof arity.max === 'number' && arity.max >= min;
		const shown = hasMax ? (arity.max as number) : min;
		for (let i = 0; i < shown; i++) {
			params.push('arg' + (i + 1) + (i >= min ? '?' : ''));
		}
		if (!hasMax) {
			unbounded = true;
		}
	} else if (arity.kind === 'variadic') {
		params.push('arg1');
		unbounded = true;
	}
	return { name, params, unbounded };
}
