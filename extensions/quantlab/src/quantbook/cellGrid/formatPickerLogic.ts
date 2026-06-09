/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G "Set Cell Format" -- the vscode-free core of the number-formats picker.
//
// The command (in quantbookCommands.ts) reads the focused grid's selection
// (CellGridPanel.focusedGridSelection, W-G-2b), maps a chosen preset to a format string, registers it
// on the engine (session.registerFormat -> FormatId), and applies that FormatId to every cell in the
// selection rect in ONE session.batch of `setFormat` ops (one undo unit) -> recalcDirtyChecked ->
// CellGridPanel.refreshSession. The grid re-renders the engine-formatted string automatically (the
// snapshot already carries `entry.rendered`, painted by canvasGrid.ts) -- this layer is PURE host UI,
// it never touches the webview.
//
// The risky, pure parts -- the preset -> format-string map and the setFormat op-builder over a
// rectangle (which must clamp/validate coords and stay within the batch-cell cap) -- live HERE and are
// unit-tested directly (the command is a thin vscode shell over them, the established N-1/N-2 split).
//
// "General" is NOT special-cased: the engine interns "General" to its built-in id 0 (FormatId::GENERAL,
// the default-format clear), so routing it through registerFormat("General") -> setFormat returns the
// cell to the engine default uniformly with every other preset. No-Fallbacks: a registerFormat / batch
// throw surfaces to the operator (a toast), never swallowed.

import type { FormatIdJson, SessionOpJson } from '../types';
import { normalizeSelectionRect, type NormalizedRect } from '../reactiveNotebook/bindVariableLogic';

// The A1 grid extent the webview renders (mirrors cellGridLogic's private A1_MAX_ROWS/COLS, which are
// not exported). A selection rect outside this is only reachable from a tampered webview bundle; we
// reject it loudly rather than build ops the engine would refuse cell-by-cell.
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

// Mirror the cellGridLogic batch-cell cap so a giant selection is rejected with a clear message BEFORE
// we build a multi-million-op array (the engine would otherwise reject the batch, but later and less
// clearly). 100k cells is well above any realistic format selection.
export const MAX_FORMAT_BATCH_CELLS = 100_000;

/**
 * The number-format presets offered by the picker, in display order. `Custom` opens a free-text input
 * box for a raw Excel format string; every other preset maps to a fixed format string via
 * {@link formatStringForPreset}. `General` returns a cell to the engine default (built-in id 0).
 */
export type FormatPreset =
	| 'General'
	| 'Number'
	| 'NumberThousands'
	| 'Currency'
	| 'Percent'
	| 'Date'
	| 'Custom';

/** One pickable preset row: a stable {@link FormatPreset} key plus its human label + example detail. */
export interface FormatPresetChoice {
	readonly preset: FormatPreset;
	readonly label: string;
	readonly detail: string;
}

/**
 * The preset rows the picker shows, in order. The labels/details are display strings (the command turns
 * them into vscode.QuickPickItem); the `preset` is the stable key the command switches on. `Custom` is
 * last (it is an escape hatch, not a common pick).
 */
export const FORMAT_PRESET_CHOICES: readonly FormatPresetChoice[] = [
	{ preset: 'General', label: 'General', detail: 'Engine default (clears any explicit format)' },
	{ preset: 'Number', label: 'Number', detail: '1234.56  (format 0.00)' },
	{ preset: 'NumberThousands', label: 'Number with thousands', detail: '1,234.56  (format #,##0.00)' },
	{ preset: 'Currency', label: 'Currency', detail: '$1,234.56  (format $#,##0.00)' },
	{ preset: 'Percent', label: 'Percent', detail: '12.34%  (format 0.00%)' },
	{ preset: 'Date', label: 'Date', detail: '2026-06-09  (format yyyy-mm-dd)' },
	{ preset: 'Custom', label: 'Custom...', detail: 'Enter a raw Excel format string' },
];

/**
 * Map a NON-custom preset to its Excel format string. `Custom` is rejected (`[bad_argument]`) because it
 * carries no fixed string -- the command resolves Custom via a separate input box and passes the raw
 * string straight to registerFormat. Throws (No-Fallbacks) on an unknown preset rather than defaulting to
 * "General", so a future preset added to the union without a mapping fails loud at the call site.
 */
