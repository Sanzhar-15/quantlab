/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-transform form factories — Phase 5 step 5.G.3.
 *
 * Each factory builds a small DOM island that:
 *   - Renders inputs reflecting the current `Transform` value.
 *   - Calls `onUpdate(next)` on change/blur with a structurally-valid
 *     Transform. The reducer's `upsertTransform` action accepts that
 *     value as-is (no further parsing in the dispatch layer).
 *
 * Forms are kind-specific because the input shapes differ. A registry
 * `FORM_BY_KIND` maps `Transform['kind']` to the right factory; the
 * caller (transformList) consults the registry on render.
 *
 * Column dropdowns are populated from the active SchemaInfo. When no
 * schema is available yet (e.g., daemon spawn in progress), text
 * inputs are used as a fallback so the user can still hand-type.
 */

import type {
	AggregateTransform, AggregationOp, BinTransform, DateTruncTransform,
	FilterTransform, GroupByTransform, LimitTransform, MathTransform,
	SortTransform, Transform, TzConvertTransform, WindowTransform,
} from '../../../src/qviz/spec';
import type { SchemaColumn } from '../../../src/qviz/messageProtocol';

export type TransformKind = Transform['kind'];

export interface TransformFormContext {
	readonly columns: readonly SchemaColumn[];
	readonly availableProducedNames: readonly string[];
}

export interface TransformFormHandle {
	readonly root: HTMLElement;
	dispose(): void;
}

/** Build a form for `transform`. Calls `onUpdate(next)` on every
 *  successful edit. The returned handle's `root` is the rendered
 *  element; the caller is responsible for mounting it into the DOM. */
export type TransformFormFactory<T extends Transform> = (
	transform: T, ctx: TransformFormContext, onUpdate: (next: T) => void,
) => TransformFormHandle;

// ---------------------------------------------------------------------------
// Common DOM helpers
// ---------------------------------------------------------------------------

function row(label: string, control: HTMLElement): HTMLElement {
	const div = document.createElement('div');
	div.className = 'qviz-form-row';
	const lab = document.createElement('label');
	lab.className = 'qviz-form-label';
	lab.textContent = label;
	div.appendChild(lab);
	div.appendChild(control);
	return div;
}

function makeSelect(
	options: readonly { value: string; label: string }[],
	current: string,
): HTMLSelectElement {
	const sel = document.createElement('select');
	sel.className = 'qviz-form-select';
	for (const opt of options) {
		const o = document.createElement('option');
		o.value = opt.value;
		o.textContent = opt.label;
		if (opt.value === current) { o.selected = true; }
		sel.appendChild(o);
	}
	return sel;
}

function makeColumnSelect(
	columns: readonly SchemaColumn[], current: string,
	options?: { allowProduced?: readonly string[] },
): HTMLSelectElement {
	const opts = [
		// Empty option so the user can clear the selection — the form
		// re-renders empty fields red via CSS.
		{ value: '', label: '(select a column)' },
		...columns.map(c => ({ value: c.name, label: `${c.name} · ${c.dtype}` })),
		...(options?.allowProduced ?? []).map(name => ({
			value: name, label: `${name} · (produced)`,
		})),
	];
	// If `current` isn't in the schema (e.g., spec saved with a column
	// that no longer exists), keep it as a synthetic option so the
	// user can see and clear it.
	if (current.length > 0 && !columns.some(c => c.name === current)
		&& !(options?.allowProduced ?? []).includes(current)) {
		opts.push({ value: current, label: `${current} · (missing)` });
	}
	return makeSelect(opts, current);
}

function makeNumberInput(value: number | undefined, placeholder?: string): HTMLInputElement {
	const inp = document.createElement('input');
	inp.type = 'number';
	inp.className = 'qviz-form-input';
	inp.step = 'any';
	if (value !== undefined) { inp.value = String(value); }
	if (placeholder) { inp.placeholder = placeholder; }
	return inp;
}

function makeTextInput(value: string | undefined, placeholder?: string): HTMLInputElement {
	const inp = document.createElement('input');
	inp.type = 'text';
	inp.className = 'qviz-form-input';
	if (value !== undefined) { inp.value = value; }
	if (placeholder) { inp.placeholder = placeholder; }
	return inp;
}

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

