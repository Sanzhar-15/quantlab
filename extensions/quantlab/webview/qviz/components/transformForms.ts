/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * Per-transform form factories -- Phase 5 step 5.G.3.
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
	ExprTransform, FilterTransform, GroupByTransform, LimitTransform,
	MathTransform, SortTransform, Transform, TzConvertTransform, WindowTransform,
} from '../../../src/qviz/spec';
import type { SchemaColumn } from '../../../src/qviz/messageProtocol';
import { printColName, printExpr } from '../../../src/qviz/exprAst';
import { parseExpression } from '../../../src/qviz/exprParser';

export type TransformKind = Transform['kind'];

export interface TransformFormContext {
	readonly columns: readonly SchemaColumn[];
	readonly availableProducedNames: readonly string[];
}

export interface TransformFormHandle {
	readonly root: HTMLElement;
	dispose(): void;
	/** Optional in-place state refresh. When the spec changes due to
	 *  this card's own dispatch (or an upstream transform changing the
	 *  available-columns set), the host calls `update(t, ctx)` instead
	 *  of disposing + re-mounting. Forms that don't implement this fall
	 *  back to the dispose-and-remount path. (M7 megaudit fix.) */
	update?(t: Transform, ctx: TransformFormContext): void;
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
		// Empty option so the user can clear the selection -- the form
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
// window (without ema -- gated by validator at Step C cleanup)
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
	// Megaudit Theme A (A1, 2026-05-13): order_by required for all
	// window fns. Column picker mirrors `column` selector.
	const orderSel = makeColumnSelect(ctx.columns, t.order_by, { allowProduced: ctx.availableProducedNames });
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
			order_by: orderSel.value,
			as: asInp.value,
		});
		winInp.style.display = requiresWindow ? '' : 'none';
	};
	colSel.addEventListener('change', emit);
	fnSel.addEventListener('change', emit);
	winInp.addEventListener('change', emit);
	orderSel.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Fn', fnSel));
	root.appendChild(row('Window', winInp));
	root.appendChild(row('Order by', orderSel));
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

// Megaudit Theme A (A2, 2026-05-13): these three math fns emit window
// SQL and require `order_by`. Others are row-local.
const MATH_FNS_ORDER_REQUIRED = new Set(['log_returns', 'pct_change', 'drawdown']);

