/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 W-N "Name Manager" -- the vscode-free core of LISTING, DESCRIBING, and resolving the Go-To anchor
// of the workbook's defined names. The command (in quantbookCommands.ts) reads the focused grid's session,
// calls `session.listNames()`, shapes each into a QuickPick item via {@link describeTarget} +
// {@link describeScope}, and -- on a
// "Go-To" pick -- resolves the name's anchor via {@link goToAnchor} (switching the panel to the target
// sheet first, then posting the webview `navigateTo`). The DEFINE path reuses the FE-4 `nameDefineLogic`
// validation verbatim (this module does NOT re-implement name validation -- it only DESCRIBES + LOCATES).
//
// The N-1/N-2 split (established by cellGrid): the risky pure parts -- target-shape projection + the
// "which kind has an anchor" decision -- live HERE and are unit-tested directly against real engine
// `listNames()` output; the command is a thin vscode shell.
//
// **REFRESH CONTRACT (engine GROUND TRUTH, 2026-06-12)**: `setName`/`deleteName` are delta-, epoch-, AND
// token-INVISIBLE -- a `snapshotDelta` after a name change is EMPTY with an UNCHANGED version token. So the
// manager MUST refresh its list by calling `listNames()` (or a full `snapshot()`) EXPLICITLY after every
// define/rename/delete; it must NEVER wait on a delta/token change. The engine sorts the list
// (workbook-scoped first, then sheetId, then name), so the order is stable for re-render.
//
// No-Fallbacks: a Constant/Formula name has NO grid anchor; {@link goToAnchor} returns `undefined` for it
// (the command DISABLES Go-To for that pick) rather than fabricating an A1 landing. An unknown target
// `kind` (a future engine variant this build does not mirror) throws rather than being silently dropped.

import { columnLabelA1, formatRangeTarget } from '../reactiveNotebook/bindVariableLogic';
import type { NamedRangeJson, NamedTargetJson } from '../types';

/**
 * A name's resolved Go-To anchor: the top-left cell of its target, on the target's sheet. Returned by
 * {@link goToAnchor} ONLY for `cell` / `range` kinds (which have a grid location). 0-based grid coordinates.
 */
export interface NameAnchor {
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
}

/**
 * Whether this defined-name target has a grid anchor a "Go-To" can land on. `true` for `cell` / `range`
 * (a coordinate exists); `false` for `constant` / `formula` (no cell -- they hold a value / an expression,
 * not a location). The command consults this to enable/disable the Go-To action for a pick.
 */
export function isGoToable(target: NamedTargetJson): boolean {
	return target.kind === 'cell' || target.kind === 'range';
}

/**
 * Resolve a defined name's Go-To anchor -- the top-left cell of its target -- or `undefined` for a
 * `constant` / `formula` name (which has no grid location). The command switches the host panel to
 * `anchor.sheet` (if different) and posts a `navigateTo` to land on `(anchor.row, anchor.col)`.
 *
 * No-Fallbacks:
 *  - A `cell` target with a missing `cell` payload, or a `range` target with a missing `range` payload,
 *    THROWS (a malformed engine DTO must surface, not silently no-op to A1).
 *  - An unknown `kind` (a future engine variant this build does not mirror) THROWS.
 *  - A `constant` / `formula` returns `undefined` (the typed "no anchor" answer the command branches on).
 */
export function goToAnchor(target: NamedTargetJson): NameAnchor | undefined {
	switch (target.kind) {
		case 'cell': {
			if (target.cell === undefined) {
				throw new Error('[bad_argument] goToAnchor: a "cell"-kind named target is missing its `cell` payload.');
			}
			return { sheet: target.cell.sheet, row: target.cell.row, col: target.cell.col };
		}
		case 'range': {
			if (target.range === undefined) {
				throw new Error('[bad_argument] goToAnchor: a "range"-kind named target is missing its `range` payload.');
			}
			// The engine reports inclusive bounds with start <= end (a defined name is a normalized
			// rectangle); the anchor is the top-left corner.
			return { sheet: target.range.sheet, row: target.range.startRow, col: target.range.startCol };
		}
		case 'constant':
		case 'formula':
			return undefined;
		default: {
			// Exhaustiveness guard (No-Fallbacks): a kind the mirror does not know about must fail loud,
			// never be treated as "no anchor".
			const exhaustive: never = target.kind;
			throw new Error(`[bad_argument] goToAnchor: unknown named-target kind "${String(exhaustive)}".`);
		}
	}
}

