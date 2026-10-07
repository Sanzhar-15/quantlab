#!/bin/bash
# F-PACK-13 closing check 7 (LOG-1): no secret value in a log line or thrown message on the encryption / secret-storage paths.
# Run: bash src/vs/platform/encryption/test/check-no-secret-in-logs.sh   (from any directory; needs `node` on PATH)
# Self-test: bash src/vs/platform/encryption/test/check-no-secret-in-logs.selftest.sh
# rc 0 = no hit · rc 1 = hit(s), printed as file:line · rc 3 = a target file is missing · rc 2 = tool error (grep, node,
# or a target the walker cannot tokenize). A tool error is never reported as "no hits".
#
# RULE A (secret identifiers, grep, one line at a time). A SINK line (throw, Error(...), a log call, console.*) that also
# carries a value-bearing identifier in a LEAK position: a ${...} interpolation of the bare identifier (or its member
# chain), a bare call argument, a string concatenation operand, or a JSON.stringify argument.
# Identifier names (keys such as `key`/`fullKey`/`extensionId` are identifiers, not secrets, and are not listed):
# value(s), encrypted/decrypted(Value), ciphertext, plaintext, password, secret(Value), token, parsedValue, bufferToDecrypt.
# Limit: one line at a time; a log call whose leaking argument sits on a continuation line is not seen by rule A.
#
# RULE B (raw caught errors, token walker in plain node, built-ins only, embedded below). A caught error may carry a
# secret in its message or stack (a JSON.parse SyntaxError quotes its input; a native Keychain error is opaque), so every
# RAW use of one in a sink is a hit, whatever its name. Conservative: it does not decide whether a given error holds a
# secret. The walker tokenizes TypeScript (comments, strings, template literals with nested ${}, regex literals) and
# matches brackets; an untokenizable target is rc 2, never "no hits".
#   Caught-error bindings: `catch (<binding or destructuring>)` blocks; the parameter of a `.catch(handler)` and of the
#   second (rejection) handler of `.then(ok, handler)`. A rejection handler that is not an inline arrow/function
#   (e.g. `.catch(onUnexpectedError)`) cannot be followed and is itself a hit.
#   Taint: inside the scope, `const|let|var x = <init>` (and `x = <init>`, and destructuring) whose init uses a tainted
#   name raw makes x (or the destructured names) tainted too, e.g. `const { message } = e`, `const m = e.message`.
#   A raw use is a hit when it is: inside the arguments of a log call (.trace/.debug/.info/.warn/.error/.critical/.log,
#   console.*, onUnexpectedError, onUnexpectedExternalError), at any nesting depth, on any line of the call; inside a
#   ${...} interpolation; inside String(...) or JSON.stringify(...); inside the arguments of `new <X>Error(...)` or
#   `Error(...)`; the value of a `cause:` property or of a `cause =` assignment (or shorthand `{ cause }`); an operand
#   of a binary `+` / `+=`; or a member chain ending in a `.toString()` / `.toLocaleString()` call.
#   Not covered, by name: `throw e` / `return e` (rethrow of the original error), a tainted value leaving through a call
#   into another function outside the sinks above, aliasing through object members or closures outside the catch scope.
#   EXCEPTIONS (a use in one of these forms is not raw), each with its reason:
#     typeof <e>                 → a primitive type name, never error content.
#     <e> instanceof <X>         → a boolean.
#     <e>.name, <e>.constructor.name (also with ?.) → the error class name; the fold's design (i) logs failed(class).
#     errorClassOf(<e>)          → returns the class name or `non-Error <typeof>` only. Valid only while the same file
#                                  defines `function errorClassOf` with exactly the pinned body below (HELPER_BODY);
#                                  any other body, or a call with no local definition, is a hit (re-justify it here).
set -u

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"

