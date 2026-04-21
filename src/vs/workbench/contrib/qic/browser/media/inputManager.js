/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Input Manager
 * Handles input lockout and concurrent request prevention
 * GAP-17 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		DEBOUNCE_MS: 300,           // Prevent double-clicks
		ERROR_UNLOCK_DELAY_MS: 3000, // Unlock after error state
		TOAST_DURATION_MS: 2000,    // Toast visibility duration
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let chatInput = null;
	let sendBtn = null;
	let cancelBtn = null;
	let isLocked = false;
	let lastSubmitTime = 0;
	let currentPlaceholder = 'Ask anything...';
	let unsubscribe = null;
	let errorUnlockTimerId = null;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		chatInput = document.getElementById('chat-input');
		sendBtn = document.getElementById('send-btn');
		cancelBtn = document.getElementById('cancel-btn');

		if (!chatInput || !sendBtn) {
			console.error('[InputManager] Required elements not found');
			return;
		}

		setupEventListeners();
		subscribeToState();
		updateSendButtonState();
	}

	function setupEventListeners() {
		// Listen to custom events from inputCore (avoids duplicate DOM handlers)
		window.addEventListener('qic:submit', handleSubmitEvent);
		window.addEventListener('qic:cancel', handleCancel);

		// Cancel button (unique to inputManager)
		cancelBtn?.addEventListener('click', handleCancel);
	}

	function subscribeToState() {
		if (!window.qicState) {
			console.warn('[InputManager] State manager not available');
			return;
		}

		unsubscribe = window.qicState.subscribeTo('agentState', (state, patch) => {
			handleAgentStateChange(window.qicState.selectors.getAgentState());
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function handleSubmitEvent() {
		submit();
	}

	function handleCancel() {
		if (!isLocked) return;

		vscode.postMessage({ type: 'cancel-request' });
		showToast('Cancelling...');
	}

	function handleAgentStateChange(agentState) {
		switch (agentState) {
			case 'idle':
				unlock();
				break;

			case 'processing':
				lock('processing');
				break;

			case 'waiting_approval':
				lock('waiting_approval');
				break;

			case 'error':
				lock('error');
				// Clear any previous error timeout
				if (errorUnlockTimerId) {
					clearTimeout(errorUnlockTimerId);
				}
				// Auto-unlock after delay for error state
				errorUnlockTimerId = setTimeout(() => {
					errorUnlockTimerId = null;
					const currentState = window.qicState?.selectors.getAgentState();
					if (currentState === 'error') {
						unlock();
					}
				}, CONFIG.ERROR_UNLOCK_DELAY_MS);
				break;

			case 'suspended':
				lock('suspended');
				break;

			default:
				console.warn('[InputManager] Unknown agent state:', agentState);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Lock/Unlock
	// ═══════════════════════════════════════════════════════════════════

	function lock(reason) {
		if (isLocked) return;

		isLocked = true;
		chatInput.disabled = true;
		sendBtn.disabled = true;

		// Show cancel button, hide send button
		if (cancelBtn) {
			sendBtn.hidden = true;
			cancelBtn.hidden = false;
		}

		// Update placeholder
		currentPlaceholder = chatInput.placeholder;
		chatInput.placeholder = getPlaceholderForReason(reason);

		// Add visual indicator
		chatInput.classList.add('qic-input-locked');
	}

	function unlock() {
		if (!isLocked) return;

		isLocked = false;
		chatInput.disabled = false;
		updateSendButtonState();

		// Show send button, hide cancel button
		if (cancelBtn) {
			sendBtn.hidden = false;
			cancelBtn.hidden = true;
		}

		// Restore placeholder
		chatInput.placeholder = currentPlaceholder || 'Ask anything...';

		// Remove visual indicator
		chatInput.classList.remove('qic-input-locked');

		// Focus input
		chatInput.focus();
	}

	function getPlaceholderForReason(reason) {
		const placeholders = {
			'processing': 'Waiting for response...',
			'waiting_approval': 'Waiting for your approval...',
			'error': 'Error occurred - check status',
			'suspended': 'Conversation suspended'
		};
		return placeholders[reason] || 'Please wait...';
	}

	// ═══════════════════════════════════════════════════════════════════
	// Submit
	// ═══════════════════════════════════════════════════════════════════

	function submit() {
		const now = Date.now();

		// Debounce rapid submissions
		if (now - lastSubmitTime < CONFIG.DEBOUNCE_MS) {
			return false;
		}

		// Check lock state
		if (isLocked) {
			showToast('Please wait for the current response...');
			return false;
		}

		// Get content
		const content = chatInput.value.trim();
		if (!content) {
			return false;
		}

		// Record submit time
		lastSubmitTime = now;

		// Lock immediately for responsive feel
		lock('processing');

		// Collect mentions (basic implementation)
		const mentions = extractMentions(content);

		// Send message via legacy protocol (user-message) for compatibility
		vscode.postMessage({
			type: 'user-message',
			text: content,
			mentions: mentions
		});

		// Clear input (delegate to inputCore to handle resize)
		if (window.qicInputCore) {
			window.qicInputCore.clear();
		} else {
			chatInput.value = '';
		}

		return true;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function updateSendButtonState() {
		// Delegate to inputCore if available, otherwise fallback
		if (window.qicInputCore?.updateSendButtonState) {
			window.qicInputCore.updateSendButtonState();
			return;
		}
		if (isLocked) {
			sendBtn.disabled = true;
			return;
		}
		sendBtn.disabled = !chatInput.value.trim();
	}

	function extractMentions(content) {
		// Basic mention extraction
		// Full implementation in Phase 4
		const mentions = [];
		const regex = /@([\w./\-]+)/g;
		let match;

		while ((match = regex.exec(content)) !== null) {
			mentions.push({
				id: match[1],
				type: 'file',
				path: match[1],
				displayName: match[1],
				tokens: 0
			});
		}

		return mentions;
	}

	function showToast(message) {
		// Use shared toast if available
		if (window.qicToast?.show) {
			window.qicToast.show(message);
			return;
		}

		// Remove existing toast
		const existing = document.querySelector('.qic-toast');
		existing?.remove();

		// Create new toast
		const toast = document.createElement('div');
		toast.className = 'qic-toast';
		toast.textContent = message;
		toast.setAttribute('role', 'alert');
		document.body.appendChild(toast);

		// Animate in
		requestAnimationFrame(() => {
			toast.classList.add('qic-toast-visible');
		});

		// Remove after duration
		setTimeout(() => {
			toast.classList.remove('qic-toast-visible');
			setTimeout(() => toast.remove(), 300);
		}, CONFIG.TOAST_DURATION_MS);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (errorUnlockTimerId) {
			clearTimeout(errorUnlockTimerId);
			errorUnlockTimerId = null;
		}
		window.removeEventListener('qic:submit', handleSubmitEvent);
		window.removeEventListener('qic:cancel', handleCancel);
		cancelBtn?.removeEventListener('click', handleCancel);
		chatInput = null;
		sendBtn = null;
		cancelBtn = null;
		isLocked = false;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	window.qicInput = {
		init,
		submit,
		cancel: handleCancel,
		dispose,
		isLocked: () => isLocked,
		focus: () => chatInput?.focus(),

		// For debugging
		_debug: {
			lock,
			unlock,
			getLastSubmitTime: () => lastSubmitTime
		}
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