const FILTER_OPS: readonly { value: FilterTransform['op']; label: string }[] = [
	{ value: '==', label: '==' },
	{ value: '!=', label: '≠' },
	{ value: '<', label: '<' },
	{ value: '<=', label: '≤' },
	{ value: '>', label: '>' },
	{ value: '>=', label: '≥' },
	{ value: 'is_null', label: 'is null' },
	{ value: 'not_null', label: 'is not null' },
];

const filterForm: TransformFormFactory<FilterTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--filter';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const opSel = makeSelect(FILTER_OPS, t.op);
	const valueInp = makeTextInput(
		typeof t.value === 'string' || typeof t.value === 'number'
			? String(t.value) : '',
		'value',
	);
	const emit = (): void => {
		const op = opSel.value as FilterTransform['op'];
		const needsValue = op !== 'is_null' && op !== 'not_null';
		const raw = valueInp.value;
		const value: FilterTransform['value'] = needsValue
			? (raw.length > 0 && !isNaN(Number(raw)) ? Number(raw) : raw)
			: undefined;
		// Hide value input for null-checks.
		valueInp.style.display = needsValue ? '' : 'none';
		onUpdate({
			kind: 'filter',
			column: colSel.value,
			op,
			...(value !== undefined ? { value } : {}),
		});
	};
	colSel.addEventListener('change', emit);
	opSel.addEventListener('change', emit);
	valueInp.addEventListener('blur', emit);
	valueInp.addEventListener('change', emit);

	root.appendChild(row('Column', colSel));
	root.appendChild(row('Op', opSel));
	root.appendChild(row('Value', valueInp));
	// Initial visibility for null-checks.
	if (t.op === 'is_null' || t.op === 'not_null') {
		valueInp.style.display = 'none';
	}
	return { root, dispose: () => { /* listeners die with the DOM */ } };
};

// ---------------------------------------------------------------------------
// date_trunc
// ---------------------------------------------------------------------------

const DATE_TRUNC_UNITS: readonly { value: DateTruncTransform['unit']; label: string }[] = [
	'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
].map(u => ({ value: u as DateTruncTransform['unit'], label: u }));

const dateTruncForm: TransformFormFactory<DateTruncTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--date-trunc';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const unitSel = makeSelect(DATE_TRUNC_UNITS, t.unit);
	const asInp = makeTextInput(t.as, 'output column name');
	const emit = (): void => {
		onUpdate({
			kind: 'date_trunc',
			column: colSel.value,
			unit: unitSel.value as DateTruncTransform['unit'],
			as: asInp.value,
		});
	};
	colSel.addEventListener('change', emit);
	unitSel.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Unit', unitSel));
	root.appendChild(row('As', asInp));
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

const binForm: TransformFormFactory<BinTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--bin';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const nInp = makeNumberInput(t.n_bins, 'count (2-1000)');
	const asInp = makeTextInput(t.as, 'output column name');
	const emit = (): void => {
		const n = parseInt(nInp.value, 10);
		onUpdate({
			kind: 'bin',
			column: colSel.value,
			n_bins: Number.isFinite(n) && n > 0 ? n : 10,
			as: asInp.value,
			strategy: 'equal_width', // Only supported value (Step C fix gate).
		});
	};
	colSel.addEventListener('change', emit);
	nInp.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Bins', nInp));
	root.appendChild(row('As', asInp));
	const strategyNote = document.createElement('div');
	strategyNote.className = 'qviz-form-note';
	strategyNote.textContent = 'Strategy: equal_width (equal_freq not yet implemented)';
	root.appendChild(strategyNote);
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// groupby
// ---------------------------------------------------------------------------

const groupByForm: TransformFormFactory<GroupByTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--groupby';
	const note = document.createElement('div');
	note.className = 'qviz-form-note';
	note.textContent = 'Group columns (one per line):';
	root.appendChild(note);
	const ta = document.createElement('textarea');
	ta.className = 'qviz-form-textarea';
	ta.rows = Math.max(2, t.columns.length + 1);
	ta.value = t.columns.join('\n');
	ta.placeholder = 'column_name\nother_column';
	const emit = (): void => {
		const cols = ta.value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
		onUpdate({ kind: 'groupby', columns: cols });
	};
	ta.addEventListener('blur', emit);
	ta.addEventListener('change', emit);
	root.appendChild(ta);
	// Show available column names as a click-to-append helper.
	if (ctx.columns.length > 0) {
		const chips = document.createElement('div');
		chips.className = 'qviz-form-chips';
		for (const c of ctx.columns) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'qviz-form-chip';
			chip.textContent = c.name;
			chip.addEventListener('click', () => {
				const lines = ta.value.split('\n').map(s => s.trim());
				if (!lines.includes(c.name)) {
					lines.push(c.name);
					ta.value = lines.filter(s => s.length > 0).join('\n');
					emit();
				}
			});
			chips.appendChild(chip);
		}
		root.appendChild(chips);
	}
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

