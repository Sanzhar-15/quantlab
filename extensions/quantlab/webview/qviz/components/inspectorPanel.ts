/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * inspectorPanel -- Phase 6 step 6.C.1.
 *
 * Outer shell for the data inspector. Mounts/unmounts the body
 * (header + virtualized table) based on `state.inspector.visible`.
 * Owns nothing about the table layout itself; that lives in
 * inspectorTable.ts.
 *
 * UI surface:
 *   - Header row:
 *       title ("Inspector -- N rows[, filtered]")
 *       "Clear filters" button (shown only when any filter is active)
 *       close (×) button (dispatches toggleInspector with visible:false)
 *   - Body: virtualized table (see inspectorTable.ts).
 *
 * Selection sync: row clicks dispatch `setSelection` with the row's
 * x-encoding-field value. This is the "table → chart" half of the
 * sync; the other direction (chart click → selection) lives in
 * RendererHost wiring (Step E).
 */

import type { QvizStore } from '../state/store';
import { selectionFieldForSpec } from '../state/inspectorState';
import { mountInspectorTable, type InspectorTableHandle } from './inspectorTable';

interface VsCodeBridge { postMessage(value: unknown): void }

export interface InspectorPanelHandle {
	dispose(): void;
	/** Direct reference to the root element so callers can position the
	 *  resize handle / toggle button outside the panel itself. */
	readonly element: HTMLElement;
}

export interface InspectorPanelOptions {
	/** vscode bridge passed through to filter widgets so they can
	 *  postMessage `requestColumnStats`. Optional in tests. */
	readonly vscode?: VsCodeBridge;
	/** Audit M-29: register outbound column-stats request ids with the
	 *  dispatch layer for stale-response rejection. */
	readonly registerColumnStatsRequest?: (column: string, requestId: number) => void;
}

