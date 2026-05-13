/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 1 (post-smoke builder-coherence pass, 2026-05-14):
 * controller-layer chart-type fitter.
 *
 * Pure function: given a schema + the currently-edited spec + a target
 * chart type, produce the (family, chartType, encodings) tuple to
 * apply atomically as ONE history entry via the
 * `applyChartTypeWithFit` reducer action.
 *
 * Why a controller, not a reducer:
 *
 *   - The reducer must be schema-agnostic. Adding `schema` to every
 *     `setChartType` dispatch would couple every test that mutates
 *     chart type to a schema-provider -- most existing tests do not
 *     have one. Keeping the reducer schema-free preserves the
 *     existing 1054-test invariants.
 *   - The controller is invoked from the chart-type picker's click
 *     handler (the ONLY entry point for user-initiated chart-type
 *     transitions). It reads schema from the store, computes the fit,
 *     and dispatches a fully-resolved action. The reducer applies
 *     it as one transition.
 *
 * Policy (in fit order):
 *
 *   1. Preserve compatible encodings. Any channel allowed on the
 *      target chart type that the user has already filled stays
 *      untouched. (Same filter as the legacy `setChartType` reducer.)
 *   2. For candlestick: if no OHLCV cluster is preserved, run
 *      `detectOhlcvFromSchema` to populate one. Don't touch x/y;
 *      candlestick doesn't use them.
 *   3. For non-candlestick: walk the new chart type's REQUIRED
 *      channels (per `CHART_CHANNELS`). For each empty required
 *      channel, pick a column via Pattern B (schema-dtype-driven)
 *      using the channel's natural type preference:
 *
 *        x         → temporal > quantitative > nominal/ordinal
 *        y, y2     → quantitative > nominal/ordinal
 *        color     → nominal/ordinal > quantitative
 *        size      → quantitative
 *        shape     → nominal/ordinal
 *        facet_*   → nominal/ordinal
 *
 *      Skip columns already used by an existing encoding so x != y.
 *
 *   4. Never overwrite a user-assigned compatible channel. If schema
 *      has no candidate of the preferred types, the channel stays
 *      empty and the UI's required-channel indicator surfaces the
 *      gap (existing behavior, unchanged).
 *
 * **Critical invariant**: the controller NEVER auto-fills at load
 * time. It is invoked only by the chart-type picker. Old saved
 * specs that the user opens but doesn't touch are byte-identical
 * to disk.
 */

import type {
	ChartFamily, ChartType, Encoding, Encodings, OhlcvEncoding, QvizSpec,
} from '../../../src/qviz/spec';
import type { SchemaColumn, SchemaInfo } from '../../../src/qviz/messageProtocol';
import {
	CHART_CHANNELS, channelsForChartType, type RegularChannel,
} from '../../../src/qviz/chartChannels';
import {
	classifyColumn, type ClassifiedColumnType,
} from '../../../src/qviz/schemaEncoding';

/** Cycle 2 audit MEDIUM (Both Opus and Codex, 2026-05-14): the
 *  `y` channel preference table previously allowed nominal/ordinal
 *  fallbacks. That's fine for line/scatter/bar (Vega-Lite tolerates
 *  categorical y), but pie's `y` is the slice-angle (theta) channel
 *  and histogram's `y` is the count axis -- both render incoherently
 *  with a string-valued column. Restrict those targets to
 *  quantitative-only and leave the channel empty if no quant
 *  candidate exists; the required-channel indicator surfaces the
 *  gap. */
const Y_QUANTITATIVE_ONLY_TARGETS: ReadonlySet<ChartType> =
	new Set<ChartType>(['pie', 'histogram']);

export type FitFilledChannel = RegularChannel | 'ohlcv';

export interface FitResult {
	readonly family: ChartFamily;
	readonly chartType: ChartType;
	readonly encodings: Encodings;
	readonly filledChannels: readonly FitFilledChannel[];
}

/**
 * Compute the (family, chartType, encodings) to apply for a
 * user-initiated chart-type transition.
 *
 * `schema` may be `null` if the daemon hasn't responded yet; in that
 * case the result preserves compatible encodings only (matches the
 * legacy `setChartType` reducer behavior).
 */
