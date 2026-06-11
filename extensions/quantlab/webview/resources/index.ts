/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//  Resources Panel Webview Script
//  Renders server catalog with per-section state, search, tier toggles,
//  implementation status, keyboard navigation, and collapse persistence.

// ---- Webview-local type definitions (cannot import from src/) ----

interface ResourceCategory {
	id: string;
	label: string;
	description: string;
	order: number;
	icon: string;
	context_hints: string[];
	tools: ResourceTool[];
}

interface ResourceTool {
	id: string;
	label: string;
	description: string;
	tier: 'essential' | 'advanced';
	implemented: boolean;
	cross_ref: string | null;
}

interface WorkflowTemplate {
	id: string;
	label: string;
	description: string;
	section: string;
	steps: string[];
}

interface CatalogPayload {
	statistics: ResourceCategory[];
	strategy: ResourceCategory[];
	workflows: WorkflowTemplate[];
	version: string;
}

type Section = 'strategy' | 'stats';

interface SectionState {
	searchQuery: string;
	expandedCategories: Set<string>;
	showAdvanced: Set<string>;
}

interface SavedState {
	section?: Section;
	showImplementedOnly?: boolean;
	workflowsExpanded?: boolean;
	sectionStates?: Record<Section, {
		searchQuery?: string;
		expandedCategories?: string[];
		showAdvanced?: string[];
	}>;
}

// Provider -> Webview message types
type ProviderMessage =
	| { type: 'setCatalog'; catalog: CatalogPayload; section: Section }
	| { type: 'setSection'; section: Section }
	| { type: 'navigateTo'; section: Section; categoryId: string; toolId: string }
	| { type: 'catalogError'; errorType: string; message: string; lastUpdated?: number }
	| { type: 'catalogUnavailable'; message: string }
	| { type: 'updateCategoryHighlight'; contextHint: string; matchingCategoryIds: string[] };

interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

// ---- Utilities ----

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function resolveIcon(serverIcon: string): string {
	return serverIcon || 'symbol-misc';
}

// ---- State ----

const vscode = acquireVsCodeApi();

let currentSection: Section = 'strategy';
let catalog: CatalogPayload | null = null;
let showImplementedOnly = false;
let workflowsExpanded = false;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const sectionStates: Record<Section, SectionState> = {
	strategy: { searchQuery: '', expandedCategories: new Set(), showAdvanced: new Set() },
	stats: { searchQuery: '', expandedCategories: new Set(), showAdvanced: new Set() },
};

function currentState(): SectionState {
	return sectionStates[currentSection];
}

// Restore persisted state
const savedState = vscode.getState() as SavedState | undefined;
if (savedState) {
	currentSection = savedState.section ?? 'strategy';
	showImplementedOnly = savedState.showImplementedOnly ?? false;
	workflowsExpanded = savedState.workflowsExpanded ?? false;
	if (savedState.sectionStates) {
		for (const sec of ['strategy', 'stats'] as const) {
			const ss = savedState.sectionStates[sec];
			if (ss) {
				sectionStates[sec] = {
					searchQuery: ss.searchQuery ?? '',
					expandedCategories: new Set(ss.expandedCategories ?? []),
					showAdvanced: new Set(ss.showAdvanced ?? []),
				};
			}
		}
	}
}

function persistState(): void {
	vscode.setState({
		section: currentSection,
		showImplementedOnly,
		workflowsExpanded,
		sectionStates: {
			strategy: {
				searchQuery: sectionStates.strategy.searchQuery,
				expandedCategories: [...sectionStates.strategy.expandedCategories],
				showAdvanced: [...sectionStates.strategy.showAdvanced],
			},
			stats: {
				searchQuery: sectionStates.stats.searchQuery,
				expandedCategories: [...sectionStates.stats.expandedCategories],
				showAdvanced: [...sectionStates.stats.showAdvanced],
			},
		},
	} satisfies SavedState);
}

// ---- Initialization ----