TARGETS=(
	src/vs/platform/encryption/common/encryptionService.ts
	src/vs/platform/encryption/electron-main/encryptionMainService.ts
	src/vs/platform/secrets/common/secrets.ts
	src/vs/workbench/services/secrets/browser/secretStorageService.ts
	src/vs/workbench/services/secrets/electron-browser/secretStorageService.ts
	src/vs/workbench/services/encryption/browser/encryptionService.ts
	src/vs/workbench/services/encryption/electron-browser/encryptionService.ts
	src/vs/workbench/api/browser/mainThreadSecretState.ts
	src/vs/workbench/api/common/extHostSecretState.ts
	src/vs/workbench/api/common/extHostSecrets.ts
)

missing=0
for f in "${TARGETS[@]}"; do
	if [ ! -f "$ROOT/$f" ]; then
		echo "MISSING target: $f"
		missing=1
	fi
done
if [ "$missing" -ne 0 ]; then
	echo "RED: target file(s) missing (rc 3)"
	exit 3
fi

# ---- RULE A ----
NB='[^A-Za-z0-9_$]'
IDS='(value|values|encrypted|decrypted|encryptedValue|decryptedValue|ciphertext|cipherText|plaintext|plainText|password|secret|secretValue|token|parsedValue|bufferToDecrypt)'
CHAIN='([.][A-Za-z0-9_$]+)*'
SINK='(throw[[:space:]]|Error\(|\.(trace|debug|info|warn|error|critical|log)\(|console\.)'
LEAK_INTERP="\\\$\\{[[:space:]]*${IDS}${CHAIN}[[:space:]]*\\}"
LEAK_ARG="[(,][[:space:]]*${IDS}${CHAIN}[[:space:]]*[,)]"
LEAK_CONCAT="(\\+[[:space:]]*${IDS}(${NB}|\$)|(^|${NB})${IDS}${CHAIN}[[:space:]]*\\+)"
LEAK_JSON="JSON\\.stringify\\([[:space:]]*${IDS}(${NB}|\$)"
LEAK="(${LEAK_INTERP}|${LEAK_ARG}|${LEAK_CONCAT}|${LEAK_JSON})"

hits=0
for f in "${TARGETS[@]}"; do
	sink_lines="$(grep -nE "$SINK" "$ROOT/$f")"
	rc=$?
	if [ "$rc" -eq 2 ]; then
		echo "grep error on $f (rc 2)"
		exit 2
	fi
	if [ "$rc" -eq 1 ]; then
		continue
	fi
	leak_lines="$(printf '%s\n' "$sink_lines" | grep -E "$LEAK")"
	rc=$?
	if [ "$rc" -eq 2 ]; then
		echo "grep error on $f (rc 2)"
		exit 2
	fi
	if [ "$rc" -eq 0 ]; then
		printf '%s\n' "$leak_lines" | sed "s|^|$f:|"
		hits=1
	fi
done

# ---- RULE B ----
if ! command -v node >/dev/null; then
	echo "node not found on PATH: the caught-error walker cannot run (rc 2)"
	exit 2
fi
walker_out="$(node - "$ROOT" "${TARGETS[@]}" <<'WALKER'
'use strict';
const fs = require('fs');
const path = require('path');

// The one errorClassOf body the exception accepts (token kind:value, space-joined). Class name or typeof only.
const HELPER_BODY = 'p:{ id:if p:( id:error id:instanceof id:Error p:) p:{ id:return id:error p:. id:constructor p:. id:name p:; p:} id:return tmpl:non-Error  p:${ id:typeof id:error p:} tmpl: p:; p:}';

class WalkError extends Error { }
const fail = (msg) => { throw new WalkError(msg); };

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'critical', 'log']);
const LOG_FUNCS = new Set(['onUnexpectedError', 'onUnexpectedExternalError']);
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const SINGLE = '=+-*%&|^!~<>?:;,.@#';

