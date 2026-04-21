/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Context Drawer Manager
 * Phase 4 - Prompt 04-02
 *
 * Manages the expandable context drawer that shows full details of all attached
 * context items. Provides content previews, bulk actions, and search/filter.
 *
 * GAP-11 Amendment: Lane-specific context budgets
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		MAX_PREVIEW_LINES: 20,
		MAX_PREVIEW_CHARS: 2000,
		MAX_DRAWER_HEIGHT: 400,
		ANIMATION_DURATION: 300,
	};

	// GAP-11: Lane-specific context budgets
	const LANE_BUDGETS = {
		'chat-ask': { maxContext: 16000, label: 'Ask' },
		'chat-gather': { maxContext: 32000, label: 'Gather' },
		'chat-plan': { maxContext: 64000, label: 'Plan' },
		'chat-act': { maxContext: 200000, label: 'Code' },
	};

	const ICONS = {
		file: 'codicon-file',
		selection: 'codicon-selection',
		symbol: 'codicon-symbol-method',
		url: 'codicon-link',
		image: 'codicon-file-media',
		folder: 'codicon-folder',
		terminal: 'codicon-terminal',
		docs: 'codicon-book',
		diagnostic: 'codicon-warning',
	};

	const SYMBOL_ICONS = {
		'class': 'codicon-symbol-class',
		'function': 'codicon-symbol-method',
		'method': 'codicon-symbol-method',
		'variable': 'codicon-symbol-variable',
		'constant': 'codicon-symbol-constant',
		'interface': 'codicon-symbol-interface',
		'enum': 'codicon-symbol-enum',
		'property': 'codicon-symbol-property',
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let drawer = null;
	let content = null;
	let toggleBtn = null;
	let searchInput = null;
	let clearAllBtn = null;
	let collapseBtn = null;
	let countEl = null;
	let tokenCountEl = null;
	let tokenLimitEl = null;
	let laneBadgeEl = null;
	let chipsManager = null;

	let isExpanded = false;
	const expandedItems = new Set();
	let currentLane = 'chat-ask';
	let currentLimit = LANE_BUDGETS['chat-ask'].maxContext;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init(contextChipsManager) {
		chipsManager = contextChipsManager;

		drawer = document.getElementById('context-drawer');
		content = document.getElementById('context-drawer-content');
		toggleBtn = document.getElementById('context-drawer-toggle');
		searchInput = document.getElementById('context-search-input');
		clearAllBtn = document.getElementById('context-clear-all-btn');
		collapseBtn = document.getElementById('context-collapse-btn');
		countEl = drawer?.querySelector('.drawer-count');
		tokenCountEl = document.getElementById('context-token-count');
		tokenLimitEl = document.getElementById('context-token-limit');
		laneBadgeEl = document.getElementById('context-lane-badge');

		if (!drawer || !content) {
			console.warn('[ContextDrawerManager] Container not found');
			return;
		}

		// ACCESSIBILITY: Set up initial ARIA states
		setupAccessibility();
		setupEventListeners();
		updateVisibility();
	}

	function setupAccessibility() {
		// Drawer aria-expanded initial state (ISSUE #013)
		if (drawer) {
			drawer.setAttribute('aria-expanded', 'false');
		}

		// Content list role (ISSUE #022)
		if (content) {
			content.setAttribute('role', 'list');
			content.setAttribute('aria-label', 'Context items');
		}

		// Search input aria-label (ISSUE #010)
		if (searchInput) {
			searchInput.setAttribute('aria-label', 'Filter context items');
		}

		// Toggle button aria attributes
		const contextToggle = document.getElementById('context-toggle');
		if (contextToggle) {
			contextToggle.setAttribute('aria-expanded', 'false');
			if (drawer?.id) {
				contextToggle.setAttribute('aria-controls', drawer.id);
			}
		}

		// Clear all button aria-label
		if (clearAllBtn && !clearAllBtn.getAttribute('aria-label')) {
			clearAllBtn.setAttribute('aria-label', 'Clear all context items');
		}

		// Collapse button aria-label
		if (collapseBtn && !collapseBtn.getAttribute('aria-label')) {
			collapseBtn.setAttribute('aria-label', 'Collapse context drawer');
		}

		// Create live region for status announcements (ISSUE #011)
		createLiveRegion();
	}

	function createLiveRegion() {
		let liveRegion = drawer?.querySelector('.context-drawer-live-region');
		if (!liveRegion && drawer) {
			liveRegion = document.createElement('div');
			liveRegion.className = 'context-drawer-live-region sr-only';
			liveRegion.setAttribute('aria-live', 'polite');
			liveRegion.setAttribute('aria-atomic', 'true');
			drawer.appendChild(liveRegion);
		}
	}

	function announce(message) {
		const liveRegion = drawer?.querySelector('.context-drawer-live-region');
		if (liveRegion) {
			liveRegion.textContent = '';
			// Small delay to ensure screen readers pick up the change
			setTimeout(() => {
				liveRegion.textContent = message;
			}, 50);
		}
	}

	function setupEventListeners() {
		// Toggle drawer
		toggleBtn?.addEventListener('click', () => {
			toggle();
		});

		// Also allow toggle from context chips row toggle button
		const contextToggle = document.getElementById('context-toggle');
		contextToggle?.addEventListener('click', () => {
			toggle();
		});

		// Collapse button
		collapseBtn?.addEventListener('click', () => {
			collapse();
		});

		// Clear all
		clearAllBtn?.addEventListener('click', () => {
			confirmClearAll();
		});

		// Search filter
		searchInput?.addEventListener('input', (e) => {
			filterItems(e.target.value);
		});

		// Item interactions
		content?.addEventListener('click', (e) => {
			handleContentClick(e);
		});

		// Keyboard
		content?.addEventListener('keydown', (e) => {
			handleKeyDown(e);
		});

		// Keyboard shortcut for drawer toggle (Escape to close)
		drawer?.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && isExpanded) {
				e.preventDefault();
				collapse();
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function handleContentClick(e) {
		const item = e.target.closest('.context-drawer-item');
		if (!item) return;

		const itemId = item.dataset.id;

		// Toggle expand
		if (e.target.closest('.context-drawer-item-header') &&
			!e.target.closest('.context-drawer-item-btn')) {
			toggleItemExpand(itemId);
			return;
		}

		// Open in editor
		if (e.target.closest('[data-action="open"]')) {
			openItem(itemId);
			return;
		}

		// Remove item
		if (e.target.closest('[data-action="remove"]')) {
			removeItem(itemId);
			return;
		}
	}

	function handleKeyDown(e) {
		const item = e.target.closest('.context-drawer-item');
		if (!item) return;

		const itemId = item.dataset.id;

		switch (e.key) {
			case 'Enter':
			case ' ':
				if (e.target.closest('.context-drawer-item-header')) {
					e.preventDefault();
					toggleItemExpand(itemId);
				}
				break;
			case 'Delete':
				e.preventDefault();
				removeItem(itemId);
				break;
			case 'ArrowDown':
				e.preventDefault();
				focusNextItem(item);
				break;
			case 'ArrowUp':
				e.preventDefault();
				focusPreviousItem(item);
				break;
		}
	}

	function focusNextItem(current) {
		const next = current.nextElementSibling;
		if (next?.classList.contains('context-drawer-item')) {
			next.querySelector('.context-drawer-item-header')?.focus();
		}
	}

	function focusPreviousItem(current) {
		const prev = current.previousElementSibling;
		if (prev?.classList.contains('context-drawer-item')) {
			prev.querySelector('.context-drawer-item-header')?.focus();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Drawer Controls
	// ═══════════════════════════════════════════════════════════════════

	function toggle() {
		if (isExpanded) {
			collapse();
		} else {
			expand();
		}
	}

	function expand() {
		if (!drawer) return;

		isExpanded = true;
		drawer.classList.remove('collapsed');
		drawer.classList.add('expanded');
		drawer.setAttribute('aria-expanded', 'true');

		// Update toggle button
		const contextToggle = document.getElementById('context-toggle');
		contextToggle?.setAttribute('aria-expanded', 'true');

		render();

		// Focus search input
		setTimeout(() => {
			searchInput?.focus();
		}, CONFIG.ANIMATION_DURATION);
	}

	function collapse() {
		if (!drawer) return;

		isExpanded = false;
		drawer.classList.add('collapsed');
		drawer.classList.remove('expanded');
		drawer.setAttribute('aria-expanded', 'false');

		// Update toggle button
		const contextToggle = document.getElementById('context-toggle');
		contextToggle?.setAttribute('aria-expanded', 'false');
	}

	function open() {
		if (!isExpanded) {
			expand();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Item Management
	// ═══════════════════════════════════════════════════════════════════

	function toggleItemExpand(itemId) {
		const itemEl = content?.querySelector(`[data-id="${itemId}"]`);
		if (!itemEl) return;

		if (expandedItems.has(itemId)) {
			expandedItems.delete(itemId);
			itemEl.classList.remove('expanded');
		} else {
			expandedItems.add(itemId);
			itemEl.classList.add('expanded');
			loadItemContent(itemId);
		}
	}

	async function loadItemContent(itemId) {
		if (!chipsManager) return;

		const item = chipsManager.items?.get(itemId);
		if (!item || item.contentLoaded) return;

		const itemEl = content?.querySelector(`[data-id="${itemId}"]`);
		const previewEl = itemEl?.querySelector('.context-drawer-item-preview');
		if (!previewEl) return;

		previewEl.textContent = 'Loading...';
		// ACCESSIBILITY: Announce loading state (ISSUE #011)
		announce('Loading content preview');

		// Request content from extension
		notifyHost('context:getContent', { id: itemId });
	}

	function updateItemContent(itemId, contentText) {
		if (!chipsManager) return;

		const item = chipsManager.items?.get(itemId);
		if (item) {
			item.content = contentText;
			item.contentLoaded = true;
		}

		const itemEl = content?.querySelector(`[data-id="${itemId}"]`);
		const previewEl = itemEl?.querySelector('.context-drawer-item-preview');
		if (!previewEl) return;

		const truncated = truncateContent(contentText);
		previewEl.textContent = truncated.text;
		if (truncated.isTruncated) {
			previewEl.classList.add('truncated');
		} else {
			previewEl.classList.remove('truncated');
		}
	}

	function truncateContent(contentText) {
		if (!contentText) return { text: '(empty)', isTruncated: false };

		const lines = contentText.split('\n');
		let text = contentText;
		let isTruncated = false;

		if (lines.length > CONFIG.MAX_PREVIEW_LINES) {
			text = lines.slice(0, CONFIG.MAX_PREVIEW_LINES).join('\n');
			isTruncated = true;
		}

		if (text.length > CONFIG.MAX_PREVIEW_CHARS) {
			text = text.substring(0, CONFIG.MAX_PREVIEW_CHARS);
			isTruncated = true;
		}

		return { text, isTruncated };
	}

	function filterItems(query) {
		const normalizedQuery = query.toLowerCase().trim();
		const items = content?.querySelectorAll('.context-drawer-item') || [];

		items.forEach(itemEl => {
			const item = chipsManager?.items?.get(itemEl.dataset.id);
			if (!item) return;

			const searchText = [
				item.path,
				item.label,
				item.name,
				item.url,
				item.content
			].filter(Boolean).join(' ').toLowerCase();

			if (!normalizedQuery || searchText.includes(normalizedQuery)) {
				itemEl.classList.remove('filtered-out');
			} else {
				itemEl.classList.add('filtered-out');
			}
		});
	}

	function openItem(itemId) {
		const item = chipsManager?.items?.get(itemId);
		if (item) {
			notifyHost('context:openItem', {
				id: itemId,
				item: serializeItem(item)
			});
		}
	}

	function removeItem(itemId) {
		const item = chipsManager?.items?.get(itemId);
		const itemLabel = item ? getTitle(item) : 'Item';
		chipsManager?.removeItem(itemId);
		render();
		// ACCESSIBILITY: Announce removal
		announce(`${itemLabel} removed from context`);
	}

	function confirmClearAll() {
		// Use a simple confirm for now
		if (confirm('Remove all context items?')) {
			const count = chipsManager?.items?.size || 0;
			chipsManager?.clearAll();
			render();
			// ACCESSIBILITY: Announce clear
			announce(`${count} context item${count !== 1 ? 's' : ''} cleared`);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	function render() {
		if (!chipsManager) return;

		const items = Array.from(chipsManager.items?.values() || []);

		// Update count
		if (countEl) {
			countEl.textContent = `(${items.length} item${items.length !== 1 ? 's' : ''})`;
		}

		// Update token estimate
		updateTokenEstimate(items);

		// Update visibility
		updateVisibility();

		// Render items only if expanded
		if (!isExpanded || !content) return;

		content.innerHTML = items.map(item => renderItem(item)).join('');

		// Restore expanded state
		expandedItems.forEach(id => {
			const itemEl = content.querySelector(`[data-id="${id}"]`);
			if (itemEl) {
				itemEl.classList.add('expanded');
			}
		});
	}

	function renderItem(item) {
		const icon = getIcon(item);
		const title = getTitle(item);
		const meta = getMeta(item);
		const preview = renderPreview(item);

		return `
			<div
				class="context-drawer-item"
				data-id="${escapeAttr(item.id)}"
				data-type="${escapeAttr(item.type)}"
				role="listitem"
			>
				<div class="context-drawer-item-header" tabindex="0">
					<span class="context-drawer-item-icon ${item.type} codicon ${icon}"></span>
					<div class="context-drawer-item-info">
						<div class="context-drawer-item-title">${escapeHtml(title)}</div>
						<div class="context-drawer-item-meta">${escapeHtml(meta)}</div>
					</div>
					<div class="context-drawer-item-actions">
						<button
							class="context-drawer-item-btn"
							data-action="open"
							title="Open in editor"
							aria-label="Open ${escapeAttr(title)} in editor"
						>
							<span class="codicon codicon-go-to-file"></span>
						</button>
						<button
							class="context-drawer-item-btn"
							data-action="remove"
							title="Remove"
							aria-label="Remove ${escapeAttr(title)}"
						>
							<span class="codicon codicon-close"></span>
						</button>
					</div>
				</div>
				<div class="context-drawer-item-content">
					${preview}
				</div>
			</div>
		`;
	}

	function renderPreview(item) {
		if (item.type === 'image') {
			return `
				<div class="context-drawer-item-image">
					<img src="${escapeAttr(item.dataUrl || item.path)}" alt="${escapeAttr(item.label || 'Image')}" />
				</div>
			`;
		}

		const contentText = item.content || 'Click to load preview...';
		const truncated = truncateContent(contentText);

		return `
			<pre class="context-drawer-item-preview ${truncated.isTruncated ? 'truncated' : ''}">${escapeHtml(truncated.text)}</pre>
		`;
	}

	function getIcon(item) {
		if (item.type === 'symbol' && item.symbolKind) {
			return SYMBOL_ICONS[item.symbolKind] || ICONS.symbol;
		}
		return ICONS[item.type] || 'codicon-circle-filled';
	}

	function getTitle(item) {
		switch (item.type) {
			case 'file':
				return (item.path || '').split('/').pop() || 'File';
			case 'selection':
				return item.label || 'Selection';
			case 'symbol':
				return item.name || 'Symbol';
			case 'url':
				return item.label || item.url;
			case 'image':
				return item.label || 'Image';
			case 'folder':
				return (item.path || '').split('/').pop() || 'Folder';
			case 'terminal':
				return item.label || 'Terminal output';
			case 'docs':
				return item.label || 'Documentation';
			default:
				return item.label || 'Context';
		}
	}

	function getMeta(item) {
		switch (item.type) {
			case 'file':
				if (item.startLine && item.endLine) {
					return `${item.path} • Lines ${item.startLine}-${item.endLine}`;
				}
				return item.path || '';
			case 'selection':
				return `${item.path || 'Selection'} • ${item.lineCount || 0} lines`;
			case 'symbol':
				return `${item.symbolKind || 'symbol'} in ${item.path || 'unknown'}`;
			case 'url':
				return item.url || '';
			case 'image':
				return item.path || 'Attached image';
			case 'folder':
				return item.path || '';
			case 'terminal':
				return item.terminalName || 'Terminal';
			case 'docs':
				return item.source || 'Documentation';
			default:
				return '';
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Token Estimation (GAP-11)
	// ═══════════════════════════════════════════════════════════════════

	function updateTokenEstimate(items) {
		// Rough estimate: ~4 chars per token
		let totalChars = 0;
		items.forEach(item => {
			if (item.content) {
				totalChars += item.content.length;
			} else if (item.tokens) {
				totalChars += item.tokens * 4;
			} else {
				// Estimate based on type
				totalChars += item.type === 'file' ? 5000 : 500;
			}
		});

		const tokens = Math.round(totalChars / 4);

		if (tokenCountEl) {
			tokenCountEl.textContent = formatTokens(tokens);
		}

		updateWarningState(tokens);
	}

	function updateWarningState(tokens) {
		const percentage = (tokens / currentLimit) * 100;

		const indicator = tokenCountEl?.closest('.context-size-indicator');
		if (!indicator) return;

		indicator.classList.remove('warning', 'error');

		if (percentage >= 90) {
			indicator.classList.add('error');
		} else if (percentage >= 75) {
			indicator.classList.add('warning');
		}
	}

	function setLimit(maxTokens, lane) {
		currentLimit = maxTokens;
		if (lane) {
			currentLane = lane;
		}

		if (tokenLimitEl) {
			tokenLimitEl.textContent = formatTokens(maxTokens);
		}

		// Update badge
		const laneConfig = Object.entries(LANE_BUDGETS).find(([_, config]) => config.maxContext === maxTokens);
		if (laneBadgeEl && laneConfig) {
			laneBadgeEl.textContent = `(${laneConfig[1].label})`;
		}

		// Re-check warning state
		if (chipsManager) {
			const items = Array.from(chipsManager.items?.values() || []);
			updateTokenEstimate(items);
		}
	}

	function formatTokens(tokens) {
		if (tokens >= 1000000) {
			return `${(tokens / 1000000).toFixed(1)}M`;
		}
		if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(1)}K`;
		}
		return tokens.toString();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Visibility
	// ═══════════════════════════════════════════════════════════════════

	function updateVisibility() {
		if (!drawer || !chipsManager) return;

		const itemCount = chipsManager.items?.size || 0;

		if (itemCount === 0) {
			drawer.classList.add('hidden');
		} else {
			drawer.classList.remove('hidden');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'context:content':
				if (message.id && message.content !== undefined) {
					updateItemContent(message.id, message.content);
				}
				break;
			case 'context:set':
			case 'context:added':
			case 'context:removed':
			case 'context:cleared':
				// Chips manager handles these - we just re-render
				render();
				break;
			case 'lane:changed':
				const budget = LANE_BUDGETS[message.lane];
				if (budget) {
					setLimit(budget.maxContext, message.lane);
				}
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function notifyHost(type, data) {
		const vscode = window.vscodeApi || (window.acquireVsCodeApi && window.acquireVsCodeApi());
		if (vscode) {
			vscode.postMessage({ type, ...data });
		}
	}

	function serializeItem(item) {
		return {
			id: item.id,
			type: item.type,
			label: getTitle(item),
			tokens: item.tokens,
			...item
		};
	}

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		expandedItems.clear();
		drawer = null;
		content = null;
		toggleBtn = null;
		searchInput = null;
		clearAllBtn = null;
		collapseBtn = null;
		countEl = null;
		tokenCountEl = null;
		tokenLimitEl = null;
		laneBadgeEl = null;
		chipsManager = null;
		isExpanded = false;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicContextDrawer = {
		init,
		dispose,
		open,
		expand,
		collapse,
		toggle,
		render,
		setLimit,
		handleMessage,
		updateItemContent,
	};

	// Auto-init after DOM ready (needs chips manager)
	// Initialization is handled by main.js which calls init with chipsManager

})();