function init(): void {
	const root = document.getElementById('resources-root');
	if (!root) { return; }

	root.innerHTML = renderShell();
	bindShellEvents();

	// Show loading state
	const content = document.getElementById('section-content');
	if (content) {
		content.innerHTML = renderLoading();
	}

	// Listen for messages from extension
	window.addEventListener('message', event => {
		handleProviderMessage(event.data as ProviderMessage);
	});

	// Notify extension we're ready
	vscode.postMessage({ type: 'ready' });
}

function renderShell(): string {
	return `
		<div class="resources-container">
			<div class="section-switcher">
				<button class="section-btn${currentSection === 'strategy' ? ' active' : ''}" data-section="strategy">Strategy</button>
				<button class="section-btn${currentSection === 'stats' ? ' active' : ''}" data-section="stats">Statistics</button>
			</div>
			<div class="toolbar">
				<div class="search-container">
					<span class="codicon codicon-search"></span>
					<input type="text" class="search-input" placeholder="Search tools..."
						value="${escapeAttr(currentState().searchQuery)}" />
					<span class="codicon codicon-close search-clear"
						style="display:${currentState().searchQuery ? 'inline' : 'none'}"></span>
				</div>
				<button class="filter-toggle${showImplementedOnly ? ' active' : ''}"
					title="Show implemented tools only">
					<span class="codicon codicon-filter"></span>
				</button>
			</div>
			<div class="context-banner" style="display:none"></div>
			<div class="catalog-error-banner" style="display:none"></div>
			<div class="section-content" id="section-content" role="tree" aria-label="Resources"></div>
		</div>
	`;
}

function renderLoading(): string {
	return '<div class="catalog-loading"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading resources...</div>';
}

function renderUnavailable(message: string): string {
	return `
		<div class="catalog-unavailable">
			<span class="codicon codicon-cloud-download"></span>
			<p>${escapeHtml(message)}</p>
			<button class="retry-btn">Retry</button>
		</div>
	`;
}

// ---- Shell event binding ----

function bindShellEvents(): void {
	// Section buttons
	document.querySelectorAll('.section-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const section = btn.getAttribute('data-section') as Section;
			switchSection(section);
		});
	});

	// Search input
	const searchInput = document.querySelector('.search-input') as HTMLInputElement | null;
	if (searchInput) {
		searchInput.addEventListener('input', () => {
			const query = searchInput.value;
			currentState().searchQuery = query;

			// Show/hide clear button
			const clearBtn = document.querySelector('.search-clear') as HTMLElement;
			if (clearBtn) {
				clearBtn.style.display = query ? 'inline' : 'none';
			}

			// Debounced render
			if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); }
			searchDebounceTimer = setTimeout(() => {
				renderCurrentSection();
				persistState();
			}, 200);
		});
	}

	// Search clear button
	const clearBtn = document.querySelector('.search-clear');
	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			const input = document.querySelector('.search-input') as HTMLInputElement;
			if (input) {
				input.value = '';
				currentState().searchQuery = '';
				(clearBtn as HTMLElement).style.display = 'none';
				renderCurrentSection();
				persistState();
			}
		});
	}

	// Filter toggle
	const filterBtn = document.querySelector('.filter-toggle');
	if (filterBtn) {
		filterBtn.addEventListener('click', () => {
			showImplementedOnly = !showImplementedOnly;
			filterBtn.classList.toggle('active', showImplementedOnly);
			renderCurrentSection();
			persistState();
		});
	}

	// Keyboard navigation on section content
	const content = document.getElementById('section-content');
	if (content) {
		content.addEventListener('keydown', handleKeyboard);
	}
}

// ---- Section switching ----

function switchSection(section: Section, notify = true): void {
	currentSection = section;

	// Update button states
	document.querySelectorAll('.section-btn').forEach(btn => {
		btn.classList.toggle('active', btn.getAttribute('data-section') === section);
	});

	// Update search input with this section's saved query
	const searchInput = document.querySelector('.search-input') as HTMLInputElement;
	if (searchInput) {
		searchInput.value = currentState().searchQuery;
		const clearBtn = document.querySelector('.search-clear') as HTMLElement;
		if (clearBtn) {
			clearBtn.style.display = currentState().searchQuery ? 'inline' : 'none';
		}
	}

	renderCurrentSection();
	persistState();

	if (notify) {
		vscode.postMessage({ type: 'sectionChange', section });
	}
}

