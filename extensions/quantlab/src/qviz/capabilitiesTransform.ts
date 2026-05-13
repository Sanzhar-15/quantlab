/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit F1 (2026-05-13): single source of truth for the snake_case
 * (daemon JSON) -> camelCase (webview protocol) capability transform.
 *
 * Extracted from two duplicate call sites in `VisualiseSpecProvider`
 * (initial caps fetch and the post-respawn refetch) so:
 *
 *   1. The contract is unit-testable without spinning up the provider
 *      harness.
 *   2. Drift between the two call sites becomes a compile error
 *      (both import the same helper).
 *   3. A future caller (e.g. a third refetch path) inherits the right
 *      shape by construction.
 */

import type { DaemonCapabilitiesData } from './daemon-client';
import type { DaemonCapabilities } from './messageProtocol';

export function mapDaemonCapsForInit(
	raw: DaemonCapabilitiesData,
): DaemonCapabilities {
	// F1 codex/opus audit (2026-05-13): be strict about what counts as
	// "inspector present" — a misbehaving daemon emitting
	// `{"inspector": null}` would previously crash on
	// `daemonInspector.preview_offset`. The helper extraction is the
	// natural place to harden against this (defense in depth on top of
	// the typed contract).
	const di = raw.inspector;
	const hasInspector = di !== undefined && di !== null && typeof di === 'object';
	return {
		daemonVersion: raw.daemon_version,
		transformKinds: raw.transform_kinds,
		chartFamilies: raw.chart_families.filter(
			(f): f is 'timeseries' | 'general' =>
				f === 'timeseries' || f === 'general',
		),
		// Preserve "inspector absent" vs "inspector all-false" semantics:
		// pre-Phase-6 daemons omit the bag entirely, and the webview's
		// toggle stays disabled. An all-false inspector means the daemon
		// supports inspector ops but every sub-feature is off.
		...(hasInspector ? {
			inspector: {
				previewOffset: !!di.preview_offset,
				columnStats: !!di.column_stats,
				aggregateFilters: !!di.aggregate_filters,
			},
		} : {}),
	};
}
