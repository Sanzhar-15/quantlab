/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I-b (R12, 2026-06-19) -- the vscode-free core of the "Functions" catalog sidebar.
//
// The engine already exposes every registered function (built-ins + any registered UDFs) via
// `session.listFunctions()` with rich metadata, but until now that list only fed autocomplete + the MCP
// `list_functions` tool -- there was no discoverable catalog UI. This builds a browsable tree: user-defined
// functions (when present) grouped first, then built-ins grouped by first letter (a function-reference
// browse), each node carrying a one-line signature (description) + a full-metadata tooltip. The provider
// adapts these nodes to TreeItems; clicking a function copies its name to the clipboard. (Also satisfies
// the R22 "discoverable catalog UI" tail.)
//
// PURE + vscode-free (the FunctionCatalogTreeProvider is the thin shell), so the grouping + ordering +
// signature/tooltip formatting are unit-tested headlessly. No-Fallbacks: an empty function list yields an
// explicit `empty` node, never a blank tree.

import type { ArityJson, FunctionMetadataJson } from '../types';

/**
 * A function is USER-DEFINED (vs a built-in) when the engine tagged it: built-ins register with an empty
 * `provenanceTags` and no `displayName`; a registered UDF carries a provenance tag (e.g. `"python"`) and/or
 * a `displayName`. (Today the IDE registers no UDFs, so the catalog is all built-ins; this stays correct
 * when UDF registration lands.)
 */
export function isUserDefined(fn: FunctionMetadataJson): boolean {
	return fn.provenanceTags.length > 0 || fn.displayName !== undefined;
}

/** A concise human signature from the function's {@link ArityJson} (we have no per-arg names). Pure + total. */
export function formatArity(arity: ArityJson): string {
	switch (arity.kind) {
		case 'fixed': {
			const n = arity.n ?? 0;
			return n === 0 ? '()' : `(${n} arg${n === 1 ? '' : 's'})`;
		}
		case 'range': {
			const min = arity.min ?? 0;
			return arity.max === undefined ? `(${min}+ args)` : `(${min}-${arity.max} args)`;
		}
		case 'variadic':
			return '(variadic)';
		default:
			// No-Fallbacks: an unknown arity kind is surfaced, never silently blanked.
			return '(?)';
	}
}

/**
 * The multi-line tooltip body for a function node. Surfaces the USER-relevant metadata: canonical name +
 * signature, an optional UDF display name, aliases, volatility + determinism, the arg context (scalar vs
 * aggregate -- affects how a range arg binds), and provenance tags. Pure. The engine-internal plumbing
 * fields (`depShape`/`batchShape`/`argPolicy`/`cancellation`) are deliberately omitted -- their raw enum
 * strings are cryptic noise in a user-facing catalog hover, not actionable.
 */
export function buildFunctionTooltip(fn: FunctionMetadataJson): string {
	const lines = [`${fn.canonicalName} ${formatArity(fn.arity)}`];
	if (fn.displayName !== undefined && fn.displayName !== fn.canonicalName) {
		lines.push(`Display name: ${fn.displayName}`);
	}
	if (fn.aliases.length > 0) {
		lines.push(`Aliases: ${fn.aliases.join(', ')}`);
	}
	lines.push(`Volatility: ${fn.volatility}  |  Deterministic: ${fn.determinism ? 'yes' : 'no'}`);
	lines.push(`Context: ${fn.argContext}`);
	if (fn.provenanceTags.length > 0) {
		lines.push(`Tags: ${fn.provenanceTags.join(', ')}`);
	}
	return lines.join('\n');
}

/** A snapshot of the focused workbook's function list, assembled by the vscode shell. `hasFocusedGrid`
 *  distinguishes "no workbook is focused" (-> a `noGrid` node) from "the workbook registers no functions"
 *  (-> an `empty` node); both would otherwise be an empty `functions` array. */
export interface FunctionCatalogInput {
	readonly hasFocusedGrid: boolean;
	readonly functions: readonly FunctionMetadataJson[];
}

/** Discriminated render node. `group` is collapsible (its `children` are function leaves). */
export type FunctionCatalogNode =
	| { readonly kind: 'noGrid'; readonly id: string; readonly label: string }
	| { readonly kind: 'empty'; readonly id: string; readonly label: string }
	| {
		readonly kind: 'group';
		readonly id: string;
		readonly label: string;
		readonly count: number;
		readonly userDefined: boolean;
		readonly children: readonly FunctionCatalogNode[];
	}
	| {
		readonly kind: 'function';
		readonly id: string;
		readonly label: string;
		readonly name: string;
		readonly signature: string;
		readonly tooltip: string;
		readonly userDefined: boolean;
	};

/** Case-insensitive A..Z bucket for a built-in's first character; non-letters bucket under `#`. */
function firstLetterBucket(name: string): string {
	const c = name.charAt(0).toUpperCase();
	return c >= 'A' && c <= 'Z' ? c : '#';
}

function functionNode(fn: FunctionMetadataJson, userDefined: boolean): FunctionCatalogNode {
	return {
		kind: 'function',
		id: `fnCatalog.fn.${fn.canonicalName}`,
		label: fn.canonicalName,
		name: fn.canonicalName,
		signature: formatArity(fn.arity),
		tooltip: buildFunctionTooltip(fn),
		userDefined,
	};
}

/**
 * Build the catalog tree's ROOT nodes from {@link FunctionCatalogInput}. Pure + total. The `group` nodes
 * carry their function children inline (the provider returns them from `getChildren(group)`).
 *
 * - No focused grid (`hasFocusedGrid === false`) -> a single `noGrid` node (distinct from "no functions" --
 *   the workbook may register plenty; there is just no focused grid to read).
 * - A focused grid with no functions -> a single `empty` node (No-Fallbacks: never a blank tree).
 * - User-defined functions (if any) -> ONE "User-defined" group first (sorted by name).
 * - Built-ins -> grouped by first letter (A..Z, non-letters under `#`), letters ascending, each group's
 *   functions sorted by name.
 */
export function buildFunctionCatalogNodes(input: FunctionCatalogInput): FunctionCatalogNode[] {
	if (!input.hasFocusedGrid) {
		return [{ kind: 'noGrid', id: 'fnCatalog.noGrid', label: 'No workbook is focused' }];
	}
	const functions = input.functions;
	if (functions.length === 0) {
		return [{ kind: 'empty', id: 'fnCatalog.empty', label: 'No functions registered' }];
	}

	const userDefined = functions.filter(isUserDefined).slice().sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
	const builtins = functions.filter((f) => !isUserDefined(f));

	const roots: FunctionCatalogNode[] = [];

	if (userDefined.length > 0) {
		roots.push({
			kind: 'group',
			id: 'fnCatalog.group.userDefined',
			label: 'User-defined',
			count: userDefined.length,
			userDefined: true,
			children: userDefined.map((f) => functionNode(f, true)),
		});
	}

	// Bucket built-ins by first letter, then emit groups in letter order with name-sorted children.
	const byLetter = new Map<string, FunctionMetadataJson[]>();
	for (const f of builtins) {
		const bucket = firstLetterBucket(f.canonicalName);
		const list = byLetter.get(bucket);
		if (list === undefined) {
			byLetter.set(bucket, [f]);
		} else {
			list.push(f);
		}
	}
	for (const letter of [...byLetter.keys()].sort()) {
		const group = byLetter.get(letter)!.slice().sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
		roots.push({
			kind: 'group',
			id: `fnCatalog.group.${letter}`,
			label: letter,
			count: group.length,
			userDefined: false,
			children: group.map((f) => functionNode(f, false)),
		});
	}

	return roots;
}
