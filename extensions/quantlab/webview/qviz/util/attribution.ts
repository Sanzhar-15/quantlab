/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 2 V2 (2026-05-14): webview-side attribution lookup helper.
 *
 * Companion to `src/qviz/render/attribution.ts:describeColumnDrop`,
 * which returns the formatted suffix string for renderer error
 * messages. This helper returns the STRUCTURED record so UI
 * components (encoding-shelf badge, transform-card chips) can use
 * the `{ index, kind }` for routing decisions like
 * "click badge -> scroll to transform #N".
 *
 * First-drop-wins, same semantics as `describeColumnDrop` -- when a
 * column was dropped and re-introduced and dropped again, the FIRST
 * drop is the canonical attribution. Matches the renderer's wording
 * so the badge agrees with the diagnostics-panel error.
 *
 * Callers must pass an attribution payload that is FRESH against the
 * current spec. Use the gate
 *   `state.query.lastData?.specHash === state.spec.currentHash`
 * before invoking. The Front 2 V1 audit MEDIUM fix established this
 * pattern at the render-trigger sites; V2 UI consumers re-apply it
 * locally per component to avoid badge/chip misattribution after a
 * spec edit and before the next dataReceived.
 */

import type { TransformAttribution } from '../../../src/qviz/messageProtocol';

/** Returns `{ index, kind }` for the first transform that dropped the
 *  named column, or `null` if the column was never dropped or
 *  attribution is absent. */
export function findColumnDrop(
	column: string,
	attribution: readonly TransformAttribution[] | null | undefined,
): { readonly index: number; readonly kind: string } | null {
	if (!attribution) { return null; }
	for (const record of attribution) {
		if (record.drops.includes(column)) {
			return { index: record.index, kind: record.kind };
		}
	}
	return null;
}
