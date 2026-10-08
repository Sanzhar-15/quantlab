/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isPlainObject } from './jsonc';

/**
 * QL-IMPORT: pure merges of imported settings / keybindings into the existing user files.
 */

/** JSON with object keys sorted recursively, so equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	}
	return value;
}

export interface SettingsMerge {
	merged: Record<string, unknown>;
	added: string[];
	overwritten: string[];
	unchanged: string[];
}

/**
 * Top-level key merge; the imported value wins. Existing keys keep their position, new keys follow
 * in the imported order.
 */
export function mergeSettings(existing: Record<string, unknown>, imported: Record<string, unknown>): SettingsMerge {
	const entries = new Map<string, unknown>(Object.entries(existing));
	const added: string[] = [];
	const overwritten: string[] = [];
	const unchanged: string[] = [];
	for (const [key, value] of Object.entries(imported)) {
		if (!entries.has(key)) {
			added.push(key);
		} else if (canonicalJson(entries.get(key)) === canonicalJson(value)) {
			unchanged.push(key);
		} else {
			overwritten.push(key);
		}
		entries.set(key, value);
	}
	return { merged: Object.fromEntries(entries), added, overwritten, unchanged };
}

export interface KeybindingsMerge {
	merged: unknown[];
	added: number;
	duplicates: number;
}

/** The `key` string of a keybinding entry, or undefined when the entry has none (then it conflicts with nothing). */
function keybindingKey(entry: unknown): string | undefined {
	return isPlainObject(entry) && typeof entry.key === 'string' ? entry.key : undefined;
}

/**
 * Existing entries first, then the imported ones; later entries win in VS Code, so order is precedence.
 * An imported entry equal to one already present is not added again, but it is not allowed to lose
 * precedence either: when a different entry bound to the same key sits between its first and its last
 * occurrence in existing + imported (`[A, B, A]` for two commands on one key), the LAST occurrence is
 * kept and the earlier ones dropped, so A still wins over B; when nothing conflicts between them, the
 * first occurrence stays where it is, so an identical re-import changes nothing. Existing entries that
 * the import does not repeat are never touched.
 */
export function mergeKeybindings(existing: unknown[], imported: unknown[]): KeybindingsMerge {
	const sequence = [...existing, ...imported];
	const canon = sequence.map(canonicalJson);
	const importedCanon = new Set<string>(canon.slice(existing.length));
	const occurrences = new Map<string, number[]>();
	canon.forEach((c, index) => occurrences.set(c, [...(occurrences.get(c) ?? []), index]));

	const dropped = new Set<number>();
	for (const [c, indices] of occurrences) {
		if (indices.length === 1 || !importedCanon.has(c)) {
			continue;
		}
		const first = indices[0];
		const last = indices[indices.length - 1];
		const key = keybindingKey(sequence[first]);
		let conflictBetween = false;
		for (let j = first + 1; j < last && key !== undefined; j++) {
			if (canon[j] !== c && keybindingKey(sequence[j]) === key) {
				conflictBetween = true;
				break;
			}
		}
		const kept = conflictBetween ? last : first;
		for (const index of indices) {
			if (index !== kept) {
				dropped.add(index);
			}
		}
	}

	const present = new Set<string>(canon.slice(0, existing.length));
	let added = 0;
	let duplicates = 0;
	for (const entry of imported) {
		const c = canonicalJson(entry);
		if (present.has(c)) {
			duplicates++;
		} else {
			present.add(c);
			added++;
		}
	}
	return { merged: sequence.filter((_, index) => !dropped.has(index)), added, duplicates };
}