const mathForm: TransformFormFactory<MathTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--math';
	const colSel = makeColumnSelect(ctx.columns, t.column);
	const fnSel = makeSelect(MATH_FNS, t.fn);
	const periodsInp = makeNumberInput(t.periods, 'periods (log_returns/pct_change)');
	const orderSel = makeColumnSelect(ctx.columns, t.order_by ?? '',
		{ allowProduced: ctx.availableProducedNames });
	const asInp = makeTextInput(t.as, 'output column');
	const emit = (): void => {
		const fn = fnSel.value as MathTransform['fn'];
		const usesPeriods = fn === 'log_returns' || fn === 'pct_change';
		const usesOrderBy = MATH_FNS_ORDER_REQUIRED.has(fn);
		const periods = usesPeriods ? parseInt(periodsInp.value, 10) || undefined : undefined;
		onUpdate({
			kind: 'math',
			column: colSel.value,
			fn,
			...(periods !== undefined ? { periods } : {}),
			...(usesOrderBy ? { order_by: orderSel.value } : {}),
			as: asInp.value,
		});
		periodsInp.style.display = usesPeriods ? '' : 'none';
		orderSel.style.display = usesOrderBy ? '' : 'none';
	};
	colSel.addEventListener('change', emit);
	fnSel.addEventListener('change', emit);
	periodsInp.addEventListener('change', emit);
	orderSel.addEventListener('change', emit);
	asInp.addEventListener('blur', emit);
	asInp.addEventListener('change', emit);
	root.appendChild(row('Column', colSel));
	root.appendChild(row('Fn', fnSel));
	root.appendChild(row('Periods', periodsInp));
	root.appendChild(row('Order by', orderSel));
	root.appendChild(row('As', asInp));
	if (t.fn !== 'log_returns' && t.fn !== 'pct_change') {
		periodsInp.style.display = 'none';
	}
	if (!MATH_FNS_ORDER_REQUIRED.has(t.fn)) {
		orderSel.style.display = 'none';
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
// expr (Visualise v2 calculated field)
// ---------------------------------------------------------------------------

const exprForm: TransformFormFactory<ExprTransform> = (t, ctx, onUpdate) => {
	const root = document.createElement('div');
	root.className = 'qviz-form qviz-form--expr';

	const textarea = document.createElement('textarea');
	textarea.className = 'qviz-form-input qviz-form-expr-textarea';
	textarea.rows = 4;
	textarea.spellcheck = false;
	textarea.value = printExpr(t.expression);
	textarea.placeholder = "e.g. (close - open) / open  --  or  if (vol > 0.3) then 1 else 0";

	const asInp = makeTextInput(t.as, 'output column');

	// Hint chip row: available column names so the user can see what to
	// type. Each chip shows the column's dtype so the user can pick
	// numeric vs. string targets at a glance.
	const hintRow = document.createElement('div');
	hintRow.className = 'qviz-form-expr-hints';
	const hintLabel = document.createElement('span');
	hintLabel.className = 'qviz-form-expr-hint-label';
	hintLabel.textContent = 'Columns: ';
	hintRow.appendChild(hintLabel);
	const sourceChips = ctx.columns.map(c => ({ name: c.name, dtype: c.dtype }));
	const producedChips = ctx.availableProducedNames.map(n => ({ name: n, dtype: 'produced' }));
	for (const { name, dtype } of [...sourceChips, ...producedChips]) {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'qviz-form-expr-hint-chip';
		chip.textContent = name;
		chip.title = `${name}: ${dtype} -- click to insert at the cursor`;
		const tag = document.createElement('span');
		tag.className = 'qviz-form-expr-hint-chip-dtype';
		tag.textContent = dtype;
		chip.appendChild(tag);
		chip.addEventListener('click', () => {
			// Codex audit LOW (2026-05-12): route the column name
			// through `printColName` so names that aren't bare
			// identifiers (`mid price`, `if`, `null`, `weird``name`)
			// emit as the backtick-quoted form that actually parses.
			// Naive `before + name + after` would insert raw text that
			// the parser rejects.
			const inserted = printColName(name);
			const before = textarea.value.slice(0, textarea.selectionStart);
			const after = textarea.value.slice(textarea.selectionEnd);
			textarea.value = before + inserted + after;
			const caret = before.length + inserted.length;
			textarea.selectionStart = textarea.selectionEnd = caret;
			textarea.focus();
			schedulePreview();
			// Manual chip-insert is a "commit" action: dispatch so the
			// chart re-renders with the new column reference. We can do
			// this because the chip-insert doesn't disrupt the user's
			// in-flight typing -- they explicitly clicked.
			commitExpr();
		});
		hintRow.appendChild(chip);
	}

	const errBox = document.createElement('div');
	errBox.className = 'qviz-form-expr-error';
	errBox.hidden = true;

	// M8: surface `as` collision against schema + upstream-produced
	// columns inline, BEFORE the user hits compile and gets a daemon
	// error. The pool is computed once at mount; chips/columns are a
	// snapshot — same lifecycle pattern as the rest of the form.
	const reservedNames = new Set<string>([
		...ctx.columns.map(c => c.name),
		...ctx.availableProducedNames,
	]);
	const asErr = document.createElement('div');
	asErr.className = 'qviz-form-expr-error';
	asErr.hidden = true;
	const validateAs = (): boolean => {
		const name = asInp.value;
		if (name.length === 0) {
			asInp.classList.add('qviz-form-expr-textarea--invalid');
			asErr.hidden = false;
			asErr.textContent = 'Output column name is required.';
			return false;
		}
		if (reservedNames.has(name)) {
			asInp.classList.add('qviz-form-expr-textarea--invalid');
			asErr.hidden = false;
			asErr.textContent = `'${name}' is already a column in the pipeline -- pick a different name.`;
			return false;
		}
		asInp.classList.remove('qviz-form-expr-textarea--invalid');
		asErr.hidden = true;
		asErr.textContent = '';
		return true;
	};

	// Two-phase update model:
	//
	//   - `previewParse` runs on every `input` event (debounced). Updates
	//     the inline error UI ONLY. Does NOT dispatch.
	//   - `dispatchIfValid` runs on `change` (textarea blur) or Ctrl+Enter.
	//     Re-parses the current text and dispatches if valid.
	//
	// Why split: dispatching on every keystroke causes `renderCards` to
	// rebuild the form (since the spec hash changed), which destroys the
	// textarea + cursor + any in-flight unparseable text. By holding
	// dispatch until the user is "done" (blur or explicit commit), the
	// in-flight typing experience is preserved.
	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	const schedulePreview = (): void => {
		if (previewTimer !== null) { clearTimeout(previewTimer); }
		previewTimer = setTimeout(previewParse, 120);
	};
	const previewParse = (): void => {
		previewTimer = null;
		const r = parseExpression(textarea.value);
		if (!r.ok) {
			textarea.classList.add('qviz-form-expr-textarea--invalid');
			errBox.hidden = false;
			errBox.textContent = `Parse error at position ${r.position}: ${r.error}`;
			return;
		}
		textarea.classList.remove('qviz-form-expr-textarea--invalid');
		errBox.hidden = true;
		errBox.textContent = '';
	};
	// Last-valid AST tracked in the form's own closure: when the user
	// edits the `as` field with an in-flight unparseable expression, we
	// still commit the `as` change by carrying the previous AST forward.
	// `t.expression` is the spec's source of truth; we shadow it so we
	// can ALSO commit through unparseable interludes.
	let lastValidAst: ExprTransform['expression'] = t.expression;
	let lastValidRefs: readonly string[] = t.references;

	// `commitExpr`: invoked from textarea events. Dispatches ONLY when
	// the textarea parses successfully — otherwise we'd reset the
	// textarea to a canonical form on the next renderCards() pass and
	// destroy the user's in-flight typing.
	const commitExpr = (): void => {
		if (previewTimer !== null) { clearTimeout(previewTimer); previewTimer = null; }
		const r = parseExpression(textarea.value);
		if (!r.ok) {
			textarea.classList.add('qviz-form-expr-textarea--invalid');
			errBox.hidden = false;
			errBox.textContent = `Parse error at position ${r.position}: ${r.error}`;
			return;
		}
		textarea.classList.remove('qviz-form-expr-textarea--invalid');
		errBox.hidden = true;
		errBox.textContent = '';
		lastValidAst = r.ast;
		lastValidRefs = r.references;
		if (!validateAs()) { return; }
		onUpdate({
			kind: 'expr',
			as: asInp.value,
			expression: lastValidAst,
			references: lastValidRefs,
		});
	};

	// `commitAs`: invoked from `as` input events. Always dispatches with
	// the LAST-VALID AST so the user's `as` edit isn't lost when the
	// expression textarea happens to be mid-edit (M2 megaudit fix).
	const commitAs = (): void => {
		if (!validateAs()) { return; }
		onUpdate({
			kind: 'expr',
			as: asInp.value,
			expression: lastValidAst,
			references: lastValidRefs,
		});
	};

	textarea.addEventListener('input', schedulePreview);
	textarea.addEventListener('change', commitExpr);
	textarea.addEventListener('keydown', (e: KeyboardEvent) => {
		// Cmd+Enter / Ctrl+Enter commits without leaving the field --
		// matches the convention in chat boxes, editor command palettes,
		// etc. for "send/apply now".
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			commitExpr();
		}
	});
	asInp.addEventListener('input', validateAs);
	asInp.addEventListener('change', commitAs);
	asInp.addEventListener('blur', commitAs);

	root.appendChild(row('Expression', textarea));
	root.appendChild(hintRow);
	root.appendChild(errBox);
	root.appendChild(row('As', asInp));
	root.appendChild(asErr);

	return {
		root,
		dispose: () => {
			if (previewTimer !== null) {
				clearTimeout(previewTimer);
				previewTimer = null;
			}
		},
		// M7 (megaudit): in-place refresh. When the spec or upstream
		// produced-names change, the host calls update() rather than
		// disposing + re-mounting. This preserves:
		//   - the textarea's text + caret position (in-flight typing)
		//   - which element has focus
		//   - the user's selection
		// We only mutate what's diverged from the previous render: the
		// `as` input value if the spec carries a new `as`, and the chip
		// row if upstream columns changed.
		update: (nextT: Transform, nextCtx: TransformFormContext) => {
			if (nextT.kind !== 'expr') { return; }  // type guard for the union
			lastValidAst = nextT.expression;
			lastValidRefs = nextT.references;
			// Only overwrite the `as` input if (a) the user isn't
			// currently editing it AND (b) the spec's `as` differs from
			// what's shown. Without the focus check, an in-flight
			// `as` edit would be clobbered by our own dispatch.
			if (document.activeElement !== asInp && asInp.value !== nextT.as) {
				asInp.value = nextT.as;
			}
			// Refresh the reserved-names set for collision detection.
			reservedNames.clear();
			for (const c of nextCtx.columns) { reservedNames.add(c.name); }
			for (const n of nextCtx.availableProducedNames) { reservedNames.add(n); }
			// Rebuild the hint chip row in-place. The textarea is NOT
			// touched.
			while (hintRow.childNodes.length > 1) {
				hintRow.removeChild(hintRow.lastChild!);
			}
			for (const { name, dtype } of [
				...nextCtx.columns.map(c => ({ name: c.name, dtype: c.dtype })),
				...nextCtx.availableProducedNames.map(n => ({ name: n, dtype: 'produced' })),
			]) {
				const chip = document.createElement('button');
				chip.type = 'button';
				chip.className = 'qviz-form-expr-hint-chip';
				chip.textContent = name;
				chip.title = `${name}: ${dtype} -- click to insert at the cursor`;
				const tag = document.createElement('span');
				tag.className = 'qviz-form-expr-hint-chip-dtype';
				tag.textContent = dtype;
				chip.appendChild(tag);
				chip.addEventListener('click', () => {
					// Same printColName routing as the mount path.
					const inserted = printColName(name);
					const before = textarea.value.slice(0, textarea.selectionStart);
					const after = textarea.value.slice(textarea.selectionEnd);
					textarea.value = before + inserted + after;
					const caret = before.length + inserted.length;
					textarea.selectionStart = textarea.selectionEnd = caret;
					textarea.focus();
					schedulePreview();
					commitExpr();
				});
				hintRow.appendChild(chip);
			}
		},
	};
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
	resample: (() => {
		throw new Error("'resample' is not yet implemented; menu must not offer it.");
	}) as unknown as TransformFormFactory<Extract<Transform, { kind: 'resample' }>>,
	expr: exprForm,
};