const AGG_FNS: readonly { value: AggregationOp['fn']; label: string }[] = [
	'sum', 'mean', 'median', 'min', 'max', 'count', 'std', 'first', 'last',
].map(f => ({ value: f as AggregationOp['fn'], label: f }));

const aggregateForm: TransformFormFactory<AggregateTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--aggregate';
	const list = document.createElement('div');
	list.className = 'qviz-form-aggs';
	root.appendChild(list);

	const aggs = t.aggs.length > 0
		? [...t.aggs] as AggregationOp[]
		: [{ column: '', fn: 'count' as const, as: 'count' }];

	const emit = (): void => {
		onUpdate({ kind: 'aggregate', aggs });
	};

	const render = (): void => {
		list.innerHTML = '';
		aggs.forEach((agg, i) => {
			const row = document.createElement('div');
			row.className = 'qviz-form-agg-row';
			const colSel = makeColumnSelect(ctx.columns, agg.column, {
				allowProduced: ctx.availableProducedNames,
			});
			const fnSel = makeSelect(AGG_FNS, agg.fn);
			const asInp = makeTextInput(agg.as, 'output column');
			const rm = document.createElement('button');
			rm.type = 'button';
			rm.className = 'qviz-form-remove';
			rm.textContent = '×';
			rm.title = 'Remove aggregation';

			colSel.addEventListener('change', () => { aggs[i] = { ...aggs[i], column: colSel.value }; emit(); });
			fnSel.addEventListener('change', () => { aggs[i] = { ...aggs[i], fn: fnSel.value as AggregationOp['fn'] }; emit(); });
			const onAsUpdate = (): void => { aggs[i] = { ...aggs[i], as: asInp.value }; emit(); };
			asInp.addEventListener('blur', onAsUpdate);
			asInp.addEventListener('change', onAsUpdate);
			rm.addEventListener('click', () => {
				if (aggs.length === 1) { return; }
				aggs.splice(i, 1);
				render();
				emit();
			});

			row.appendChild(colSel);
			row.appendChild(fnSel);
			row.appendChild(asInp);
			row.appendChild(rm);
			list.appendChild(row);
		});
	};
	render();

	const addBtn = document.createElement('button');
	addBtn.type = 'button';
	addBtn.className = 'qviz-form-add';
	addBtn.textContent = '+ Add aggregation';
	addBtn.addEventListener('click', () => {
		aggs.push({ column: '', fn: 'sum', as: '' });
		render();
		emit();
	});
	root.appendChild(addBtn);

	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// window (without ema — gated by validator at Step C cleanup)
// ---------------------------------------------------------------------------

const WINDOW_FNS: readonly { value: WindowTransform['fn']; label: string }[] = [
	{ value: 'rolling_mean', label: 'rolling_mean' },
	{ value: 'rolling_std', label: 'rolling_std' },
	{ value: 'rolling_max', label: 'rolling_max' },
	{ value: 'rolling_min', label: 'rolling_min' },
	{ value: 'cumsum', label: 'cumsum' },
	{ value: 'cumprod', label: 'cumprod' },
	{ value: 'cummax', label: 'cummax' },
	{ value: 'cummin', label: 'cummin' },
];

const windowForm: TransformFormFactory<WindowTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--window';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const fnSel = makeSelect(WINDOW_FNS, t.fn);
	const winInp = makeNumberInput(t.window, 'rolling window');
	const asInp = makeTextInput(t.as, 'output column');
	const emit = (): void => {
		const fn = fnSel.value as WindowTransform['fn'];
		const requiresWindow = fn.startsWith('rolling_');
		const winVal = requiresWindow ? parseInt(winInp.value, 10) || undefined : undefined;
		onUpdate({
			kind: 'window',
			column: colSel.value,
			fn,
			...(winVal !== undefined ? { window: winVal } : {}),
			as: asInp.value,
		});
		winInp.style.display = requiresWindow ? '' : 'none';
	};
	colSel.addEventListener('change', emit);
	fnSel.addEventListener('change', emit);
	winInp.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Fn', fnSel));
	root.appendChild(row('Window', winInp));
	root.appendChild(row('As', asInp));
	if (!t.fn.startsWith('rolling_')) {
		winInp.style.display = 'none';
	}
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

