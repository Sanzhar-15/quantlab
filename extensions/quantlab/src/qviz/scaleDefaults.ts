/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-(chart-type × channel × encoding-type) scale defaults —
 * Front 4 (post-smoke builder-coherence pass, 2026-05-14).
 *
 * The chart renderer (general.ts, timeseries.ts) is purely spec-driven
 * today: it emits whatever scale options the spec carries, with the
 * single exception of `chart.options.y_axis_zero` which forces
 * `scale.zero = true` on the y axis. This is correct on first
 * principles but it puts the burden of knowing canonical scale
 * conventions on the user: bar charts want `zero=true` (Tufte canon —
 * bars without a zero baseline lie), scatter / line-over-temporal-x
 * want `zero=false` (auto-fit to data), histograms want `zero=true`
 * on the count axis. Without these defaults, users drop a numeric
 * column on `x` of a scatter and watch points cluster top-right
 * because the axis stretches to include 0.
 *
 * This module exposes one function:
 *
 *   getDefaultScaleOptions(chartType, channel, encodingType)
 *     → { zero?: boolean; type?: ScaleType }
 *
 * Precedence (computed by the renderer, NOT persisted into the spec):
 *
 *   1. Explicit encoding.scale wins.
 *   2. Explicit chart.options.{x,y}_axis_zero wins for that axis.
 *   3. Otherwise this module's default applies.
 *
 * **Critical invariant** (per Codex's "don't auto-mutate saved specs"
 * rule): defaults are EFFECTIVE values computed at render time. They
 * are NEVER written back into the spec. Old v1 specs render exactly
 * as before unless they newly hit an undefined option, in which case
 * they get the same default a fresh spec would.
 *
 * For symmetry with `y_axis_zero`, `chart.options.x_axis_zero?` is
 * recognized as an override here too (the spec type adds the field
 * in `spec.ts`).
 */

import type { ChartType, Encoding, EncodingType } from './spec';

type ScaleType = NonNullable<Encoding['scale']>;

export type ScaleDefaultChannel =
	| 'x' | 'y' | 'y2'
	| 'color' | 'size' | 'shape'
	| 'facet_row' | 'facet_col';

export interface ScaleDefault {
	readonly zero?: boolean;
	readonly type?: ScaleType;
}

/**
 * Compute the effective scale-option defaults for a (chartType,
 * channel, encodingType) triple. Returns an empty object when no
 * default applies; callers should NOT auto-fill the encoding.scale
 * with an empty result.
 */
export function getDefaultScaleOptions(
	chartType: ChartType,
	channel: ScaleDefaultChannel,
	encodingType: EncodingType,
): ScaleDefault {
	// Color / size / shape / facet channels — no scale defaults today.
	// Color schemes are handled by the renderer's theming layer
	// (general.ts:resolveColorScale). Returning empty preserves that.
	if (channel !== 'x' && channel !== 'y' && channel !== 'y2') {
		return {};
	}

	// Quantitative-axis-zero conventions:
	//
	// - bar / histogram: zero=true on the quantitative value axis
	//   (Tufte canon — bar length without a zero baseline lies).
	//   Channel y is the value axis for both.
	// - scatter / line / area / baseline / heatmap: zero=false on
	//   quantitative axes. Auto-fit to data is the right default for
	//   shapes that don't communicate magnitude via length-from-zero.
	//
	// Temporal axes (`encodingType === 'temporal'`): never force zero.
	// A temporal scale anchored at Unix 0 makes 2024 dates squish
	// into the right edge — exactly the BTC-scatter top-right symptom
	// from the smoke session.
	//
	// Nominal/ordinal axes: zero doesn't apply.
	if (encodingType !== 'quantitative') {
		return {};
	}

	switch (chartType) {
		case 'bar':
		case 'histogram':
			// Value axis (y) zeroes; x doesn't need it (could be
			// nominal categories or numeric bins).
			if (channel === 'y') { return { zero: true }; }
			return {};
		case 'scatter':
		case 'line':
		case 'area':
		case 'baseline':
		case 'heatmap':
			// Scatter cluster-in-corner symptom: explicitly do NOT
			// force zero on x or y. The renderer auto-fits.
			return { zero: false };
		case 'pie':
		case 'candlestick':
			// Pie has no x/y in the cartesian sense; candlestick
			// uses the OHLCV cluster which the renderer handles
			// outside this defaults path. Return empty.
			return {};
		default:
			// Exhaustive switch — TS will fail compile if a new
			// chart type is added without an arm here.
			return {};
	}
}
