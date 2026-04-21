/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActionState, StrategyInfo } from '../../src/types/action';
import type { HistoryEntry } from '../../src/types/history';
import { renderPromptState } from './states/prompt';
import { renderSelectionState } from './states/selection';
import { renderConfigurationState, handleSetFieldValue, updateColumnOptions } from './states/configuration';
import { renderRunningState } from './states/running';
import { renderResultsState } from './states/results';
import { applyReducedMotion, applyTheme, ReducedMotionMode, ThemePayload } from '../shared/appearance';

declare function acquireVsCodeApi(): { postMessage: (message: unknown) => void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('action-root');

if (!root) {
	throw new Error('Action root not found');
}

const container = document.createElement('div');
container.className = 'action-shell';
root.appendChild(container);

const handleRunDrag = (event: DragEvent): boolean => {
	const types = Array.from(event.dataTransfer?.types ?? []);
	if (!types.includes('application/quantlab-run')) {
		return false;
	}
	event.preventDefault();
	return true;
};

container.addEventListener('dragover', event => {
	if (!handleRunDrag(event)) {
		return;
	}
	container.classList.add('drop-target');
});

container.addEventListener('dragleave', () => {
	container.classList.remove('drop-target');
});

container.addEventListener('drop', event => {
	if (!handleRunDrag(event)) {
		return;
	}
	container.classList.remove('drop-target');
	const runId = event.dataTransfer?.getData('application/quantlab-run');
	if (runId) {
		postMessage({ type: 'selectRun', runId });
	}
});

const announcer = document.createElement('div');
announcer.className = 'sr-announcer';
announcer.setAttribute('role', 'status');
announcer.setAttribute('aria-live', 'polite');
announcer.setAttribute('aria-atomic', 'true');
root.appendChild(announcer);

applyReducedMotion('auto');

let strategyInfo: StrategyInfo | undefined;
let fileType: 'strategy' | 'data' = 'strategy';
let recentRuns: HistoryEntry[] = [];
let currentState: ActionState | undefined;
let lastProgressBucket = -1;
let dataSourceMetadata: { dateRange?: { start: string; end: string } } | undefined;

const postMessage = (message: unknown) => vscode.postMessage(message);

function render(): void {
	if (!currentState) {
		container.innerHTML = '<div class="empty-state">Loading Action view...</div>';
		return;
	}

	switch (currentState.type) {
		case 'prompt':
			renderPromptState(container, currentState, { postMessage });
			lastProgressBucket = -1;
			return;
		case 'selection':
			renderSelectionState(container, currentState, { strategy: strategyInfo, postMessage });
			lastProgressBucket = -1;
			return;
		case 'configuration':
			renderConfigurationState(container, currentState, { postMessage });
			// Setup date range presets if metadata is already available
			setupDateRangePresets();
			lastProgressBucket = -1;
			return;
		case 'running':
			renderRunningState(container, currentState, { postMessage });
			announceProgress(currentState.progress);
			return;
		case 'results':
			renderResultsState(container, currentState, { postMessage });
			lastProgressBucket = -1;
			return;
		default:
			container.innerHTML = '<div class="empty-state">Unknown Action state.</div>';
			return;
	}
}

function announceProgress(progress: number): void {
	const bucket = progress >= 100 ? 100 : progress >= 75 ? 75 : progress >= 50 ? 50 : progress >= 25 ? 25 : -1;
	if (bucket <= lastProgressBucket) {
		return;
	}
	lastProgressBucket = bucket;
	if (bucket > 0) {
		announcer.textContent = `Job progress ${bucket} percent.`;
	}
}

function setupDateRangePresets(): void {
	if (!dataSourceMetadata?.dateRange) {
		return;
	}

	const dateStart = container.querySelector<HTMLInputElement>('#dateStart');
	const dateEnd = container.querySelector<HTMLInputElement>('#dateEnd');

	if (!dateStart || !dateEnd) {
		return;
	}

	// Check if presets already exist
	if (container.querySelector('.date-range-presets')) {
		return;
	}

	// Create preset container
	const presetsContainer = document.createElement('div');
	presetsContainer.className = 'date-range-presets';
	presetsContainer.innerHTML = `
		<button type="button" class="preset-btn" data-preset="all">All Data</button>
		<button type="button" class="preset-btn" data-preset="ytd">YTD</button>
		<button type="button" class="preset-btn" data-preset="1y">Last Year</button>
		<button type="button" class="preset-btn" data-preset="6m">6 Months</button>
		<button type="button" class="preset-btn" data-preset="3m">3 Months</button>
	`;

	// Insert before date inputs
	const dateStartField = dateStart.closest('.form-field');
	if (dateStartField) {
		dateStartField.parentElement?.insertBefore(presetsContainer, dateStartField);
	}

	// Attach event listeners
	const presetButtons = presetsContainer.querySelectorAll<HTMLButtonElement>('.preset-btn');
	for (const btn of presetButtons) {
		btn.addEventListener('click', () => {
			const preset = btn.getAttribute('data-preset');
			if (!preset || !dataSourceMetadata?.dateRange) {
				return;
			}

			const now = new Date();
			let start: string, end: string;

			switch (preset) {
				case 'all':
					start = dataSourceMetadata.dateRange.start;
					end = dataSourceMetadata.dateRange.end;
					break;
				case 'ytd':
					start = `${now.getFullYear()}-01-01`;
					end = now.toISOString().split('T')[0];
					break;
				case '1y': {
					const oneYearAgo = new Date(now);
					oneYearAgo.setFullYear(now.getFullYear() - 1);
					start = oneYearAgo.toISOString().split('T')[0];
					end = now.toISOString().split('T')[0];
					break;
				}
				case '6m': {
					const sixMonthsAgo = new Date(now);
					sixMonthsAgo.setMonth(now.getMonth() - 6);
					start = sixMonthsAgo.toISOString().split('T')[0];
					end = now.toISOString().split('T')[0];
					break;
				}
				case '3m': {
					const threeMonthsAgo = new Date(now);
					threeMonthsAgo.setMonth(now.getMonth() - 3);
					start = threeMonthsAgo.toISOString().split('T')[0];
					end = now.toISOString().split('T')[0];
					break;
				}
				default:
					return;
			}

			dateStart.value = start;
			dateEnd.value = end;

			// Trigger change events for validation
			dateStart.dispatchEvent(new Event('change', { bubbles: true }));
			dateEnd.dispatchEvent(new Event('change', { bubbles: true }));

			// Update active state
			for (const b of presetButtons) {
				b.classList.remove('active');
			}
			btn.classList.add('active');
		});
	}
}

function handleMessage(message: unknown): void {
	if (!message || typeof message !== 'object' || !('type' in message)) {
		return;
	}

	const payload = message as { type: string };
	if (payload.type === 'init') {
		const init = payload as { strategy?: StrategyInfo; fileType?: 'strategy' | 'data'; recentRuns?: HistoryEntry[] };
		strategyInfo = init.strategy;
		fileType = init.fileType ?? 'strategy';
		recentRuns = Array.isArray(init.recentRuns) ? init.recentRuns : [];
		if (currentState && currentState.type === 'selection' && !currentState.recentRuns.length) {
			currentState = { ...currentState, recentRuns };
		}
		render();
		return;
	}

	if (payload.type === 'theme') {
		const themeMessage = payload as { theme?: ThemePayload };
		applyTheme(themeMessage.theme);
		return;
	}

	if (payload.type === 'reducedMotion') {
		const motionMessage = payload as { mode?: ReducedMotionMode };
		applyReducedMotion(motionMessage.mode ?? 'auto');
		return;
	}

	if (payload.type === 'setFieldValue') {
		const fieldMessage = payload as { fieldId: string; value: string; displayName: string };
		if (fieldMessage.fieldId) {
			handleSetFieldValue(container, fieldMessage.fieldId, fieldMessage.value, fieldMessage.displayName);
		}
		return;
	}

	if (payload.type === 'setColumnOptions') {
		const msg = payload as { options: Array<{ label: string; value: string }> };
		updateColumnOptions(container, msg.options);
		return;
	}

	if (payload.type === 'setDataSourceMetadata') {
		const msg = payload as { metadata: { dateRange?: { start: string; end: string } } };
		dataSourceMetadata = msg.metadata;
		setupDateRangePresets();
		return;
	}

	if (payload.type === 'setState') {
		const stateMessage = payload as { state?: ActionState };
		if (!stateMessage.state || typeof stateMessage.state !== 'object' || !('type' in stateMessage.state)) {
			return;
		}
		currentState = stateMessage.state;
		if (currentState.type === 'selection' && !currentState.recentRuns.length) {
			currentState = { ...currentState, recentRuns };
		}
		render();
	}
}

window.addEventListener('message', event => handleMessage(event.data));

postMessage({ type: 'ready' });