function tokenize(src, file) {
	const toks = [];
	const braces = [];
	const n = src.length;
	let i = 0;
	let line = 1;
	const push = (k, v, ln) => toks.push({ k, v, line: ln });
	const regexAllowed = () => {
		const p = toks[toks.length - 1];
		if (!p) { return true; }
		if (p.k === 'id') { return KW_BEFORE_REGEX.has(p.v); }
		if (p.k !== 'p') { return false; }
		return p.v !== ')' && p.v !== ']';
	};
	const templateChunk = () => {
		const ln = line;
		const s = i;
		while (i < n) {
			const c = src[i];
			if (c === '\\') { if (src[i + 1] === '\n') { line++; } i += 2; continue; }
			if (c === '\n') { line++; i++; continue; }
			if (c === '`') { push('tmpl', src.slice(s, i), ln); i++; return; }
			if (c === '$' && src[i + 1] === '{') { push('tmpl', src.slice(s, i), ln); push('p', '${', line); braces.push('interp'); i += 2; return; }
			i++;
		}
		fail(`${file}:${ln}: unterminated template literal`);
	};
	while (i < n) {
		const c = src[i];
		if (c === '\n') { line++; i++; continue; }
		if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { i++; continue; }
		if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { i++; } continue; }
		if (c === '/' && src[i + 1] === '*') {
			const e = src.indexOf('*/', i + 2);
			if (e < 0) { fail(`${file}:${line}: unterminated block comment`); }
			for (let j = i; j < e; j++) { if (src[j] === '\n') { line++; } }
			i = e + 2;
			continue;
		}
		if (c === '"' || c === '\'') {
			const ln = line;
			let j = i + 1;
			while (j < n && src[j] !== c) {
				if (src[j] === '\\') { if (src[j + 1] === '\n') { line++; } j += 2; continue; }
				if (src[j] === '\n') { fail(`${file}:${ln}: unterminated string literal`); }
				j++;
			}
			if (j >= n) { fail(`${file}:${ln}: unterminated string literal`); }
			push('str', src.slice(i, j + 1), ln);
			i = j + 1;
			continue;
		}
		if (c === '`') { i++; templateChunk(); continue; }
		if (/[A-Za-z_$]/.test(c)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_$]/.test(src[j])) { j++; }
			push('id', src.slice(i, j), line);
			i = j;
			continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
			let j = i + 1;
			while (j < n && /[0-9A-Za-z_.]/.test(src[j])) { j++; }
			push('num', src.slice(i, j), line);
			i = j;
			continue;
		}
		if (c === '/' && regexAllowed()) {
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				const d = src[j];
				if (d === '\\') { j += 2; continue; }
				if (d === '\n') { fail(`${file}:${line}: unterminated regex literal`); }
				if (inClass) { if (d === ']') { inClass = false; } } else if (d === '[') { inClass = true; } else if (d === '/') { break; }
				j++;
			}
			if (j >= n) { fail(`${file}:${line}: unterminated regex literal`); }
			j++;
			while (j < n && /[A-Za-z]/.test(src[j])) { j++; }
			push('re', src.slice(i, j), line);
			i = j;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') { if (c === '{') { braces.push('brace'); } push('p', c, line); i++; continue; }
		if (c === '}') {
			const top = braces.pop();
			if (top === undefined) { fail(`${file}:${line}: unbalanced }`); }
			push('p', '}', line);
			i++;
			if (top === 'interp') { templateChunk(); }
			continue;
		}
		if (c === ')' || c === ']') { push('p', c, line); i++; continue; }
		let m = null;
		for (const p of PUNCT) { if (src.startsWith(p, i)) { m = p; break; } }
		if (m === '?.' && /[0-9]/.test(src[i + 2])) { m = null; }
		if (m === null) {
			if (!SINGLE.includes(c)) { fail(`${file}:${line}: unexpected character ${JSON.stringify(c)}`); }
			m = c;
		}
		push('p', m, line);
		i += m.length;
	}
	if (braces.length) { fail(`${file}: unbalanced { at end of file`); }
	return toks;
}
PUNCT.sort((a, b) => b.length - a.length);