// ---- Provider message handling ----

function handleProviderMessage(data: ProviderMessage): void {
	switch (data.type) {
		case 'setCatalog':
			catalog = data.catalog;
			// A fresh catalog invalidates any prior error/offline banner; the
			// provider re-posts catalogError immediately after setCatalog when a
			// degraded state still applies (postMessage order is preserved).
			hideErrorBanner();
			if (data.section) {
				currentSection = data.section;
				document.querySelectorAll('.section-btn').forEach(btn => {
					btn.classList.toggle('active', btn.getAttribute('data-section') === data.section);
				});
			}
			renderCurrentSection();
			break;

		case 'setSection':
			switchSection(data.section, false);
			break;

		case 'navigateTo':
			handleNavigateTo(data.section, data.categoryId, data.toolId);
			break;

		case 'catalogError':
			showErrorBanner(data.errorType, data.message);
			break;

		case 'catalogUnavailable':
			showUnavailableState(data.message);
			break;

		case 'updateCategoryHighlight':
			handleCategoryHighlight(data.contextHint, data.matchingCategoryIds);
			break;
	}
}

// ---- Rendering ----

function renderCurrentSection(): void {
	const content = document.getElementById('section-content');
	if (!content || !catalog) { return; }

	const categories = currentSection === 'stats' ? catalog.statistics : catalog.strategy;
	const searchFilter = currentState().searchQuery.trim().toLowerCase();

	// Get workflows for this section
	const sectionKey = currentSection === 'stats' ? 'statistics' : 'strategy';
	const workflows = catalog.workflows.filter(w => w.section === sectionKey);

	let html = '';

	// Workflows section (collapsible)
	if (workflows.length > 0) {
		html += renderWorkflows(workflows);
	}

	// Categories
	let hasVisibleCategories = false;
	for (const cat of categories) {
		const catHtml = renderCategory(cat, searchFilter);
		if (catHtml) {
			hasVisibleCategories = true;
			html += catHtml;
		}
	}

	if (!hasVisibleCategories) {
		if (searchFilter) {
			html += renderEmptySearch(currentState().searchQuery);
		} else if (showImplementedOnly) {
			html += renderEmptyFilter();
		}
	}

	content.innerHTML = html;
	bindContentEvents(content);
}

function renderCategory(cat: ResourceCategory, searchFilter: string): string {
	let tools = cat.tools;
	const state = currentState();

	// Apply "implemented only" filter
	if (showImplementedOnly) {
		tools = tools.filter(t => t.implemented);
	}

	// Apply search filter
	const catLabelMatch = searchFilter
		? cat.label.toLowerCase().includes(searchFilter)
		: false;

	if (searchFilter && !catLabelMatch) {
		tools = tools.filter(t =>
			t.label.toLowerCase().includes(searchFilter) ||
			t.description.toLowerCase().includes(searchFilter),
		);
	}

	if (tools.length === 0) { return ''; }

	const essentialTools = tools.filter(t => t.tier === 'essential');
	const advancedTools = tools.filter(t => t.tier === 'advanced');
	const isExpanded = state.expandedCategories.has(cat.id) || !!searchFilter;
	const showAdv = state.showAdvanced.has(cat.id) || !!searchFilter;

	const showDescription = !!searchFilter;

	return `
		<div class="stats-category" data-category="${escapeAttr(cat.id)}" role="group">
			<div class="category-header" tabindex="0" role="treeitem" aria-expanded="${isExpanded}">
				<span class="codicon codicon-chevron-${isExpanded ? 'down' : 'right'} expand-icon"></span>
				<span class="codicon codicon-${escapeAttr(resolveIcon(cat.icon))}"></span>
				<span class="category-label">${escapeHtml(cat.label)}</span>
				<span class="category-count">${tools.length}</span>
			</div>
			<div class="category-tools" style="display: ${isExpanded ? 'block' : 'none'}">
				${essentialTools.map(t => renderTool(t, showDescription)).join('')}
				${advancedTools.length > 0 ? renderTierDivider(cat.id, showAdv, advancedTools.length) : ''}
				${showAdv ? advancedTools.map(t => renderTool(t, showDescription)).join('') : ''}
			</div>
		</div>
	`;
}