/**
 * A human-readable, single-line description of a defined name's TARGET for the manager list:
 *  - `cell`     -> the sheet-qualified A1 cell, e.g. `Returns!B2` (resolved against `sheetNameFor`).
 *  - `range`    -> the sheet-qualified A1 range, e.g. `Returns!B2:B13`.
 *  - `constant` -> `= <value>` (the literal value, rendered from the wire `CellValueJson`).
 *  - `formula`  -> `= <source>` (the raw formula source, no leading `=` in the DTO -> we add one).
 *
 * `sheetNameFor(sheetId)` maps a target's sheet id to its display name; it returns `undefined` when the
 * sheet is gone (a dangling target -- the engine keeps the name; we surface the numeric id rather than
 * inventing a name). No-Fallbacks: an unknown `kind` throws (handled by the exhaustive default).
 */
export function describeTarget(target: NamedTargetJson, sheetNameFor: (sheetId: number) => string | undefined): string {
	switch (target.kind) {
		case 'cell': {
			if (target.cell === undefined) {
				throw new Error('[bad_argument] describeTarget: a "cell"-kind named target is missing its `cell` payload.');
			}
			const sheetName = sheetNameFor(target.cell.sheet) ?? `#${target.cell.sheet}`;
			return `${sheetName}!${columnLabelA1(target.cell.col)}${target.cell.row + 1}`;
		}
		case 'range': {
			if (target.range === undefined) {
				throw new Error('[bad_argument] describeTarget: a "range"-kind named target is missing its `range` payload.');
			}
			const sheetName = sheetNameFor(target.range.sheet) ?? `#${target.range.sheet}`;
			return formatRangeTarget(sheetName, target.range.startRow, target.range.startCol, target.range.endRow, target.range.endCol);
		}
		case 'constant':
			return `= ${describeConstant(target)}`;
		case 'formula': {
			if (target.formula === undefined) {
				throw new Error('[bad_argument] describeTarget: a "formula"-kind named target is missing its `formula` payload.');
			}
			return `= ${target.formula}`;
		}
		default: {
			const exhaustive: never = target.kind;
			throw new Error(`[bad_argument] describeTarget: unknown named-target kind "${String(exhaustive)}".`);
		}
	}
}

/**
 * Render a `constant`-kind target's wire {@link NamedTargetJson.value} as a short display string. Mirrors
 * the engine `CellValueJson` discriminated union. No-Fallbacks: a missing payload or an unknown value kind
 * throws (a malformed DTO must surface).
 */
function describeConstant(target: NamedTargetJson): string {
	const value = target.value;
	if (value === undefined) {
		throw new Error('[bad_argument] describeConstant: a "constant"-kind named target is missing its `value` payload.');
	}
	switch (value.kind) {
		case 'number':
			return value.number === undefined ? 'number' : String(value.number);
		case 'boolean':
			return value.boolean === undefined ? 'boolean' : (value.boolean ? 'TRUE' : 'FALSE');
		case 'text':
			return value.text === undefined ? 'text' : `"${value.text}"`;
		case 'error':
			return value.error ?? '#ERROR';
		case 'blank':
			return '(blank)';
		default:
			throw new Error(`[bad_argument] describeConstant: unknown constant value kind "${String(value.kind)}".`);
	}
}

/**
 * A short scope label for the manager list: `Workbook` for a workbook-scoped name, or the scoping sheet's
 * display name (resolved via `sheetNameFor`) for a sheet-scoped name (falling back to `#<id>` when the
 * sheet is gone -- a dangling scope the engine still tracks).
 */
export function describeScope(name: NamedRangeJson, sheetNameFor: (sheetId: number) => string | undefined): string {
	if (name.scope === undefined) {
		return 'Workbook';
	}
	return sheetNameFor(name.scope) ?? `#${name.scope}`;
}
