/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * TransformList -- Phase 5 steps 5.G.2 + 5.G.4 + 5.G.5.
 *
 * Renders the ordered transform pipeline as a list of cards. Each card
 * has a header (kind + summary + move/edit/delete buttons) and an
 * expandable form (the per-kind factory from `transformForms.ts`).
 *
 * Add menu (5.G.2): driven by `runtime.capabilities.transformKinds` so
 * unsupported variants are never offered. Falls back to a static union
 * if capabilities haven't loaded yet (better UX than blocking on the
 * daemon for the menu).
 *
 * Pipeline validation (5.G.4): each card's header gets an inline error
 * marker when the transform breaks compile-time constraints. Currently
 * checked: groupby must be followed by aggregate (mirror of
 * `compiler.py` finalization rule).
 *
 * Histogram preset (5.G.5): when `chart.type === 'histogram'` and the
 * pipeline doesn't already contain bin+groupby+aggregate(count), a
 * one-click button at the top inserts that pipeline pre-built against
 * the current x encoding's column.
 */

import type { QvizStore } from '../state/store';
import type {
	BinTransform, GroupByTransform, AggregateTransform,
	Transform, TransformKind,
} from '../../../src/qviz/spec';
import { validatePipeline } from '../../../src/qviz/pipelineValidate';
import {
	FORM_BY_KIND, defaultTransformOfKind, summarizeTransform,
	type TransformFormHandle,
} from './transformForms';

/** All transform kinds known to the spec format. The Add menu is
 *  filtered against `runtime.capabilities.transformKinds`; this list
 *  is the upper bound.
 *  `resample` excluded -- Step C cleanup gates it in the validator. */
const ALL_KINDS: readonly TransformKind[] = [
	'filter', 'date_trunc', 'bin', 'groupby', 'aggregate',
	'window', 'math', 'tz_convert', 'sort', 'limit', 'expr',
];

