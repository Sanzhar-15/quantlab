/*---------------------------------------------------------------------------------------------
 *  Prompt state renderer - shown when Action view opens.
 *  Prompts users to select an action from the Resources panel.
 *--------------------------------------------------------------------------------------------*/

import type { ActionPromptState } from '../../../src/types/action';
import { escapeHtml } from '../utils';

interface PromptContext {
	postMessage: (message: unknown) => void;
}

export function renderPromptState(container: HTMLElement, state: ActionPromptState, _context: PromptContext): void {
	const fileName = state.filePath.split(/[/\\]/).pop() ?? '';
	const fileLabel = state.fileType === 'strategy' ? 'strategy' : 'data file';

	container.innerHTML = `
		<div class="action-page prompt-state">
			<div class="prompt-content">
				<div class="prompt-icon">
					<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M30 24H10M10 24L18 16M10 24L18 32" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
						<rect x="32" y="8" width="8" height="32" rx="4" fill="currentColor" opacity="0.15"/>
					</svg>
				</div>
				<h1 class="prompt-heading">Select an action</h1>
				<p class="prompt-subtitle">
					Choose an analysis from the <strong>Resources</strong> panel to get started with
					<span class="prompt-file-name" title="${escapeHtml(state.filePath)}">${escapeHtml(fileName)}</span>.
				</p>
				<p class="prompt-hint">
					The Resources panel is in the sidebar on the left. Browse ${state.fileType === 'data' ? 'statistical tests' : 'strategy tools'} and click one to configure it here.
				</p>
			</div>
		</div>
	`;
}
