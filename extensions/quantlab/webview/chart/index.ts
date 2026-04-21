/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChartClient } from './chartApi';
import { ParameterPanel } from './parameterPanel';
import { createMessageHandler } from './messageHandler';
import { installErrorBoundary } from './errorBoundary';
import { applyReducedMotion, applyTheme, ReducedMotionMode, ThemePayload } from '../shared/appearance';

declare function acquireVsCodeApi(): {
	postMessage: (message: unknown) => void;
	getState?: () => unknown;
	setState?: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('chart-root');

if (!root) {
	throw new Error('Chart root not found');
}

const toolbar = document.createElement('div');
toolbar.className = 'toolbar';

// --- Data source dropdown ---
const dataSourceContainer = document.createElement('div');
dataSourceContainer.className = 'data-source-container';

const dataSourceButton = document.createElement('button');
dataSourceButton.className = 'data-source-button';
dataSourceButton.textContent = 'No Data';
dataSourceButton.title = 'Select a data source';
dataSourceButton.addEventListener('click', () => {
	dataSourceDropdown.classList.toggle('show');
});

const dataSourceDropdown = document.createElement('div');
dataSourceDropdown.className = 'data-source-dropdown';

// Browse button at bottom of dropdown
const browseOption = document.createElement('div');
browseOption.className = 'data-source-option browse';
browseOption.textContent = 'Browse Local Files...';
browseOption.addEventListener('click', () => {
	dataSourceDropdown.classList.remove('show');
	vscode.postMessage({ type: 'requestFilePicker' });
});
dataSourceDropdown.appendChild(browseOption);

dataSourceContainer.append(dataSourceButton, dataSourceDropdown);

// Close dropdown when clicking outside
document.addEventListener('click', (event) => {
	if (!dataSourceContainer.contains(event.target as Node)) {
		dataSourceDropdown.classList.remove('show');
	}
});

// --- Timeframe label (read-only) ---
const timeframeLabel = document.createElement('span');
timeframeLabel.className = 'timeframe-label';
timeframeLabel.textContent = '';

const strategyButton = document.createElement('button');
strategyButton.textContent = 'Strategy';
strategyButton.classList.add('toggle');
strategyButton.setAttribute('aria-pressed', 'true');

const dateStart = document.createElement('input');
dateStart.type = 'date';
const dateEnd = document.createElement('input');
dateEnd.type = 'date';

const applyDateRange = () => {
	if (!dateStart.value || !dateEnd.value) {
		return;
	}
	vscode.postMessage({
		type: 'overrideDateRange',
		range: { start: dateStart.value, end: dateEnd.value }
	});
};

dateStart.addEventListener('change', applyDateRange);
dateEnd.addEventListener('change', applyDateRange);

const complexityBadge = document.createElement('div');
complexityBadge.className = 'complexity safe';
complexityBadge.textContent = 'Complexity: safe';

const refreshButton = document.createElement('button');
refreshButton.textContent = 'Refresh';
refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

const screenshotButton = document.createElement('button');
screenshotButton.textContent = 'Screenshot';
screenshotButton.addEventListener('click', () => vscode.postMessage({ type: 'screenshot' }));

const fullscreenButton = document.createElement('button');
fullscreenButton.className = 'toolbar-icon-button';
fullscreenButton.title = 'Toggle Fullscreen';
fullscreenButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/></svg>';
fullscreenButton.addEventListener('click', () => vscode.postMessage({ type: 'toggleFullscreen' }));

const settingsButton = document.createElement('button');
settingsButton.textContent = 'Settings';
settingsButton.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

const leftGroup = document.createElement('div');
leftGroup.className = 'toolbar-group';
leftGroup.append(dataSourceContainer, timeframeLabel, strategyButton, dateStart, dateEnd);

const rightGroup = document.createElement('div');
rightGroup.className = 'toolbar-group';
rightGroup.append(refreshButton, screenshotButton, fullscreenButton, settingsButton);

const spacer = document.createElement('div');
spacer.className = 'spacer';

toolbar.append(leftGroup, complexityBadge, spacer, rightGroup);

const banner = document.createElement('div');
banner.id = 'banner';

const noVizPrompt = document.createElement('div');
noVizPrompt.className = 'no-viz';

const noVizText = document.createElement('div');
noVizText.className = 'no-viz-text';
noVizText.textContent = 'No visualization code found. Add visualize() to customize chart output.';

const noVizActions = document.createElement('div');
noVizActions.className = 'no-viz-actions';

const addVizButton = document.createElement('button');
addVizButton.textContent = 'Add visualize()';
addVizButton.addEventListener('click', () => vscode.postMessage({ type: 'addVisualization' }));

const generateVizButton = document.createElement('button');
generateVizButton.textContent = 'Generate with AI';
generateVizButton.classList.add('primary');
generateVizButton.addEventListener('click', () => vscode.postMessage({ type: 'generateVisualization' }));

noVizActions.append(addVizButton, generateVizButton);
noVizPrompt.append(noVizText, noVizActions);

const chartContainer = document.createElement('div');
chartContainer.id = 'chart-container';

const errorOverlay = document.createElement('div');
errorOverlay.className = 'error-overlay';
const errorContent = document.createElement('div');
errorContent.className = 'error-content';
errorContent.setAttribute('role', 'alert');
const errorMessage = document.createElement('div');
errorMessage.className = 'error-message';
const errorActions = document.createElement('div');
errorActions.className = 'error-actions';
errorContent.append(errorMessage, errorActions);
errorOverlay.appendChild(errorContent);
chartContainer.appendChild(errorOverlay);

// --- LHS Chart Tools Toolbar ---
const lhsToolbar = document.createElement('div');
lhsToolbar.className = 'lhs-toolbar';

const lhsToggle = document.createElement('button');
lhsToggle.className = 'lhs-toolbar-toggle';
lhsToggle.title = 'Chart Tools';
const lhsToggleIcon = document.createElement('span');
lhsToggleIcon.className = 'lhs-toolbar-toggle-icon';
lhsToggleIcon.textContent = '\u203A';
lhsToggle.appendChild(lhsToggleIcon);

const lhsTools = document.createElement('div');
lhsTools.className = 'lhs-toolbar-tools';

const svgTool = (paths: string): string =>
	`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${paths}</svg>`;

const toolDefs = [
	{ id: 'crosshair', label: 'Crosshair', svg: svgTool('<path d="M8 2v12"/><path d="M2 8h12"/><circle cx="8" cy="8" r="3"/>') },
	{ id: 'hline', label: 'Horizontal Line', svg: svgTool('<path d="M2 8h12"/>') },
	{ id: 'trendline', label: 'Trend Line', svg: svgTool('<path d="M3 13L13 3"/>') },
	{ id: 'rectangle', label: 'Rectangle', svg: svgTool('<rect x="2.5" y="4" width="11" height="8" rx="1"/>') },
	{ id: 'measure', label: 'Measure', svg: svgTool('<path d="M2 8h12"/><path d="M5 5.5v5"/><path d="M8 6v4"/><path d="M11 5.5v5"/>') },
];

let activeToolId: string | null = null;

for (let i = 0; i < toolDefs.length; i++) {
	// Separator between crosshair (selection) and drawing tools
	if (i === 1) {
		const sep = document.createElement('div');
		sep.className = 'lhs-toolbar-separator';
		lhsTools.appendChild(sep);
	}

	const tool = toolDefs[i];
	const btn = document.createElement('button');
	btn.className = 'lhs-tool-button';
	btn.title = tool.label;
	btn.dataset.tool = tool.id;

	const iconSpan = document.createElement('span');
	iconSpan.className = 'lhs-tool-icon';
	iconSpan.innerHTML = tool.svg;
	btn.appendChild(iconSpan);

	btn.addEventListener('click', () => {
		if (activeToolId === tool.id) {
			activeToolId = null;
			btn.classList.remove('active');
		} else {
			lhsTools.querySelectorAll('.lhs-tool-button.active').forEach(b => b.classList.remove('active'));
			activeToolId = tool.id;
			btn.classList.add('active');
		}
		vscode.postMessage({ type: 'selectTool', tool: activeToolId });
	});

	lhsTools.appendChild(btn);
}

lhsToggle.addEventListener('click', () => {
	const expanded = lhsToolbar.classList.toggle('expanded');
	lhsToggle.title = expanded ? 'Hide Tools' : 'Chart Tools';
});

lhsToolbar.append(lhsToggle, lhsTools);
chartContainer.appendChild(lhsToolbar);

const panelRoot = document.createElement('div');
panelRoot.className = 'params-panel';

const panelHeader = document.createElement('div');
panelHeader.className = 'params-header';

const panelTitle = document.createElement('span');
panelTitle.textContent = 'Parameters';

const toggleButton = document.createElement('button');
toggleButton.textContent = 'Hide';

panelHeader.append(panelTitle, toggleButton);

const panelList = document.createElement('div');
panelList.className = 'params-list';

const panelActions = document.createElement('div');
panelActions.className = 'params-actions';

const resetButton = document.createElement('button');
resetButton.textContent = 'Reset to Defaults';

const applyButton = document.createElement('button');
applyButton.textContent = 'Apply to Code';
applyButton.classList.add('primary');

panelActions.append(resetButton, applyButton);
panelRoot.append(panelHeader, panelList, panelActions);

root.append(toolbar, banner, noVizPrompt, chartContainer, panelRoot);

applyReducedMotion('auto');

const chartClient = new ChartClient(chartContainer);
const storedState = typeof vscode.getState === 'function' ? (vscode.getState() as { strategyPaneVisible?: boolean } | undefined) : undefined;
let strategyPaneVisible = storedState?.strategyPaneVisible ?? true;

const updateStrategyButton = (visible: boolean) => {
	strategyButton.textContent = visible ? 'Strategy' : 'Show Strategy';
	strategyButton.classList.toggle('toggle-off', !visible);
	strategyButton.setAttribute('aria-pressed', String(visible));
};

chartClient.setStrategyPaneVisible(strategyPaneVisible);
updateStrategyButton(strategyPaneVisible);

const parameterPanel = new ParameterPanel(
	panelList,
	(id, value) => vscode.postMessage({ type: 'parameterChange', id, value }),
	() => vscode.postMessage({ type: 'resetDefaults' }),
	() => vscode.postMessage({ type: 'applyToCode' })
);

parameterPanel.attachActions(resetButton, applyButton);

toggleButton.addEventListener('click', () => {
	const collapsed = panelRoot.classList.toggle('params-collapsed');
	toggleButton.textContent = collapsed ? 'Show' : 'Hide';
	vscode.postMessage({ type: 'toggleParameters', collapsed });
});

strategyButton.addEventListener('click', () => {
	strategyPaneVisible = chartClient.toggleStrategyPane();
	updateStrategyButton(strategyPaneVisible);
	if (typeof vscode.setState === 'function') {
		const currentState = typeof vscode.getState === 'function' ? (vscode.getState() as Record<string, unknown> | undefined) : undefined;
		vscode.setState({ ...(currentState ?? {}), strategyPaneVisible });
	}
});

chartContainer.addEventListener('dragover', event => {
	const types = Array.from(event.dataTransfer?.types ?? []);
	const valid = types.includes('application/quantlab-file') || types.includes('application/quantlab-run') || types.includes('text/plain');
	if (!valid) {
		return;
	}
	event.preventDefault();
	chartContainer.classList.add('drop-target');
});

chartContainer.addEventListener('dragleave', () => {
	chartContainer.classList.remove('drop-target');
});

chartContainer.addEventListener('drop', event => {
	event.preventDefault();
	chartContainer.classList.remove('drop-target');
	const data = event.dataTransfer;
	if (!data) {
		return;
	}

	const runId = data.getData('application/quantlab-run');
	if (runId) {
		vscode.postMessage({ type: 'dropRun', runId });
		return;
	}

	const filePath = data.getData('application/quantlab-file') || data.getData('text/plain');
	if (filePath) {
		vscode.postMessage({ type: 'dropFile', filePath });
	}
});

const handler = createMessageHandler({
	postMessage: message => vscode.postMessage(message),
	chart: chartClient,
	parameterPanel,
	banner,
	noViz: noVizPrompt,
	toolbar: {
		dataSourceButton,
		dataSourceDropdown,
		timeframeLabel,
		dateStart,
		dateEnd,
		complexity: complexityBadge
	},
	panelRoot,
	errorOverlay,
	errorMessage,
	errorActions
});

window.addEventListener('message', event => {
	const message = event.data as { type?: string; theme?: ThemePayload; mode?: ReducedMotionMode };
	if (message?.type === 'theme') {
		applyTheme(message.theme);
		return;
	}
	if (message?.type === 'reducedMotion') {
		applyReducedMotion(message.mode ?? 'auto');
		return;
	}
	handler(event.data);
});

installErrorBoundary(message => {
	handler({ type: 'showError', message, actions: ['reload', 'editVisualization'] });
});

vscode.postMessage({ type: 'ready' });

document.addEventListener('visibilitychange', () => {
	if (!document.hidden) {
		requestAnimationFrame(() => chartClient.refreshLayout());
	}
});