/** Build a default (empty) transform of the given kind for "Add" menu.
 *
 *  `reservedNames` is the set of column names already in use (source
 *  schema + already-produced names). For kinds that produce a new
 *  column, the default `as` is uniquified against this set so two quick
 *  "+ Add transform → expr" clicks don't both default to `'new_col'`.
 *  Pass an empty set if you don't have it; callers in the transformList
 *  always pass the live snapshot. (L4 megaudit fix.) */
export function defaultTransformOfKind(
	kind: TransformKind,
	reservedNames: ReadonlySet<string> = new Set(),
): Transform {
	const uniqueName = (base: string): string => {
		if (!reservedNames.has(base)) { return base; }
		for (let i = 2; i < 1000; i += 1) {
			const candidate = `${base}${i}`;
			if (!reservedNames.has(candidate)) { return candidate; }
		}
		return `${base}_${Date.now()}`;
	};
	switch (kind) {
		case 'filter': return { kind: 'filter', column: '', op: '==', value: '' };
		case 'date_trunc': return { kind: 'date_trunc', column: '', unit: 'day', as: uniqueName('day') };
		case 'bin': return { kind: 'bin', column: '', n_bins: 10, as: uniqueName('bin'), strategy: 'equal_width' };
		case 'groupby': return { kind: 'groupby', columns: [] };
		case 'aggregate': return { kind: 'aggregate', aggs: [{ column: '', fn: 'count', as: uniqueName('count') }] };
		case 'window': return { kind: 'window', column: '', fn: 'rolling_mean', window: 5, order_by: '', as: uniqueName('roll') };
		case 'math': return { kind: 'math', column: '', fn: 'log_returns', order_by: '', as: uniqueName('r') };
		case 'tz_convert': return { kind: 'tz_convert', column: '', to_tz: 'UTC' };
		case 'sort': return { kind: 'sort', columns: [{ column: '' }] };
		case 'limit': return { kind: 'limit', n: 100 };
		case 'resample':
			throw new Error("'resample' is not yet implemented (validator rejects).");
		case 'expr':
			// Default: a constant `0` so the form parses immediately. The
			// user replaces the textarea contents with their expression
			// and fills in `as`. L4: `new_col` is uniquified so back-to-
			// back "+ Add transform → expr" doesn't collide.
			return {
				kind: 'expr',
				as: uniqueName('new_col'),
				expression: { kind: 'num', value: 0 },
				references: [],
			};
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
		case 'expr': {
			const printed = printExpr(t.expression);
			const truncated = printed.length > 48 ? printed.slice(0, 45) + '…' : printed;
			return `${truncated} as ${t.as}`;
		}
	}
}
