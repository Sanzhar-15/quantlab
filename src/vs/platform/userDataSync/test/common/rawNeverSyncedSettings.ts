/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ParseError, parse, visit } from '../../../../base/common/json.js';

/**
 * QuantLab F-SYNC-STRIP-1: raw JSONC fixtures that write a never-synced key more than once. `JSON.stringify` cannot
 * keep a duplicate property, so every fixture here is built by concatenation, and {@link rawSettings} refuses to
 * return text whose raw occurrence count differs from the one requested. The key names are pinned here on purpose,
 * not read from the product list: dropping a key from the product list must turn the tests RED.
 */
export const DEMO_EMAIL = 'qic.demo.email';
export const DEMO_PASSWORD = 'qic.demo.password';

/** A second spelling of each key (the same property name written with a unicode escape). */
const ESCAPED_SPELLING: Readonly<Record<string, string>> = {
	[DEMO_EMAIL]: 'qic.demo.\\u0065mail',
	[DEMO_PASSWORD]: 'qic.demo.passw\\u006frd'
};

export type RawStyle = 'plain' | 'comments' | 'trailing-comma' | 'compact' | 'escaped-key' | 'keys-only-trailing-comma';

export interface IRawSettings {
	/** The raw JSONC text. */
	readonly text: string;
	/** One distinct value per written occurrence, in text order. */
	readonly sentinels: readonly string[];
	/** The ordinary settings the text holds (each written once). */
	readonly ordinary: Readonly<Record<string, number>>;
}

function countRaw(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** Throws unless the raw text writes every key exactly `occurrences` times (either spelling counts). */
export function assertRawOccurrences(text: string, keys: readonly string[], occurrences: number): void {
	for (const key of keys) {
		const written = countRaw(text, '"' + key + '"') + (ESCAPED_SPELLING[key] ? countRaw(text, '"' + ESCAPED_SPELLING[key] + '"') : 0);
		if (written !== occurrences) {
			throw new Error(`the fixture asked for ${occurrences} occurrence(s) of ${key} and the raw text holds ${written}`);
		}
	}
}

/**
 * `occurrences` copies of every key in `keys`, interleaved with ordinary settings named `<ordinaryPrefix>.…` and
 * each with its own value `<tag>-<n>`. Throws when the raw text does not hold exactly `occurrences` copies of each key.
 */
export function rawSettings(keys: readonly string[], occurrences: number, style: RawStyle, tag: string, ordinaryPrefix: string): IRawSettings {
	if (occurrences < 1) {
		throw new Error(`a fixture needs at least one occurrence, asked for ${occurrences}`);
	}
	const compact = style === 'compact';
	const comments = style === 'comments';
	const trailingComma = style === 'trailing-comma' || style === 'keys-only-trailing-comma';
	const colon = compact ? ':' : ': ';
	const sentinels: string[] = [];
	const ordinary: Record<string, number> = {};
	const entries: { lead: string; text: string; trail: string }[] = [];

	const addOrdinary = (name: string, value: number) => {
		ordinary[name] = value;
		entries.push({ lead: '', text: '"' + name + '"' + colon + value, trail: '' });
	};
	const addCredential = (key: string, occurrence: number) => {
		const sentinel = tag + '-' + sentinels.length;
		sentinels.push(sentinel);
		const spelled = style === 'escaped-key' && occurrence % 2 === 1 ? ESCAPED_SPELLING[key] : key;
		entries.push({
			lead: comments ? '// note before an entry\n\t' : '',
			text: '"' + spelled + '"' + colon + '"' + sentinel + '"',
			trail: comments ? ' /* note after an entry */' : ''
		});
	};

	if (style !== 'keys-only-trailing-comma') {
		addOrdinary(ordinaryPrefix + '.head', 1);
	}
	for (let occurrence = 0; occurrence < occurrences; occurrence++) {
		for (const key of keys) {
			addCredential(key, occurrence);
		}
		if (style !== 'keys-only-trailing-comma') {
			addOrdinary(ordinaryPrefix + '.between-' + occurrence, 100 + occurrence);
		}
	}
	if (style !== 'keys-only-trailing-comma') {
		addOrdinary(ordinaryPrefix + '.tail', 2);
	}

	const eol = compact ? '' : '\n';
	const indent = compact ? '' : '\t';
	const lines = entries.map((entry, index) => indent + entry.lead + entry.text + (index < entries.length - 1 || trailingComma ? ',' : '') + entry.trail);
	const text = '{' + eol + lines.join(eol) + eol + '}';

	// The fixture proves its own duplicates in the raw text.
	assertRawOccurrences(text, keys, occurrences);
	for (const sentinel of sentinels) {
		if (countRaw(text, '"' + sentinel + '"') !== 1) {
			throw new Error(`the sentinel ${sentinel} is not written exactly once`);
		}
	}
	return { text, sentinels, ordinary };
}

/** The names of the properties of the root object, in text order, found by the real tokenizer. */
export function topLevelPropertyNames(content: string): string[] {
	const names: string[] = [];
	const errors: ParseError[] = [];
	let depth = 0;
	visit(content, {
		onObjectBegin: () => { depth++; },
		onObjectEnd: () => { depth--; },
		onArrayBegin: () => { depth++; },
		onArrayEnd: () => { depth--; },
		onObjectProperty: (name: string) => { if (depth === 1) { names.push(name); } },
		onError: (error, offset, length) => { errors.push({ error, offset, length }); }
	}, { allowTrailingComma: true, allowEmptyContent: true });
	assert.deepStrictEqual(errors, [], 'the content must parse');
	return names;
}

/** No never-synced key at the top level, none spelled anywhere in the text, and none of the sentinel values. */
export function assertNoNeverSynced(content: string, sentinels: readonly string[], context: string): void {
	assert.ok(!content.includes('qic.demo.'), `${context}: a qic.demo.* key is in the content`);
	for (const sentinel of sentinels) {
		assert.ok(!content.includes(sentinel), `${context}: the value ${sentinel} is in the content`);
	}
}

/** The settings content parses and holds neither key as a top-level property (checked on the decoded property names). */
export function assertNoNeverSyncedProperty(settings: string, context: string): void {
	const names = topLevelPropertyNames(settings);
	assert.ok(!names.includes(DEMO_EMAIL), `${context}: ${DEMO_EMAIL} is a top-level property`);
	assert.ok(!names.includes(DEMO_PASSWORD), `${context}: ${DEMO_PASSWORD} is a top-level property`);
}

/** Every expected ordinary setting is in the content with its value. */
export function assertOrdinaryKept(settings: string, expected: Readonly<Record<string, number>>, context: string): void {
	const errors: ParseError[] = [];
	const parsed = parse(settings, errors, { allowTrailingComma: true, allowEmptyContent: true });
	assert.deepStrictEqual(errors, [], `${context}: the content must parse`);
	for (const [name, value] of Object.entries(expected)) {
		assert.strictEqual(parsed?.[name], value, `${context}: the ordinary setting ${name} must be kept`);
	}
}