function renderTool(tool: ResourceTool, showDescription: boolean): string {
	const implClass = tool.implemented ? 'tool-implemented' : 'tool-unimplemented';
	const indicator = tool.implemented ? '\u25CF' : '\u25CB';
	const crossRefAttr = tool.cross_ref ? ` data-crossref="${escapeAttr(tool.cross_ref)}"` : '';

	const tooltip = tool.implemented
		? escapeAttr(tool.description)
		: escapeAttr(`[Planned] ${tool.description}`);

	return `
		<div class="tool-item ${implClass}" data-tool="${escapeAttr(tool.id)}"${crossRefAttr}
			title="${tooltip}" tabindex="-1" role="treeitem">
			<span class="tool-indicator">${indicator}</span>
			<span class="tool-label">${escapeHtml(tool.label)}</span>
			${tool.cross_ref ? `<span class="codicon codicon-link-external cross-ref-icon" data-crossref-btn="${escapeAttr(tool.cross_ref)}" title="Go to cross-reference"></span>` : ''}
		</div>
		${showDescription ? `<div class="tool-description">${escapeHtml(tool.description)}</div>` : ''}
	`;
}

function renderTierDivider(categoryId: string, isShown: boolean, advancedCount: number): string {
	return `
		<div class="tier-divider" data-tier-category="${escapeAttr(categoryId)}">
			<span class="tier-line"></span>
			<button class="tier-toggle">${isShown ? 'Hide' : `Show ${advancedCount}`} Advanced</button>
			<span class="tier-line"></span>
		</div>
	`;
}

function renderWorkflows(workflows: WorkflowTemplate[]): string {
	if (workflows.length === 0) { return ''; }
	return `
		<div class="workflows-section">
			<div class="workflows-header" tabindex="0" role="treeitem" aria-expanded="${workflowsExpanded}">
				<span class="codicon codicon-chevron-${workflowsExpanded ? 'down' : 'right'}"></span>
				<span>Workflows</span>
				<span class="workflows-count">(${workflows.length})</span>
			</div>
			<div class="workflows-list" style="display: ${workflowsExpanded ? 'block' : 'none'}">
				${workflows.map(w => `
					<div class="workflow-item" data-workflow="${escapeAttr(w.id)}"
						title="${escapeAttr(w.description)}" tabindex="-1" role="treeitem">
						<span class="codicon codicon-run-all"></span>
						<span class="workflow-label">${escapeHtml(w.label)}</span>
						<span class="workflow-step-count">${w.steps.length} steps</span>
					</div>
				`).join('')}
			</div>
		</div>
	`;
}

function renderEmptySearch(query: string): string {
	return `
		<div class="empty-search">
			<span class="codicon codicon-search"></span>
			<p>No tools matching "${escapeHtml(query)}"</p>
			<p class="empty-search-hint">Try a different search term, or clear the search to browse categories.</p>
		</div>
	`;
}

function renderEmptyFilter(): string {
	return `
		<div class="empty-search">
			<span class="codicon codicon-filter"></span>
			<p>No implemented tools in this section.</p>
			<p class="empty-search-hint">Turn off the filter to see all planned tools.</p>
		</div>
	`;
}

// ---- Content event binding ----

