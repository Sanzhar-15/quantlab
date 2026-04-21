/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Input Core
 * Handles input area structure and basic interactions
 * Note: Lockout logic is in inputManager.js (02-06)
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		MIN_HEIGHT: 36,
		MAX_HEIGHT: 200,
		CHAR_WARN_THRESHOLD: 10000,
		CHAR_MAX_THRESHOLD: 50000,
	};

	// ═══════════════════════════════════════════════════════════════════
	// Elements
	// ═══════════════════════════════════════════════════════════════════

	let chatInput = null;
	let sendBtn = null;
	let cancelBtn = null;
	let charCount = null;
	let contextChipsRow = null;
	let contextChips = null;
	let contextToggle = null;
	let contextCount = null;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		chatInput = document.getElementById('chat-input');
		sendBtn = document.getElementById('send-btn');
		cancelBtn = document.getElementById('cancel-btn');
		charCount = document.getElementById('char-count');
		contextChipsRow = document.getElementById('context-chips-row');
		contextChips = document.getElementById('context-chips');
		contextToggle = document.getElementById('context-toggle');
		contextCount = document.getElementById('context-count');

		if (!chatInput || !sendBtn) {
			console.error('[InputCore] Required elements not found');
			return;
		}

		// ACCESSIBILITY (ISSUE #002): Set initial aria-expanded state
		if (contextToggle && !contextToggle.hasAttribute('aria-expanded')) {
			contextToggle.setAttribute('aria-expanded', 'false');
		}

		setupEventListeners();
		updateCharCount();
		updateSendButtonState();
	}

	function setupEventListeners() {
		// Input events
		chatInput.addEventListener('input', handleInput);
		chatInput.addEventListener('keydown', handleKeydown);
		chatInput.addEventListener('focus', handleFocus);
		chatInput.addEventListener('blur', handleBlur);

		// Button events
		sendBtn.addEventListener('click', handleSendClick);
		cancelBtn?.addEventListener('click', handleCancelClick);

		// Context toggle
		contextToggle?.addEventListener('click', handleContextToggle);

		// Paste handling
		chatInput.addEventListener('paste', handlePaste);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	let resizeFrameId = null;

	function handleInput(e) {
		// Debounce autoResize to once per frame (avoids multiple forced layouts per keystroke)
		if (!resizeFrameId) {
			resizeFrameId = requestAnimationFrame(() => {
				resizeFrameId = null;
				autoResize();
			});
		}
		updateCharCount();
		updateSendButtonState();

		// Dispatch custom event for other modules
		dispatchInputEvent('qic:input', { value: chatInput.value });
	}

	function handleKeydown(e) {
		// Ctrl/Cmd + Enter to submit
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (!sendBtn.disabled) {
				dispatchInputEvent('qic:submit', { value: chatInput.value });
			}
			return;
		}

		// Shift + Enter for new line (default behavior, but we can enhance)
		if (e.key === 'Enter' && e.shiftKey) {
			// Allow default behavior
			return;
		}

		// Plain Enter - configurable behavior
		if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			// Option: Submit on Enter (uncomment to enable)
			// e.preventDefault();
			// if (!sendBtn.disabled) {
			//     dispatchInputEvent('qic:submit', { value: chatInput.value });
			// }
			return;
		}

		// Escape to cancel
		if (e.key === 'Escape') {
			e.preventDefault();
			dispatchInputEvent('qic:cancel', {});
			return;
		}

		// @ for mention autocomplete (handled by Phase 4)
		if (e.key === '@') {
			dispatchInputEvent('qic:mention-trigger', {
				position: chatInput.selectionStart
			});
			return;
		}

		// Tab for autocomplete accept (Phase 4)
		if (e.key === 'Tab') {
			const hasAutocomplete = document.querySelector('.qic-autocomplete-active');
			if (hasAutocomplete) {
				e.preventDefault();
				dispatchInputEvent('qic:autocomplete-accept', {});
			}
			return;
		}

		// Arrow keys for autocomplete navigation (Phase 4)
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			const hasAutocomplete = document.querySelector('.qic-autocomplete-active');
			if (hasAutocomplete) {
				e.preventDefault();
				dispatchInputEvent('qic:autocomplete-navigate', {
					direction: e.key === 'ArrowUp' ? 'up' : 'down'
				});
			}
			return;
		}
	}

	function handleFocus() {
		chatInput.parentElement?.classList.add('qic-input-focused');
		dispatchInputEvent('qic:focus', {});
	}

	function handleBlur() {
		chatInput.parentElement?.classList.remove('qic-input-focused');
		dispatchInputEvent('qic:blur', {});
	}

	function handleSendClick(e) {
		e.preventDefault();
		if (!sendBtn.disabled) {
			dispatchInputEvent('qic:submit', { value: chatInput.value });
		}
	}

	function handleCancelClick(e) {
		e.preventDefault();
		dispatchInputEvent('qic:cancel', {});
	}

	function handleContextToggle(e) {
		e.preventDefault();
		const isExpanded = contextToggle.getAttribute('aria-expanded') === 'true';
		contextToggle.setAttribute('aria-expanded', !isExpanded);
		dispatchInputEvent('qic:context-toggle', { expanded: !isExpanded });
	}

	function handlePaste(e) {
		const text = e.clipboardData?.getData('text');

		// Check for large paste (06-05: Edge case handling)
		if (window.QicEdgeCaseUtils?.isPasteTooLarge(text)) {
			e.preventDefault();
			const size = window.QicEdgeCaseUtils.formatBytes(text.length);
			showLargePasteWarning(text, size);
			return;
		}

		// Allow normal paste, but dispatch event for potential processing
		dispatchInputEvent('qic:paste', { text });
	}

	function showLargePasteWarning(text, size) {
		// Create warning element if it doesn't exist
		let warning = document.getElementById('paste-warning');
		if (!warning) {
			warning = document.createElement('div');
			warning.id = 'paste-warning';
			warning.className = 'qic-paste-warning';
			warning.innerHTML = `
				<div class="qic-paste-warning-header">
					<span class="codicon codicon-warning"></span>
					<span>Large Paste Detected</span>
				</div>
				<div class="qic-paste-warning-message"></div>
				<div class="qic-paste-warning-actions">
					<button class="qic-btn qic-btn-secondary" data-action="add-context">Add as Context</button>
					<button class="qic-btn qic-btn-secondary" data-action="paste-anyway">Paste Anyway</button>
					<button class="qic-btn" data-action="cancel">Cancel</button>
				</div>
			`;
			chatInput?.parentNode?.insertBefore(warning, chatInput.nextSibling);

			warning.addEventListener('click', (e) => {
				const action = e.target.closest('[data-action]')?.dataset.action;
				if (action === 'add-context') {
					// Request to add as file context
					dispatchInputEvent('qic:add-text-context', { text: warning._pasteText });
					warning.remove();
				} else if (action === 'paste-anyway') {
					// Insert the text anyway
					if (chatInput) {
						const start = chatInput.selectionStart;
						const end = chatInput.selectionEnd;
						const value = chatInput.value;
						chatInput.value = value.slice(0, start) + warning._pasteText + value.slice(end);
						chatInput.selectionStart = chatInput.selectionEnd = start + warning._pasteText.length;
						chatInput.dispatchEvent(new Event('input', { bubbles: true }));
					}
					warning.remove();
				} else if (action === 'cancel') {
					warning.remove();
				}
			});
		}

		warning._pasteText = text;
		warning.querySelector('.qic-paste-warning-message').textContent =
			`The pasted content is ${size}. Consider adding it as context instead for better handling.`;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Auto-resize
	// ═══════════════════════════════════════════════════════════════════

	function autoResize() {
		if (!chatInput) return;

		// Reset height to auto to get accurate scrollHeight
		chatInput.style.height = 'auto';

		// Calculate new height
		const scrollHeight = chatInput.scrollHeight;
		const newHeight = Math.min(Math.max(scrollHeight, CONFIG.MIN_HEIGHT), CONFIG.MAX_HEIGHT);

		chatInput.style.height = newHeight + 'px';

		// Add/remove scrollable class
		if (scrollHeight > CONFIG.MAX_HEIGHT) {
			chatInput.classList.add('qic-input-scrollable');
		} else {
			chatInput.classList.remove('qic-input-scrollable');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Character Count
	// ═══════════════════════════════════════════════════════════════════

	function updateCharCount() {
		if (!charCount || !chatInput) return;

		const length = chatInput.value.length;

		if (length === 0) {
			charCount.textContent = '';
			charCount.className = 'qic-char-count';
			return;
		}

		charCount.textContent = length.toLocaleString();

		// Add warning/error classes
		if (length >= CONFIG.CHAR_MAX_THRESHOLD) {
			charCount.className = 'qic-char-count qic-char-error';
		} else if (length >= CONFIG.CHAR_WARN_THRESHOLD) {
			charCount.className = 'qic-char-count qic-char-warn';
		} else {
			charCount.className = 'qic-char-count';
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Button State
	// ═══════════════════════════════════════════════════════════════════

	function updateSendButtonState() {
		if (!sendBtn || !chatInput) return;

		const hasContent = chatInput.value.trim().length > 0;
		const isOverLimit = chatInput.value.length >= CONFIG.CHAR_MAX_THRESHOLD;
		const isLocked = chatInput.classList.contains('qic-input-locked');

		sendBtn.disabled = !hasContent || isOverLimit || isLocked;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Context Chips (Basic - Full implementation in Phase 4)
	// ═══════════════════════════════════════════════════════════════════

	function updateContextChips(items) {
		if (!contextChips || !contextCount) return;

		// Update count
		contextCount.textContent = items.length.toString();

		// Show/hide row
		if (contextChipsRow) {
			contextChipsRow.hidden = items.length === 0;
		}

		// Render chips (basic - full implementation in Phase 4)
		contextChips.innerHTML = items.slice(0, 5).map(item => `
			<div class="qic-context-chip" data-id="${escapeAttr(item.id)}">
				<span class="codicon codicon-${getContextIcon(item.type)}"></span>
				<span class="qic-chip-label">${escapeHtml(item.displayName)}</span>
				<button class="qic-chip-remove" title="Remove" aria-label="Remove ${item.displayName}">
					<span class="codicon codicon-close"></span>
				</button>
			</div>
		`).join('');

		// Add overflow indicator
		if (items.length > 5) {
			contextChips.innerHTML += `
				<span class="qic-chip-overflow">+${items.length - 5} more</span>
			`;
		}

		// Wire remove buttons
		contextChips.querySelectorAll('.qic-chip-remove').forEach(btn => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const chip = btn.closest('.qic-context-chip');
				const id = chip?.dataset.id;
				if (id) {
					dispatchInputEvent('qic:context-remove', { id });
				}
			});
		});
	}

	function getContextIcon(type) {
		const icons = {
			'file': 'file',
			'folder': 'folder',
			'selection': 'selection',
			'symbol': 'symbol-method',
			'terminal': 'terminal',
			'diagnostic': 'warning',
			'docs': 'book'
		};
		return icons[type] || 'file';
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	function getValue() {
		return chatInput?.value || '';
	}

	function setValue(value) {
		if (!chatInput) return;
		chatInput.value = value;
		autoResize();
		updateCharCount();
		updateSendButtonState();
	}

	function clear() {
		setValue('');
	}

	function focus() {
		chatInput?.focus();
	}

	function blur() {
		chatInput?.blur();
	}

	function disable() {
		if (chatInput) chatInput.disabled = true;
		if (sendBtn) sendBtn.disabled = true;
	}

	function enable() {
		if (chatInput) chatInput.disabled = false;
		updateSendButtonState();
	}

	function setPlaceholder(text) {
		if (chatInput) chatInput.placeholder = text;
	}

	function showCancelButton() {
		if (sendBtn) sendBtn.hidden = true;
		if (cancelBtn) cancelBtn.hidden = false;
	}

	function hideCancelButton() {
		if (sendBtn) sendBtn.hidden = false;
		if (cancelBtn) cancelBtn.hidden = true;
	}

	function insertText(text, position = null) {
		if (!chatInput) return;

		const start = position ?? chatInput.selectionStart;
		const end = chatInput.selectionEnd;
		const before = chatInput.value.substring(0, start);
		const after = chatInput.value.substring(end);

		chatInput.value = before + text + after;
		chatInput.selectionStart = chatInput.selectionEnd = start + text.length;

		autoResize();
		updateCharCount();
		updateSendButtonState();
		chatInput.focus();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function dispatchInputEvent(type, detail) {
		window.dispatchEvent(new CustomEvent(type, { detail }));
	}

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		if (resizeFrameId) {
			cancelAnimationFrame(resizeFrameId);
			resizeFrameId = null;
		}
		chatInput?.removeEventListener('input', handleInput);
		chatInput?.removeEventListener('keydown', handleKeydown);
		chatInput?.removeEventListener('focus', handleFocus);
		chatInput?.removeEventListener('blur', handleBlur);
		chatInput?.removeEventListener('paste', handlePaste);
		sendBtn?.removeEventListener('click', handleSendClick);
		cancelBtn?.removeEventListener('click', handleCancelClick);
		contextToggle?.removeEventListener('click', handleContextToggle);
		chatInput = null;
		sendBtn = null;
		cancelBtn = null;
		charCount = null;
		contextChipsRow = null;
		contextChips = null;
		contextToggle = null;
		contextCount = null;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.qicInputCore = {
		init,
		dispose,
		getValue,
		setValue,
		clear,
		focus,
		blur,
		disable,
		enable,
		setPlaceholder,
		showCancelButton,
		hideCancelButton,
		insertText,
		autoResize,
		updateSendButtonState,
		updateContextChips,

		// For other modules
		getElement: () => chatInput,

		// For debugging
		_debug: {
			getConfig: () => CONFIG
		}
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