function link(toks, file) {
	const stack = [];
	const closeOf = { '(': ')', '[': ']', '{': '}', '${': '}' };
	for (let k = 0; k < toks.length; k++) {
		const t = toks[k];
		t.parent = stack.length ? stack[stack.length - 1] : -1;
		if (t.k !== 'p') { continue; }
		if (closeOf[t.v]) { stack.push(k); continue; }
		if (t.v === ')' || t.v === ']' || t.v === '}') {
			const o = stack.pop();
			if (o === undefined || closeOf[toks[o].v] !== t.v) { fail(`${file}:${t.line}: mismatched ${t.v}`); }
			toks[o].match = k;
			t.open = o;
			t.parent = toks[o].parent;
		}
	}
	if (stack.length) { fail(`${file}:${toks[stack[0]].line}: unclosed ${toks[stack[0]].v}`); }
}

const isP = (t, v) => t !== undefined && t.k === 'p' && t.v === v;
const isId = (t, v) => t !== undefined && t.k === 'id' && (v === undefined || t.v === v);
const isDot = (t) => isP(t, '.') || isP(t, '?.');

// Binding names of a parameter list or pattern between [from, to) (exclusive), skipping types and default values.
function patternNames(toks, from, to) {
	const names = new Set();
	const top = toks[from] ? toks[from].parent : -1;
	for (let j = from; j < to; j++) {
		const t = toks[j];
		if (t.parent === top && (isP(t, ':') || isP(t, '='))) {
			while (j + 1 < to && !(toks[j + 1].parent === top && isP(toks[j + 1], ','))) { j++; }
			continue;
		}
		if (t.k === 'p' && t.v === '=' ) {
			const lvl = t.parent;
			while (j + 1 < to && !(toks[j + 1].parent === lvl && (isP(toks[j + 1], ',')))) { j++; }
			continue;
		}
		if (t.k !== 'id') { continue; }
		const nx = toks[j + 1];
		if (t.parent !== top && isP(nx, ':')) { continue; } // `{ key: binding }` key
		names.add(t.v);
	}
	return names;
}

function chainOf(toks, j) {
	const segs = [];
	let k = j + 1;
	for (;;) {
		const t = toks[k];
		if (isP(t, '!') && (isDot(toks[k + 1]) || isP(toks[k + 1], '['))) { k++; continue; }
		if (isDot(t) && isId(toks[k + 1])) { segs.push(toks[k + 1].v); k += 2; continue; }
		if (isP(t, '?.') && (isP(toks[k + 1], '(') || isP(toks[k + 1], '['))) { k++; continue; }
		if (isP(t, '[')) { segs.push('[]'); k = t.match + 1; continue; }
		if (isP(t, '(')) { segs.push('()'); k = t.match + 1; continue; }
		break;
	}
	return { segs, end: k - 1 };
}

function isRef(toks, j) {
	if (isDot(toks[j - 1])) { return false; }
	const par = toks[toks[j].parent];
	if (isP(toks[j + 1], ':') && par && isP(par, '{') && (isP(toks[j - 1], '{') || isP(toks[j - 1], ','))) { return false; }
	return true;
}

function allowedForm(toks, j, helperOk) {
	if (isId(toks[j - 1], 'typeof')) { return true; }
	const { segs, end } = chainOf(toks, j);
	if (segs.length === 0 && isId(toks[end + 1], 'instanceof')) { return true; }
	const s = segs.join('.');
	if (s === 'name' || s === 'constructor.name') { return true; }
	if (segs.length === 0 && isP(toks[j - 1], '(') && isId(toks[j - 2], 'errorClassOf') && !isDot(toks[j - 3]) && isP(toks[end + 1], ')')) {
		return helperOk;
	}
	return false;
}

// Start of the expression a call/index opener belongs to: walks back over its callee chain and a leading `new`.
function exprStart(toks, a) {
	let k = a;
	for (;;) {
		const prev = toks[k - 1];
		if (isId(prev) && !KW_BEFORE_REGEX.has(prev.v) && prev.v !== 'if' && prev.v !== 'while' && prev.v !== 'for' && prev.v !== 'switch' && prev.v !== 'catch') {
			k--;
			if (isDot(toks[k - 1])) { k--; continue; }
			break;
		}
		if ((isP(prev, ')') || isP(prev, ']')) && isP(toks[k], '(') ) { k = prev.open; continue; }
		break;
	}
	if (isId(toks[k - 1], 'new')) { k--; }
	return k;
}

