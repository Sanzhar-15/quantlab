/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * Builder webview entry -- Phase 5 step D (replacing the Step A
 * placeholder). Wires:
 *   - Inbound messages from the provider via `validateExtensionMessage`
 *     → dispatched into the qviz state store as actions.
 *   - Outbound messages to the provider (`ready`, `requestData`) via
 *     `vscode.postMessage` with envelope (`protocolVersion`,
 *     `requestId`, `specHash` recomputed from the spec on the send side).
 *   - Four UI components: columnPanel, chartTypePicker, encodingShelf,
 *     previewArea. Each subscribes to the store and dispatches actions.
 *   - Live-preview loop: spec changes → debounced `requestData` → daemon
 *     `aggregate` → `data` message → arrow extraction → RendererHost.
 *
 * Save: Cmd+S / Cmd+Shift+S in the editor invokes VS Code's standard
 * save UI, which routes through the provider's drift-aware save. The
 * webview doesn't need a Save button at this step.
 */

import {
	type ExtensionMessage,
	type ThemeTokens,
	type TransformAttribution,
	PROTOCOL_VERSION,
	validateExtensionMessage,
} from '../../src/qviz/messageProtocol';
import type { QvizSpec } from '../../src/qviz/spec';
import type { ColumnData, QvizTheme } from '../../src/qviz/render/types';
import { extractColumnsFromArrowIpc } from '../../src/qviz/render/extract-arrow';
import { createStore } from '../qviz/state/store';
import { isDirty } from '../qviz/state/specState';
import { mountColumnPanel } from '../qviz/components/columnPanel';
import { mountInspectorPanel } from '../qviz/components/inspectorPanel';
import { DEFAULT_INSPECTOR_WINDOW_N } from '../qviz/components/inspectorTable';
import { mountChartTypePicker } from '../qviz/components/chartTypePicker';
import { mountEncodingShelves } from '../qviz/components/encodingShelf';
import { mountPreviewArea } from '../qviz/components/previewArea';
import { mountTransformList } from '../qviz/components/transformList';
import { mountAnnouncer } from '../qviz/components/announcer';
import { handleInvalidExtensionMessage } from './invalidMessage';
import { RendererHost } from '../qviz/render/RendererHost';

interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

// Diagnostic bridge (2026-05-14, Codex-co-designed): when the
// extension host enables `QUANTLAB_QVIZ_WEBVIEW_DEBUG`, the inline
// pre-bundle bootstrap calls `acquireVsCodeApi()` first and exposes
// the handle as `window.__qvizDebugAcquireVsCodeApi`. The bundle
// reuses that handle so we don't violate the one-call-only rule.
// In normal mode the helper is undefined and the bundle acquires
// the API itself.
interface QvizDebugWindow extends Window {
	__qvizDebugAcquireVsCodeApi?: () => VSCodeApi;
	__qvizDebugMark?: (stage: string, data?: unknown) => void;
}
const vscode = (window as QvizDebugWindow).__qvizDebugAcquireVsCodeApi?.()
	?? acquireVsCodeApi();
(window as QvizDebugWindow).__qvizDebugMark?.('bundle-acquired-vscode-api');

let outboundRequestId = 0;
function nextRequestId(): number { outboundRequestId += 1; return outboundRequestId; }

const REQUEST_DATA_DEBOUNCE_MS = 200;

