/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * chartTypePicker -- Phase 5 step 5.D.2.
 *
 * Renders 9 buttons (line, area, bar, histogram, candlestick,
 * baseline, scatter, heatmap, pie). For shared types (line, bar,
 * histogram), the family is derived from the CURRENT spec: if the
 * current family supports the target type, keep it; otherwise switch
 * to a family that does (preferring timeseries for trading workflows).
 *
 * Megaudit CRITICAL-4: prior implementation hard-coded 7 types
 * (omitting baseline and pie) and used a fixed family per type, making
 * `general.line`, `general.bar`, `general.histogram`, pie, and
 * baseline unreachable from the builder.
 */

import type { QvizStore } from '../state/store';
import type { ChartFamily, ChartType } from '../../../src/qviz/spec';
import { CHART_TYPE_BY_FAMILY } from '../../../src/qviz/validate';
import { fitChartTypeTransition } from '../controllers/chartTypeFit';

/** Front 1 (2026-05-14): controller-layer auto-fit kill switch.
 *  Constant rather than a VS Code config because:
 *    - The fit is non-destructive (only fills EMPTY required
 *      channels; never overwrites user-set encodings) so we expect
 *      to ship it default-on with no toggle.
 *    - A surface-area config schema entry would have to be
 *      explained in docs, which is heavier than the value.
 *  If a regression surfaces, flip this to `false` and ship a
 *  hotfix. The chart-type picker falls back to the legacy
 *  `setChartType` action (same behavior as before Front 1). */
const BUILDER_INTELLIGENCE_ENABLED = true;

/** All chart types the picker offers, in display order. */
const CHART_TYPES_IN_ORDER: readonly { type: ChartType; label: string }[] = [
	{ type: 'line', label: 'Line' },
	{ type: 'area', label: 'Area' },
	{ type: 'bar', label: 'Bar' },
	{ type: 'histogram', label: 'Histogram' },
	{ type: 'candlestick', label: 'Candlestick' },
	{ type: 'baseline', label: 'Baseline' },
	{ type: 'scatter', label: 'Scatter' },
	{ type: 'heatmap', label: 'Heatmap' },
	{ type: 'pie', label: 'Pie' },
];

/**
 * Megaudit CRITICAL-4: pick the family for the target chart type.
 *   - If the current family supports the target type, keep it (no
 *     spurious family swap on a shared-type click like `line`).
 *   - Otherwise prefer `timeseries` when it supports the type
 *     (line/area/bar/histogram/candlestick/baseline) -- those are the
 *     more common picks in trading workflows.
 *   - Fall back to `general` (scatter/heatmap/pie + the shared types).
 */
function familyForType(t: ChartType, current: ChartFamily | null): ChartFamily {
	if (current !== null && CHART_TYPE_BY_FAMILY[current].includes(t)) {
		return current;
	}
	if (CHART_TYPE_BY_FAMILY.timeseries.includes(t)) { return 'timeseries'; }
	return 'general';
}

