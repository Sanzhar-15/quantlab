/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared structural-equality and canonical-serialization utilities.
 *
 * Background: the prior session shipped THREE separate "structural compare"
 * implementations (`serializedEqual` in specDocCore, `transformsShallowEqual`
 * in specState, ad-hoc compares elsewhere) all built on `JSON.stringify`,
 * which is property-order-sensitive. The Step A megaudit caught the first
 * occurrence; the Step B megaudit caught two more. Consolidating the
 * comparator here so future code has one obvious correct answer.
 *
 * Two exports:
 *   - `structurallyEqual(a, b)`: recursive deep-equal that ignores property
 *     order and treats `undefined` as "absent" (matching JSON.stringify's
 *     omit-on-undefined behaviour).
 *   - `canonicalStringify(value)`: JSON.stringify variant with sorted
 *     property keys at every level, so identical-content objects produce
 *     identical bytes regardless of insertion order. Use for hashes
 *     (specHash) where byte stability matters.
 */

/** Recursive structural equality for JSON-shaped values. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
	if (a === b) { return true; }
	if (a === null || b === null) { return false; }
	if (typeof a !== 'object' || typeof b !== 'object') { return false; }
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) { return false; }
		for (let i = 0; i < a.length; i++) {
			if (!structurallyEqual(a[i], b[i])) { return false; }
		}
		return true;
	}
	if (Array.isArray(b)) { return false; }
	const aRec = a as Record<string, unknown>;
	const bRec = b as Record<string, unknown>;
	const aKeys = Object.keys(aRec).filter(k => aRec[k] !== undefined);
	const bKeys = Object.keys(bRec).filter(k => bRec[k] !== undefined);
	if (aKeys.length !== bKeys.length) { return false; }
	for (const k of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(bRec, k)) { return false; }
		if (!structurallyEqual(aRec[k], bRec[k])) { return false; }
	}
	return true;
}

/**
 * JSON.stringify with deterministic property-key order (lexicographic at
 * every nesting level). The output is byte-stable for content-equal
 * inputs regardless of insertion order. Drops `undefined` values, same
 * as plain JSON.stringify.
 *
 * Throws on unsupported types (functions, BigInt, Symbol, circular refs).
 * Caller's responsibility to pre-flight values; this is hot-path code.
 */
export function canonicalStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) { return value; }
	if (typeof value !== 'object') { return value; }
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	const obj = value as Record<string, unknown>;
	const sortedKeys = Object.keys(obj).sort();
	const result: Record<string, unknown> = {};
	for (const k of sortedKeys) {
		const v = obj[k];
		if (v === undefined) { continue; }
		result[k] = canonicalize(v);
	}
	return result;
}
