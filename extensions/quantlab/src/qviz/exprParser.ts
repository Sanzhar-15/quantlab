/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Visualise v2 -- expression parser.
 *
 * Recursive-descent parser for the calculated-field expression language.
 * Pure, no dependencies. Produces an `ExprAst` plus the deduplicated
 * list of column references (in source order).
 *
 * Grammar (precedence low -> high):
 *
 *   expr        := or
 *   or          := and ( '||' and )*
 *   and         := not ( '&&' not )*
 *   not         := '!' not | comparison
 *   comparison  := add ( ('==' | '!=' | '<' | '<=' | '>' | '>=') add )?
 *   add         := mul ( ('+' | '-') mul )*
 *   mul         := unary ( ('*' | '/' | '%') unary )*
 *   unary       := '-' unary | primary
 *   primary     := number | string | 'true' | 'false' | 'null'
 *                | ident '(' args? ')'         (function call)
 *                | ident                       (column ref)
 *                | 'if' '(' expr ')' 'then' expr 'else' expr
 *                | '(' expr ')'
 *   args        := expr ( ',' expr )*
 *
 * Whitespace insignificant. No semicolons. String literals use single
 * quotes with backslash escapes.
 *
 * Hard caps (EXPR_LIMITS): input length 1024 chars, AST depth 16, AST
 * node count 256. Pathological inputs reject BEFORE traversal.
 *
 * Error reporting: every failure includes a position (0-based char
 * offset) and a one-line message. The form-factory renders the error
 * with a position marker so users see where the parse failed.
 */

import {
	type BinaryOp, type ExprAst, type WhitelistedFn,
	BINARY_OPS, EXPR_LIMITS, FN_ARITY, WHITELISTED_FNS,
	astDepth, astNodeCount, collectColumnRefs,
} from './exprAst';

export type ParseSuccess = {
	readonly ok: true;
	readonly ast: ExprAst;
	readonly references: readonly string[];
};

export type ParseFailure = {
	readonly ok: false;
	readonly error: string;
	readonly position: number;
};

export type ParseResult = ParseSuccess | ParseFailure;

