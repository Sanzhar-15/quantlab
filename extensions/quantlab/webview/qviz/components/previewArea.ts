/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * previewArea -- Phase 5 step 5.D.4.
 *
 * Renders the chart preview pane: a chart container (handed to
 * `RendererHost`), a stripe row for stale-chart / drift indicators,
 * and a diagnostics readout that shows compile / apply errors and the
 * last successful render's elapsed time.
 *
 * Component model: the function `mountPreviewArea(root, store)` mounts
 * the component into `root`, subscribes to the store, and returns a
 * `Disposable` that detaches everything.
 *
 * The chart container is exposed via `getContainer()` on the returned
 * handle so the live-preview wiring can construct a `RendererHost`
 * against it.
 */

import type { QvizStore } from '../state/store';
import { hasStaleChart } from '../state/queryState';

export interface PreviewAreaHandle {
	readonly chartContainer: HTMLElement;
	dispose(): void;
}

export interface PreviewAreaCallbacks {
	/** Phase 8 Step D: "Retry connection" button on the daemon-status
	 *  banner. Host wires this to a `retryDaemon` postMessage. */
	readonly onRetryDaemon?: () => void;
	/** Phase 8 Step D: "Re-check file" button on the dataset-status
	 *  banner. Host wires this to a `recheckDataset` postMessage. */
	readonly onRecheckDataset?: () => void;
}

