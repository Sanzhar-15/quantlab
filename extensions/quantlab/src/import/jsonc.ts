/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QL-IMPORT: a minimal JSONC reader (VS Code `settings.json` / `keybindings.json` allow comments and
 * trailing commas). A character scanner that honours string literals and `\` escapes, so `//` or `/*`
 * inside a string value is data, never a comment.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces `//` and block comments outside string literals with a single space. */
function stripComments(text: string, what: string): string {
	const out: string[] = [];
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text.charAt(i);
		if (inString) {
			out.push(ch);
			if (ch === '\\') {
				if (i + 1 < text.length) {
					out.push(text.charAt(i + 1));
				}
				i += 2;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out.push(ch);
			i++;
			continue;
		}
		if (ch === '/' && text.charAt(i + 1) === '/') {
			while (i < text.length && text.charAt(i) !== '\n' && text.charAt(i) !== '\r') {
				i++;
			}
			out.push(' ');
			continue;
		}
		if (ch === '/' && text.charAt(i + 1) === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end === -1) {
				throw new Error(`${what}: unterminated block comment`);
			}
			out.push(' ');
			i = end + 2;
			continue;
		}
		out.push(ch);
		i++;
	}
	return out.join('');
}

function isJsonWhitespace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Drops a `,` outside string literals when only whitespace separates it from a closing `}` or `]`. */
function stripTrailingCommas(text: string): string {
	const out: string[] = [];
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text.charAt(i);
		if (inString) {
			out.push(ch);
			if (ch === '\\') {
				if (i + 1 < text.length) {
					out.push(text.charAt(i + 1));
				}
				i += 2;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out.push(ch);
			i++;
			continue;
		}
		if (ch === ',') {
			let j = i + 1;
			while (j < text.length && isJsonWhitespace(text.charAt(j))) {
				j++;
			}
			const next = text.charAt(j);
			if (next === '}' || next === ']') {
				i++;
				continue;
			}
		}
		out.push(ch);
		i++;
	}
	return out.join('');
}

/**
 * Parses JSONC text. Throws an Error naming `what` when the text is empty, has an unterminated block
 * comment or is not valid JSON once comments and trailing commas are removed. What an absent file
 * means is the caller's decision, not the parser's.
 */
export function parseJsonc(text: string, what: string): unknown {
	const withoutBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
	const clean = stripTrailingCommas(stripComments(withoutBom, what));
	if (clean.trim() === '') {
		throw new Error(`${what}: no JSON content (empty file)`);
	}
	try {
		return JSON.parse(clean);
	} catch (err: unknown) {
		throw new Error(`${what}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