const MATH_FNS: readonly { value: MathTransform['fn']; label: string }[] = [
	'log', 'log10', 'exp', 'abs', 'sqrt', 'log_returns', 'pct_change', 'drawdown',
].map(f => ({ value: f as MathTransform['fn'], label: f }));

const mathForm: TransformFormFactory<MathTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--math';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const fnSel = makeSelect(MATH_FNS, t.fn);
	const periodsInp = makeNumberInput(t.periods, 'periods (log_returns/pct_change)');
	const asInp = makeTextInput(t.as, 'output column');
	const emit = (): void => {
		const fn = fnSel.value as MathTransform['fn'];
		const usesPeriods = fn === 'log_returns' || fn === 'pct_change';
		const periods = usesPeriods ? parseInt(periodsInp.value, 10) || undefined : undefined;
		onUpdate({
			kind: 'math',
			column: colSel.value,
			fn,
			...(periods !== undefined ? { periods } : {}),
			as: asInp.value,
		});
		periodsInp.style.display = usesPeriods ? '' : 'none';
	};
	colSel.addEventListener('change', emit);
	fnSel.addEventListener('change', emit);
	periodsInp.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Fn', fnSel));
	root.appendChild(row('Periods', periodsInp));
	root.appendChild(row('As', asInp));
	if (t.fn !== 'log_returns' && t.fn !== 'pct_change') {
		periodsInp.style.display = 'none';
	}
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// tz_convert
// ---------------------------------------------------------------------------

const tzConvertForm: TransformFormFactory<TzConvertTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--tz-convert';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const tzInp = makeTextInput(t.to_tz, 'e.g. America/New_York');
	const asInp = makeTextInput(t.as, 'output column (optional)');
	const emit = (): void => {
		onUpdate({
			kind: 'tz_convert',
			column: colSel.value,
			to_tz: tzInp.value,
			...(asInp.value.length > 0 ? { as: asInp.value } : {}),
		});
	};
	colSel.addEventListener('change', emit);
	tzInp.addEventListener('blur', emit);
	tzInp.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('To TZ', tzInp));
	root.appendChild(row('As', asInp));
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

const sortForm: TransformFormFactory<SortTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--sort';
	const list = document.createElement('div');
	list.className = 'qviz-form-sort-cols';
	root.appendChild(list);

	const cols = t.columns.length > 0
		? t.columns.map(c => ({ column: c.column, desc: c.desc ?? false }))
		: [{ column: '', desc: false }];

	const emit = (): void => {
		onUpdate({
			kind: 'sort',
			columns: cols.map(c => ({
				column: c.column,
				...(c.desc ? { desc: true } : {}),
			})),
		});
	};

	const render = (): void => {
		list.innerHTML = '';
		cols.forEach((c, i) => {
			const r = document.createElement('div');
			r.className = 'qviz-form-sort-row';
			const colSel = makeColumnSelect(ctx.columns, c.column, {
				allowProduced: ctx.availableProducedNames,
			});
			const dirSel = makeSelect(
				[{ value: 'asc', label: 'asc ↑' }, { value: 'desc', label: 'desc ↓' }],
				c.desc ? 'desc' : 'asc',
			);
			const rm = document.createElement('button');
			rm.type = 'button';
			rm.className = 'qviz-form-remove';
			rm.textContent = '×';
			colSel.addEventListener('change', () => { cols[i] = { ...cols[i], column: colSel.value }; emit(); });
			dirSel.addEventListener('change', () => { cols[i] = { ...cols[i], desc: dirSel.value === 'desc' }; emit(); });
			rm.addEventListener('click', () => {
				if (cols.length === 1) { return; }
				cols.splice(i, 1);
				render();
				emit();
			});
			r.appendChild(colSel);
			r.appendChild(dirSel);
			r.appendChild(rm);
			list.appendChild(r);
		});
	};
	render();

	const addBtn = document.createElement('button');
	addBtn.type = 'button';
	addBtn.className = 'qviz-form-add';
	addBtn.textContent = '+ Add sort key';
	addBtn.addEventListener('click', () => {
		cols.push({ column: '', desc: false });
		render();
		emit();
	});
	root.appendChild(addBtn);
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

