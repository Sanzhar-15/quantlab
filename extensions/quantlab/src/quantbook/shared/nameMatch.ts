/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-11 v2 "Name box" matched-name -- the vscode-free, DOM-free core that reverses name resolution: given
// the current grid selection, which defined NAME (if any) exactly covers it? The name box uses this to show
// `returns` instead of `B2:B13` when the selection coincides with a named range, exactly like Excel.
//
// **Build isolation (FE-0b):** this lives under `src/quantbook/shared/` -- the ONE host subtree the webview
// esbuild bundle is allowed to import (everything else under `src/quantbook/` is host runtime: napi/vscode).
// So it MUST stay pure (no value import out of `shared/`); the only dependency is the engine DTO
// {@link NamedRangeJson}, taken as a TYPE (erased by esbuild before bundling). The selection shape is
// declared locally ({@link NameMatchSelection}) for the same reason -- it mirrors `nameBoxLogic`'s
// `NameBoxSelection` field-for-field and is structurally interchangeable with it.

import type { NamedRangeJson } from '../types';

/**
 * The grid selection a name match tests against: the active sheet plus the two selection corners (anchor +
 * focus, in any order -- normalized inside {@link matchNameForSelection}). Structurally identical to
 * `nameBoxLogic.NameBoxSelection`; kept local so this shared module needs no value/type coupling back into
 * the host `cellGrid/` subtree (the build isolation forbids it).
 */
export interface NameMatchSelection {
	readonly sheet: number;
	readonly anchorRow: number;
	readonly anchorCol: number;
	readonly focusRow: number;
	readonly focusCol: number;
}

/**
 * **FE-11 v2** -- the REVERSE of name resolution: given the current grid selection, return the defined NAME
 * whose target EXACTLY matches it (so the name box can show `returns` instead of `B2:B13`), or `undefined`
 * if none. Excel-faithful exact match:
 *  - a `cell` target matches a 1x1 selection AT that cell;
 *  - a `range` target matches when the selection's normalized extent equals the target's four bounds;
 *  both on `selection.sheet`. `constant`/`formula` names have no grid extent and never match (so a cell that
 *  merely sits INSIDE a larger named range shows the A1 ref, exactly like Excel -- the box reflects the name
 *  only when the selection coincides with the WHOLE named range).
 *
 * Scope: a name is visible on a sheet when it is workbook-scoped (`scope === undefined`) or scoped to that
 * sheet (`scope === selection.sheet`). When several visible names cover the IDENTICAL extent, the pick is
 * deterministic -- sheet-scoped before workbook-scoped, then alphabetical by canonical (engine-upper) `name`
 * -- the same shadowing order `nameBoxLogic.routeNameBoxSubmit` uses, made total by the alphabetical tiebreak.
 *
 * Pure (no vscode, no engine, no DOM). The `undefined` return is the honest "no match" answer -- the caller
 * shows the A1 ref -- NOT an error-masking fallback.
 */
export function matchNameForSelection(
	selection: NameMatchSelection,
	names: readonly NamedRangeJson[],
): string | undefined {
	const top = Math.min(selection.anchorRow, selection.focusRow);
	const bottom = Math.max(selection.anchorRow, selection.focusRow);
	const left = Math.min(selection.anchorCol, selection.focusCol);
	const right = Math.max(selection.anchorCol, selection.focusCol);
	const isSingleCell = top === bottom && left === right;

	const matches = names.filter((n) => {
		// Scope-visible on the active sheet: workbook-scoped, or scoped to THIS sheet. (A sheet-scoped name
		// of ANOTHER sheet is invisible here.)
		if (n.scope !== undefined && n.scope !== selection.sheet) {
			return false;
		}
		const t = n.target;
		if (t.kind === 'cell') {
			// A loaded .qbook can carry a 1x1 `cell` target; it matches only a single-cell selection at it.
			return t.cell !== undefined
				&& t.cell.sheet === selection.sheet
				&& isSingleCell
				&& t.cell.row === top
				&& t.cell.col === left;
		}
		if (t.kind === 'range') {
			// The IDE's setName always creates `range` targets (incl. 1x1, where start === end).
			return t.range !== undefined
				&& t.range.sheet === selection.sheet
				&& t.range.startRow === top
				&& t.range.endRow === bottom
				&& t.range.startCol === left
				&& t.range.endCol === right;
		}
		return false; // constant / formula -- no grid extent to coincide with a selection
	});
	if (matches.length === 0) {
		return undefined;
	}
	// Deterministic precedence: sheet-scoped (scope === active sheet) shadows workbook-scoped, then
	// alphabetical by canonical name. (Post-filter, every scope is either undefined or selection.sheet.)
	const ranked = [...matches].sort((a, b) => {
		const aRank = a.scope === selection.sheet ? 0 : 1;
		const bRank = b.scope === selection.sheet ? 0 : 1;
		if (aRank !== bRank) {
			return aRank - bRank;
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	return ranked[0].name;
}