function init(): void {
	const root = document.getElementById('qviz-spec-root');
	if (!root) {
		throw new Error('qviz-spec webview: #qviz-spec-root missing from DOM');
	}

	// Build the layout shell.
	// Phase 6 (6.C.1): the main grid now has a 4th column for the inspector
	// panel, only visible when `inspectorState.visible === true` (the
	// grid template is swapped between 3-col and 4-col by a body class).
	root.innerHTML = `
		<div class="qviz-app">
			<header class="qviz-app-header">
				<h1 class="qviz-app-title">
					Visualise spec
					<span id="qviz-unsaved-badge" class="qviz-unsaved-badge"
						aria-label="Unsaved changes" title="Unsaved changes" hidden>●</span>
				</h1>
				<div class="qviz-app-header-controls">
					<button id="qviz-promote-to-chart" type="button"
						class="qviz-promote-to-chart" disabled
						title="Open this dataset in the Chart view (requires a timeseries chart and a resolvable dataset)">Promote to Chart</button>
					<button id="qviz-inspector-toggle" type="button"
						class="qviz-inspector-toggle" aria-pressed="false"
						title="Toggle data inspector (Ctrl+I)">Inspector</button>
					<div class="qviz-app-hint">Cmd+S to save</div>
				</div>
			</header>
			<main class="qviz-app-main">
				<aside class="qviz-app-aside" id="qviz-column-panel-root"></aside>
				<section class="qviz-app-builder">
					<div id="qviz-chart-type-root"></div>
					<div id="qviz-encoding-root"></div>
					<div id="qviz-transform-list-root"></div>
				</section>
				<section class="qviz-app-preview" id="qviz-preview-root"></section>
				<aside class="qviz-app-inspector" id="qviz-inspector-root" hidden></aside>
			</main>
		</div>
	`;
	const columnPanelRoot = document.getElementById('qviz-column-panel-root')!;
	const chartTypeRoot = document.getElementById('qviz-chart-type-root')!;
	const encodingRoot = document.getElementById('qviz-encoding-root')!;
	const transformListRoot = document.getElementById('qviz-transform-list-root')!;
	const previewRoot = document.getElementById('qviz-preview-root')!;
	const inspectorRoot = document.getElementById('qviz-inspector-root')!;
	const inspectorToggleBtn = document.getElementById('qviz-inspector-toggle') as HTMLButtonElement;
	const promoteToChartBtn = document.getElementById('qviz-promote-to-chart') as HTMLButtonElement;
	const unsavedBadge = document.getElementById('qviz-unsaved-badge') as HTMLElement;

	const store = createStore();
	const announcer = mountAnnouncer(root, store);
	const columnPanel = mountColumnPanel(columnPanelRoot, store);
	const chartType = mountChartTypePicker(chartTypeRoot, store);
	const encoding = mountEncodingShelves(encodingRoot, store);
	const transformList = mountTransformList(transformListRoot, store);
	const preview = mountPreviewArea(previewRoot, store, {
		// Phase 8 Step D: retry-button wiring. Each click posts a
		// host-side message; the provider tears down the lifecycle
		// (retryDaemon) or re-resolves the dataset path (recheckDataset)
		// and broadcasts the resulting status back to the webview.
		onRetryDaemon: () => {
			vscode.postMessage({
				type: 'retryDaemon',
				protocolVersion: PROTOCOL_VERSION,
				requestId: nextRequestId(),
			});
		},
		onRecheckDataset: () => {
			vscode.postMessage({
				type: 'recheckDataset',
				protocolVersion: PROTOCOL_VERSION,
				requestId: nextRequestId(),
			});
		},
	});
	const inspectorPanel = mountInspectorPanel(inspectorRoot, store, {
		vscode,
		registerColumnStatsRequest: (column, requestId) => {
			latestColumnStatsRequestIds.set(column, requestId);
		},
	});
	// Phase 6 (6.E.1): renderer reports chart-click selections through
	// `onSelection`; the dispatcher converts to a `setSelection` action,
	// which the inspector table picks up via its row-highlight pass.
	const renderer = new RendererHost(preview.chartContainer, undefined, {
		onSelection: (x: unknown) => {
			store.dispatch({ type: 'setSelection', x });
		},
	});

	// Step 5.E.2 -- ResizeObserver on the chart container. Re-apply the
	// last render with the same data so the chart fills the resized
	// container. Debounced so a drag doesn't trigger 60 re-applies per
	// second. We don't re-fetch data on resize.
	let disposed = false;
	// Megaudit residual: post-data render/extract failures use
	// `localErrorReceived` (webview-only), which bypasses the inflight
	// gate but still gates on `lastSuccessfulSpecHash` so stale errors
	// from superseded specs don't clobber current diagnostics. The
	// previous `errorReceived` with `requestId: -1` was a no-op
	// because the reducer's inflight match always failed.
	//
	// Megaudit-2 A3-MAJOR-4 / CODEX-10: the dispatcher takes a
	// `triggerSpecHash` captured AT THE MOMENT renderActiveData was
	// invoked. Reading `state.query.lastData.specHash` at error time
	// raced with concurrent dataReceived updates: an error from
	// rendering spec_A would dispatch with spec_B's hash if a fresh
	// requestData landed during the render, clobbering spec_B's
	// diagnostics with an irrelevant error.
	// Megaudit HIGH (Codex, 2026-05-14): drop local errors whose
	// `triggerSpecHash` no longer matches the editor's current spec.
	// The localErrorReceived reducer arm gates on
	// `lastSuccessfulSpecHash === action.specHash`, which is correct
	// for attribution but doesn't catch the case "user edits spec A
	// to spec B; render of A fails and dispatches; diagnostics shows
	// error attributed to A while editor shows B". Gate at dispatch
	// time before the reducer ever sees it.
	const isErrorForCurrentSpec = (triggerSpecHash: string): boolean =>
		store.getState().spec.currentHash === triggerSpecHash;
	const dispatchExtractError = (triggerSpecHash: string, message: string): void => {
		if (!isErrorForCurrentSpec(triggerSpecHash)) { return; }
		store.dispatch({
			type: 'localErrorReceived',
			specHash: triggerSpecHash,
			error: message,
			errorKind: 'internal',
		});
	};
	const dispatchRenderError = (triggerSpecHash: string, stage: string, message: string): void => {
		if (!isErrorForCurrentSpec(triggerSpecHash)) { return; }
		store.dispatch({
			type: 'localErrorReceived',
			specHash: triggerSpecHash,
			error: `${stage}: ${message}`,
			errorKind: 'internal',
		});
	};
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	const RESIZE_DEBOUNCE_MS = 120;
	const resizeObserver = new ResizeObserver(() => {
		if (resizeTimer !== null) { clearTimeout(resizeTimer); }
		resizeTimer = setTimeout(() => {
			resizeTimer = null;
			// Megaudit MAJOR-59: short-circuit if disposed; the timer
			// callback can fire after dispose if the panel is being
			// torn down right as a resize happens.
			if (disposed) { return; }
			const state = store.getState();
			const spec = state.spec.current;
			const data = state.query.lastData;
			if (spec === null || data === null) { return; }
			// Front 2 audit MEDIUM (Opus + Codex, 2026-05-14): when the
			// spec has been edited but the new dataReceived has not yet
			// landed, `spec` is the NEW spec while `data` is the OLD
			// payload. Pre-Front-2 this could surface a "column not in
			// data" error against stale columns; Front 2 makes it
			// worse because the suffix would name a transform from the
			// OLD spec that does not exist in the NEW spec's
			// `transforms` array. Drop attribution to null when hashes
			// diverge so the error message stays accurate (plain,
			// pre-Front-2 wording).
			const attrForRender = data.specHash === state.spec.currentHash
				? data.attribution
				: null;
			void renderActiveData(renderer, spec, data.arrow,
				data.specHash,
				dispatchExtractError, dispatchRenderError,
				attrForRender);
		}, RESIZE_DEBOUNCE_MS);
	});
	resizeObserver.observe(preview.chartContainer);

	// Subscribe to inbound messages.
	window.addEventListener('message', (event: MessageEvent) => {
		const result = validateExtensionMessage(event.data);
		if (!result.ok) {
			handleInvalidExtensionMessage(result.error, announcer);
			return;
		}
		const msg = result.value;
		// Audit M-A/M-B (2026-05-11): drop inspectorData/inspectorError
		// responses whose requestId doesn't match the most recently
		// dispatched inspector request. Out-of-order delivery (or a
		// stale response landing after init for a different document)
		// must not overwrite the current window. Init separately resets
		// the cursor so even a same-id response from the prior document
		// is rejected.
		if (msg.type === 'init') {
			latestInspectorRequestId = null;
			lastInspectorWindowOffsetReq = null;
			lastInspectorFiltersHashReq = '';
			latestColumnStatsRequestIds.clear();
		}
		if (msg.type === 'inspectorData' || msg.type === 'inspectorError') {
			if (latestInspectorRequestId === null || msg.requestId !== latestInspectorRequestId) {
				return;
			}
		}
		// Audit M-29 (2026-05-11): drop stale columnStats responses
		// whose requestId doesn't match the latest dispatched for that
		// column. A user opening + closing + reopening the same filter
		// widget can produce multiple in-flight requests; without this
		// gate the OLD response's stats overwrite the freshly-fetched
		// ones on race.
		if (msg.type === 'columnStats' || msg.type === 'columnStatsError') {
			const expected = latestColumnStatsRequestIds.get(msg.column);
			if (expected === undefined || msg.requestId !== expected) {
				return;
			}
			// Successful response → drop the in-flight cursor.
			latestColumnStatsRequestIds.delete(msg.column);
		}
		dispatchExtensionMessage(store, msg);
	});

	// Live-preview wiring: debounced requestData on spec change, and
	// renderer drive on dataReceived. The actual de-dup guard is
	// `lastSuccessfullyRenderedHash` (a few lines down); the previous
	// `lastDispatchedHash` was dead code retained for a comment that
	// no longer matched the implementation. (Megaudit Theme D D14,
	// 2026-05-13.)
	let lastDispatchedEditHash: string | null = null;
	let lastRenderedDataHash: string | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleRequestData = (spec: QvizSpec, specHash: string): void => {
		if (debounceTimer !== null) { clearTimeout(debounceTimer); }
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			// Step 5.H.2: send `edit` BEFORE `requestData` so VS Code's
			// undo stack gets the new spec recorded as an edit step.
			// Provider's handleEdit suppresses the contentChange echo
			// so this doesn't bounce back as an init. Skip if the hash
			// matches what we last edit-dispatched (idempotent -- the
			// document's structurally-equal short-circuit also catches
			// duplicates, but the network round-trip is wasteful).
			if (lastDispatchedEditHash !== specHash) {
				lastDispatchedEditHash = specHash;
				vscode.postMessage({
					type: 'edit',
					protocolVersion: PROTOCOL_VERSION,
					requestId: nextRequestId(),
					specHash,
					spec,
					label: 'builder edit',
				});
			}
			const requestId = nextRequestId();
			store.dispatch({ type: 'requestStarted', requestId, specHash });
			// Phase 6 (6.D.3): include the inspector's active filter set
			// in the chart's data request so the rendered aggregate
			// matches what the inspector table shows. Omitted when no
			// filter is active so the daemon's cache key for the
			// unfiltered chart stays identical to pre-Phase-6.
			const filtersForChart = filtersValues(store.getState().inspector.filters);
			vscode.postMessage({
				type: 'requestData',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				specHash,
				spec,
				...(filtersForChart.length > 0 ? { inspectorFilters: filtersForChart } : {}),
			});
		}, REQUEST_DATA_DEBOUNCE_MS);
	};

	let lastRenderedThemeVersion = -1;
	let lastSuccessfullyRenderedHash: string | null = null;
	// Megaudit-2 M-32: track the schema.info identity so a fresh
	// `schemaChanged` (mid-session drift detection) forces a re-fetch
	// even when the spec hash hasn't changed. The previous trigger only
	// fired on spec.currentHash changes; if the dataset's columns
	// changed under the same spec, the cached `lastData` was stale.
	// Re-rendering with stale data → either silent miscoloring (drift
	// 'added'/'changed') or extract-time failures (drift
	// 'fields-missing').
	let lastObservedSchemaInfo: unknown = null;
	let lastObservedFiltersHash = '';
	const liveSubscription = store.subscribe((state) => {
		// Live-preview trigger. Megaudit MAJOR-33: the prior gate
		// (`hash !== lastDispatchedHash`) silently swallowed undo when
		// the post-undo hash matched a previously-dispatched value --
		// no fresh requestData fired and the chart stayed at the
		// pre-undo render. New gate: dispatch unless the hash matches
		// the LAST SUCCESSFULLY RENDERED hash (i.e., the chart on
		// screen already reflects this spec).
		const spec = state.spec.current;
		const hash = state.spec.currentHash;
		// Megaudit-2 M-32: if schema.info reference changed, reset the
		// "already rendered" gate so the live trigger refires for the
		// CURRENT spec under the NEW schema. Identity-compare is safe
		// because the schemaState reducer always allocates a new
		// frozen object on schemaChanged/init.
		if (state.schema.info !== lastObservedSchemaInfo) {
			lastObservedSchemaInfo = state.schema.info;
			// Force re-fetch + re-render on the next spec evaluation.
			// Null the render-side cursors so the live trigger refires
			// scheduleRequestData (which will be no-op-elided by the
			// daemon if data really is the same) and renderActiveData
			// (which re-runs against the new schema). Don't reset
			// `lastDispatchedEditHash` -- the spec hash is unchanged
			// and the provider's applyEdit short-circuits on a
			// structurally-equal spec anyway, so re-emitting `edit`
			// would just be wasted IPC.
			lastSuccessfullyRenderedHash = null;
			lastRenderedDataHash = null;
		}
		// Phase 6 (6.D.3): inspector filter edits don't change the spec
		// hash, but they DO change the data the chart should render. When
		// the filters-hash advances, null out the rendered-hash cursor
		// so the gate below refires `scheduleRequestData` for the same
		// spec but with the new filters.
		const filtersHash = JSON.stringify(state.inspector.filters);
		if (filtersHash !== lastObservedFiltersHash) {
			lastObservedFiltersHash = filtersHash;
			lastSuccessfullyRenderedHash = null;
			lastRenderedDataHash = null;
		}
		if (spec !== null && hash !== null && hash !== lastSuccessfullyRenderedHash) {
			scheduleRequestData(spec, hash);
		}
		// Render trigger: a fresh data hash OR a theme bump. Theme
		// bumps re-render the existing chart with new theme tokens
		// without a daemon round-trip (Step 5.E.1).
		const themeChanged = state.ui.themeTokensVersion !== lastRenderedThemeVersion;
		const dataChanged = state.query.lastData !== null
			&& state.query.lastData.specHash !== lastRenderedDataHash;
		if (spec !== null && state.query.lastData !== null && (dataChanged || themeChanged)) {
			lastRenderedDataHash = state.query.lastData.specHash;
			lastRenderedThemeVersion = state.ui.themeTokensVersion;
			lastSuccessfullyRenderedHash = state.query.lastData.specHash;
			// Front 2 audit MEDIUM: same stale-attribution gate as the
			// resize path above. Spec edited but new data not yet
			// arrived -> drop attribution so the error message doesn't
			// reference transform indices from the prior spec.
			const attrForRender = state.query.lastData.specHash === state.spec.currentHash
				? state.query.lastData.attribution
				: null;
			void renderActiveData(renderer, spec, state.query.lastData.arrow,
				state.query.lastData.specHash,
				dispatchExtractError, dispatchRenderError,
				attrForRender);
		}
	});
	// liveSubscription is a store-unsubscribe function; called in the
	// dispose path below to detach. Megaudit MEDIUM (Sonnet,
	// 2026-05-14): removed `void liveSubscription;` no-op that was
	// suppressing an unused-locals lint warning without explanation.

	// Step 5.E.1 -- theme refresh via MutationObserver on body.className.
	// VS Code signals theme changes by toggling body classes
	// (`vscode-dark`, `vscode-light`, `vscode-high-contrast`). The
	// observer fires `themeUpdated` so the store advances
	// `ui.themeTokensVersion`, which the render-trigger subscriber
	// above picks up. No daemon round-trip required.
	//
	// Megaudit MAJOR-57: only watch `class` (theme is signaled there).
	// Watching `style` too caused spurious dispatches on unrelated
	// VS Code style mutations (font-size adjustments, etc.).
	const themeObserver = new MutationObserver(() => {
		store.dispatch({ type: 'themeUpdated', tokens: readThemeTokensFromCssVars() });
	});
	themeObserver.observe(document.body, {
		attributes: true,
		attributeFilter: ['class'],
	});
	// Fire once on mount to seed the version (the initial render uses
	// `readThemeFromCssVars` directly; this dispatch makes future
	// reads coherent).
	store.dispatch({ type: 'themeUpdated', tokens: readThemeTokensFromCssVars() });

	// Ready signal.
	vscode.postMessage({
		type: 'ready',
		protocolVersion: PROTOCOL_VERSION,
		requestId: nextRequestId(),
	});

	// Phase 6 (6.C.3): toggle button + Ctrl+I shortcut. Both dispatch the
	// same `toggleInspector` action; the view-side reaction lives in the
	// inspectorVisibilitySubscription below.
	const onToggleClick = (): void => {
		store.dispatch({ type: 'toggleInspector' });
	};
	const onKeyDown = (e: KeyboardEvent): void => {
		const active = document.activeElement;
		const inEditable = active && (
			active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
			|| (active as HTMLElement).isContentEditable
		);
		// Phase 6 (6.E.5): Escape clears the inspector selection.
		// Defer to native handling when focus is in a text input or
		// a popup is open -- Esc has other meanings there (commit input,
		// close popup) and the inspector selection isn't the priority.
		if (e.key === 'Escape' && !inEditable) {
			if (store.getState().inspector.selection !== null) {
				e.preventDefault();
				store.dispatch({ type: 'clearSelection' });
			}
			return;
		}
		// Phase 8 Step B: Ctrl+Z / Cmd+Z undoes UI changes (inspector
		// toggle, selection). When the UI history is empty we let the
		// keystroke bubble to VS Code, whose CustomDocument undo stack
		// handles spec edits via the EditEvent → onDidChangeCustomDocument
		// machinery wired in VisualiseSpecProvider.
		// Ctrl+Y or Ctrl+Shift+Z does the redo.
		if (!inEditable && (e.ctrlKey || e.metaKey)) {
			const isZ = e.key === 'z' || e.key === 'Z';
			const isY = e.key === 'y' || e.key === 'Y';
			if (isZ && !e.shiftKey) {
				if (store.getState().history.past.length > 0) {
					e.preventDefault();
					store.dispatch({ type: 'undoUiHistory' });
				}
				// else: let VS Code handle Ctrl+Z for spec undo.
				return;
			}
			if (isY || (isZ && e.shiftKey)) {
				if (store.getState().history.future.length > 0) {
					e.preventDefault();
					store.dispatch({ type: 'redoUiHistory' });
				}
				// else: let VS Code handle Ctrl+Y for spec redo.
				return;
			}
		}
		// Ctrl+I on Linux/Windows, Cmd+I on macOS. Reject when focus is
		// inside a text input so we don't hijack italicize-style
		// shortcuts in form fields. The encoded-italic mapping (Ctrl+I
		// → italic) isn't used anywhere in this webview, but defensive
		// focus check is cheap.
		if (e.key !== 'i' && e.key !== 'I') { return; }
		if (!(e.ctrlKey || e.metaKey)) { return; }
		if (inEditable) { return; }
		// Audit M-E (2026-05-11): swallow the shortcut when the daemon
		// doesn't advertise inspector caps -- opening would just produce
		// cryptic op-unsupported errors. The button is disabled in this
		// state too; the shortcut bypasses the button so we re-check.
		const insCaps = store.getState().runtime.capabilities?.inspector;
		if (!(insCaps && insCaps.previewOffset && insCaps.columnStats && insCaps.aggregateFilters)) {
			return;
		}
		e.preventDefault();
		store.dispatch({ type: 'toggleInspector' });
	};
	inspectorToggleBtn.addEventListener('click', onToggleClick);
	window.addEventListener('keydown', onKeyDown);

	// Layout reactive bits: show/hide inspector aside; refresh the
	// toggle button's pressed state; trigger inspector-data fetch when
	// the panel becomes visible (or its scroll/filter state requires a
	// fresh window).
	let lastInspectorVisible = false;
	let lastInspectorWindowOffsetReq: number | null = null;
	let lastInspectorFiltersHashReq = '';
	// Audit M-27 (2026-05-11): track error reference (not string value)
	// so two consecutive errors with the same message produce TWO
	// distinct error-observed transitions, each clearing the request
	// cursor so retries fire. The reducer allocates a fresh state object
	// on every `inspectorError` dispatch, so reference inequality
	// catches every error landing (including duplicate-message ones).
	let lastInspectorErrorRef: unknown = null;
	// Audit M-A/M-B (2026-05-11): track the most-recently-sent inspector
	// requestId so out-of-order or post-init responses can be dropped.
	// Without this, a slow response from before a filter edit could
	// land AFTER the user's new filter window and clobber it (the
	// reducer is last-write-wins for inspectorDataReceived).
	let latestInspectorRequestId: number | null = null;
	// Audit M-29 (2026-05-11): same stale-response problem for column
	// stats. Per-column map of last-dispatched requestId; responses
	// whose id doesn't match are dropped. init resets the entire map.
	const latestColumnStatsRequestIds = new Map<string, number>();
	const dispatchInspectorRequest = (offset: number): void => {
		// Phase 6 (6.C.2): one inspector data fetch per (offset, filters)
		// pair. Duplicate calls are short-circuited by the cursor below.
		const filtersHash = JSON.stringify(store.getState().inspector.filters);
		if (offset === lastInspectorWindowOffsetReq
			&& filtersHash === lastInspectorFiltersHashReq) {
			return;
		}
		lastInspectorWindowOffsetReq = offset;
		lastInspectorFiltersHashReq = filtersHash;
		const requestId = nextRequestId();
		latestInspectorRequestId = requestId;
		const filters = filtersValues(store.getState().inspector.filters);
		vscode.postMessage({
			type: 'requestInspectorData',
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			offset,
			n: DEFAULT_INSPECTOR_WINDOW_N,
			...(filters.length > 0 ? { inspectorFilters: filters } : {}),
		});
	};
	// Phase 8 Step F: in-webview unsaved indicator. Subscribes to the
	// spec slice's isDirty() selector and toggles a small dot in the app
	// header. VS Code's tab dot covers the same signal at the editor
	// level; this one sits inside the webview so users editing the chart
	// have an at-a-glance unsaved cue without looking up at the tab.
	const unsavedSub = store.subscribe(() => {
		unsavedBadge.hidden = !isDirty(store.getState().spec);
	});
	// Visualise v2: Promote to Chart button. Enabled only when the
	// current spec is timeseries AND the dataset resolves (datasetStatus
	// === 'ok'). Tooltip explains the gate state.
	const promoteSub = store.subscribe(() => {
		const s = store.getState();
		const spec = s.spec.current;
		const isTimeseries = spec?.chart.family === 'timeseries';
		const datasetOk = s.runtime.datasetStatus === 'ok'
			|| s.runtime.datasetStatus === null;
		const enabled = !!spec && isTimeseries && datasetOk;
		promoteToChartBtn.disabled = !enabled;
		promoteToChartBtn.title = enabled
			? 'Open this dataset in the Chart view (writes a .py scaffold to .quantlab/visualise-promoted/).'
			: !spec
				? 'No spec loaded yet.'
				: !isTimeseries
					? `Promote to Chart only supports timeseries specs (current: ${spec.chart.family}/${spec.chart.type}).`
					: `Dataset is not resolvable (${s.runtime.datasetStatus}). Fix the dataset path first.`;
	});
	const onPromoteClick = (): void => {
		vscode.postMessage({
			type: 'promoteToChart',
			protocolVersion: PROTOCOL_VERSION,
			requestId: nextRequestId(),
		});
	};
	promoteToChartBtn.addEventListener('click', onPromoteClick);
	// **Subscriber invariant** (Front 7 fix, 2026-05-13 post-smoke):
	// `store.subscribe` callbacks MUST be pure read-and-render. They
	// MUST NOT call `store.dispatch(...)` synchronously — the store's
	// re-entrancy guard at `store.ts:172-180` throws on nested
	// dispatch. Force-close logic that previously lived here on
	// capabilities loss now lives in `reduceInspectorInner`'s
	// `capabilitiesUpdated` arm. Apply the same invariant to every
	// other subscriber added below.
	const inspectorViewSub = store.subscribe(() => {
		const state = store.getState();
		const insp = state.inspector;
		// Audit M-E (2026-05-11): gate the toggle on daemon capability.
		// Pre-Phase-6 daemons advertise no `inspector` bag; clicking the
		// toggle on those would trigger cryptic "unsupported op" errors.
		// We keep the button visible but disabled so the affordance is
		// discoverable on dialog upgrade.
		const insCaps = state.runtime.capabilities?.inspector;
		const inspectorSupported = insCaps !== undefined
			&& insCaps.previewOffset && insCaps.columnStats && insCaps.aggregateFilters;
		inspectorToggleBtn.disabled = !inspectorSupported;
		inspectorToggleBtn.title = inspectorSupported
			? 'Toggle data inspector (Ctrl+I)'
			: 'Data inspector requires a newer Python daemon. Reinstall the venv via the "Quantlab: Reinstall Python environment" command, or update the bundled qviz package and reload the window.';
		// Toggle parent grid class so the inspector column gets a track.
		document.body.classList.toggle('qviz-inspector-open', insp.visible);
		inspectorRoot.hidden = !insp.visible;
		inspectorToggleBtn.classList.toggle('qviz-inspector-toggle--active', insp.visible);
		inspectorToggleBtn.setAttribute('aria-pressed', String(insp.visible));
		// Audit M-C/M-D (2026-05-11): when an inspectorError lands, clear
		// the duplicate-request cursor so the next user action (filter
		// tweak, scroll, retry) actually fires. Without this clear, the
		// (offset, filtersHash) pair stayed pinned and identical retries
		// were suppressed forever.
		// Audit M-27 (2026-05-11): use the state slice's reference for
		// last-error tracking instead of the error string. Every fresh
		// `inspectorError` reducer call returns a new state object even
		// when the error message is identical, so reference inequality
		// reliably catches every error event.
		const errorRefNow = insp.lastError === null ? null : insp;
		if (errorRefNow !== lastInspectorErrorRef) {
			lastInspectorErrorRef = errorRefNow;
			if (insp.lastError !== null) {
				lastInspectorWindowOffsetReq = null;
				lastInspectorFiltersHashReq = '';
			}
		}
		// Audit M-28 (2026-05-11): drop the else -- a single tick can
		// flip visibility AND change scroll/filters (e.g., toggleInspector
		// + setColumnFilter dispatched together). The prior `if/else if`
		// short-circuit missed the second update. Now both branches
		// evaluate independently.
		if (insp.visible !== lastInspectorVisible) {
			lastInspectorVisible = insp.visible;
			if (insp.visible && insp.window === null) {
				dispatchInspectorRequest(0);
			}
		}
		if (insp.visible) {
			const w = insp.window;
			const scroll = insp.scrollOffset;
			if (w === null) {
				dispatchInspectorRequest(scroll);
			} else if (scroll < w.offset || scroll >= w.offset + w.n) {
				dispatchInspectorRequest(scroll);
			}
		}
	});

	// Disposal: webview reload / panel close. Wire on beforeunload too
	// for symmetry; VS Code's webview lifecycle calls window's unload
	// when the panel disposes.
	window.addEventListener('beforeunload', () => {
		disposed = true;
		liveSubscription();
		inspectorViewSub();
		unsavedSub();
		promoteSub();
		promoteToChartBtn.removeEventListener('click', onPromoteClick);
		themeObserver.disconnect();
		resizeObserver.disconnect();
		if (resizeTimer !== null) { clearTimeout(resizeTimer); }
		announcer.dispose();
		columnPanel.dispose();
		chartType.dispose();
		encoding.dispose();
		transformList.dispose();
		preview.dispose();
		inspectorPanel.dispose();
		renderer.dispose();
		inspectorToggleBtn.removeEventListener('click', onToggleClick);
		window.removeEventListener('keydown', onKeyDown);
	});
}