export function mountTransformList(root: HTMLElement, store: QvizStore): { dispose(): void } {
	root.classList.add('qviz-transform-list');
	root.innerHTML = `
		<div class="qviz-transform-header">
			<h2 class="qviz-transform-title">Transforms</h2>
			<div class="qviz-transform-add-wrap">
				<button type="button" class="qviz-transform-add-btn">+ Add transform</button>
			</div>
		</div>
		<div class="qviz-histogram-preset" hidden></div>
		<ol class="qviz-transform-cards"></ol>
	`;
	const addBtn = root.querySelector<HTMLButtonElement>('.qviz-transform-add-btn')!;
	const presetSlot = root.querySelector<HTMLElement>('.qviz-histogram-preset')!;
	const cardsList = root.querySelector<HTMLOListElement>('.qviz-transform-cards')!;

	let openMenu: HTMLElement | null = null;
	const closeMenu = (): void => { if (openMenu !== null) { openMenu.remove(); openMenu = null; } };

	addBtn.addEventListener('click', () => {
		closeMenu();
		const state = store.getState();
		const allowed = new Set(state.runtime.capabilities?.transformKinds ?? ALL_KINDS);
		const menu = document.createElement('div');
		menu.className = 'qviz-add-menu';
		menu.setAttribute('role', 'menu');
		for (const kind of ALL_KINDS) {
			const supported = allowed.has(kind);
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'qviz-add-menu-item';
			btn.textContent = kind;
			btn.disabled = !supported;
			if (!supported) {
				btn.title = `${kind} is not in the daemon's reported capabilities.`;
			}
			btn.addEventListener('click', () => {
				closeMenu();
				// L4 (megaudit): the default `as` for kinds that produce
				// a column is uniquified against the names already in
				// use, so back-to-back `+ Add` for the same kind doesn't
				// collide.
				const reserved = new Set<string>([
					...(state.schema.info?.columns ?? []).map(c => c.name),
				]);
				const producedSoFar: string[] = [];
				for (const t of (state.spec.current?.transforms ?? [])) {
					collectProducedNames(t, producedSoFar);
				}
				for (const n of producedSoFar) { reserved.add(n); }
				const newT = defaultTransformOfKind(kind, reserved);
				const next = state.spec.current?.transforms.length ?? 0;
				store.dispatch({ type: 'upsertTransform', index: next, transform: newT });
				// Auto-open the editor on the new transform.
				store.dispatch({ type: 'openTransformEditor', index: next });
			});
			menu.appendChild(btn);
		}
		const rect = addBtn.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		document.body.appendChild(menu);
		openMenu = menu;
	});

	const onClickOutside = (e: MouseEvent): void => {
		if (openMenu !== null && !openMenu.contains(e.target as Node) && e.target !== addBtn) {
			closeMenu();
		}
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') { closeMenu(); }
	};
	document.addEventListener('click', onClickOutside, true);
	document.addEventListener('keydown', onKey);

	// Histogram preset (5.G.5).
	const presetButton = document.createElement('button');
	presetButton.type = 'button';
	presetButton.className = 'qviz-histogram-preset-btn';
	presetButton.textContent = 'Set up histogram pipeline (bin → groupby → count)';
	presetButton.addEventListener('click', () => {
		applyHistogramPreset(store);
	});
	presetSlot.appendChild(presetButton);

	// Per-card form handles, keyed by index. Forms are leaked between
	// renders if not disposed; the card-list rebuild below disposes
	// them all and remounts. We also track the transform kind the
	// handle was built for, so M7's preserve-across-render path can
	// detect when the kind changed and force a remount.
	type HandleEntry = { handle: TransformFormHandle; kind: TransformKind };
	const formHandles = new Map<number, HandleEntry>();

	const disposeForms = (): void => {
		for (const entry of formHandles.values()) {
			try { entry.handle.dispose(); } catch (e) {
				// Megaudit M-13: don't silently swallow. CLAUDE.md
				// system-boundary exception: cleanup-loop errors log
				// individually but must NOT abort the loop.
				console.warn('qviz transformList: form dispose threw:', e);
			}
		}
		formHandles.clear();
	};

	let lastSpecHash: string | null = null;
	let lastSchemaHash: string | null = null;
	let lastEditingIndex: number | null = null;
	let lastChartType: string | null = null;
	let lastCapabilitiesHash: string | null = null;
	const renderCards = (): void => {
		const state = store.getState();
		const transforms = state.spec.current?.transforms ?? [];
		const editingIndex = state.ui.editingTransformIndex;

		// Histogram preset visibility.
		const chartType = state.spec.current?.chart.type ?? null;
		const showPreset = chartType === 'histogram' && !pipelineHasHistogramShape(transforms);
		presetSlot.hidden = !showPreset;

		// Skip rebuild if nothing structural changed.
		const specHash = state.spec.currentHash;
		const schemaHash = state.schema.info?.schema_hash ?? null;
		const capHash = state.runtime.capabilities
			? state.runtime.capabilities.transformKinds.join(',')
			: null;
		if (
			specHash === lastSpecHash
			&& schemaHash === lastSchemaHash
			&& editingIndex === lastEditingIndex
			&& chartType === lastChartType
			&& capHash === lastCapabilitiesHash
		) { return; }
		lastSpecHash = specHash;
		lastSchemaHash = schemaHash;
		lastEditingIndex = editingIndex;
		lastChartType = chartType;
		lastCapabilitiesHash = capHash;

		// M7 (megaudit): preserve the editing card's form handle across
		// renders when it supports in-place update() AND the kind hasn't
		// changed. This keeps the textarea / focus / cursor stable when
		// the user is mid-typing in (e.g.) an expr form. Forms without
		// update() get the legacy dispose-and-remount path.
		const preserveIdx = editingIndex;
		const preservedEntry = preserveIdx !== null
			? formHandles.get(preserveIdx) ?? null
			: null;
		const newKindAtPreserveIdx = preserveIdx !== null && transforms[preserveIdx]
			? transforms[preserveIdx].kind : null;
		const canPreserve = preservedEntry !== null
			&& typeof preservedEntry.handle.update === 'function'
			&& preservedEntry.kind === newKindAtPreserveIdx;

		// Dispose every handle EXCEPT the preserved one.
		for (const [idx, entry] of formHandles.entries()) {
			if (canPreserve && idx === preserveIdx) { continue; }
			try { entry.handle.dispose(); } catch (e) {
				console.warn('qviz transformList: form dispose threw:', e);
			}
			formHandles.delete(idx);
		}
		cardsList.innerHTML = '';

		const pipelineErrors = validatePipeline(transforms);
		const producedNames: string[] = [];

		transforms.forEach((t, i) => {
			const card = document.createElement('li');
			card.className = 'qviz-transform-card';
			if (pipelineErrors[i]) {
				card.classList.add('qviz-transform-card--error');
			}

			const header = document.createElement('div');
			header.className = 'qviz-transform-card-header';
			const kindLabel = document.createElement('span');
			kindLabel.className = 'qviz-transform-kind';
			kindLabel.textContent = t.kind;
			const summary = document.createElement('span');
			summary.className = 'qviz-transform-summary';
			summary.textContent = summarizeTransform(t);

			const editBtn = makeIconButton(editingIndex === i ? '−' : '✎', 'Edit', () => {
				store.dispatch({
					type: 'openTransformEditor',
					index: editingIndex === i ? null : i,
				});
			});
			const upBtn = makeIconButton('▲', 'Move up', () => {
				if (i > 0) { store.dispatch({ type: 'moveTransform', fromIndex: i, toIndex: i - 1 }); }
			});
			upBtn.disabled = i === 0;
			const downBtn = makeIconButton('▼', 'Move down', () => {
				if (i < transforms.length - 1) {
					store.dispatch({ type: 'moveTransform', fromIndex: i, toIndex: i + 1 });
				}
			});
			downBtn.disabled = i === transforms.length - 1;
			const delBtn = makeIconButton('×', 'Delete', () => {
				store.dispatch({ type: 'deleteTransform', index: i });
			});
			delBtn.classList.add('qviz-transform-delete');

			header.appendChild(kindLabel);
			header.appendChild(summary);
			header.appendChild(upBtn);
			header.appendChild(downBtn);
			header.appendChild(editBtn);
			header.appendChild(delBtn);
			card.appendChild(header);

			if (pipelineErrors[i]) {
				const err = document.createElement('div');
				err.className = 'qviz-transform-card-error';
				err.textContent = pipelineErrors[i];
				err.setAttribute('role', 'alert');
				card.appendChild(err);
			}

			if (editingIndex === i) {
				const formContainer = document.createElement('div');
				formContainer.className = 'qviz-transform-card-form';
				const formCtx = {
					columns: state.schema.info?.columns ?? [],
					availableProducedNames: [...producedNames],
				};
				// M7: reuse the preserved handle if it's still valid.
				if (canPreserve && preservedEntry !== null && preserveIdx === i) {
					formContainer.appendChild(preservedEntry.handle.root);
					card.appendChild(formContainer);
					formHandles.set(i, preservedEntry);
					// In-place state refresh: textarea, focus, cursor preserved.
					preservedEntry.handle.update?.(t, formCtx);
				} else {
					// Type erasure here is unavoidable (factories are
					// per-kind); the card's `t` matches the registry.
					const factory = FORM_BY_KIND[t.kind] as (
						t: Transform,
						ctx: {
							columns: ReadonlyArray<{ name: string; dtype: string; nullable: boolean }>;
							availableProducedNames: readonly string[];
						},
						on: (n: Transform) => void,
					) => TransformFormHandle;
					const handle = factory(t, formCtx, (next) => {
						store.dispatch({ type: 'upsertTransform', index: i, transform: next });
					});
					formContainer.appendChild(handle.root);
					card.appendChild(formContainer);
					formHandles.set(i, { handle, kind: t.kind });
				}
			}

			cardsList.appendChild(card);

			// Track produced names so downstream forms can offer them
			// in column-select dropdowns.
			collectProducedNames(t, producedNames);
		});

		if (transforms.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'qviz-transform-empty';
			empty.textContent = 'No transforms. Use "+ Add transform" to start a pipeline.';
			cardsList.appendChild(empty);
		}
	};

	const off = store.subscribe(renderCards);
	renderCards();

	return {
		dispose: () => {
			off();
			closeMenu();
			document.removeEventListener('click', onClickOutside, true);
			document.removeEventListener('keydown', onKey);
			disposeForms();
			root.innerHTML = '';
			root.classList.remove('qviz-transform-list');
		},
	};
}

