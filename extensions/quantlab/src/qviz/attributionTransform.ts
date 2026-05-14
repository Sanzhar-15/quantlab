/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit HIGH (Codex, 2026-05-14): strip the prepended inspector-filter
 * attribution records emitted by the daemon and re-index the remainder so
 * the saved spec's `transforms[0]` maps back to `record.index=0`.
 *
 * Wire context: the daemon's `op_aggregate` PREPENDS the inspector
 * filters to `spec.transforms` before calling `compile_spec`, so the
 * daemon emits attribution indices for the EFFECTIVE list (filters
 * first, then saved transforms). The webview's `attrByIndex.get(i)`
 * maps card `i` to `record.index === i` against the SAVED transforms.
 * Without this adjustment, card 0 would resolve to the first inspector
 * filter record (or any later card to the wrong transform). Shelf
 * badges and chip rows would point at the wrong transform.
 *
 * Pure (no vscode/IO) so the regression suite can pin every edge case
 * without spinning up the full provider. Used by
 * `VisualiseSpecProvider.ts:op_aggregate` response relay.
 */

import type { DataMessage } from './messageProtocol';

export function stripInspectorFilterAttribution(
	rawAttribution: DataMessage['attribution'],
	filterCount: number,
): DataMessage['attribution'] {
	if (rawAttribution === undefined) { return undefined; }
	if (filterCount <= 0) { return rawAttribution; }
	if (filterCount > rawAttribution.length) {
		// Defensive: more inspector filters than attribution records.
		// Returns empty array; the provider's downstream filter
		// normalizes empty to absent on the wire.
		return [];
	}
	return rawAttribution
		.slice(filterCount)
		.map(rec => ({ ...rec, index: rec.index - filterCount }));
}