/** Phase 6 helper: shallow values() of the inspector filters map,
 *  preserving order by sorted column name so the JSON cache key on
 *  the daemon side stays stable across reorderings. */
function filtersValues(
	filters: import('../qviz/state/inspectorState').InspectorState['filters'],
): import('../../src/qviz/messageProtocol').InspectorFilter[] {
	const names = Object.keys(filters).sort();
	const out: import('../../src/qviz/messageProtocol').InspectorFilter[] = [];
	for (const n of names) {
		const f = filters[n];
		if (f !== undefined) { out.push(f); }
	}
	return out;
}

function dispatchExtensionMessage(
	store: ReturnType<typeof createStore>, msg: ExtensionMessage,
): void {
	switch (msg.type) {
		case 'init':
			store.dispatch({
				type: 'init',
				fsPath: msg.fsPath,
				spec: msg.spec,
				schema: msg.schema,
				capabilities: msg.capabilities,
				lastSavedHash: msg.lastSavedHash,
			});
			return;
		case 'data':
			store.dispatch({
				type: 'dataReceived',
				requestId: msg.requestId,
				specHash: msg.specHash,
				arrow: msg.arrow,
				elapsedMs: msg.elapsedMs,
				cached: msg.cached,
				diagnostics: msg.diagnostics,
				// Front 2 (2026-05-14): pass through the per-transform
				// schema-snapshot attribution. Absent on pre-Front-2
				// daemons.
				...(msg.attribution !== undefined
					? { attribution: msg.attribution }
					: {}),
			});
			return;
		case 'error':
			store.dispatch({
				type: 'errorReceived',
				requestId: msg.requestId,
				specHash: msg.specHash,
				error: msg.error,
				errorKind: msg.errorKind,
				transformIndex: msg.transformIndex,
			});
			return;
		case 'schemaChanged':
			store.dispatch({
				type: 'schemaChanged',
				oldHash: msg.oldHash,
				newHash: msg.newHash,
				drift: msg.drift,
				newSchema: msg.newSchema,
				missingFields: msg.missingFields,
			});
			return;
		case 'daemonStatus':
			store.dispatch({
				type: 'daemonStatus',
				status: msg.status,
				retryInMs: msg.retryInMs,
				lastError: msg.lastError,
			});
			return;
		case 'theme':
			store.dispatch({ type: 'themeUpdated', tokens: msg.tokens });
			return;
		case 'saveResult':
			if (msg.status === 'ok') {
				store.dispatch({
					type: 'saveResult', status: 'ok',
					specHash: msg.specHash, fsPath: msg.fsPath,
				});
			} else {
				store.dispatch({
					type: 'saveResult', status: 'failed',
					specHash: msg.specHash, error: msg.error,
				});
			}
			return;
		case 'capabilities':
			store.dispatch({
				type: 'capabilitiesUpdated', capabilities: msg.capabilities,
			});
			return;
		case 'datasetStatus':
			store.dispatch({
				type: 'datasetStatus',
				status: msg.status,
				datasetUri: msg.datasetUri,
				error: msg.error,
			});
			return;
		case 'saveStarted':
			// Megaudit-2 (revealed by CODEX-12 enabling qviz-spec
			// compilation): the provider broadcasts a `saveStarted`
			// envelope immediately BEFORE the disk write so the
			// webview's persistence slice records the in-flight save
			// hash. Without this case the protocol validator accepted
			// the message but the switch fell through to the `never`
			// branch and threw -- silent because the validator's
			// envelope handler logged + dropped. Now wired into the
			// store.
			store.dispatch({
				type: 'saveStarted',
				specHash: msg.specHash,
			});
			return;
		case 'inspectorData':
			store.dispatch({
				type: 'inspectorDataReceived',
				arrow: msg.arrow,
				offset: msg.offset,
				n: msg.n,
				total: msg.total,
				elapsedMs: msg.elapsedMs,
			});
			return;
		case 'inspectorError':
			// Megaudit D3 (2026-05-13): forward `errorKind` -- the
			// previous dispatch dropped it, so the state slice's
			// lastErrorKind never got set and the Retry button was
			// rendered uniformly even for terminal kinds like
			// `security` or `protocol`.
			store.dispatch({
				type: 'inspectorError',
				error: msg.error,
				errorKind: msg.errorKind,
			});
			return;
		case 'columnStats':
			store.dispatch({
				type: 'columnStatsReceived',
				column: msg.column,
				stats: msg.stats,
			});
			return;
		case 'columnStatsError':
			store.dispatch({
				type: 'columnStatsError',
				column: msg.column,
				error: msg.error,
			});
			return;
		default: {
			const exhaustive: never = msg;
			throw new Error(`unknown ExtensionMessage: ${JSON.stringify(exhaustive)}`);
		}
	}
}

