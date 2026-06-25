/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure, vscode-free cell-value formatter.
 *
 * Extracted from `cellGridHtml.ts` (retired FE megaudit S5-H4 / S6, 2026-06-25):
 * `buildHtml` and the DOM-table path were dead code; `formatCellValue` remained live
 * (consumed by `filterLogic.ts`), so it was moved here to a minimal standalone module.
 */

import type { QuantbookCellValue } from '../types';

/**
 * Convert a {@link QuantbookCellValue} tagged union to its unformatted display string.
 *
 * - `number`  → `String(value.value)` (raw JS number, no locale formatting)
 * - `boolean` → `'TRUE'` / `'FALSE'`
 * - `text`    → the string as-is
 * - `error`   → the error sigil (e.g. `'#REF!'`)
 * - `pending` → `'(pending)'`
 *
 * This mirrors the `formatCellValueClient` inline in the retired `cellGridHtml.ts` webview script
 * (the two were kept in sync; now only the host copy lives here).
 */
export function formatCellValue(value: QuantbookCellValue): string {
	switch (value.kind) {
		case 'number':
			return String(value.value);
		case 'boolean':
			return value.value ? 'TRUE' : 'FALSE';
		case 'text':
			return value.value;
		case 'error':
			return value.value;
		case 'pending':
			return '(pending)';
	}
}
