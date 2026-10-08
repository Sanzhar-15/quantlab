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

const KEY_MODIFIER = /^(ctrl|shift|alt|meta|win|cmd)[+-]/;

/**
 * The chords of a keybinding entry's `key`, read as the editor reads them (src/vs/base/common/keybindingParser.ts):
 * lower case, surrounding whitespace ignored, modifiers in any order and separated by `+` or `-`, `meta`, `win` and
 * `cmd` one modifier, chords separated by a space. Undefined when the entry has no key string or the string holds no
 * chord (then it conflicts with nothing).
 */
function keybindingChords(entry: unknown): string[] | undefined {
	if (!isPlainObject(entry) || typeof entry.key !== 'string') {
		return undefined;
	}
	const chords: string[] = [];
	let input = entry.key.toLowerCase().trim();
	while (input.length > 0) {
		const modifiers = new Set<string>();
		for (let match = KEY_MODIFIER.exec(input); match; match = KEY_MODIFIER.exec(input)) {
			modifiers.add(match[1] === 'win' || match[1] === 'cmd' ? 'meta' : match[1]);
			input = input.substring(match[0].length);
		}
		const space = input.indexOf(' ');
		const key = space > 0 ? input.substring(0, space) : input;
		input = space > 0 ? input.substring(space).trim() : '';
		// A space cannot be part of a key, so it separates the modifiers from the key without ambiguity (`ctrl++`, `ctrl+-`).
		chords.push(`${['ctrl', 'shift', 'alt', 'meta'].filter(modifier => modifiers.has(modifier)).join('+')} ${key}`);
	}
	return chords.length > 0 ? chords : undefined;
}

/**
 * Two bindings compete for a key press, as in the editor's resolver, when their chord sequences are equal or one is
 * the beginning of the other (`ctrl+k` and `ctrl+k ctrl+x`: the longer one makes the shorter wait for a second chord).
 */
function chordsConflict(a: string[], b: string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * Existing entries first, then the imported ones; later entries win in VS Code, so order is precedence.
 * An imported entry equal to one already present is not added again, but it is not allowed to lose
 * precedence either: when a different entry competing for the same key press (the same chords however they are
 * spelled, or a chord sequence one of which begins the other) sits between its first and its last
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
		const chords = keybindingChords(sequence[first]);
		let conflictBetween = false;
		for (let j = first + 1; j < last && chords !== undefined; j++) {
			const other = canon[j] !== c ? keybindingChords(sequence[j]) : undefined;
			if (other !== undefined && chordsConflict(chords, other)) {
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
