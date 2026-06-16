/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-11 "Name box" -- the vscode-free core of routing an Excel-style name-box submit. The name box (the
// reference field left of the formula bar) accepts THREE things: an existing defined name (jump to it),
// an A1 cell/range reference (jump to its top-left), or a NEW valid name typed over a selection (define
// it). {@link routeNameBoxSubmit} decides WHICH -- a pure, unit-tested decision -- and the host shell
// (cellGridPanel.ts handleNameBoxSubmit) executes the returned action (navigate via goToAnchor +
// navigateToCell, or define via setName + toast). The established cellGrid N-1/N-2 split: the risky
// disambiguation lives HERE; the command is a thin vscode shell.
//
// PRECEDENCE (first match wins -- the namespaces are provably DISJOINT, so the order is unambiguous):
//   1. an existing defined name (case-insensitive; engine stores upper) -> navigate to it.
//   2. an A1 reference, bare ("B5", "B5:D9") or sheet-qualified ("Sheet2!C3") -> navigate to top-left.
//   3. a syntactically valid NEW name + a selection -> define it over the selection.
//   4. otherwise -> a loud error naming the broken rule.
// DISJOINTNESS: {@link isValidDefinedName} rejects every cell-ref form (`A1`/`$A$1`/`AB12`) and any
// string containing `:` or `!`, so a STORED name is never an A1 ref and an A1 ref is never a valid new
// name. A name can therefore never tie with a reference -- steps 1/2/3 cannot disagree about a token.
//
// No-Fallbacks: step 4 returns a typed `error` action (never a silent no-op); an unknown sheet in a
// sheet-qualified ref is a loud error, never a default-to-sheet-0; a malformed sheet-qualified ref is an
// error (a `!` means the user intends a reference -- a name cannot contain `!` -- so it must NOT fall
// through to the define path). A thrown `McpToolError` from the A1 parser is converted to the typed
// `error` action at THIS boundary (an exception -> explicit discriminated result, not a swallow).

import type { CellRangeJson, NamedRangeJson, SheetInfoJson } from '../types';
import { buildNameRange, definedNameRejectionReason, isValidDefinedName } from './nameDefineLogic';
import { McpToolError, parseA1Range } from '../mcp/mcpToolLogic';

/**
 * The grid selection a name-box submit acts over: the active sheet plus the two selection corners
 * (anchor + focus, in any order -- {@link buildNameRange} normalizes them). A single-cell selection has
 * anchor === focus, which {@link buildNameRange} turns into a 1x1 range (Excel allows naming one cell).
 */
export interface NameBoxSelection {
	readonly sheet: number;
	readonly anchorRow: number;
	readonly anchorCol: number;
	readonly focusRow: number;
	readonly focusCol: number;
}

/**
 * The decision {@link routeNameBoxSubmit} returns -- a discriminated action the host executes:
 *  - `navigate-name`: jump to the defined name (the host resolves its anchor via `goToAnchor`; a
 *    constant/formula name with no grid anchor surfaces the host's loud "no cell to go to" toast).
 *  - `navigate-ref`: jump to the resolved A1 reference's TOP-LEFT cell on `sheet`.
 *  - `define`: create the workbook name `name` over `range` (host calls `setName` + shows the toast).
 *  - `error`: a loud, specific reason (No-Fallbacks -- never a silent no-op).
 */
export type NameBoxAction =
	| { readonly kind: 'navigate-name'; readonly name: NamedRangeJson }
	| { readonly kind: 'navigate-ref'; readonly sheet: number; readonly row: number; readonly col: number }
	| { readonly kind: 'define'; readonly name: string; readonly range: CellRangeJson }
	| { readonly kind: 'error'; readonly reason: string };

/**
 * Resolve a name-box submission to the action the host should take. See the module header for the
 * precedence + disjointness contract. `text` is the raw operator entry (trimmed here defensively);
 * `existingNames` is a FRESH `listNames()` read (name ops are delta-invisible -- the caller must not
 * cache them); `sheets` is the live (non-tombstoned) sheet list for resolving a sheet-qualified ref.
 */
export function routeNameBoxSubmit(
	text: string,
	selection: NameBoxSelection,
	existingNames: readonly NamedRangeJson[],
	sheets: readonly SheetInfoJson[],
): NameBoxAction {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { kind: 'error', reason: 'Type a defined name, a cell reference like B5 or Sheet2!C3, or select a range and type a new name to define it.' };
	}

	// 1. An existing defined name (case-insensitive; the engine stores names upper-cased). Only VISIBLE names
	// resolve by bare entry: workbook-scoped, or scoped to the ACTIVE sheet -- a name scoped to ANOTHER sheet
	// is not referenceable here (Excel: you would qualify it `Sheet!name`). This is the SAME visibility rule
	// the matched-name display + inline dropdown use (shared/nameMatch + the dropdown scope filter); FE-11 v2
	// tightened it (a prior `matches[0]` fallback could navigate to a foreign sheet-scoped name -- an
	// inconsistency with those two surfaces). Among visible matches, prefer the active-sheet scope, then the
	// workbook one -- the Excel shadowing order. (A stored name can never look like an A1 ref, so this never
	// steals a reference jump.)
	const key = trimmed.toUpperCase();
	const matches = existingNames.filter(
		(n) => n.name.toUpperCase() === key && (n.scope === undefined || n.scope === selection.sheet),
	);
	if (matches.length > 0) {
		const picked =
			matches.find((n) => n.scope === selection.sheet) ??
			matches.find((n) => n.scope === undefined) ??
			matches[0];
		return { kind: 'navigate-name', name: picked };
	}

	// 2a. A sheet-qualified reference ("Sheet2!C3"). A `!` can ONLY be a reference -- a defined name
	// cannot contain `!` -- so a parse failure here is a loud error, NOT a fall-through to define.
	const bang = trimmed.indexOf('!');
	if (bang >= 0) {
		const sheetName = trimmed.slice(0, bang);
		const bareRef = trimmed.slice(bang + 1);
		const sheet = sheets.find((s) => s.name === sheetName); // exact, case-sensitive (engine sheet names are)
		if (sheet === undefined) {
			return { kind: 'error', reason: `No sheet named "${sheetName}".` };
		}
		try {
			const range = parseA1Range(bareRef);
			return { kind: 'navigate-ref', sheet: sheet.id, row: range.startRow, col: range.startCol };
		} catch (err) {
			if (err instanceof McpToolError) {
				return { kind: 'error', reason: `"${bareRef}" is not a valid cell reference on sheet "${sheetName}".` };
			}
			throw err; // an unexpected (non-A1) failure must surface loud, not be masked as an error action
		}
	}

	// 2b. A bare reference ("B5", "B5:D9") on the active sheet. A parse failure means it is NOT a
	// reference -> fall through to the define path (a name has no `:`/`!`).
	try {
		const range = parseA1Range(trimmed);
		return { kind: 'navigate-ref', sheet: selection.sheet, row: range.startRow, col: range.startCol };
	} catch (err) {
		if (!(err instanceof McpToolError)) {
			throw err; // unexpected failure -> loud
		}
		// not an A1 reference; continue to step 3.
	}

	// 3. A syntactically valid NEW name -> define it over the selection (1x1 for a single cell).
	if (isValidDefinedName(trimmed)) {
		const range = buildNameRange(selection.sheet, selection.anchorRow, selection.anchorCol, selection.focusRow, selection.focusCol);
		return { kind: 'define', name: trimmed, range };
	}

	// 4. Neither a name, nor a reference, nor a valid new name -> loud, specific reason.
	return {
		kind: 'error',
		reason: definedNameRejectionReason(trimmed) ?? `"${trimmed}" is not a defined name, a cell reference, or a valid new name.`,
	};
}

// FE-11 v2 NOTE: the REVERSE direction (selection -> matched NAME, for the name box's matched-name display)
// lives in the pure, webview-importable `src/quantbook/shared/nameMatch.ts` (matchNameForSelection). It is
// NOT here because the webview cannot import this host-runtime module (the FE-0b build isolation); see that
// file's header.