function calleeSink(toks, a) {
	const c1 = toks[a - 1];
	if (!isId(c1)) { return null; }
	const member = isDot(toks[a - 2]);
	if (member && LOG_METHODS.has(c1.v)) { return 'log call'; }
	if (member && isId(toks[a - 3], 'console')) { return 'log call'; }
	if (!member && LOG_FUNCS.has(c1.v)) { return 'log call'; }
	if (!member && c1.v === 'String') { return 'String()'; }
	if (member && c1.v === 'stringify' && isId(toks[a - 3], 'JSON')) { return 'JSON.stringify'; }
	if (/Error$/.test(c1.v)) {
		if (!member && c1.v === 'Error') { return 'Error message'; }
		if (isId(toks[exprStart(toks, a) ], 'new')) { return 'Error message'; }
	}
	return null;
}

// Tokens [s .. e] form one operand at parent level P: is it a `+` operand, or the value of `cause`?
function levelSinks(toks, s, e, P, out) {
	const before = toks[s - 1];
	const operandEnd = (t) => t !== undefined && (t.k === 'id' || t.k === 'num' || t.k === 'str' || t.k === 'tmpl' || t.k === 're' || isP(t, ')') || isP(t, ']'));
	if (isP(before, '+=') || (isP(before, '+') && operandEnd(toks[s - 2]))) { out.add('string concatenation'); }
	if (isP(toks[e + 1], '+') || isP(toks[e + 1], '+=')) { out.add('string concatenation'); }
	let k = s - 1;
	while (k > P && k >= 0) {
		const t = toks[k];
		if (t.parent === P && (isP(t, ',') || isP(t, ';'))) { break; }
		if ((isP(t, ')') || isP(t, ']') || isP(t, '}')) && t.parent === P) { k = t.open - 1; continue; }
		k--;
	}
	if (isId(toks[k + 1], 'cause') && isP(toks[k + 2], ':')) { out.add('Error cause'); }
	for (let m = k + 1; m < s; m++) {
		if (toks[m].parent === P && isId(toks[m], 'cause') && isP(toks[m + 1], '=')) { out.add('Error cause'); }
	}
}

function sinksOf(toks, j, scopeOpen) {
	const out = new Set();
	const { segs, end } = chainOf(toks, j);
	const last = segs.length >= 2 ? segs[segs.length - 2] : '';
	if ((last === 'toString' || last === 'toLocaleString') && segs[segs.length - 1] === '()') { out.add('toString()'); }
	if (toks[j].v === 'cause' && isP(toks[toks[j].parent], '{') && segs.length === 0
		&& (isP(toks[j - 1], '{') || isP(toks[j - 1], ',')) && (isP(toks[j + 1], ',') || isP(toks[j + 1], '}'))) {
		out.add('Error cause');
	}
	levelSinks(toks, j, end, toks[j].parent, out);
	let a = toks[j].parent;
	while (a > scopeOpen) {
		const o = toks[a];
		if (isP(o, '${')) { out.add('interpolation'); }
		if (isP(o, '(')) { const c = calleeSink(toks, a); if (c) { out.add(c); } }
		const s = isP(o, '(') || isP(o, '[') ? exprStart(toks, a) : a;
		levelSinks(toks, s, o.match, o.parent, out);
		a = o.parent;
	}
	return out;
}

function handlerScope(toks, s, end, file, scopes, hits, lines) {
	let k = s;
	if (isId(toks[k], 'async')) { k++; }
	const t = toks[k];
	if (isId(t) && isP(toks[k + 1], '=>') && t.v !== 'function') {
		scopes.push({ names: new Set([t.v]), open: toks[k].parent, from: k + 2, to: end, line: t.line });
		return;
	}
	if (isP(t, '(') && isP(toks[t.match + 1], '=>')) {
		scopes.push({ names: patternNames(toks, k + 1, t.match), open: toks[k].parent, from: t.match + 2, to: end, line: t.line });
		return;
	}
	if (isId(t, 'function')) {
		let p = k + 1;
		if (isId(toks[p])) { p++; }
		if (!isP(toks[p], '(')) { fail(`${file}:${t.line}: rejection handler function without a parameter list`); }
		scopes.push({ names: patternNames(toks, p + 1, toks[p].match), open: toks[k].parent, from: toks[p].match + 1, to: end, line: t.line });
		return;
	}
	const ln = (t === undefined ? toks[s - 1] : t).line;
	hits.push(`${file}:${ln}: caught-error rejection handler not an inline function (cannot follow the error): ${lines[ln - 1].trim()}`);
}

