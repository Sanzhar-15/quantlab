/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Context Chips Manager
 * Phase 4 - Prompt 04-01
 *
 * Manages context chips UI - visual display of attached files, selections, symbols.
 * Provides add/remove/clear functionality with animations and keyboard support.
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		MAX_VISIBLE_CHIPS: 5,
		ANIMATION_DURATION: 200,
		SYMBOL_ICONS: {
			'class': 'codicon-symbol-class',
			'function': 'codicon-symbol-method',
			'method': 'codicon-symbol-method',
			'variable': 'codicon-symbol-variable',
			'constant': 'codicon-symbol-constant',
			'interface': 'codicon-symbol-interface',
			'enum': 'codicon-symbol-enum',
			'property': 'codicon-symbol-property',
			'field': 'codicon-symbol-field',
			'namespace': 'codicon-symbol-namespace',
			'module': 'codicon-symbol-namespace',
		},
		TYPE_ICONS: {
			'file': 'codicon-file',
			'folder': 'codicon-folder',
			'selection': 'codicon-selection',
			'symbol': 'codicon-symbol-method',
			'url': 'codicon-link',
			'image': 'codicon-file-media',
			'terminal': 'codicon-terminal',
			'docs': 'codicon-book',
			'diagnostic': 'codicon-warning',
		}
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let container = null;
	let chipsContainer = null;
	let overflowBtn = null;
	let addBtn = null;
	let contextCount = null;
	const items = new Map(); // id -> ContextItem

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		container = document.getElementById('context-chips-row');
		chipsContainer = document.getElementById('context-chips');
		overflowBtn = document.querySelector('.qic-chip-overflow-btn');
		addBtn = document.getElementById('add-context-btn');
		contextCount = document.getElementById('context-count');

		if (!container || !chipsContainer) {
			console.warn('[ContextChipsManager] Container not found');
			return;
		}

		setupEventListeners();
		updateVisibility();
	}

	function setupEventListeners() {
		// Click on chips container (delegated)
		chipsContainer?.addEventListener('click', handleChipClick);

		// Keyboard navigation
		chipsContainer?.addEventListener('keydown', handleKeyDown);

		// Add context button
		addBtn?.addEventListener('click', () => {
			triggerAddContext();
		});

		// Overflow button
		if (overflowBtn) {
			overflowBtn.addEventListener('click', () => {
				openContextDrawer();
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function handleChipClick(e) {
		const chip = e.target.closest('.qic-context-chip');
		const removeBtn = e.target.closest('.qic-chip-remove');
		const overflow = e.target.closest('.qic-chip-overflow');

		if (overflow) {
			openContextDrawer();
			return;
		}

		if (removeBtn && chip) {
			e.stopPropagation();
			const id = chip.dataset.id;
			if (id) {
				removeItem(id);
			}
			return;
		}

		if (chip) {
			const id = chip.dataset.id;
			if (id) {
				openItemDetails(id);
			}
		}
	}

	function handleKeyDown(e) {
		const chip = e.target.closest('.qic-context-chip');
		if (!chip) return;

		const id = chip.dataset.id;

		switch (e.key) {
			case 'Delete':
			case 'Backspace':
				e.preventDefault();
				if (id) removeItem(id);
				break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				if (id) openItemDetails(id);
				break;
			case 'ArrowLeft':
				e.preventDefault();
				focusPreviousChip(chip);
				break;
			case 'ArrowRight':
				e.preventDefault();
				focusNextChip(chip);
				break;
		}
	}

	function focusPreviousChip(currentChip) {
		const chips = Array.from(chipsContainer.querySelectorAll('.qic-context-chip'));
		const index = chips.indexOf(currentChip);
		if (index > 0) {
			chips[index - 1].focus();
		}
	}

	function focusNextChip(currentChip) {
		const chips = Array.from(chipsContainer.querySelectorAll('.qic-context-chip'));
		const index = chips.indexOf(currentChip);
		if (index < chips.length - 1) {
			chips[index + 1].focus();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Add a context item
	 * @param {ContextItem} item
	 */
	function addItem(item) {
		if (!item || !item.id) {
			console.warn('[ContextChipsManager] Invalid item');
			return;
		}

		if (items.has(item.id)) {
			// Update existing item
			items.set(item.id, { ...items.get(item.id), ...item });
		} else {
			items.set(item.id, item);
		}

		renderChips();
		updateVisibility();
		// Update drawer if available
		window.QicContextDrawer?.render();

		// Notify host
		notifyHost('context:add', { item: serializeItem(item) });
	}

	/**
	 * Remove a context item
	 * @param {string} id
	 */
	function removeItem(id) {
		const chip = chipsContainer?.querySelector(`[data-id="${id}"]`);

		// Phase 6 (06-02): Determine next focus target before removing
		let nextFocus = null;
		if (chip) {
			const chips = Array.from(chipsContainer.querySelectorAll('.qic-context-chip'));
			const index = chips.indexOf(chip);
			nextFocus = chips[index + 1] || chips[index - 1] || addBtn;
		}

		if (chip) {
			// Animate out
			chip.classList.add('qic-chip-removing');
			setTimeout(() => {
				items.delete(id);
				renderChips();
				updateVisibility();
				// Update drawer if available
				window.QicContextDrawer?.render();
				notifyHost('context:remove', { id });

				// Phase 6 (06-02): Restore focus after removal
				if (nextFocus) {
					// Re-query for next chip since DOM was re-rendered
					const chips = Array.from(chipsContainer.querySelectorAll('.qic-context-chip'));
					if (chips.length > 0) {
						chips[Math.min(chips.indexOf(nextFocus), chips.length - 1)]?.focus() || chips[0]?.focus();
					} else if (addBtn) {
						addBtn.focus();
					}
				}

				// Announce removal for screen readers
				announce(`Context item removed. ${items.size} items remaining.`);
			}, CONFIG.ANIMATION_DURATION);
		} else {
			items.delete(id);
			renderChips();
			updateVisibility();
			// Update drawer if available
			window.QicContextDrawer?.render();
			notifyHost('context:remove', { id });
			announce(`Context item removed. ${items.size} items remaining.`);
		}
	}

	/**
	 * Clear all context items
	 */
	function clearAll() {
		items.clear();
		renderChips();
		updateVisibility();
		// Update drawer if available
		window.QicContextDrawer?.render();
		notifyHost('context:clear', {});
	}

	/**
	 * Get all context items
	 * @returns {ContextItem[]}
	 */
	function getItems() {
		return Array.from(items.values());
	}

	/**
	 * Get total token count
	 * @returns {number}
	 */
	function getTotalTokens() {
		let total = 0;
		for (const item of items.values()) {
			total += item.tokens || 0;
		}
		return total;
	}

	/**
	 * Set items from host (replaces all)
	 * @param {ContextItem[]} newItems
	 */
	function setItems(newItems) {
		items.clear();
		for (const item of newItems || []) {
			if (item && item.id) {
				items.set(item.id, item);
			}
		}
		renderChips();
		updateVisibility();
	}

	/**
	 * Update item state
	 * @param {string} id
	 * @param {'loading'|'ready'|'error'} state
	 */
	function updateItemState(id, state) {
		const item = items.get(id);
		if (item) {
			item.state = state;
			renderChips();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	function renderChips() {
		if (!chipsContainer) return;

		const itemList = Array.from(items.values());
		const visibleItems = itemList.slice(0, CONFIG.MAX_VISIBLE_CHIPS);
		const hiddenCount = itemList.length - visibleItems.length;

		// Phase 6 (06-02): Add role="list" for accessibility
		chipsContainer.setAttribute('role', 'list');
		chipsContainer.setAttribute('aria-label', 'Attached context items');

		// Render visible chips
		chipsContainer.innerHTML = visibleItems.map(item => createChipHTML(item)).join('');

		// Add overflow indicator with proper accessibility
		if (hiddenCount > 0) {
			chipsContainer.innerHTML += `
				<button
					class="qic-chip-overflow"
					title="Show all ${itemList.length} items"
					aria-label="${hiddenCount} more context items. Click to show all ${itemList.length} items."
				>
					+${hiddenCount} more
				</button>
			`;
		}

		// Update context count
		if (contextCount) {
			contextCount.textContent = itemList.length.toString();
		}
	}

	function createChipHTML(item) {
		const label = getItemLabel(item);
		const icon = getItemIcon(item);
		const tooltip = getItemTooltip(item);
		const stateAttr = item.state ? `data-state="${item.state}"` : '';
		const symbolKindAttr = item.symbolKind ? `data-symbol-kind="${item.symbolKind}"` : '';
		const pinnedAttr = item.pinned ? 'data-pinned="true"' : '';
		const tokensLabel = item.tokens ? ` (${formatTokens(item.tokens)})` : '';

		return `
			<div
				class="qic-context-chip"
				data-id="${escapeAttr(item.id)}"
				data-type="${escapeAttr(item.type)}"
				${stateAttr}
				${symbolKindAttr}
				${pinnedAttr}
				role="listitem"
				tabindex="0"
				aria-label="${escapeAttr(label)}${tokensLabel}"
				title="${escapeAttr(tooltip)}"
			>
				<span class="qic-chip-icon codicon ${icon}" aria-hidden="true"></span>
				<span class="qic-chip-label">${escapeHtml(label)}</span>
				${item.pinned ? '' : `
					<button
						class="qic-chip-remove"
						aria-label="Remove ${escapeAttr(label)}"
						title="Remove"
					>
						<span class="codicon codicon-close" aria-hidden="true"></span>
					</button>
				`}
			</div>
		`;
	}

	function getItemLabel(item) {
		switch (item.type) {
			case 'file':
				const filename = (item.path || '').split('/').pop() || 'File';
				if (item.startLine && item.endLine) {
					return `${filename}:${item.startLine}-${item.endLine}`;
				}
				return filename;

			case 'selection':
				return item.label || `Selection (${item.lineCount || 0} lines)`;

			case 'symbol':
				return item.name || 'Symbol';

			case 'url':
				try {
					return new URL(item.url).hostname;
				} catch {
					return (item.url || '').substring(0, 30);
				}

			case 'image':
				return item.label || 'Image';

			case 'folder':
				return (item.path || '').split('/').pop() || 'Folder';

			case 'terminal':
				return item.label || 'Terminal output';

			case 'docs':
				return item.label || 'Documentation';

			default:
				return item.label || item.displayName || 'Context';
		}
	}

	function getItemIcon(item) {
		if (item.type === 'symbol' && item.symbolKind) {
			return CONFIG.SYMBOL_ICONS[item.symbolKind] || CONFIG.TYPE_ICONS.symbol;
		}
		return CONFIG.TYPE_ICONS[item.type] || 'codicon-file';
	}

	function getItemTooltip(item) {
		const parts = [];

		switch (item.type) {
			case 'file':
				parts.push(item.path || 'File');
				if (item.startLine && item.endLine) {
					parts.push(`Lines ${item.startLine}-${item.endLine}`);
				}
				break;

			case 'selection':
				parts.push(item.path || 'Selection');
				parts.push(`${item.lineCount || 0} lines selected`);
				break;

			case 'symbol':
				parts.push(`${item.symbolKind || 'Symbol'}: ${item.name || 'Unknown'}`);
				if (item.path) parts.push(item.path);
				break;

			case 'url':
				parts.push(item.url || 'URL');
				break;

			case 'image':
				parts.push(item.path || 'Image');
				break;

			default:
				parts.push(item.label || item.displayName || '');
		}

		if (item.tokens) {
			parts.push(`${formatTokens(item.tokens)} tokens`);
		}

		return parts.filter(Boolean).join('\n');
	}

	function formatTokens(tokens) {
		if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(1)}K`;
		}
		return tokens.toString();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Visibility & Actions
	// ═══════════════════════════════════════════════════════════════════

	function updateVisibility() {
		if (!container) return;

		if (items.size === 0) {
			container.hidden = true;
		} else {
			container.hidden = false;
		}
	}

	function triggerAddContext() {
		notifyHost('context:showPicker', {});
	}

	function openContextDrawer() {
		// Open the drawer directly
		window.QicContextDrawer?.open();
	}

	function openItemDetails(id) {
		const item = items.get(id);
		if (item) {
			notifyHost('context:openItem', { id, item: serializeItem(item) });
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'context:set':
				setItems(message.items || message.payload?.items);
				// Also update drawer
				window.QicContextDrawer?.render();
				break;

			case 'context:added':
				if (message.item || message.payload?.item) {
					const item = message.item || message.payload.item;
					items.set(item.id, item);
					renderChips();
					updateVisibility();
					// Also update drawer
					window.QicContextDrawer?.render();
				}
				break;

			case 'context:removed':
				const removeId = message.id || message.payload?.id;
				if (removeId) {
					items.delete(removeId);
					renderChips();
					updateVisibility();
					// Also update drawer
					window.QicContextDrawer?.render();
				}
				break;

			case 'context:cleared':
				items.clear();
				renderChips();
				updateVisibility();
				// Also update drawer
				window.QicContextDrawer?.render();
				break;

			case 'context:updateState':
				const stateId = message.id || message.payload?.id;
				const state = message.state || message.payload?.state;
				if (stateId && state) {
					updateItemState(stateId, state);
				}
				break;

			// Forward drawer-specific messages
			case 'context:content':
			case 'context:openDrawer':
			case 'lane:changed':
				window.QicContextDrawer?.handleMessage(message);
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
			label: getItemLabel(item),
			tokens: item.tokens,
			...item
		};
	}

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	// ═══════════════════════════════════════════════════════════════════
	// Phase 6 (06-02): Accessibility - Screen Reader Announcements
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Announce message to screen readers via live region
	 * @param {string} message
	 */
	function announce(message) {
		// Use global announcer if available (created by main.js)
		let announcer = document.getElementById('qic-announcer');

		// Create announcer if it doesn't exist
		if (!announcer) {
			announcer = document.createElement('div');
			announcer.id = 'qic-announcer';
			announcer.setAttribute('role', 'status');
			announcer.setAttribute('aria-live', 'polite');
			announcer.setAttribute('aria-atomic', 'true');
			announcer.className = 'sr-only';
			document.body.appendChild(announcer);
		}

		// Clear and set with brief delay to ensure announcement
		announcer.textContent = '';
		setTimeout(() => {
			announcer.textContent = message;
		}, 50);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicContextChips = {
		init,
		addItem,
		removeItem,
		clearAll,
		getItems,
		getTotalTokens,
		setItems,
		updateItemState,
		handleMessage,
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