async function renderActiveData(
	renderer: RendererHost, spec: QvizSpec, arrow: Uint8Array,
	// Megaudit-2 A3-MAJOR-4 / CODEX-10: the spec hash this render is
	// FOR, captured at trigger time. Threaded into dispatchers so
	// errors attribute to the SPEC THAT FAILED, not whichever spec
	// happens to be in state.query.lastData when the failure dispatches.
	triggerSpecHash: string,
	dispatchExtractError: (triggerSpecHash: string, message: string) => void,
	dispatchRenderError: (triggerSpecHash: string, stage: string, message: string) => void,
	// Front 2 (2026-05-14): per-transform schema-snapshot attribution from
	// `state.query.lastData.attribution`. Threaded into the renderer so
	// "column not in data" errors name the responsible transform. `null`
	// on pre-Front-2 daemons; the renderer falls back to plain messages.
	attribution: readonly TransformAttribution[] | null,
): Promise<void> {
	let columns: ColumnData;
	try {
		columns = extractColumnsFromArrowIpc(arrow);
	} catch (e) {
		// Megaudit M-6: surface the extraction failure to the
		// diagnostics readout via an action, not just console.error.
		const message = `arrow extraction failed: ${(e as Error).message}`;
		console.error('qviz-spec:', message);
		dispatchExtractError(triggerSpecHash, message);
		return;
	}
	const theme = readThemeFromCssVars();
	const result = await renderer.render(spec, columns, theme, attribution);
	if (!result.ok) {
		// Megaudit M-7: surface render failures to the diagnostics
		// readout too.
		const message = `renderer ${result.stage} failed: ${result.error}`;
		console.warn('qviz-spec:', message);
		dispatchRenderError(triggerSpecHash, result.stage, message);
	}
}