function findScopes(toks, file, hits, lines) {
	const scopes = [];
	for (let k = 0; k < toks.length; k++) {
		const t = toks[k];
		if (!isId(t)) { continue; }
		if (t.v === 'catch' && !isDot(toks[k - 1])) {
			const nx = toks[k + 1];
			if (isP(nx, ':') || isP(nx, ',')) { continue; } // property key named catch
			if (isP(nx, '{')) { continue; } // optional catch binding: nothing caught is named
			if (!isP(nx, '(')) { fail(`${file}:${t.line}: catch not followed by ( or {`); }
			const body = toks[nx.match + 1];
			if (!isP(body, '{')) { fail(`${file}:${t.line}: catch (...) not followed by a block`); }
			scopes.push({ names: patternNames(toks, k + 2, nx.match), open: nx.match + 1, from: nx.match + 2, to: body.match, line: t.line });
			continue;
		}
		if ((t.v === 'catch' || t.v === 'then') && isDot(toks[k - 1]) && isP(toks[k + 1], '(')) {
			const open = k + 1;
			const close = toks[open].match;
			if (t.v === 'catch') { handlerScope(toks, k + 2, close, file, scopes, hits, lines); continue; }
			let comma = -1;
			for (let m = k + 2; m < close; m++) { if (toks[m].parent === open && isP(toks[m], ',')) { comma = m; break; } }
			if (comma < 0) { continue; } // .then(ok): no rejection handler
			let stop = close;
			for (let m = comma + 1; m < close; m++) { if (toks[m].parent === open && isP(toks[m], ',')) { stop = m; break; } }
			if (comma + 1 < stop) { handlerScope(toks, comma + 1, stop, file, scopes, hits, lines); }
		}
	}
	return scopes;
}

function helperVerified(toks, file, hits, lines) {
	const calls = toks.filter((t, k) => isId(t, 'errorClassOf') && !isId(toks[k - 1], 'function') && isP(toks[k + 1], '('));
	if (calls.length === 0) { return false; }
	const defs = [];
	for (let k = 0; k < toks.length; k++) {
		if (isId(toks[k], 'function') && isId(toks[k + 1], 'errorClassOf') && isP(toks[k + 2], '(')) { defs.push(k); }
	}
	if (defs.length !== 1) {
		hits.push(`${file}:${calls[0].line}: caught-error exception errorClassOf: ${defs.length} local definitions (need exactly 1 with the pinned body): ${lines[calls[0].line - 1].trim()}`);
		return false;
	}
	let b = toks[defs[0] + 2].match + 1;
	while (b < toks.length && !(isP(toks[b], '{') && toks[b].parent === toks[defs[0]].parent)) { b++; }
	if (b >= toks.length) { fail(`${file}: function errorClassOf has no body`); }
	const body = toks.slice(b, toks[b].match + 1).map(t => `${t.k}:${t.v}`).join(' ');
	if (body !== HELPER_BODY) {
		hits.push(`${file}:${toks[defs[0]].line}: caught-error exception errorClassOf: body is not the pinned class-only body (re-justify it in the gate): ${body}`);
		return false;
	}
	return true;
}