function bindContentEvents(container: HTMLElement): void {
	// Category header click -> expand/collapse
	container.querySelectorAll('.category-header').forEach(header => {
		header.addEventListener('click', () => {
			const catEl = header.closest('.stats-category');
			const catId = catEl?.getAttribute('data-category');
			if (catId) { toggleCategory(catId); }
		});
	});

	// Tool item click -> dispatch
	container.querySelectorAll('.tool-item').forEach(item => {
		item.addEventListener('click', (e) => {
			// Don't trigger tool click if cross-ref icon was clicked
			if ((e.target as HTMLElement).closest('.cross-ref-icon')) { return; }
			e.stopPropagation();
			const toolId = item.getAttribute('data-tool');
			if (toolId) {
				const isImplemented = item.classList.contains('tool-implemented');
				if (isImplemented) {
					vscode.postMessage({ type: 'toolClick', toolId });
				}
			}
		});
	});

	// Cross-reference icon click
	container.querySelectorAll('.cross-ref-icon').forEach(icon => {
		icon.addEventListener('click', (e) => {
			e.stopPropagation();
			const targetToolId = (icon as HTMLElement).getAttribute('data-crossref-btn');
			if (targetToolId) {
				vscode.postMessage({ type: 'crossRefClick', targetToolId });
			}
		});
	});

	// Tier divider click -> toggle advanced
	container.querySelectorAll('.tier-divider').forEach(divider => {
		divider.addEventListener('click', () => {
			const catId = divider.getAttribute('data-tier-category');
			if (catId) { toggleAdvanced(catId); }
		});
	});

	// Workflow header click -> expand/collapse
	const wfHeader = container.querySelector('.workflows-header');
	if (wfHeader) {
		wfHeader.addEventListener('click', () => {
			workflowsExpanded = !workflowsExpanded;
			renderCurrentSection();
			persistState();
		});
	}

	// Workflow item click -> dispatch
	container.querySelectorAll('.workflow-item').forEach(item => {
		item.addEventListener('click', (e) => {
			e.stopPropagation();
			const workflowId = item.getAttribute('data-workflow');
			if (workflowId) {
				vscode.postMessage({ type: 'workflowClick', workflowId });
			}
		});
	});
}

// ---- State toggles ----

function toggleCategory(categoryId: string): void {
	const state = currentState();
	if (state.expandedCategories.has(categoryId)) {
		state.expandedCategories.delete(categoryId);
	} else {
		state.expandedCategories.add(categoryId);
	}
	renderCurrentSection();
	persistState();
}

function toggleAdvanced(categoryId: string): void {
	const state = currentState();
	if (state.showAdvanced.has(categoryId)) {
		state.showAdvanced.delete(categoryId);
	} else {
		state.showAdvanced.add(categoryId);
	}
	renderCurrentSection();
	persistState();
}

// ---- Keyboard navigation ----

function handleKeyboard(e: KeyboardEvent): void {
	const target = e.target as HTMLElement;

	switch (e.key) {
		case 'Enter':
		case ' ':
			e.preventDefault();
			if (target.closest('.category-header')) {
				const catId = target.closest('.stats-category')?.getAttribute('data-category');
				if (catId) { toggleCategory(catId); }
			} else if (target.closest('.tool-item')) {
				target.click();
			} else if (target.closest('.workflows-header')) {
				workflowsExpanded = !workflowsExpanded;
				renderCurrentSection();
				persistState();
			} else if (target.closest('.workflow-item')) {
				target.click();
			}
			break;

		case 'ArrowDown':
			e.preventDefault();
			focusNextItem(target, 'down');
			break;

		case 'ArrowUp':
			e.preventDefault();
			focusNextItem(target, 'up');
			break;

		case 'ArrowRight':
			if (target.closest('.category-header')) {
				const catId = target.closest('.stats-category')?.getAttribute('data-category');
				if (catId && !currentState().expandedCategories.has(catId)) {
					e.preventDefault();
					toggleCategory(catId);
				}
			}
			break;

		case 'ArrowLeft':
			if (target.closest('.category-header')) {
				const catId = target.closest('.stats-category')?.getAttribute('data-category');
				if (catId && currentState().expandedCategories.has(catId)) {
					e.preventDefault();
					toggleCategory(catId);
				}
			} else if (target.closest('.tool-item')) {
				e.preventDefault();
				const catHeader = target.closest('.stats-category')?.querySelector('.category-header') as HTMLElement;
				catHeader?.focus();
			}
			break;
	}
}

