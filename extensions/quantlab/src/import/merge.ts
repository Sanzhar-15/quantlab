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

/**
 * Existing entries first, then the imported entries not already present (later entries win in VS Code,
 * so the imported ones go last).
 */
export function mergeKeybindings(existing: unknown[], imported: unknown[]): KeybindingsMerge {
	const merged: unknown[] = [...existing];
	const present = new Set<string>(existing.map(canonicalJson));
	let added = 0;
	let duplicates = 0;
	for (const entry of imported) {
		const key = canonicalJson(entry);
		if (present.has(key)) {
			duplicates++;
		} else {
			present.add(key);
			merged.push(entry);
			added++;
		}
	}
	return { merged, added, duplicates };
}