export function fitChartTypeTransition(
	schema: SchemaInfo | null,
	currentSpec: QvizSpec,
	targetType: ChartType,
	targetFamily: ChartFamily,
): FitResult {
	const oldEnc = currentSpec.chart.encodings;

	// Step 1: preserve compatible encodings. Mirrors the legacy
	// `setChartType` reducer's filter; we duplicate the logic here
	// because we want the COMBINED (preserve + fit) operation to be
	// one dispatch, not two.
	const allowedChannels = targetType === 'candlestick'
		? new Set<string>()
		: new Set<string>(channelsForChartType(targetType));
	const next: Record<string, unknown> = {};
	for (const [ch, val] of Object.entries(oldEnc)) {
		if (val === undefined) { continue; }
		if (ch === 'ohlcv') {
			if (targetType === 'candlestick') { next[ch] = val; }
			continue;
		}
		if (allowedChannels.has(ch)) { next[ch] = val; }
	}

	const filled: FitFilledChannel[] = [];

	// Step 2: candlestick OHLCV cluster.
	if (targetType === 'candlestick') {
		if (next.ohlcv === undefined && schema !== null) {
			const ohlcv = detectOhlcvFromSchema(schema);
			if (ohlcv !== null) {
				next.ohlcv = ohlcv;
				filled.push('ohlcv');
			}
		}
		return {
			family: targetFamily,
			chartType: targetType,
			encodings: next as Encodings,
			filledChannels: filled,
		};
	}

	// Step 3: fill empty required channels via Pattern B. Skip when
	// we have no schema (daemon hasn't responded yet).
	if (schema === null) {
		return {
			family: targetFamily,
			chartType: targetType,
			encodings: next as Encodings,
			filledChannels: filled,
		};
	}

	const cfg = CHART_CHANNELS[targetType as Exclude<ChartType, 'candlestick'>];

	// Track columns already used so we don't double-assign (x != y).
	// Non-candlestick targets never have `ohlcv` in `next` (we filtered
	// it at the top), so every value here is an Encoding.
	const used = new Set<string>();
	for (const ch of Object.keys(next)) {
		if (ch === 'ohlcv') { continue; }
		const enc = next[ch] as Encoding | undefined;
		if (enc !== undefined) {
			used.add(enc.field);
		}
	}

	for (const channel of cfg.required) {
		if (next[channel] !== undefined) { continue; }
		const picked = pickColumnForChannel(schema, channel, targetType, used);
		if (picked !== null) {
			next[channel] = picked;
			used.add(picked.field);
			filled.push(channel);
		}
	}

	return {
		family: targetFamily,
		chartType: targetType,
		encodings: next as Encodings,
		filledChannels: filled,
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Per-channel preference list. The fitter walks this in order and
 *  picks the first matching column not already used. */
const CHANNEL_TYPE_PREFERENCE: Record<RegularChannel, readonly ClassifiedColumnType[]> = {
	x: ['temporal', 'quantitative', 'nominal', 'ordinal'],
	y: ['quantitative', 'nominal', 'ordinal'],
	y2: ['quantitative'],
	color: ['nominal', 'ordinal', 'quantitative'],
	size: ['quantitative'],
	shape: ['nominal', 'ordinal'],
	facet_row: ['nominal', 'ordinal'],
	facet_col: ['nominal', 'ordinal'],
};

function pickColumnForChannel(
	schema: SchemaInfo,
	channel: RegularChannel,
	targetType: ChartType,
	used: ReadonlySet<string>,
): Encoding | null {
	// Chart-type-aware constraint: pie/histogram y requires
	// quantitative or stays empty (see Y_QUANTITATIVE_ONLY_TARGETS
	// docstring).
	const prefs: readonly ClassifiedColumnType[]
		= (channel === 'y' && Y_QUANTITATIVE_ONLY_TARGETS.has(targetType))
			? ['quantitative']
			: CHANNEL_TYPE_PREFERENCE[channel];
	for (const wantType of prefs) {
		for (const col of schema.columns) {
			if (used.has(col.name)) { continue; }
			if (classifyColumn(col) !== wantType) { continue; }
			// Pattern B (schema-driven): the persisted encoding type
			// is the classified type. wantType doubles as the encoding
			// type since classification and Vega-Lite encoding
			// vocabularies are the same set ({temporal, quantitative,
			// nominal, ordinal}).
			return {
				field: col.name,
				type: wantType === 'ordinal' ? 'ordinal' : wantType,
			};
		}
	}
	return null;
}

/**
 * OHLCV auto-detect for candlestick. Mirrors `defaults.ts:
 * detectOhlcvColumns` (used at default-spec time) but reads the
 * schema directly so the controller can be invoked from the picker
 * without going through `deriveDefaultSpec`.
 *
 * Requires:
 *   - exactly one column matching each of open/high/low/close
 *     (case-insensitive), all quantitative
 *   - one temporal column (any name)
 *   - case-ambiguous duplicates (`Close` + `close`) refuse the
 *     auto-detect, matching Megaudit Theme G G13.
 *
 * Returns `null` when any requirement fails. The candlestick
 * chart-type swap still completes; the UI's OHLCV shelf shows
 * "Pick columns".
 */
function detectOhlcvFromSchema(schema: SchemaInfo): OhlcvEncoding | null {
	const byLower = new Map<string, SchemaColumn>();
	let temporal: SchemaColumn | null = null;
	for (const col of schema.columns) {
		const key = col.name.toLowerCase();
		if (byLower.has(key)) { return null; }
		byLower.set(key, col);
		if (temporal === null && classifyColumn(col) === 'temporal') {
			temporal = col;
		}
	}
	if (temporal === null) { return null; }
	const o = byLower.get('open');
	const h = byLower.get('high');
	const l = byLower.get('low');
	const c = byLower.get('close');
	if (!o || !h || !l || !c) { return null; }
	if (classifyColumn(o) !== 'quantitative'
		|| classifyColumn(h) !== 'quantitative'
		|| classifyColumn(l) !== 'quantitative'
		|| classifyColumn(c) !== 'quantitative'
	) { return null; }
	const v = byLower.get('volume');
	const volume = v && classifyColumn(v) === 'quantitative' ? v.name : undefined;
	return {
		time: temporal.name,
		open: o.name,
		high: h.name,
		low: l.name,
		close: c.name,
		...(volume !== undefined ? { volume } : {}),
	};
}
