/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Empty State Manager
 * Handles empty state UI and quick actions
 */

(function() {
	'use strict';

	let emptyState = null;

	function init() {
		emptyState = document.getElementById('empty-state');
		if (!emptyState) return;

		// Wire quick action buttons
		emptyState.querySelectorAll('.qic-quick-action').forEach(btn => {
			btn.addEventListener('click', () => {
				const prompt = btn.dataset.prompt;
				if (prompt) {
					insertPrompt(prompt);
				}
			});
		});
	}

	function insertPrompt(prompt) {
		// Insert into input and focus
		if (window.qicInputCore) {
			window.qicInputCore.setValue(prompt);
			window.qicInputCore.focus();
		} else {
			// Fallback: try direct DOM manipulation
			const chatInput = document.getElementById('chat-input');
			if (chatInput) {
				chatInput.value = prompt;
				chatInput.focus();
				// Trigger input event for send button state update
				chatInput.dispatchEvent(new Event('input', { bubbles: true }));
			}
		}
	}

	function show() {
		if (emptyState) {
			emptyState.hidden = false;
		}
	}

	function hide() {
		if (emptyState) {
			emptyState.hidden = true;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	window.qicEmptyState = {
		init,
		show,
		hide,
		insertPrompt
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
