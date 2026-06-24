/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave Q2a (2026-06-24) -- chart data extraction (PURE).**
 *
 * Turns a persistent chart object ({@link ChartJson}) + a snapshot cell reader into a minimal qviz GENERAL
 * {@link QvizSpec} + matching {@link ColumnData}. Deliberately vscode/DOM/renderer-FREE so it unit-tests in
 * isolation (mirrors the codebase's `*Logic.ts` split). The {@link ChartOverlayManager} owns the DOM +
 * Vega-Lite embed; this module owns the column maths:
 *  - the FIRST column of the source range is the X axis (or a synthesised 1-based index for a single column);
 *  - the remaining columns are Y series;
 *  - a header row (top row all-text, more than one row) names the columns; otherwise the A1 column letter;
 *  - >1 Y column is reshaped to long form `{ x (repeated), value, series }` with a `series` colour encoding.
 *
 * No-Fallbacks: an unsupported type, an off-active-sheet source, or an empty data region returns an explicit
 * `{ error }` the caller renders IN the chart box -- never silently fabricated/blank data.
 */

import { QVIZ_SCHEMA_VERSION, type ChartType, type EncodingType, type Encodings, type QvizSpec } from '../../src/qviz/spec';
import type { ColumnData } from '../../src/qviz/render/types';
import type { ChartJson, QuantbookCellValue } from '../../src/quantbook/types';

/** Reads a cell's COMPUTED value on the ACTIVE sheet (the only sheet the current snapshot carries). */
export type CellReader = (row: number, col: number) => QuantbookCellValue | undefined;

// Discriminated by `ok` (the codebase bans the `in` operator -- a tagged union is the idiomatic narrow).
export type BuiltChart = { readonly ok: true; readonly columns: ColumnData; readonly spec: QvizSpec; readonly sig: string };
export type BuildResult = BuiltChart | { readonly ok: false; readonly error: string };

/** The chart types the engine stores + this module renders (must match the host/engine whitelist). */
export const ALLOWED_CHART_TYPES: ReadonlySet<string> = new Set(['line', 'bar', 'scatter']);

export function buildChartData(
	chart: ChartJson,
	activeSheet: number | null,
	readCell: CellReader,
	columnLabel: (col: number) => string,
): BuildResult {
	if (!ALLOWED_CHART_TYPES.has(chart.chartType)) {
		// The engine only ever stores line/bar/scatter; an unknown token is a contract violation -> surface it.
		return { ok: false, error: 'Unsupported chart type: ' + chart.chartType };
	}
	if (activeSheet === null || chart.srcSheet !== activeSheet) {
		// v1 renders a chart only when its source is on the active sheet (the snapshot carries one sheet).
		return { ok: false, error: 'Chart source is on another sheet.' };
	}
	const r0 = Math.min(chart.srcStartRow, chart.srcEndRow);
	const r1 = Math.max(chart.srcStartRow, chart.srcEndRow);
	const c0 = Math.min(chart.srcStartCol, chart.srcEndCol);
	const c1 = Math.max(chart.srcStartCol, chart.srcEndCol);
	const rowCount = r1 - r0 + 1;
	const colCount = c1 - c0 + 1;

	const numAt = (r: number, c: number): number | null => {
		const v = readCell(r, c);
		return v !== undefined && v.kind === 'number' ? v.value : null;
	};
	const textAt = (r: number, c: number): string => {
		const v = readCell(r, c);
		if (v === undefined) {
			return '';
		}
		switch (v.kind) {
			case 'number': return String(v.value);
			case 'text': return v.value;
			case 'boolean': return v.value ? 'TRUE' : 'FALSE';
			case 'error': return v.value;
			case 'pending': return '';
		}
	};

	// Header detection: the top row is a header iff there is more than one row, it has at least one TEXT cell,
	// and NO number/boolean cell (a number OR a boolean in the top row means it is DATA, not labels -- matching
	// Excel's "first row labels"). Blank cells in the header are allowed (an empty corner cell is common).
	let hasHeaderText = false;
	let hasHeaderNonText = false;
	for (let c = c0; c <= c1; c++) {
		const v = readCell(r0, c);
		if (v === undefined) { continue; }
		if (v.kind === 'text') { hasHeaderText = true; }
		else if (v.kind === 'number' || v.kind === 'boolean') { hasHeaderNonText = true; }
	}
	const header = rowCount >= 2 && hasHeaderText && !hasHeaderNonText;
	const dataR0 = header ? r0 + 1 : r0;
	const dataCount = r1 - dataR0 + 1;
	if (dataCount < 1) {
		// Defensive: currently unreachable (a header requires rowCount >= 2, so dataR0 <= r1), but guards a
		// future multi-row-header change from silently building a chart over an empty data region.
		return { ok: false, error: 'Chart range has no data rows.' };
	}

	const usedNames = new Set<string>();
	const nameFor = (col: number): string => {
		let base = header ? textAt(r0, col).trim() : '';
		if (base.length === 0) {
			base = columnLabel(col);
		}
		let name = base;
		let k = 2;
		while (usedNames.has(name)) {
			name = base + ' (' + k + ')';
			k++;
		}
		usedNames.add(name);
		return name;
	};
	const uniqueKey = (base: string): string => {
		let name = base;
		let k = 2;
		while (usedNames.has(name)) {
			name = base + '_' + k;
			k++;
		}
		usedNames.add(name);
		return name;
	};

	const hasXColumn = colCount >= 2;
	const xCol = hasXColumn ? c0 : null;
	const yCols: number[] = [];
	for (let c = hasXColumn ? c0 + 1 : c0; c <= c1; c++) {
		yCols.push(c);
	}

	// X axis values + type.
	let xName: string;
	let xType: EncodingType;
	let xValues: (number | null)[] | string[];
	if (xCol === null) {
		xName = uniqueKey('Index');
		xType = 'quantitative';
		const idx: number[] = [];
		for (let i = 0; i < dataCount; i++) { idx.push(i + 1); }
		xValues = idx;
	} else {
		xName = nameFor(xCol);
		let allNumeric = true;
		let anyValue = false;
		for (let r = dataR0; r <= r1; r++) {
			const v = readCell(r, xCol);
			if (v === undefined || v.kind === 'pending') { continue; }
			anyValue = true;
			if (v.kind !== 'number') { allNumeric = false; break; }
		}
		if (allNumeric && anyValue) {
			xType = 'quantitative';
			const xs: (number | null)[] = [];
			for (let r = dataR0; r <= r1; r++) { xs.push(numAt(r, xCol)); }
			xValues = xs;
		} else {
			xType = 'nominal';
			const xs: string[] = [];
			for (let r = dataR0; r <= r1; r++) { xs.push(textAt(r, xCol)); }
			xValues = xs;
		}
	}

	const chartType = chart.chartType as ChartType;
	const title = chart.title !== undefined && chart.title.length > 0 ? chart.title : chart.name;
	let columns: ColumnData;
	let encodings: Encodings;

	if (yCols.length === 1) {
		const yName = nameFor(yCols[0]);
		const ys: (number | null)[] = [];
		for (let r = dataR0; r <= r1; r++) { ys.push(numAt(r, yCols[0])); }
		columns = { [xName]: xValues, [yName]: ys };
		encodings = {
			x: { field: xName, type: xType },
			y: { field: yName, type: 'quantitative' },
		};
	} else {
		// >1 Y column: long form { x (repeated), value, series } with a colour encoding (multi-series).
		const valueKey = uniqueKey('value');
		const seriesKey = uniqueKey('series');
		// The runtime element type is governed by `xType` (see the per-element push below); the union annotation
		// just lets both branches push into it.
		const longX: (number | null)[] | string[] = [];
		const longValue: (number | null)[] = [];
		const longSeries: string[] = [];
		for (const yc of yCols) {
			const yName = nameFor(yc);
			for (let i = 0; i < dataCount; i++) {
				const r = dataR0 + i;
				// Repeat the X value per series.
				if (xType === 'quantitative') {
					(longX as (number | null)[]).push((xValues as (number | null)[])[i]);
				} else {
					(longX as string[]).push((xValues as string[])[i]);
				}
				longValue.push(numAt(r, yc));
				longSeries.push(yName);
			}
		}
		columns = { [xName]: longX, [valueKey]: longValue, [seriesKey]: longSeries };
		encodings = {
			x: { field: xName, type: xType },
			y: { field: valueKey, type: 'quantitative' },
			color: { field: seriesKey, type: 'nominal' },
		};
	}

	const spec: QvizSpec = {
		qviz_version: QVIZ_SCHEMA_VERSION,
		title,
		dataset: { uri: 'chart-' + chart.id, schema_hash: '', mtime_ns: 0 },
		transforms: [],
		chart: {
			family: 'general',
			type: chartType,
			encodings,
			options: { show_legend: yCols.length >= 2, show_grid: true },
		},
		provenance: {
			generated_at: new Date().toISOString(),
			generator: 'quantbook-sheets',
			query_hash: '',
			tool_versions: { qviz_schema: QVIZ_SCHEMA_VERSION },
		},
	};

	// Signature: type + the full column data (keys + values) + x type fully determine the rendered chart.
	const sig = chartType + '|' + xType + '|' + JSON.stringify(columns);
	return { ok: true, columns, spec, sig };
}
