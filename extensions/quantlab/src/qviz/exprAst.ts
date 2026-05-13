/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Visualise v2 -- expression language AST.
 *
 * A closed grammar for user-authored calculated-field expressions. The
 * Visualise builder parses user text into this AST in the webview, ships
 * it as JSON inside an `ExprTransform` spec entry, and the daemon walks
 * the AST to emit DuckDB SQL with column names quoted via
 * `quote_ident` and literals parameterized.
 *
 * Why an AST (not a raw expression string):
 *   - The webview validates the AST shape + grammar BEFORE the spec
 *     ever reaches the daemon. Bad inputs surface as inline parse errors
 *     at the call site, not as cryptic SQL errors hundreds of ms later.
 *   - The daemon's compile step is a pure structural walk: no eval, no
 *     string splicing of user input into SQL identifiers, no surprise
 *     operator precedence.
 *   - Future additions (richer fns, type-aware autocomplete) extend the
 *     AST union without re-parsing strings.
 *
 * Intentionally OUT OF SCOPE for v1:
 *   - Window functions (`lag`, `cumsum`, `rolling_*`) -- belong in the
 *     existing `window` transform. Composing `window` then `expr` via
 *     the CTE chain is the right pattern.
 *   - Aggregate functions (`sum`, `mean`, `count`) -- belong in
 *     `aggregate`.
 *   - Subqueries, UDFs, custom operators.
 */

/** Operators allowed on binary nodes. Closed list -- the parser
 *  produces only these strings; the daemon-side compiler maps each to a
 *  specific DuckDB operator. */
export type BinaryOp =
	| '+' | '-' | '*' | '/' | '%'                  // arithmetic
	| '==' | '!=' | '<' | '<=' | '>' | '>='        // comparison
	| '&&' | '||';                                  // logical

/** Functions callable in the grammar. Each maps to a DuckDB scalar
 *  function on the daemon side. NEW fns require both a TS-side entry
 *  here AND a daemon-side mapping; tests pin the round-trip so neither
 *  side can drift unilaterally.
 *
 *  Unary numeric:  abs, log, log10, ln, exp, sqrt
 *  2-arg numeric:  min, max
 *  Null handling:  coalesce (variadic), nullif (2-arg)
 */
export type WhitelistedFn =
	| 'abs' | 'log' | 'log10' | 'ln' | 'exp' | 'sqrt'
	| 'min' | 'max'
	| 'coalesce' | 'nullif';

/** The expression AST. A discriminated union -- the parser produces
 *  values of this exact shape; the validator at `validate.ts` walks the
 *  same union for defense-in-depth; the daemon-side compiler walks it
 *  to emit SQL. */
export type ExprAst =
	| { readonly kind: 'col'; readonly name: string }
	/** Numeric literal. `source` (optional) preserves the parser's exact
	 *  spelling when it includes a decimal point or exponent, so the
	 *  printer can round-trip `5.0` rather than canonicalizing to `5`.
	 *  Omitted for plain integer literals to keep the AST compact. */
	| { readonly kind: 'num'; readonly value: number; readonly source?: string }
	| { readonly kind: 'str'; readonly value: string }
	| { readonly kind: 'bool'; readonly value: boolean }
	| { readonly kind: 'null' }
	| { readonly kind: 'unary'; readonly op: '-' | '!'; readonly operand: ExprAst }
	| { readonly kind: 'binary'; readonly op: BinaryOp; readonly left: ExprAst; readonly right: ExprAst }
	| { readonly kind: 'call'; readonly fn: WhitelistedFn; readonly args: readonly ExprAst[] }
	| { readonly kind: 'if'; readonly cond: ExprAst; readonly then_: ExprAst; readonly else_: ExprAst };

/** Compile-time enumeration of the AST kinds. Used by the validator's
 *  walker to confirm only-known kinds at the wire boundary. */
export const EXPR_AST_KINDS = new Set<ExprAst['kind']>([
	'col', 'num', 'str', 'bool', 'null',
	'unary', 'binary', 'call', 'if',
]);

export const BINARY_OPS = new Set<BinaryOp>([
	'+', '-', '*', '/', '%',
	'==', '!=', '<', '<=', '>', '>=',
	'&&', '||',
]);

export const UNARY_OPS = new Set<'-' | '!'>(['-', '!']);

export const WHITELISTED_FNS = new Set<WhitelistedFn>([
	'abs', 'log', 'log10', 'ln', 'exp', 'sqrt',
	'min', 'max',
	'coalesce', 'nullif',
]);

/** Arity gate per whitelisted fn. The parser doesn't enforce arity
 *  (the daemon-side compiler does) but having the table TS-side lets
 *  the form factory show a helpful tooltip on hover. */
export const FN_ARITY: Readonly<Record<WhitelistedFn, { min: number; max: number }>> = Object.freeze({
	abs: { min: 1, max: 1 },
	log: { min: 1, max: 1 },
	log10: { min: 1, max: 1 },
	ln: { min: 1, max: 1 },
	exp: { min: 1, max: 1 },
	sqrt: { min: 1, max: 1 },
	min: { min: 2, max: 2 },
	max: { min: 2, max: 2 },
	coalesce: { min: 1, max: 32 },
	nullif: { min: 2, max: 2 },
});