const limitForm: TransformFormFactory<LimitTransform> = (t, _ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--limit';
	const nInp = makeNumberInput(t.n, 'rows');
	const offInp = makeNumberInput(t.offset, 'offset (optional)');
	const emit = (): void => {
		const n = parseInt(nInp.value, 10);
		const off = offInp.value.length > 0 ? parseInt(offInp.value, 10) : undefined;
		onUpdate({
			kind: 'limit',
			n: Number.isFinite(n) && n > 0 ? n : 100,
			...(off !== undefined && Number.isFinite(off) ? { offset: off } : {}),
		});
	};
	nInp.addEventListener('change', emit);
	offInp.addEventListener('change', emit);
	root.appendChild(row('N', nInp));
	root.appendChild(row('Offset', offInp));
	return { root, dispose: () => { /* */ } };
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const FORM_BY_KIND: { [K in TransformKind]: TransformFormFactory<Extract<Transform, { kind: K }>> } = {
	filter: filterForm,
	date_trunc: dateTruncForm,
	bin: binForm,
	groupby: groupByForm,
	aggregate: aggregateForm,
	window: windowForm,
	math: mathForm,
	tz_convert: tzConvertForm,
	sort: sortForm,
	limit: limitForm,
	// `resample` is in the Transform union but rejected by the
	// validator (Step C cleanup). No form factory; the menu doesn't
	// offer it. Listed here so TS knows the registry is exhaustive.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	resample: (() => {
		throw new Error("'resample' is not yet implemented; menu must not offer it.");
	}) as unknown as TransformFormFactory<Extract<Transform, { kind: 'resample' }>>,
};

/** Build a default (empty) transform of the given kind for "Add" menu. */
export function defaultTransformOfKind(kind: TransformKind): Transform {
	switch (kind) {
		case 'filter': return { kind: 'filter', column: '', op: '==', value: '' };
		case 'date_trunc': return { kind: 'date_trunc', column: '', unit: 'day', as: 'day' };
		case 'bin': return { kind: 'bin', column: '', n_bins: 10, as: 'bin', strategy: 'equal_width' };
		case 'groupby': return { kind: 'groupby', columns: [] };
		case 'aggregate': return { kind: 'aggregate', aggs: [{ column: '', fn: 'count', as: 'count' }] };
		case 'window': return { kind: 'window', column: '', fn: 'rolling_mean', window: 5, as: 'roll' };
		case 'math': return { kind: 'math', column: '', fn: 'log_returns', as: 'r' };
		case 'tz_convert': return { kind: 'tz_convert', column: '', to_tz: 'UTC' };
		case 'sort': return { kind: 'sort', columns: [{ column: '' }] };
		case 'limit': return { kind: 'limit', n: 100 };
		case 'resample':
			throw new Error("'resample' is not yet implemented (validator rejects).");
	}
}

/** Short, human-readable summary used in collapsed transform cards. */
export function summarizeTransform(t: Transform): string {
	switch (t.kind) {
		case 'filter': {
			if (t.op === 'is_null' || t.op === 'not_null') {
				return `${t.column} ${t.op}`;
			}
			return `${t.column} ${t.op} ${JSON.stringify(t.value)}`;
		}
		case 'date_trunc': return `${t.column} → ${t.unit} (as ${t.as})`;
		case 'bin': return `${t.column} → ${t.n_bins} bins (as ${t.as})`;
		case 'groupby': return `by ${t.columns.join(', ') || '(none)'}`;
		case 'aggregate':
			return t.aggs.map(a => `${a.fn}(${a.column}) as ${a.as}`).join(', ');
		case 'window':
			return `${t.fn}(${t.column}${t.window ? `, n=${t.window}` : ''}) as ${t.as}`;
		case 'math': return `${t.fn}(${t.column}${t.periods ? `, p=${t.periods}` : ''}) as ${t.as}`;
		case 'tz_convert': return `${t.column} → ${t.to_tz}${t.as ? ` as ${t.as}` : ''}`;
		case 'sort': return t.columns.map(c => `${c.column}${c.desc ? ' ↓' : ' ↑'}`).join(', ');
		case 'limit': return `n=${t.n}${t.offset ? `, offset=${t.offset}` : ''}`;
		case 'resample': return '(unsupported)';
	}
}