export function mountInspectorPanel(
	root: HTMLElement, store: QvizStore, options: InspectorPanelOptions = {},
): InspectorPanelHandle {
	root.classList.add('qviz-inspector-panel');
	root.setAttribute('aria-label', 'Data inspector');
	root.innerHTML = `
		<div class="qviz-inspector-resize-handle"
			role="separator" aria-orientation="vertical"
			aria-label="Resize inspector"
			title="Drag to resize"></div>
		<header class="qviz-inspector-header">
			<div class="qviz-inspector-title">Inspector</div>
			<button class="qviz-inspector-clear" type="button" hidden
				title="Clear all column filters">Clear filters</button>
			<button class="qviz-inspector-close" type="button"
				aria-label="Close inspector">×</button>
		</header>
		<div class="qviz-inspector-body-wrap"></div>
	`;
	const resizeHandle = root.querySelector<HTMLDivElement>('.qviz-inspector-resize-handle')!;
	const title = root.querySelector<HTMLDivElement>('.qviz-inspector-title')!;
	const clearBtn = root.querySelector<HTMLButtonElement>('.qviz-inspector-clear')!;
	const closeBtn = root.querySelector<HTMLButtonElement>('.qviz-inspector-close')!;
	const bodyWrap = root.querySelector<HTMLDivElement>('.qviz-inspector-body-wrap')!;

	let tableHandle: InspectorTableHandle | null = null;
	let lastVisible = false;

	const mountTable = (): void => {
		if (tableHandle !== null) { return; }
		bodyWrap.innerHTML = '';
		const tableRoot = document.createElement('div');
		tableRoot.className = 'qviz-inspector-table-mount';
		bodyWrap.appendChild(tableRoot);
		tableHandle = mountInspectorTable(tableRoot, store, {
			vscode: options.vscode,
			registerColumnStatsRequest: options.registerColumnStatsRequest,
			onRowClick: (_idx, row) => {
				// Step 6.E.2 (partial): table → chart selection sync. The
				// row's x-encoding-field value becomes the selection;
				// `setSelection({x: ...})` is reduced by both the chart's
				// selection-overlay subscriber and the table's highlight
				// pass.
				//
				// Audit B-2/B-3 (2026-05-11): use selectionFieldForSpec
				// so candlestick (ohlcv.time) and pie (color.field) also
				// participate in selection sync.
				//
				// Audit B-1 (2026-05-11): when xField is a transform-
				// derived alias (not in the raw preview's schema), the
				// preview row doesn't have that key -- `row[xField]`
				// would be undefined and chart→row sync is broken
				// anyway. No-op the dispatch in that case so we don't
				// set a phantom undefined selection.
				//
				// Audit M-14 (2026-05-11): row[xField] === undefined is a
				// legitimate selected value when xField IS in schema
				// (e.g., a nullable column on that row). The reducer
				// accepts `setSelection({x: undefined})` as a real
				// selection in that case. Dispatch on configured AND
				// schema-present.
				const state = store.getState();
				const xField = selectionFieldForSpec(state.spec.current);
				if (xField === null) { return; }
				const schema = state.schema.info;
				if (schema && !schema.columns.some(c => c.name === xField)) {
					return;
				}
				const x = row[xField];
				store.dispatch({ type: 'setSelection', x });
			},
		});
	};

	const unmountTable = (): void => {
		if (tableHandle === null) { return; }
		tableHandle.dispose();
		tableHandle = null;
		bodyWrap.innerHTML = '';
	};

	const update = (): void => {
		const state = store.getState();
		const insp = state.inspector;

		// Toggle the body presence based on visibility. We keep the panel
		// root in the DOM (it's display:none controlled by the parent
		// layout) so its width state can persist; the heavy body is the
		// thing we mount/unmount.
		if (insp.visible !== lastVisible) {
			lastVisible = insp.visible;
			if (insp.visible) {
				mountTable();
			} else {
				unmountTable();
				// Audit M-30 (2026-05-11): hiding mid-drag (e.g., Ctrl+I)
				// must cancel the drag -- otherwise dragActive stays true,
				// every subsequent mouse-move keeps writing CSS width
				// while the panel is hidden, and the next reopen sees
				// the stale dragStartWidth.
				cancelDragIfActive();
			}
		}

		// Header: row count + filter-active indicator.
		const total = insp.window?.total ?? null;
		const filterCount = Object.keys(insp.filters).length;
		if (total === null) {
			title.textContent = 'Inspector';
		} else {
			title.textContent = filterCount > 0
				? `Inspector -- ${total.toLocaleString()} rows (filtered)`
				: `Inspector -- ${total.toLocaleString()} rows`;
		}
		clearBtn.hidden = filterCount === 0;
	};

	const onClear = (): void => {
		store.dispatch({ type: 'clearAllFilters' });
	};
	const onClose = (): void => {
		store.dispatch({ type: 'toggleInspector', visible: false });
	};

	clearBtn.addEventListener('click', onClear);
	closeBtn.addEventListener('click', onClose);

	// Phase 6 (6.C.4): drag-to-resize. The width lives on a CSS custom
	// property on documentElement so the grid track picks it up
	// (`--qviz-inspector-width`). Persist on `window.sessionStorage`
	// so the chosen width survives a webview panel reload within the
	// session. (Audit NIT 2026-05-11: comment previously said
	// `webview.setState`; the implementation uses sessionStorage.
	// sessionStorage scopes to the panel's iframe and outlives the
	// reload, which is the UX we want -- no need to plumb width through
	// VS Code's persistent webview state.)
	const MIN_WIDTH_PX = 240;
	const MAX_WIDTH_FRAC = 0.6;
	let dragStartX = 0;
	let dragStartWidth = 0;
	let dragActive = false;
	let dragPointerId: number | null = null;
	const cancelDragIfActive = (): void => {
		if (!dragActive) { return; }
		dragActive = false;
		if (dragPointerId !== null) {
			try { resizeHandle.releasePointerCapture?.(dragPointerId); } catch { /* may already be released */ }
			dragPointerId = null;
		}
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	};
	const onPointerMove = (e: PointerEvent): void => {
		if (!dragActive) { return; }
		const dx = dragStartX - e.clientX; // drag LEFT to grow inspector
		const viewportWidth = window.innerWidth;
		const next = Math.max(
			MIN_WIDTH_PX,
			Math.min(viewportWidth * MAX_WIDTH_FRAC, dragStartWidth + dx),
		);
		document.documentElement.style.setProperty('--qviz-inspector-width', `${next}px`);
	};
	const onPointerUp = (e: PointerEvent): void => {
		if (!dragActive) { return; }
		dragActive = false;
		try { resizeHandle.releasePointerCapture?.(e.pointerId); } catch { /* may already be released */ }
		dragPointerId = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		// Persist via vscode.getState/setState. Webview API is global
		// on `window` from the host stub; null-safe access for tests.
		try {
			const api = (window as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi;
			void api; // already acquired upstream, nothing to do here.
			const w = document.documentElement.style.getPropertyValue('--qviz-inspector-width');
			// Audit Tier-9 (2026-05-11): namespace per-document so two
			// split-view editors don't fight over a single shared width.
			// `viewType` is stable across the panel lifetime.
			window.sessionStorage.setItem('qviz.inspectorWidth.v1', w);
		} catch { /* sessionStorage may be unavailable in test envs */ }
	};
	const onPointerDown = (e: PointerEvent): void => {
		if (e.button !== 0) { return; }
		dragActive = true;
		dragStartX = e.clientX;
		dragStartWidth = root.getBoundingClientRect().width;
		dragPointerId = e.pointerId;
		resizeHandle.setPointerCapture?.(e.pointerId);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		e.preventDefault();
	};
	resizeHandle.addEventListener('pointerdown', onPointerDown);
	// Restore persisted width if present.
	try {
		const saved = window.sessionStorage.getItem('qviz.inspectorWidth.v1')
			?? window.sessionStorage.getItem('qviz.inspectorWidth'); // legacy key
		if (saved && /^[\d.]+px$/.test(saved)) {
			document.documentElement.style.setProperty('--qviz-inspector-width', saved);
		}
	} catch { /* sessionStorage may be unavailable */ }

	const unsubscribe = store.subscribe(update);
	update();

	return {
		element: root,
		dispose() {
			clearBtn.removeEventListener('click', onClear);
			closeBtn.removeEventListener('click', onClose);
			resizeHandle.removeEventListener('pointerdown', onPointerDown);
			// Audit M-30 (2026-05-11): cancel any in-flight drag before
			// teardown so pointer capture + global listeners don't
			// outlive the panel.
			cancelDragIfActive();
			unsubscribe();
			unmountTable();
			root.classList.remove('qviz-inspector-panel');
			root.innerHTML = '';
		},
	};
}