/** Hard caps that bound parser cost + validator workload. The parser
 *  rejects inputs that exceed any of these BEFORE building an AST; the
 *  validator (defense in depth) re-checks the produced AST. */
export const EXPR_LIMITS = Object.freeze({
	maxInputLength: 1024,
	maxAstDepth: 16,
	maxAstNodes: 256,
});

/**
 * Walk an AST and collect every column reference (deduplicated, in
 * traversal order). Used by the parser to populate `ExprTransform.references`
 * and by the validator to confirm the spec's `references` matches the AST.
 */
export function collectColumnRefs(ast: ExprAst): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	walk(ast, n => {
		if (n.kind === 'col' && !seen.has(n.name)) {
			seen.add(n.name);
			out.push(n.name);
		}
	});
	return out;
}

/** Walk an AST in pre-order, invoking `visit` on each node. Internal
 *  helper used by `collectColumnRefs` and by the validator. */
export function walk(ast: ExprAst, visit: (node: ExprAst) => void): void {
	visit(ast);
	switch (ast.kind) {
		case 'col': case 'num': case 'str': case 'bool': case 'null':
			return;
		case 'unary':
			walk(ast.operand, visit);
			return;
		case 'binary':
			walk(ast.left, visit);
			walk(ast.right, visit);
			return;
		case 'call':
			for (const a of ast.args) { walk(a, visit); }
			return;
		case 'if':
			walk(ast.cond, visit);
			walk(ast.then_, visit);
			walk(ast.else_, visit);
			return;
		default: {
			const exhaustive: never = ast;
			throw new Error(`walk: unknown ExprAst kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** Depth of the AST (root = 1). Used by the parser and validator to
 *  enforce `EXPR_LIMITS.maxAstDepth`. */
export function astDepth(ast: ExprAst): number {
	switch (ast.kind) {
		case 'col': case 'num': case 'str': case 'bool': case 'null':
			return 1;
		case 'unary':
			return 1 + astDepth(ast.operand);
		case 'binary':
			return 1 + Math.max(astDepth(ast.left), astDepth(ast.right));
		case 'call': {
			let m = 0;
			for (const a of ast.args) { m = Math.max(m, astDepth(a)); }
			return 1 + m;
		}
		case 'if':
			return 1 + Math.max(astDepth(ast.cond), astDepth(ast.then_), astDepth(ast.else_));
		default: {
			const exhaustive: never = ast;
			throw new Error(`astDepth: unknown ExprAst kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** Total node count of the AST. Used to enforce `EXPR_LIMITS.maxAstNodes`. */
export function astNodeCount(ast: ExprAst): number {
	let count = 0;
	walk(ast, () => { count += 1; });
	return count;
}

/** Operator precedence table for the printer. Mirrors the parser's
 *  recursive-descent ladder: higher number = binds tighter.
 *
 *  Used by `printExpr` to emit parens only where they're required to
 *  preserve grouping.
 *
 *  Codex audit MEDIUM (2026-05-12): the previous version only had
 *  binary-op entries and missed (a) unary `!` (which lives at the `not`
 *  level between `&&` and comparison), (b) if-then-else (a clause that
 *  binds looser than `||`), and (c) the fact that comparison is
 *  NON-chainable — its children must have STRICTLY greater precedence.
 *  Each hole produced a round-trip-breaking print: `(!a) == b` came out
 *  as `!a == b` (parser re-reads as `!(a == b)`), and
 *  `(if (c) then a else b) + d` lost its grouping entirely.
 */
const PREC: Readonly<Record<BinaryOp, number>> = Object.freeze({
	'||': 1,
	'&&': 2,
	'==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
	'+': 4, '-': 4,
	'*': 5, '/': 5, '%': 5,
});

/** Unary `!` lives in the parser's `not` level (above `&&`, below
 *  comparison). Unary `-` lives in the `unary` level (above everything,
 *  binds primary-tight). */
const NOT_PREC = 2.5;
const UNARY_MINUS_PREC = 10;
/** `if (c) then a else b` is a clause that binds looser than any binary
 *  op — anywhere in a non-root context it must be parenthesized. */
const IF_PREC = 0;

/** Reserved identifiers the parser rejects as bare names. */
const RESERVED_BARE_IDENTS = new Set(['true', 'false', 'null', 'if', 'then', 'else']);

/** Test whether a column name can be emitted as a plain (bare) identifier
 *  in source text. If not, the printer wraps it in backticks. */
function isBareIdentifier(name: string): boolean {
	if (name.length === 0) { return false; }
	if (RESERVED_BARE_IDENTS.has(name)) { return false; }
	for (let i = 0; i < name.length; i += 1) {
		const code = name.charCodeAt(i);
		// [A-Za-z_] for the first char, [A-Za-z0-9_] for the rest.
		const isLetterOrUnder = (code >= 0x41 && code <= 0x5A)
			|| (code >= 0x61 && code <= 0x7A)
			|| code === 0x5F;
		const isDigit = code >= 0x30 && code <= 0x39;
		if (i === 0 ? !isLetterOrUnder : !(isLetterOrUnder || isDigit)) {
			return false;
		}
	}
	return true;
}

/** Render a column name as the source text that parses back to it.
 *  Plain identifiers emit unchanged; everything else (spaces, non-ASCII,
 *  reserved words) is wrapped in backticks with internal backticks
 *  doubled. Exported so UI insertion sites (hint chips) can produce
 *  text that round-trips through the parser. */
export function printColName(name: string): string {
	if (isBareIdentifier(name)) { return name; }
	// Backtick-quoted identifier; doubled backtick escapes a literal one.
	return `\`${name.replace(/`/g, '``')}\``;
}

/** Print an AST as source text. Precedence-aware: emits parens only
 *  where required to preserve grouping. `parentPrec` is the precedence
 *  of the surrounding context (binary parent or 0 at root); a child
 *  binary with `PREC[child.op] < parentPrec` gets parens. Unary nodes
 *  always print without surrounding parens (their operand binds tighter
 *  than any binary op).
 *
 *  Round-trips through `parseExpression` to an equivalent AST. Not
 *  whitespace-faithful (single spaces around operators).
 *
 *  M9/M10 (megaudit): replaces a fully-parenthesized printer that made
 *  saved specs hard to re-read.
 */
export function printExpr(ast: ExprAst): string {
	return printExprAt(ast, 0);
}

function printExprAt(ast: ExprAst, parentPrec: number): string {
	switch (ast.kind) {
		case 'col': return printColName(ast.name);
		case 'num':
			// L5: prefer the preserved source form (e.g. `5.0`) over
			// the JS-default String(value) (`5`).
			return ast.source ?? String(ast.value);
		case 'str': {
			const escaped = ast.value
				.replace(/\\/g, '\\\\')
				.replace(/'/g, '\\\'')
				.replace(/\n/g, '\\n')
				.replace(/\t/g, '\\t')
				.replace(/\r/g, '\\r');
			return `'${escaped}'`;
		}
		case 'bool': return ast.value ? 'true' : 'false';
		case 'null': return 'null';
		case 'unary': {
			// Codex audit MEDIUM (2026-05-12): unary `!` and unary `-`
			// live at DIFFERENT levels in the parser ladder:
			//   - `!` at the `not` level (NOT_PREC = 2.5)
			//   - `-` at the `unary` level (UNARY_MINUS_PREC = 10)
			// The previous version emitted unary without considering
			// parent precedence, so `(!a) == b` lost its parens and
			// re-parsed as `!(a == b)`.
			const myPrec = ast.op === '!' ? NOT_PREC : UNARY_MINUS_PREC;
			// Operand binds at the same level as the parent operator
			// (the grammar is right-associative for both: `!!a` and
			// `--a` are parsed as `!(!a)` and `-(-a)`).
			const inner = `${ast.op}${printExprAt(ast.operand, myPrec)}`;
			return myPrec < parentPrec ? `(${inner})` : inner;
		}
		case 'binary': {
			const myPrec = PREC[ast.op];
			// Comparison is non-chainable: `comparison := add (OP add)?`
			// allows AT MOST ONE comparison op, so a comparison child of
			// another comparison MUST be parenthesized. Other binary
			// ops are left-associative: left child can match my
			// precedence without parens; right child must exceed it.
			const isComparison = myPrec === 3;
			const leftPrec = isComparison ? myPrec + 1 : myPrec;
			const rightPrec = myPrec + 1;
			const leftStr = printExprAt(ast.left, leftPrec);
			const rightStr = printExprAt(ast.right, rightPrec);
			const inner = `${leftStr} ${ast.op} ${rightStr}`;
			return myPrec < parentPrec ? `(${inner})` : inner;
		}
		case 'call':
			// Function args are top-level inside their parens, so they
			// emit at IF_PREC (anything binds tighter than 0).
			return `${ast.fn}(${ast.args.map(a => printExprAt(a, IF_PREC)).join(', ')})`;
		case 'if': {
			// `if (c) then a else b` is the loosest-binding clause.
			// Embedded in any non-root context (parent precedence > 0),
			// must be parenthesized to preserve grouping — otherwise
			// `(if (c) then a else b) + d` would print as
			// `if (c) then a else b + d`, which parses as
			// `if (c) then a else (b + d)`.
			const inner = `if (${printExprAt(ast.cond, IF_PREC)}) then `
				+ `${printExprAt(ast.then_, IF_PREC)} else `
				+ `${printExprAt(ast.else_, IF_PREC)}`;
			return parentPrec > IF_PREC ? `(${inner})` : inner;
		}
		default: {
			const exhaustive: never = ast;
			throw new Error(`printExpr: unknown ExprAst kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}