// ---------------------------------------------------------------------------
// Histogram preset (5.G.5)
// ---------------------------------------------------------------------------

function pipelineHasHistogramShape(transforms: readonly Transform[]): boolean {
	// Heuristic: the pipeline contains at least one bin + groupby +
	// aggregate(count). We don't enforce strict ordering -- the user
	// may have other transforms interleaved; the preset only fires if
	// none of these are present.
	const hasBin = transforms.some(t => t.kind === 'bin');
	const hasGroup = transforms.some(t => t.kind === 'groupby');
	const hasCount = transforms.some(
		t => t.kind === 'aggregate' && t.aggs.some(a => a.fn === 'count'),
	);
	return hasBin && hasGroup && hasCount;
}

function applyHistogramPreset(store: QvizStore): void {
	const state = store.getState();
	const spec = state.spec.current;
	if (spec === null) { return; }
	// Megaudit M-21: use the x encoding's column as bin source; if no
	// x set, pick the first quantitative schema column. REFUSE to
	// build the preset when neither is available -- substituting
	// literal `'value'` / `'*'` produces an invalid spec the daemon
	// rejects with a confusing error. Tell the user to pick a column
	// first via an alert (we don't have a notification UI in the
	// builder webview; alert is the cheapest visible feedback).
	let binColumn = spec.chart.encodings.x?.field ?? '';
	if (binColumn.length === 0) {
		const numCol = state.schema.info?.columns.find(
			c => c.dtype.startsWith('int') || c.dtype.startsWith('float')
				|| c.dtype.startsWith('uint'),
		);
		binColumn = numCol?.name ?? '';
	}
	if (binColumn.length === 0) {
		// Megaudit Theme D (D15, 2026-05-13): console + announcer
		// instead of alert(). alert() is a blocking modal that doesn't
		// theme with VS Code and breaks SR users.
		const msg = 'Histogram preset needs a column. Assign a numeric column to X first, '
			+ 'or open a dataset that has numeric columns.';
		console.warn('[qviz histogram preset] ' + msg);
		// Megaudit D3 (2026-05-13): a local preset failure is a UI-side
		// protocol error from the inspector's perspective (not a daemon
		// response). Tag as 'protocol' so it's classified as terminal
		// (no Retry button) and surfaced consistently in the placeholder.
		store.dispatch({ type: 'inspectorError', error: msg, errorKind: 'protocol' });
		return;
	}
	// Megaudit M-8: gate on capabilities. If the daemon doesn't
	// support all three required transforms, refuse rather than
	// build an unsupported pipeline.
	const caps = state.runtime.capabilities;
	if (caps !== null) {
		const required = ['bin', 'groupby', 'aggregate'];
		const missing = required.filter(k => !caps.transformKinds.includes(k));
		if (missing.length > 0) {
			const msg = `Histogram preset needs daemon support for: ${missing.join(', ')}.`;
			console.warn('[qviz histogram preset] ' + msg);
			store.dispatch({ type: 'inspectorError', error: msg, errorKind: 'protocol' });
			return;
		}
	}
	const binAs = `${binColumn}_bin`;
	const startIndex = spec.transforms.length;
	const additions: Transform[] = [
		{ kind: 'bin', column: binColumn, n_bins: 30, strategy: 'equal_width', as: binAs } as BinTransform,
		{ kind: 'groupby', columns: [binAs] } as GroupByTransform,
		{ kind: 'aggregate', aggs: [{ column: binColumn, fn: 'count', as: 'count' }] } as AggregateTransform,
	];
	// Megaudit M-10: dispatch each insert separately is unavoidable
	// with the existing reducer surface (no batch action). The cost
	// is N renders for N inserts; tolerable for a 3-step preset.
	for (let i = 0; i < additions.length; i++) {
		store.dispatch({
			type: 'upsertTransform',
			index: startIndex + i,
			transform: additions[i],
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIconButton(
	glyph: string, title: string, onClick: () => void,
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'qviz-transform-icon-btn';
	btn.textContent = glyph;
	btn.title = title;
	btn.setAttribute('aria-label', title);
	btn.addEventListener('click', onClick);
	return btn;
}

/** Append the transform's produced output column names (if any) to
 *  `out`. Mirrors the schemaDrift's registerProducedNames but emits
 *  to a list (caller wants ordering for downstream column-select
 *  dropdowns). */
function collectProducedNames(t: Transform, out: string[]): void {
	switch (t.kind) {
		case 'date_trunc':
		case 'bin':
		case 'window':
		case 'math':
		case 'expr':
			out.push(t.as);
			return;
		case 'aggregate':
			for (const a of t.aggs) { out.push(a.as); }
			return;
		case 'tz_convert':
			if (t.as !== undefined) { out.push(t.as); }
			return;
		case 'resample':
			if (t.as_time !== undefined) { out.push(t.as_time); }
			return;
		case 'filter':
		case 'groupby':
		case 'sort':
		case 'limit':
			return;
	}
}