/** Parse a user-typed expression string into an AST. */
export function parseExpression(input: string): ParseResult {
	if (typeof input !== 'string') {
		return { ok: false, error: 'expression must be a string', position: 0 };
	}
	if (input.length === 0) {
		return { ok: false, error: 'expression is empty', position: 0 };
	}
	if (input.length > EXPR_LIMITS.maxInputLength) {
		return {
			ok: false,
			error: `expression exceeds ${EXPR_LIMITS.maxInputLength}-char cap (got ${input.length})`,
			position: EXPR_LIMITS.maxInputLength,
		};
	}

	const p = new Parser(input);
	let ast: ExprAst;
	try {
		ast = p.parseTop();
	} catch (e) {
		if (e instanceof ParseError) {
			return { ok: false, error: e.message, position: e.position };
		}
		throw e;
	}

	const depth = astDepth(ast);
	if (depth > EXPR_LIMITS.maxAstDepth) {
		return {
			ok: false,
			error: `expression nesting depth ${depth} exceeds cap ${EXPR_LIMITS.maxAstDepth}`,
			position: 0,
		};
	}
	const nodes = astNodeCount(ast);
	if (nodes > EXPR_LIMITS.maxAstNodes) {
		return {
			ok: false,
			error: `expression has ${nodes} nodes, exceeds cap ${EXPR_LIMITS.maxAstNodes}`,
			position: 0,
		};
	}
	const references = collectColumnRefs(ast);
	return { ok: true, ast, references };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

class ParseError extends Error {
	readonly position: number;
	constructor(message: string, position: number) {
		super(message);
		this.position = position;
	}
}

/** Reserved identifiers that cannot be column names because they have
 *  fixed meaning in the grammar. */
const RESERVED = new Set(['true', 'false', 'null', 'if', 'then', 'else']);

class Parser {
	private pos = 0;
	constructor(private readonly src: string) {}

	parseTop(): ExprAst {
		this.skipWs();
		const ast = this.parseOr();
		this.skipWs();
		if (this.pos !== this.src.length) {
			throw new ParseError(
				`unexpected trailing input starting at position ${this.pos}: '${this.peek(8)}'`,
				this.pos,
			);
		}
		return ast;
	}

	// ----- expression layers (low to high precedence) -----

	private parseOr(): ExprAst {
		let left = this.parseAnd();
		this.skipWs();
		while (this.peekChar() === '|' && this.src[this.pos + 1] === '|') {
			this.pos += 2;
			this.skipWs();
			const right = this.parseAnd();
			left = { kind: 'binary', op: '||', left, right };
			this.skipWs();
		}
		return left;
	}

	private parseAnd(): ExprAst {
		let left = this.parseNot();
		this.skipWs();
		while (this.peekChar() === '&' && this.src[this.pos + 1] === '&') {
			this.pos += 2;
			this.skipWs();
			const right = this.parseNot();
			left = { kind: 'binary', op: '&&', left, right };
			this.skipWs();
		}
		return left;
	}

	private parseNot(): ExprAst {
		this.skipWs();
		// `!=` is the comparison op; recognize `!` only when NOT followed by '='.
		if (this.peekChar() === '!' && this.src[this.pos + 1] !== '=') {
			this.pos += 1;
			this.skipWs();
			return { kind: 'unary', op: '!', operand: this.parseNot() };
		}
		return this.parseComparison();
	}

	private parseComparison(): ExprAst {
		const left = this.parseAdd();
		this.skipWs();
		const op = this.matchComparisonOp();
		if (op === null) { return left; }
		this.skipWs();
		const right = this.parseAdd();
		return { kind: 'binary', op, left, right };
	}

	private parseAdd(): ExprAst {
		let left = this.parseMul();
		this.skipWs();
		while (true) {
			const c = this.peekChar();
			if (c !== '+' && c !== '-') { break; }
			this.pos += 1;
			this.skipWs();
			const right = this.parseMul();
			left = { kind: 'binary', op: c, left, right };
			this.skipWs();
		}
		return left;
	}

	private parseMul(): ExprAst {
		let left = this.parseUnary();
		this.skipWs();
		while (true) {
			const c = this.peekChar();
			if (c !== '*' && c !== '/' && c !== '%') { break; }
			this.pos += 1;
			this.skipWs();
			const right = this.parseUnary();
			left = { kind: 'binary', op: c, left, right };
			this.skipWs();
		}
		return left;
	}

	private parseUnary(): ExprAst {
		this.skipWs();
		if (this.peekChar() === '-') {
			this.pos += 1;
			this.skipWs();
			return { kind: 'unary', op: '-', operand: this.parseUnary() };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): ExprAst {
		this.skipWs();
		const c = this.peekChar();
		if (c === '(') {
			this.pos += 1;
			this.skipWs();
			const inner = this.parseOr();
			this.skipWs();
			this.expectChar(')');
			return inner;
		}
		if (c === '\'') { return this.parseStringLit(); }
		// M1+L1 (megaudit): backtick-quoted column reference. Supports
		// non-ASCII names, names containing spaces or punctuation, and
		// reserved-word names like `null` / `if` that bare identifiers
		// can't reach. Doubled backtick escapes a literal backtick
		// inside a name (matching the convention SQL uses for quoted
		// identifiers).
		if (c === '`') { return this.parseQuotedIdent(); }
		if (c !== undefined && (isDigit(c) || (c === '.' && isDigit(this.src[this.pos + 1])))) {
			return this.parseNumber();
		}
		if (c !== undefined && (isIdentStart(c))) {
			return this.parseIdentOrCall();
		}
		throw new ParseError(
			`unexpected character at position ${this.pos}: '${c ?? '<EOF>'}'`,
			this.pos,
		);
	}

	private parseQuotedIdent(): ExprAst {
		const start = this.pos;
		this.pos += 1;  // opening backtick
		let out = '';
		while (this.pos < this.src.length) {
			const c = this.src[this.pos];
			if (c === '`') {
				// Doubled backtick = literal backtick inside the name.
				if (this.src[this.pos + 1] === '`') {
					out += '`';
					this.pos += 2;
					continue;
				}
				this.pos += 1;  // closing backtick
				if (out.length === 0) {
					throw new ParseError(
						`empty backtick-quoted identifier at position ${start}`,
						start,
					);
				}
				return { kind: 'col', name: out };
			}
			// Codex audit LOW (2026-05-12): mirror `isAcceptableString`
			// in validate.ts — reject NUL and most C0 controls. The
			// validator would catch any control char that slipped
			// through here, but failing in the parser gives the user a
			// better position-marked error rather than a downstream
			// "string contains NUL/control char" issue path.
			const code = c.charCodeAt(0);
			if (code === 0x00 || (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D)) {
				throw new ParseError(
					`backtick-quoted identifier contains a control character (U+${code.toString(16).padStart(4, '0').toUpperCase()}) at position ${this.pos}`,
					this.pos,
				);
			}
			out += c;
			this.pos += 1;
		}
		throw new ParseError(
			`unterminated backtick-quoted identifier starting at position ${start}`,
			start,
		);
	}

	// ----- atoms -----

	private parseNumber(): ExprAst {
		const start = this.pos;
		// Integer part: at least one digit.
		while (this.pos < this.src.length && isDigit(this.src[this.pos])) {
			this.pos += 1;
		}
		let hasDecimal = false;
		if (this.peekChar() === '.') {
			this.pos += 1;
			// M6 (megaudit): require at least one digit after the
			// decimal point. `5.` is rejected; `5.0` is fine.
			if (!isDigit(this.src[this.pos])) {
				throw new ParseError(
					`malformed number at position ${start}: decimal point must be followed by a digit`,
					start,
				);
			}
			while (this.pos < this.src.length && isDigit(this.src[this.pos])) {
				this.pos += 1;
			}
			hasDecimal = true;
		}
		let hasExponent = false;
		if (this.peekChar() === 'e' || this.peekChar() === 'E') {
			this.pos += 1;
			if (this.src[this.pos] === '+' || this.src[this.pos] === '-') { this.pos += 1; }
			if (!isDigit(this.src[this.pos])) {
				throw new ParseError(
					`malformed number exponent at position ${start}`,
					start,
				);
			}
			while (this.pos < this.src.length && isDigit(this.src[this.pos])) { this.pos += 1; }
			hasExponent = true;
		}
		const raw = this.src.slice(start, this.pos);
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			throw new ParseError(
				`non-finite numeric literal at position ${start}: '${raw}'`,
				start,
			);
		}
		// L2 (megaudit): integer literals outside the safe range round
		// silently in IEEE-754 — `9999999999999999` parses to
		// `10000000000000000`. For trading expressions involving
		// position sizes / nanosecond timestamps that's a real precision
		// footgun. Reject loudly for plain integer literals; tolerate
		// loss for float/exponent forms where the user opted in.
		if (!hasDecimal && !hasExponent && !Number.isSafeInteger(value)) {
			throw new ParseError(
				`integer literal '${raw}' exceeds safe range `
				+ `[-2^53, 2^53]; use exponent form (e.g. ${raw}e0) `
				+ 'to acknowledge precision loss',
				start,
			);
		}
		// L5 (megaudit): preserve the source form (decimal/exponent
		// flag) so the printer can re-emit `5.0` rather than `5`. The
		// `source` field is optional and OMITTED for integers — keeping
		// the serialized AST minimal in the common case.
		//
		// Codex second pass LOW (2026-05-13): mirror the validator's
		// 64-char source cap here so the parser doesn't produce
		// numeric literals the validator would reject. Realistic
		// numeric literals are well under this (longest finite IEEE
		// double string is ~24 chars).
		if (hasDecimal || hasExponent) {
			if (raw.length > 64) {
				throw new ParseError(
					`numeric literal '${raw.slice(0, 32)}...' is too long (${raw.length} chars, cap 64)`,
					start,
				);
			}
			return { kind: 'num', value, source: raw };
		}
		return { kind: 'num', value };
	}

	private parseStringLit(): ExprAst {
		const start = this.pos;
		this.pos += 1;  // opening quote
		let out = '';
		while (this.pos < this.src.length) {
			const c = this.src[this.pos];
			if (c === '\'') {
				this.pos += 1;
				return { kind: 'str', value: out };
			}
			if (c === '\\') {
				const nxt = this.src[this.pos + 1];
				if (nxt === undefined) {
					throw new ParseError(
						`unterminated string escape at position ${this.pos}`,
						this.pos,
					);
				}
				if (nxt === '\\' || nxt === '\'') {
					out += nxt;
					this.pos += 2;
					continue;
				}
				if (nxt === 'n') { out += '\n'; this.pos += 2; continue; }
				if (nxt === 't') { out += '\t'; this.pos += 2; continue; }
				if (nxt === 'r') { out += '\r'; this.pos += 2; continue; }
				throw new ParseError(
					`unknown string escape '\\${nxt}' at position ${this.pos}`,
					this.pos,
				);
			}
			out += c;
			this.pos += 1;
		}
		throw new ParseError(
			`unterminated string literal starting at position ${start}`,
			start,
		);
	}

	private parseIdentOrCall(): ExprAst {
		const start = this.pos;
		while (this.pos < this.src.length && isIdentPart(this.src[this.pos])) {
			this.pos += 1;
		}
		const name = this.src.slice(start, this.pos);

		if (name === 'true') { return { kind: 'bool', value: true }; }
		if (name === 'false') { return { kind: 'bool', value: false }; }
		if (name === 'null') { return { kind: 'null' }; }
		if (name === 'if') { return this.parseIfTail(start); }
		if (name === 'then' || name === 'else') {
			throw new ParseError(
				`'${name}' is reserved (only valid after 'if'); use a column with a different name`,
				start,
			);
		}

		this.skipWs();
		if (this.peekChar() === '(') {
			if (!WHITELISTED_FNS.has(name as WhitelistedFn)) {
				throw new ParseError(
					`unknown function '${name}' at position ${start} (allowed: ${[...WHITELISTED_FNS].join(', ')})`,
					start,
				);
			}
			this.pos += 1;
			this.skipWs();
			const args: ExprAst[] = [];
			if (this.peekChar() !== ')') {
				args.push(this.parseOr());
				this.skipWs();
				while (this.peekChar() === ',') {
					this.pos += 1;
					this.skipWs();
					args.push(this.parseOr());
					this.skipWs();
				}
			}
			this.expectChar(')');
			// H1 fix: enforce arity at the parser layer so the form's
			// inline error UI fires immediately (the validator and daemon
			// re-check; this is the friendly path).
			const arity = FN_ARITY[name as WhitelistedFn];
			if (args.length < arity.min || args.length > arity.max) {
				const wanted = arity.min === arity.max
					? `${arity.min}`
					: `${arity.min}..${arity.max}`;
				throw new ParseError(
					`function '${name}' expects ${wanted} arg(s), got ${args.length}`,
					start,
				);
			}
			return { kind: 'call', fn: name as WhitelistedFn, args };
		}

		// Plain identifier = column reference.
		return { kind: 'col', name };
	}

	private parseIfTail(ifStart: number): ExprAst {
		this.skipWs();
		this.expectChar('(');
		this.skipWs();
		const cond = this.parseOr();
		this.skipWs();
		this.expectChar(')');
		this.skipWs();
		this.expectKeyword('then', ifStart);
		this.skipWs();
		const then_ = this.parseOr();
		this.skipWs();
		this.expectKeyword('else', ifStart);
		this.skipWs();
		const else_ = this.parseOr();
		return { kind: 'if', cond, then_, else_ };
	}

	// ----- low-level helpers -----

	private skipWs(): void {
		while (this.pos < this.src.length) {
			const code = this.src.charCodeAt(this.pos);
			// ASCII whitespace.
			if (code === 0x09 || code === 0x0A || code === 0x0D || code === 0x20) {
				this.pos += 1;
				continue;
			}
			// L3 fix: NBSP and the common Unicode spaces slip in via
			// copy-paste from Word docs or web pages. Treat them as
			// whitespace so users don't get a cryptic "unexpected
			// character" error on an invisible glyph.
			if (code === 0x00A0       // NBSP
				|| code === 0x2002    // EN SPACE
				|| code === 0x2003    // EM SPACE
				|| code === 0x2009    // THIN SPACE
				|| code === 0x202F    // NARROW NO-BREAK SPACE
				|| code === 0x3000) { // IDEOGRAPHIC SPACE
				this.pos += 1;
				continue;
			}
			break;
		}
	}

	private peekChar(): string | undefined {
		return this.pos < this.src.length ? this.src[this.pos] : undefined;
	}

	private peek(n: number): string {
		return this.src.slice(this.pos, this.pos + n);
	}

	private expectChar(c: string): void {
		if (this.peekChar() !== c) {
			throw new ParseError(
				`expected '${c}' at position ${this.pos}, got '${this.peekChar() ?? '<EOF>'}'`,
				this.pos,
			);
		}
		this.pos += 1;
	}

	private expectKeyword(kw: string, contextStart: number): void {
		const start = this.pos;
		// Read a full identifier and compare; protects against `thenfoo`
		// matching the prefix `then`.
		while (this.pos < this.src.length && isIdentPart(this.src[this.pos])) {
			this.pos += 1;
		}
		const got = this.src.slice(start, this.pos);
		if (got !== kw) {
			throw new ParseError(
				`expected '${kw}' (in if-then-else starting at ${contextStart}), got '${got}'`,
				start,
			);
		}
	}

	/** Match a comparison operator. Order matters: 2-char ops first. */
	private matchComparisonOp(): BinaryOp | null {
		const c = this.peekChar();
		const n = this.src[this.pos + 1];
		if (c === '=' && n === '=') { this.pos += 2; return '=='; }
		if (c === '!' && n === '=') { this.pos += 2; return '!='; }
		if (c === '<' && n === '=') { this.pos += 2; return '<='; }
		if (c === '>' && n === '=') { this.pos += 2; return '>='; }
		if (c === '<') { this.pos += 1; return '<'; }
		if (c === '>') { this.pos += 1; return '>'; }
		return null;
	}
}

function isDigit(c: string | undefined): boolean {
	return c !== undefined && c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentPart(c: string): boolean {
	return isIdentStart(c) || isDigit(c);
}

// Suppress unused-import warning -- BINARY_OPS is exported for runtime
// validators that walk the AST and want to confirm only-known op names.
// Reference here keeps it live so a future TS-side validator import
// doesn't need to chase down where the set lives.
void BINARY_OPS;
void RESERVED;
