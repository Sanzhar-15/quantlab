/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave N (2026-06-20) -- the vscode-free core of the Quantbook Import command:
// format-from-extension (the engine dispatches on "xlsx" / "csv") and the
// unsupported-features warning collector (the No-Fallbacks report drained from
// the session event ring). Pure so the No-Fallbacks-relevant branches are pinned
// as a deterministic unit suite (no engine, no vscode).

import type { EventJson } from '../types';

export type ImportFormat = 'xlsx' | 'csv';

/**
 * Derive the engine import format from a file path's extension. Returns
 * `undefined` for any other extension -- the caller fails LOUD rather than
 * guessing a format (No-Fallbacks). Case-insensitive.
 */
export function deriveImportFormat(path: string): ImportFormat | undefined {
	const lower = path.toLowerCase();
	if (lower.endsWith('.xlsx')) {
		return 'xlsx';
	}
	if (lower.endsWith('.csv')) {
		return 'csv';
	}
	return undefined;
}

/**
 * Collect the human-readable unsupported-feature / import-warning messages from
 * a page of session events. The engine records each dropped OOXML feature
 * (conditional formatting, data validation, merged cells, comments, drawings,
 * pivots, macros, external links, hidden sheets, ...) as a workbook-level
 * `cell_diagnostic` with a `xlsx_unsupported_feature` / `xlsx_import_warning`
 * code; this pulls exactly those (in event order) so a lossy import is surfaced
 * LOUD. Non-import events (per-cell errors, recalc progress) are ignored.
 */
export function collectImportWarnings(events: readonly EventJson[]): string[] {
	const out: string[] = [];
	for (const ev of events) {
		// Defensive against a malformed event over the napi boundary: a `cell_diagnostic` whose
		// `diagnostic` is missing `code`/`message` (wrong shape) must NOT throw a TypeError -- that
		// would be caught by the command and silently downgrade the import to "no warnings"
		// (a No-Fallbacks violation). Guard the field types before touching them.
		if (
			ev.kind === 'cell_diagnostic' &&
			ev.diagnostic !== undefined &&
			typeof ev.diagnostic.code === 'string' &&
			typeof ev.diagnostic.message === 'string' &&
			ev.diagnostic.code.startsWith('xlsx_')
		) {
			out.push(ev.diagnostic.message);
		}
	}
	return out;
}