export function mountChartTypePicker(root: HTMLElement, store: QvizStore): { dispose(): void } {
	root.classList.add('qviz-chart-type-picker');
	root.setAttribute('role', 'radiogroup');
	root.setAttribute('aria-label', 'Chart type');

	// Megaudit-2 A5-MAJOR-1.1: WAI-ARIA Authoring Practices for a
	// radiogroup require:
	//   - exactly ONE radio with tabindex=0 (the focused / checked one)
	//   - all others tabindex=-1 (focusable only via JS / arrow keys)
	//   - ArrowDown/Right → next radio, ArrowUp/Left → previous,
	//     Home → first, End → last; selection follows focus.
	// Previous implementation had no roving tabindex and no key
	// handler, so keyboard users tabbed through ALL 9 buttons (poor
	// focus economy) and arrow keys did nothing.
	const buttons = new Map<ChartType, HTMLButtonElement>();
	const orderedTypes: ChartType[] = CHART_TYPES_IN_ORDER.map(x => x.type);
	const selectType = (type: ChartType): void => {
		const state = store.getState();
		const currentSpec = state.spec.current;
		if (currentSpec === null) {
			// Per CLAUDE.md "errors must be visible": the picker mounts
			// AFTER `init` dispatches (the visualise host wires it
			// inside the spec subscriber). A null spec at selectType
			// time means the host wired the picker before init -- an
			// invariant violation, not a runtime case.
			throw new Error('chartTypePicker.selectType: picker mounted without a current spec');
		}
		const family = familyForType(type, currentSpec.chart.family);
		// Front 1: invoke the fitter when enabled. The
		// applyChartTypeWithFit reducer arm short-circuits identity-
		// preserve when family/type/encodings are all unchanged, so
		// a no-op click produces no history entry. When the flag is
		// off, fall through to the legacy reducer (same identity-
		// preserve semantics on its own arm).
		if (!BUILDER_INTELLIGENCE_ENABLED) {
			store.dispatch({ type: 'setChartType', family, chartType: type });
			return;
		}
		const result = fitChartTypeTransition(
			state.schema.info,
			currentSpec,
			type,
			family,
		);
		store.dispatch({
			type: 'applyChartTypeWithFit',
			family: result.family,
			chartType: result.chartType,
			encodings: result.encodings,
		});
	};
	const focusIndex = (idx: number): void => {
		const clamped = ((idx % orderedTypes.length) + orderedTypes.length) % orderedTypes.length;
		const btn = buttons.get(orderedTypes[clamped]);
		if (btn) {
			btn.focus();
			// Megaudit Theme D (D1, 2026-05-13): do NOT call selectType
			// here. Arrow-key navigation must MOVE FOCUS only — Space/
			// Enter commit selection via the keydown handler below.
			// Previously, every arrow tap dispatched setChartType, and
			// the reducer's encoding-filter cascade silently destroyed
			// the user's encoding work on each keystroke. Loosely
			// modeled after WAI-ARIA listbox-with-explicit-selection.
		}
	};
	for (const { type, label } of CHART_TYPES_IN_ORDER) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.classList.add('qviz-chart-type-button');
		btn.setAttribute('role', 'radio');
		btn.setAttribute('aria-checked', 'false');
		btn.tabIndex = -1;
		btn.dataset.chartType = type;
		btn.textContent = label;
		btn.addEventListener('click', () => {
			selectType(type);
		});
		btn.addEventListener('keydown', (evt: KeyboardEvent) => {
			const idx = orderedTypes.indexOf(type);
			switch (evt.key) {
				case 'ArrowRight':
				case 'ArrowDown':
					evt.preventDefault();
					focusIndex(idx + 1);
					return;
				case 'ArrowLeft':
				case 'ArrowUp':
					evt.preventDefault();
					focusIndex(idx - 1);
					return;
				case 'Home':
					evt.preventDefault();
					focusIndex(0);
					return;
				case 'End':
					evt.preventDefault();
					focusIndex(orderedTypes.length - 1);
					return;
				case ' ':
				case 'Enter':
					evt.preventDefault();
					selectType(type);
					return;
				default:
					return;
			}
		});
		buttons.set(type, btn);
		root.appendChild(btn);
	}

	const refresh = (): void => {
		const current = store.getState().spec.current?.chart.type ?? null;
		let assignedTabStop = false;
		for (const [type, btn] of buttons) {
			const active = type === current;
			btn.classList.toggle('qviz-chart-type-button--active', active);
			btn.setAttribute('aria-checked', String(active));
			// Roving tabindex: the active (checked) radio is the single
			// tab-stop; everything else is -1.
			if (active) {
				btn.tabIndex = 0;
				assignedTabStop = true;
			} else {
				btn.tabIndex = -1;
			}
		}
		// If nothing is checked (fresh open, no spec), make the first
		// radio focusable so Tab can still land in the group.
		if (!assignedTabStop) {
			const first = buttons.get(orderedTypes[0]);
			if (first) { first.tabIndex = 0; }
		}
	};
	const off = store.subscribe(refresh);
	refresh();
	return {
		dispose: () => {
			off();
			root.innerHTML = '';
			root.classList.remove('qviz-chart-type-picker');
		},
	};
}
