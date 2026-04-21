/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Mention Autocomplete Manager
 * Phase 4 - Prompt 04-03
 *
 * Handles @-mention autocomplete in the input area for quickly attaching
 * files, symbols, and other context items.
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		DEBOUNCE_MS: 150,
		MAX_RESULTS: {
			recent: 5,
			files: 10,
			symbols: 10,
		},
		MIN_SYMBOL_QUERY: 2,
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
		'field': 'codicon-symbol-field',
		'namespace': 'codicon-symbol-namespace',
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let input = null;
	let dropdown = null;
	let content = null;
	let chipsManager = null;

	let isOpen = false;
	let query = '';
	let triggerPosition = -1;
	let focusedIndex = -1;
	let items = [];
	let debounceTimer = null;

	const sections = {
		recent: null,
		files: null,
		symbols: null,
	};

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init(inputElement, contextChipsManager) {
		input = inputElement;
		chipsManager = contextChipsManager;
		dropdown = document.getElementById('mention-autocomplete');
		content = dropdown?.querySelector('.mention-autocomplete-content');

		sections.recent = dropdown?.querySelector('[data-section="recent"] .mention-section-items');
		sections.files = dropdown?.querySelector('[data-section="files"] .mention-section-items');
		sections.symbols = dropdown?.querySelector('[data-section="symbols"] .mention-section-items');

		if (!input || !dropdown) {
			console.warn('[MentionAutocomplete] Elements not found');
			return;
		}

		setupEventListeners();
	}

	function setupEventListeners() {
		// Input events
		input?.addEventListener('input', handleInput);
		input?.addEventListener('keydown', handleKeyDown);
		input?.addEventListener('blur', handleBlur);

		// Click on items
		dropdown?.addEventListener('click', handleClick);

		// Prevent dropdown from stealing focus
		dropdown?.addEventListener('mousedown', (e) => e.preventDefault());
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function handleInput(e) {
		const value = input.value;
		const cursorPos = input.selectionStart;

		// Find @ trigger before cursor
		const textBeforeCursor = value.substring(0, cursorPos);
		const lastAtIndex = textBeforeCursor.lastIndexOf('@');

		if (lastAtIndex === -1) {
			close();
			return;
		}

		// Check if @ is at start or after whitespace
		const charBeforeAt = lastAtIndex > 0 ? value[lastAtIndex - 1] : ' ';
		if (!/\s/.test(charBeforeAt) && lastAtIndex > 0) {
			close();
			return;
		}

		// Check if there's a space after the @ query (query ended)
		const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
		if (textAfterAt.includes(' ') && textAfterAt.trim().includes(' ')) {
			close();
			return;
		}

		// Extract query
		triggerPosition = lastAtIndex;
		query = textAfterAt.trim();

		// Open and search
		open();
		debouncedSearch(query);
	}

	function handleKeyDown(e) {
		if (!isOpen) return;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				focusNext();
				break;

			case 'ArrowUp':
				e.preventDefault();
				focusPrevious();
				break;

			case 'Enter':
				if (focusedIndex >= 0) {
					e.preventDefault();
					e.stopPropagation();
					selectFocused();
				}
				break;

			case 'Tab':
				if (focusedIndex >= 0) {
					e.preventDefault();
					selectFocused();
				}
				break;

			case 'Escape':
				e.preventDefault();
				close();
				break;
		}
	}

	function handleBlur(e) {
		// Delay close to allow click on dropdown
		setTimeout(() => {
			if (!dropdown?.contains(document.activeElement)) {
				close();
			}
		}, 150);
	}

	function handleClick(e) {
		const item = e.target.closest('.mention-item');
		if (item) {
			const index = parseInt(item.dataset.index, 10);
			if (!isNaN(index)) {
				selectItem(index);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Dropdown Controls
	// ═══════════════════════════════════════════════════════════════════

	function open() {
		if (isOpen) return;

		isOpen = true;
		dropdown?.classList.remove('hidden');
		focusedIndex = -1;

		// ACCESSIBILITY: Set up listbox role and aria attributes (ISSUE #006)
		if (dropdown) {
			dropdown.setAttribute('role', 'listbox');
			dropdown.setAttribute('aria-label', 'Mention suggestions');
		}
		if (input) {
			input.setAttribute('aria-expanded', 'true');
			input.setAttribute('aria-haspopup', 'listbox');
			if (dropdown?.id) {
				input.setAttribute('aria-controls', dropdown.id);
			}
		}

		// Load recent items initially
		if (!query) {
			showRecent();
		}
	}

	function close() {
		if (!isOpen) return;

		isOpen = false;
		dropdown?.classList.add('hidden');
		query = '';
		triggerPosition = -1;
		focusedIndex = -1;
		items = [];

		// ACCESSIBILITY: Clear aria states
		if (input) {
			input.setAttribute('aria-expanded', 'false');
			input.removeAttribute('aria-activedescendant');
		}

		// Clear debounce
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Search
	// ═══════════════════════════════════════════════════════════════════

	function debouncedSearch(searchQuery) {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		debounceTimer = setTimeout(() => {
			search(searchQuery);
		}, CONFIG.DEBOUNCE_MS);
	}

	function search(searchQuery) {
		dropdown?.classList.add('loading');

		// Request search from extension
		notifyHost('mention:search', { query: searchQuery });
	}

	function showRecent() {
		notifyHost('mention:getRecent', {});
	}

	function handleSearchResults(results) {
		dropdown?.classList.remove('loading');
		items = [];

		// Render recent
		renderSection('recent', results.recent || []);

		// Render files
		renderSection('files', results.files || []);

		// Render symbols
		renderSection('symbols', results.symbols || []);

		// Check if empty
		if (items.length === 0) {
			dropdown?.classList.add('empty');
		} else {
			dropdown?.classList.remove('empty');
			focusedIndex = 0;
			updateFocusedItem();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	function renderSection(sectionName, sectionItems) {
		const container = sections[sectionName];
		if (!container) return;

		const section = container.closest('.mention-section');

		if (sectionItems.length === 0) {
			section?.classList.add('hidden');
			container.innerHTML = '';
			return;
		}

		section?.classList.remove('hidden');

		container.innerHTML = sectionItems.map((item, localIndex) => {
			const globalIndex = items.length;
			items.push({ ...item, section: sectionName });
			return renderItem(item, globalIndex);
		}).join('');
	}

	function renderItem(item, index) {
		const icon = getItemIcon(item);
		const iconClass = getItemIconClass(item);
		const label = highlightMatch(item.label || '', query);
		const detail = item.detail || '';
		const badge = item.badge || '';
		// ACCESSIBILITY: Unique id for aria-activedescendant (ISSUE #020)
		const itemId = `mention-item-${index}`;

		return `
			<div
				id="${itemId}"
				class="mention-item"
				data-index="${index}"
				role="option"
				aria-selected="false"
			>
				<span class="mention-item-icon ${iconClass} codicon ${icon}" aria-hidden="true"></span>
				<div class="mention-item-content">
					<div class="mention-item-label">${label}</div>
					${detail ? `<div class="mention-item-detail">${escapeHtml(detail)}</div>` : ''}
				</div>
				${badge ? `<span class="mention-item-badge">${escapeHtml(badge)}</span>` : ''}
			</div>
		`;
	}

	function getItemIcon(item) {
		if (item.icon) return item.icon;

		switch (item.type) {
			case 'file': return 'codicon-file';
			case 'symbol': return getSymbolIcon(item.symbolKind);
			case 'recent': return 'codicon-history';
			case 'folder': return 'codicon-folder';
			case 'url': return 'codicon-link';
			default: return 'codicon-circle-filled';
		}
	}

	function getItemIconClass(item) {
		if (item.type === 'symbol') {
			return item.symbolKind || 'symbol';
		}
		return item.type || 'file';
	}

	function getSymbolIcon(kind) {
		return SYMBOL_ICONS[kind] || 'codicon-symbol-misc';
	}

	function highlightMatch(text, matchQuery) {
		if (!matchQuery) return escapeHtml(text);

		const escaped = escapeHtml(text);
		const queryEscaped = escapeHtml(matchQuery);
		const regex = new RegExp(`(${queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

		return escaped.replace(regex, '<span class="highlight">$1</span>');
	}

	// ═══════════════════════════════════════════════════════════════════
	// Navigation
	// ═══════════════════════════════════════════════════════════════════

	function focusNext() {
		if (items.length === 0) return;

		focusedIndex = (focusedIndex + 1) % items.length;
		updateFocusedItem();
	}

	function focusPrevious() {
		if (items.length === 0) return;

		focusedIndex = focusedIndex <= 0
			? items.length - 1
			: focusedIndex - 1;
		updateFocusedItem();
	}

	function updateFocusedItem() {
		const itemEls = dropdown?.querySelectorAll('.mention-item');
		itemEls?.forEach((item, index) => {
			const isFocused = index === focusedIndex;
			item.classList.toggle('focused', isFocused);
			item.setAttribute('aria-selected', isFocused ? 'true' : 'false');

			if (isFocused) {
				item.scrollIntoView({ block: 'nearest' });
				// ACCESSIBILITY: Update aria-activedescendant (ISSUE #020)
				if (input && item.id) {
					input.setAttribute('aria-activedescendant', item.id);
				}
			}
		});

		// Clear aria-activedescendant if nothing focused
		if (focusedIndex < 0 && input) {
			input.removeAttribute('aria-activedescendant');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Selection
	// ═══════════════════════════════════════════════════════════════════

	function selectFocused() {
		if (focusedIndex >= 0 && focusedIndex < items.length) {
			selectItem(focusedIndex);
		}
	}

	function selectItem(index) {
		const item = items[index];
		if (!item) return;

		// Create context item
		const contextItem = createContextItem(item);

		// Add to chips
		if (chipsManager) {
			chipsManager.addItem(contextItem);
		}

		// Remove @query from input
		removeQueryFromInput();

		// Close dropdown
		close();
	}

	function createContextItem(item) {
		const id = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		switch (item.type) {
			case 'file':
				return {
					id,
					type: 'file',
					path: item.path,
					label: item.label,
				};

			case 'symbol':
				return {
					id,
					type: 'symbol',
					name: item.name || item.label,
					path: item.path,
					symbolKind: item.symbolKind,
					startLine: item.startLine,
					endLine: item.endLine,
				};

			case 'recent':
				// Recent items already have full context
				return {
					id,
					...item.contextData,
				};

			case 'folder':
				return {
					id,
					type: 'folder',
					path: item.path,
					label: item.label,
				};

			default:
				return {
					id,
					type: item.type || 'file',
					label: item.label,
					path: item.path,
				};
		}
	}

	function removeQueryFromInput() {
		if (triggerPosition === -1 || !input) return;

		const value = input.value;
		const cursorPos = input.selectionStart;

		// Remove @query
		const before = value.substring(0, triggerPosition);
		const after = value.substring(cursorPos);

		input.value = before + after;
		input.selectionStart = input.selectionEnd = triggerPosition;

		// Trigger input event for any listeners
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'mention:results':
				handleSearchResults(message.results || {});
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

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		input?.removeEventListener('input', handleInput);
		input?.removeEventListener('keydown', handleKeyDown);
		input?.removeEventListener('blur', handleBlur);
		dropdown?.removeEventListener('click', handleClick);
		input = null;
		dropdown = null;
		content = null;
		chipsManager = null;
		isOpen = false;
		items = [];
		focusedIndex = -1;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Focus input and insert @ to trigger autocomplete
	 */
	function focusWithAt() {
		if (!input) return;

		input.focus();

		// Insert @ at cursor position
		const cursorPos = input.selectionStart || 0;
		const value = input.value;

		// Add space before @ if needed
		const charBefore = cursorPos > 0 ? value[cursorPos - 1] : ' ';
		const prefix = /\s/.test(charBefore) ? '' : ' ';

		input.value = value.substring(0, cursorPos) + prefix + '@' + value.substring(cursorPos);
		input.selectionStart = input.selectionEnd = cursorPos + prefix.length + 1;

		// Trigger input to open autocomplete
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicMentionAutocomplete = {
		init,
		dispose,
		open,
		close,
		focusWithAt,
		handleMessage,
		isOpen: () => isOpen,
	};

})();