export function formatStringForPreset(preset: FormatPreset): string {
	switch (preset) {
		case 'General':
			// Interns to FormatId::GENERAL (built-in id 0) -- the engine's default-format clear.
			return 'General';
		case 'Number':
			return '0.00';
		case 'NumberThousands':
			return '#,##0.00';
		case 'Currency':
			return '$#,##0.00';
		case 'Percent':
			return '0.00%';
		case 'Date':
			return 'yyyy-mm-dd';
		case 'Custom':
			throw new Error('[bad_argument] formatStringForPreset: "Custom" has no fixed format string; resolve it via the input box.');
		default: {
			// Exhaustiveness guard: a new FormatPreset member with no mapping is a compile error here AND a
			// loud runtime throw (never a silent General fallback).
			const exhaustive: never = preset;
			throw new Error(`[bad_argument] formatStringForPreset: unknown preset ${String(exhaustive)}.`);
		}
	}
}

/**
 * A short, human-readable label for a preset, for the batch's undo label / toast (e.g.
 * "Set format: Currency over S0!B1:D3"). For `Custom` the caller substitutes the raw format string, so
 * this returns the literal "Custom" placeholder; non-custom presets return their display label.
 */
export function presetLabel(preset: FormatPreset): string {
	const choice = FORMAT_PRESET_CHOICES.find(c => c.preset === preset);
	return choice !== undefined ? choice.label : preset;
}

/**
 * Build the list of `setFormat` ops -- one per cell in the NORMALIZED selection rect (inclusive on both
 * axes) -- that apply `formatId` to the cell. The caller normalizes the selection's anchor+focus into a
 * top-left -> bottom-right rect first (via {@link normalizeSelectionRect}); we re-normalize defensively so
 * a reversed rect never yields a negative-size loop. The ops are returned in row-major order.
 *
 * Validation (No-Fallbacks): a non-integer / out-of-extent corner throws `[bad_argument]`; a rect whose
 * cell count exceeds {@link MAX_FORMAT_BATCH_CELLS} throws `[bad_argument]` (a clear up-front refusal vs a
 * later opaque engine batch reject). `sheet` is range-checked to the engine's u16 bound.
 */
export function buildSetFormatOps(sheet: number, rect: NormalizedRect, formatId: FormatIdJson): SessionOpJson[] {
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 65535) {
		throw new Error(`[bad_argument] setFormat: sheet must be an integer in [0, 65535], got ${sheet}.`);
	}
	// Re-normalize so a caller that passes a reversed rect still produces a forward loop (defensive; the
	// command already normalizes).
	const r = normalizeSelectionRect(rect.startRow, rect.startCol, rect.endRow, rect.endCol);
	for (const [name, v] of [['startRow', r.startRow], ['startCol', r.startCol], ['endRow', r.endRow], ['endCol', r.endCol]] as const) {
		if (!Number.isInteger(v)) {
			throw new Error(`[bad_argument] setFormat: rect ${name} must be an integer, got ${v}.`);
		}
	}
	if (r.startRow < 0 || r.endRow >= A1_MAX_ROWS || r.startCol < 0 || r.endCol >= A1_MAX_COLS) {
		throw new Error(`[bad_argument] setFormat: rect (${r.startRow},${r.startCol})-(${r.endRow},${r.endCol}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`);
	}
	const rows = r.endRow - r.startRow + 1;
	const cols = r.endCol - r.startCol + 1;
	const count = rows * cols;
	if (count > MAX_FORMAT_BATCH_CELLS) {
		throw new Error(`[bad_argument] setFormat: ${count} cells exceeds the ${MAX_FORMAT_BATCH_CELLS}-cell batch limit.`);
	}
	const ops: SessionOpJson[] = [];
	for (let row = r.startRow; row <= r.endRow; row++) {
		for (let col = r.startCol; col <= r.endCol; col++) {
			ops.push({ kind: 'setFormat', sheet, row, col, format: formatId });
		}
	}
	return ops;
}

/**
 * The undo-label / toast string for a format application over a rect, e.g.
 * `Set format: Currency over S0!B1:D3`. `appliedLabel` is the preset's display label (or the raw custom
 * format string for a Custom pick); `target` is the formatted A1 range (the command builds it via
 * {@link formatRangeTarget}).
 */
export function buildFormatUndoLabel(appliedLabel: string, target: string): string {
	return `Set format: ${appliedLabel} over ${target}`;
}