export function mountPreviewArea(
	root: HTMLElement, store: QvizStore, cbs: PreviewAreaCallbacks = {},
): PreviewAreaHandle {
	root.classList.add('qviz-preview-area');
	// Phase 8 Step C: chart-area loading skeleton is a sibling element
	// of the chart container, positioned absolutely over it via CSS so
	// the chart canvas underneath isn't disrupted on inflight transitions.
	// Hidden by default; toggled via [hidden] when state.query.inflight
	// transitions to non-null.
	root.innerHTML = `
		<div class="qviz-preview-stripe" role="status" aria-live="polite">
			<span class="qviz-preview-stripe-message"></span>
			<button class="qviz-preview-retry-daemon" type="button" hidden>Retry connection</button>
			<button class="qviz-preview-recheck-dataset" type="button" hidden>Re-check file</button>
		</div>
		<div class="qviz-preview-chart-wrap">
			<div class="qviz-preview-chart"></div>
			<div class="qviz-preview-skeleton" hidden aria-hidden="true">
				<div class="qviz-skel-bar qviz-skel-bar-1"></div>
				<div class="qviz-skel-bar qviz-skel-bar-2"></div>
				<div class="qviz-skel-bar qviz-skel-bar-3"></div>
				<div class="qviz-skel-bar qviz-skel-bar-4"></div>
				<div class="qviz-skel-axis"></div>
			</div>
		</div>
		<div class="qviz-preview-diagnostics" role="log" aria-live="polite"></div>
	`;
	const stripe = root.querySelector<HTMLElement>('.qviz-preview-stripe')!;
	const stripeMessage = root.querySelector<HTMLElement>('.qviz-preview-stripe-message')!;
	const retryDaemonBtn = root.querySelector<HTMLButtonElement>('.qviz-preview-retry-daemon')!;
	const recheckDatasetBtn = root.querySelector<HTMLButtonElement>('.qviz-preview-recheck-dataset')!;
	const chartContainer = root.querySelector<HTMLElement>('.qviz-preview-chart')!;
	const skeleton = root.querySelector<HTMLElement>('.qviz-preview-skeleton')!;
	const diagnostics = root.querySelector<HTMLElement>('.qviz-preview-diagnostics')!;

	// Phase 8 Step D: retry-button click wiring. Each button hidden by
	// default; renderStripe toggles visibility based on the current
	// daemonStatus / datasetStatus.
	const onRetryClick = (): void => { cbs.onRetryDaemon?.(); };
	const onRecheckClick = (): void => { cbs.onRecheckDataset?.(); };
	retryDaemonBtn.addEventListener('click', onRetryClick);
	recheckDatasetBtn.addEventListener('click', onRecheckClick);

	const renderStripe = (): void => {
		const state = store.getState();
		const messages: string[] = [];
		if (state.query.inflight !== null) {
			messages.push('computing…');
		}
		if (hasStaleChart(state.query)) {
			messages.push('Last successful render from previous spec');
		}
		switch (state.schema.drift) {
			case 'fields-preserved':
				messages.push('Data file changed -- schema preserved; save to refresh provenance');
				break;
			case 'fields-missing':
				messages.push(
					`Data file changed -- ${state.schema.missingFields.length} field(s) missing: `
					+ state.schema.missingFields.join(', '),
				);
				break;
			case 'same-hash':
			case null:
				break;
		}
		switch (state.runtime.daemonStatus) {
			case 'crashed':
				messages.push(`Daemon crashed; retrying in ${state.runtime.daemonRetryInMs ?? 0}ms`);
				break;
			case 'respawning':
				messages.push('Daemon respawning…');
				break;
			case 'disposing':
				// Megaudit E8 (2026-05-13): transient state between
				// dispose() invocation and the terminal `unavailable`
				// transition. The banner stops showing `ready` here
				// so the user sees the shutdown immediately rather
				// than mid-flight requests "succeeding" against a
				// daemon that's tearing down.
				messages.push('Daemon shutting down…');
				break;
			case 'unavailable':
				messages.push(
					`Daemon unavailable${state.runtime.daemonLastError ? `: ${state.runtime.daemonLastError}` : ''}`,
				);
				break;
		}
		// Step 5.I.3: dataset-availability banner. Distinct from
		// daemon status so the user sees the actual cause.
		const dataset = state.runtime.datasetStatus;
		if (dataset !== 'ok') {
			const uri = state.runtime.datasetUri ?? '?';
			const err = state.runtime.datasetError ?? '';
			switch (dataset) {
				case 'missing':
					messages.push(`Dataset file not found: ${uri}`);
					break;
				case 'dangling-symlink':
					messages.push(`Dataset symlink target gone: ${uri}`);
					break;
				case 'access-denied':
					messages.push(`Dataset access denied: ${uri}${err ? ' -- ' + err : ''}`);
					break;
				case 'path-escape':
					messages.push(`Dataset path is not workspace-relative: ${uri}`);
					break;
				case 'extension-not-allowed':
					messages.push(`Dataset extension not supported: ${uri}`);
					break;
				case 'no-workspace':
					messages.push('No workspace folder is open; cannot resolve dataset.');
					break;
			}
		}
		stripeMessage.textContent = messages.join(' · ');
		stripe.style.display = messages.length === 0 ? 'none' : '';
		// Phase 8 Step D: surface retry actions for the recoverable
		// daemon / dataset failure modes. Buttons are inside the stripe
		// so they sit next to the relevant error text.
		const ds = store.getState().runtime.daemonStatus;
		const showRetryDaemon = ds === 'crashed' || ds === 'respawning' || ds === 'unavailable';
		const tds = store.getState().runtime.datasetStatus;
		const showRecheckDataset = tds !== 'ok' && tds !== null;
		retryDaemonBtn.hidden = !showRetryDaemon;
		recheckDatasetBtn.hidden = !showRecheckDataset;
	};

	const renderDiagnostics = (): void => {
		const state = store.getState();
		const lines: string[] = [];
		if (state.query.lastErrorMessage !== null) {
			const kind = state.query.lastErrorKind ?? 'error';
			const transformPart = state.query.lastErrorTransformIndex !== null
				? ` (transform #${state.query.lastErrorTransformIndex})` : '';
			lines.push(`[${kind}]${transformPart} ${state.query.lastErrorMessage}`);
		} else if (state.query.lastData !== null) {
			const ms = state.query.lastData.elapsedMs;
			const cached = state.query.lastData.cached ? ' (cached)' : '';
			lines.push(`Render OK -- daemon elapsed ${ms.toFixed(1)}ms${cached}`);
			for (const d of state.query.lastData.diagnostics) {
				lines.push(`  • ${d}`);
			}
		}
		diagnostics.textContent = lines.join('\n');
	};

	const renderSkeleton = (): void => {
		// Phase 8 Step C: show the skeleton overlay while the daemon is
		// computing the next aggregate. Cleared the instant
		// state.query.inflight returns to null (same reducer tick that
		// receives `dataReceived` / `error`), so the skeleton never
		// outlives the actual chart paint.
		const inflight = store.getState().query.inflight !== null;
		skeleton.hidden = !inflight;
	};

	const onStateChange = (): void => {
		renderStripe();
		renderSkeleton();
		renderDiagnostics();
	};

	const unsubscribe = store.subscribe(onStateChange);
	// Paint once with initial state.
	onStateChange();

	return {
		chartContainer,
		dispose: () => {
			retryDaemonBtn.removeEventListener('click', onRetryClick);
			recheckDatasetBtn.removeEventListener('click', onRecheckClick);
			unsubscribe();
			root.innerHTML = '';
			root.classList.remove('qviz-preview-area');
		},
	};
}