function focusNextItem(current: HTMLElement, direction: 'up' | 'down'): void {
	const content = document.getElementById('section-content');
	if (!content) { return; }

	const focusable = Array.from(
		content.querySelectorAll<HTMLElement>(
			'.category-header[tabindex], .tool-item[tabindex], .workflows-header[tabindex], .workflow-item[tabindex]',
		),
	).filter(el => {
		// Only include visible elements
		const rect = el.getBoundingClientRect();
		return rect.height > 0;
	});

	const currentIndex = focusable.indexOf(current);
	if (currentIndex === -1) { return; }

	const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
	if (nextIndex >= 0 && nextIndex < focusable.length) {
		focusable[nextIndex].focus();
	}
}

// ---- Navigation (cross-ref) ----

function handleNavigateTo(section: Section, categoryId: string, toolId: string): void {
	switchSection(section, false);

	// Ensure category is expanded
	const state = sectionStates[section];
	state.expandedCategories.add(categoryId);
	renderCurrentSection();

	// Scroll to and highlight tool
	requestAnimationFrame(() => {
		const toolEl = document.querySelector(`[data-tool="${CSS.escape(toolId)}"]`);
		if (toolEl) {
			toolEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
			toolEl.classList.add('tool-highlight');
			setTimeout(() => toolEl.classList.remove('tool-highlight'), 1000);
		}
	});
}

// ---- Unavailable state ----

function showUnavailableState(message: string): void {
	const content = document.getElementById('section-content');
	if (!content) { return; }

	content.innerHTML = renderUnavailable(message);

	// Bind retry button
	const retryBtn = content.querySelector('.retry-btn');
	if (retryBtn) {
		retryBtn.addEventListener('click', () => {
			content.innerHTML = renderLoading();
			vscode.postMessage({ type: 'requestCatalog' });
		});
	}
}

// ---- Error banner (stale cache / offline) ----

function hideErrorBanner(): void {
	const banner = document.querySelector('.catalog-error-banner') as HTMLElement | null;
	if (banner) {
		banner.style.display = 'none';
	}
}

function showErrorBanner(errorType: string, message: string): void {
	const banner = document.querySelector('.catalog-error-banner') as HTMLElement;
	if (!banner) { return; }

	// 'stale-cache' and 'offline' are degraded-but-working states (warning/info);
	// anything else is a hard error.
	const cssClass = errorType === 'stale-cache' ? 'warning'
		: errorType === 'offline' ? 'info'
			: 'error';
	const icon = errorType === 'offline' ? 'cloud' : 'warning';
	banner.className = `catalog-error-banner ${cssClass}`;
	banner.innerHTML = `
		<span class="codicon codicon-${icon}"></span>
		<span>${escapeHtml(message)}</span>
		<button class="retry-btn">Retry</button>
	`;
	banner.style.display = 'flex';

	// Bind retry
	const retryBtn = banner.querySelector('.retry-btn');
	if (retryBtn) {
		retryBtn.addEventListener('click', () => {
			banner.style.display = 'none';
			vscode.postMessage({ type: 'requestCatalog' });
		});
	}
}

// ---- Context highlight ----

function handleCategoryHighlight(contextHint: string, matchingCategoryIds: string[]): void {
	const banner = document.querySelector('.context-banner') as HTMLElement;
	if (!banner) { return; }

	if (contextHint && matchingCategoryIds.length > 0) {
		banner.innerHTML = `
			Relevant for: <strong>${escapeHtml(contextHint)}</strong> data
			<span class="codicon codicon-close clear-btn" title="Clear filter"></span>
		`;
		banner.style.display = 'flex';

		const clearBtn = banner.querySelector('.clear-btn');
		if (clearBtn) {
			clearBtn.addEventListener('click', () => {
				banner.style.display = 'none';
				document.querySelectorAll('.stats-category').forEach(el => {
					el.classList.remove('category-context-match');
				});
			});
		}
	} else {
		banner.style.display = 'none';
	}

	// Highlight matching categories
	document.querySelectorAll('.stats-category').forEach(el => {
		const catId = el.getAttribute('data-category');
		if (catId && matchingCategoryIds.includes(catId)) {
			el.classList.add('category-context-match');
		} else {
			el.classList.remove('category-context-match');
		}
	});
}

// ---- Start ----

document.addEventListener('DOMContentLoaded', init);