/** Read the VS Code CSS custom properties into a single token bag.
 *  Both `readThemeFromCssVars()` (QvizTheme -- what the renderer wants)
 *  and `readThemeTokensFromCssVars()` (ThemeTokens -- what the protocol
 *  action carries) project from this same bag. */
function readVscodeCssBag(): {
	background: string;
	foreground: string;
	editorBackground: string;
	border: string;
	accent: string;
	axisGrid: string;
	axisText: string;
	seriesPalette: string[];
} {
	const styles = getComputedStyle(document.body);
	// Megaudit M-13: warn (once per session per missing var) when a
	// VS Code CSS custom property is missing/empty. Hardcoded
	// fallback colors silently substitute the user's theme -- log so
	// theme-integration regressions are diagnosable.
	const warned = new Set<string>();
	const get = (name: string, fallback: string): string => {
		const v = styles.getPropertyValue(name).trim();
		if (v.length > 0) { return v; }
		if (!warned.has(name)) {
			warned.add(name);
			console.warn(
				`qviz-spec: VS Code CSS variable ${name} is missing/empty; `
				+ `falling back to ${fallback}. Theme integration may be degraded.`,
			);
		}
		return fallback;
	};
	return {
		background: get('--vscode-editor-background', '#0a0f18'),
		foreground: get('--vscode-editor-foreground', '#e7e9ee'),
		editorBackground: get('--vscode-editor-background', '#0a0f18'),
		border: get('--vscode-panel-border', '#262d39'),
		accent: get('--vscode-focusBorder', '#fc7432'),
		axisGrid: get('--vscode-editorWhitespace-foreground', 'rgba(255,255,255,0.06)'),
		axisText: get('--vscode-descriptionForeground', 'rgba(231,233,238,0.7)'),
		seriesPalette: [
			get('--vscode-charts-blue', '#4fc3f7'),
			get('--vscode-charts-green', '#81c784'),
			get('--vscode-charts-yellow', '#fff176'),
			get('--vscode-charts-orange', '#ffb74d'),
			get('--vscode-charts-red', '#e57373'),
			get('--vscode-charts-purple', '#ba68c8'),
		],
	};
}

function readThemeFromCssVars(): QvizTheme {
	const bag = readVscodeCssBag();
	return {
		background: bag.background,
		foreground: bag.foreground,
		grid: bag.axisGrid,
		axisText: bag.axisText,
		seriesPalette: bag.seriesPalette,
	};
}

function readThemeTokensFromCssVars(): ThemeTokens {
	const bag = readVscodeCssBag();
	return {
		background: bag.background,
		foreground: bag.foreground,
		editorBackground: bag.editorBackground,
		border: bag.border,
		accent: bag.accent,
		axisGrid: bag.axisGrid,
		axisText: bag.axisText,
		seriesPalette: bag.seriesPalette,
	};
}

document.addEventListener('DOMContentLoaded', init);