function analyze(toks, scope, file, helperOk, hits, lines) {
	const tainted = new Set(scope.names);
	for (let j = scope.from; j < scope.to; j++) {
		const t = toks[j];
		if (isP(t, '=')) {
			const P = t.parent;
			let k = j - 1;
			while (k > P && k >= 0) {
				const u = toks[k];
				if (u.parent === P && (isP(u, ',') || isP(u, ';') || isId(u, 'const') || isId(u, 'let') || isId(u, 'var'))) { break; }
				if ((isP(u, ')') || isP(u, ']') || isP(u, '}')) && u.parent === P) { k = u.open - 1; continue; }
				k--;
			}
			const first = toks[k + 1];
			let names = null;
			if (isId(first) && (k + 2 === j || isP(toks[k + 2], ':'))) { names = new Set([first.v]); }
			if ((isP(first, '{') || isP(first, '[')) && first.match === j - 1) { names = patternNames(toks, k + 2, first.match); }
			if (names === null) { continue; }
			let e = j + 1;
			while (e < toks.length && !(toks[e].parent === P && (isP(toks[e], ',') || isP(toks[e], ';'))) && !(toks[e].open !== undefined && toks[e].open === P)) { e++; }
			for (let m = j + 1; m < e; m++) {
				if (isId(toks[m]) && tainted.has(toks[m].v) && isRef(toks, m) && !allowedForm(toks, m, helperOk)) {
					for (const nm of names) { tainted.add(nm); }
					break;
				}
			}
			continue;
		}
		if (!isId(t) || !tainted.has(t.v) || !isRef(toks, j)) { continue; }
		if (allowedForm(toks, j, helperOk)) { continue; }
		const sinks = sinksOf(toks, j, scope.open);
		if (sinks.size) {
			hits.push(`${file}:${t.line}: caught-error ${[...sinks].join(' + ')} (raw \`${t.v}\`, caught at line ${scope.line}): ${lines[t.line - 1].trim()}`);
		}
	}
}

function main() {
	const [root, ...targets] = process.argv.slice(2);
	if (!root || targets.length === 0) { fail('usage: node - <root> <target>...'); }
	const hits = [];
	let scopeCount = 0;
	for (const rel of targets) {
		const src = fs.readFileSync(path.join(root, rel), 'utf8');
		const lines = src.split('\n');
		const toks = tokenize(src, rel);
		link(toks, rel);
		const helperOk = helperVerified(toks, rel, hits, lines);
		const scopes = findScopes(toks, rel, hits, lines);
		scopeCount += scopes.length;
		for (const scope of scopes) { analyze(toks, scope, rel, helperOk, hits, lines); }
	}
	for (const h of [...new Set(hits)]) { console.log(h); }
	console.log(`WALKER-OK files=${targets.length} scopes=${scopeCount} hits=${new Set(hits).size}`);
}

try {
	main();
} catch (err) {
	if (err instanceof WalkError) {
		process.stderr.write(`walker: cannot analyse: ${err.message}\n`);
		process.exit(2);
	}
	throw err;
}
WALKER
)"
walker_rc=$?
if [ "$walker_rc" -ne 0 ]; then
	printf '%s\n' "$walker_out"
	echo "walker error: node exited $walker_rc (rc 2)"
	exit 2
fi
sentinel="$(printf '%s\n' "$walker_out" | tail -n 1)"
if ! [[ "$sentinel" =~ ^WALKER-OK\ files=([0-9]+)\ scopes=([0-9]+)\ hits=([0-9]+)$ ]]; then
	printf '%s\n' "$walker_out"
	echo "walker error: no completion line (rc 2)"
	exit 2
fi
walker_files="${BASH_REMATCH[1]}"
walker_scopes="${BASH_REMATCH[2]}"
walker_hits="${BASH_REMATCH[3]}"
if [ "$walker_files" -ne "${#TARGETS[@]}" ]; then
	echo "walker error: analysed $walker_files of ${#TARGETS[@]} targets (rc 2)"
	exit 2
fi
if [ "$walker_hits" -ne 0 ]; then
	printf '%s\n' "$walker_out" | sed '$d'
	hits=1
fi

if [ "$hits" -ne 0 ]; then
	echo "RED: secret value or raw caught error in a log line, thrown message or error cause (rc 1)"
	exit 1
fi
echo "GREEN: ${#TARGETS[@]} target files present, 0 hits (rule A secret identifiers; rule B raw caught errors, $walker_scopes catch scopes walked)"
exit 0
