/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 2 (2026-05-14): per-transform schema-snapshot attribution
 * helper. Pure module; consumed by the general + timeseries renderers
 * to enrich "encoding references missing column" error messages with
 * the transform responsible for the drop.
 *
 * The truth of "which transform dropped what" lives in the daemon's
 * `compile_spec` — see `python/qviz/compiler.py:compile_spec` for the
 * dispatch loop that captures per-step `available` snapshots. This
 * helper is purely *descriptive*: it formats the suffix string that
 * gets appended to the renderer's existing error message.
 *
 * Critical invariant: first-drop wins. When a column was dropped and
 * re-introduced and dropped again (rare), we attribute the error to
 * the FIRST drop. The plan documents this; smoke-session surfacing a
 * real multi-drop case would justify expanding to a chain in V2.
 *
 * When `attribution` is `null` (pre-Front-2 daemon) or `undefined`
 * (uncreated payload), the helper returns the empty string so the
 * caller's message stays verbatim. This preserves back-compat:
 * existing tests that match the old error wording stay green.
 */

import type { TransformAttribution } from '../messageProtocol';

/**
 * Returns ` -- dropped by transform #N (kind)` when `column` was
 * dropped by some transform in `attribution`, or `''` otherwise.
 *
 * Walks `attribution` in pipeline order; first hit wins. Callers
 * append the returned string directly to the error message.
 */
export function describeColumnDrop(
	column: string,
	attribution: readonly TransformAttribution[] | null | undefined,
): string {
	if (!attribution) { return ''; }
	for (const record of attribution) {
		if (record.drops.includes(column)) {
			return ` -- dropped by transform #${record.index} (${record.kind})`;
		}
	}
	return '';
}
