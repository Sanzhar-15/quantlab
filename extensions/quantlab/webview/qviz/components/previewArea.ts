/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * previewArea — Phase 5 step 5.D.4.
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

export function mountPreviewArea(root: HTMLElement, store: QvizStore): PreviewAreaHandle {
	root.classList.add('qviz-preview-area');
	root.innerHTML = `
		<div class="qviz-preview-stripe" role="status" aria-live="polite"></div>
		<div class="qviz-preview-chart"></div>
		<div class="qviz-preview-diagnostics" role="log" aria-live="polite"></div>
	`;
	const stripe = root.querySelector<HTMLElement>('.qviz-preview-stripe')!;
	const chartContainer = root.querySelector<HTMLElement>('.qviz-preview-chart')!;
	const diagnostics = root.querySelector<HTMLElement>('.qviz-preview-diagnostics')!;

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
				messages.push('Data file changed — schema preserved; save to refresh provenance');
				break;
			case 'fields-missing':
				messages.push(
					`Data file changed — ${state.schema.missingFields.length} field(s) missing: `
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
					messages.push(`Dataset access denied: ${uri}${err ? ' — ' + err : ''}`);
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
		stripe.textContent = messages.join(' · ');
		stripe.style.display = messages.length === 0 ? 'none' : '';
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
			lines.push(`Render OK — daemon elapsed ${ms.toFixed(1)}ms${cached}`);
			for (const d of state.query.lastData.diagnostics) {
				lines.push(`  • ${d}`);
			}
		}
		diagnostics.textContent = lines.join('\n');
	};

	const onStateChange = (): void => {
		renderStripe();
		renderDiagnostics();
	};

	const unsubscribe = store.subscribe(onStateChange);
	// Paint once with initial state.
	onStateChange();

	return {
		chartContainer,
		dispose: () => {
			unsubscribe();
			root.innerHTML = '';
			root.classList.remove('qviz-preview-area');
		},
	};
}
