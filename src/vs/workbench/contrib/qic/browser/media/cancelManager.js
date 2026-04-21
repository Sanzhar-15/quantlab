/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Cancel Manager
 * Handles cancel actions and their effects
 * Phase 6 - Prompt 06-10: Cancel Semantics & Timeout Handling
 * GAP-10 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CANCEL_SCENARIOS = {
		'pre-stream': {
			// Before any response received
			effect: 'clear_pending',
			preservePartial: false,
			confirmRequired: false,
		},
		'mid-stream': {
			// During streaming
			effect: 'finalize_partial',
			preservePartial: true,
			confirmRequired: false,
		},
		'tool-pending': {
			// During tool execution
			effect: 'abort_tool',
			preservePartial: true,
			confirmRequired: true,
			confirmMessage: 'Cancel tool execution? This may leave your workspace in an inconsistent state.',
		},
		'permission-pending': {
			// Waiting for permission
			effect: 'deny_permission',
			preservePartial: false,
			confirmRequired: false,
		},
		'approval-pending': {
			// Waiting for change approval
			effect: 'dismiss_changes',
			preservePartial: false,
			confirmRequired: true,
			confirmMessage: 'Dismiss pending changes? You can regenerate them later.',
		},
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentOperation = null;
	let cancelInProgress = false;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Request cancellation of current operation
	 * @param {string} reason - The reason for cancellation
	 * @returns {Promise<Object|null>} Cancel result or null
	 */
	async function requestCancel(reason = 'user_requested') {
		if (cancelInProgress) {
			return null;
		}

		const scenario = determineScenario();
		if (!scenario) {
			return null;
		}

		const config = CANCEL_SCENARIOS[scenario];

		// Check if confirmation needed
		if (config.confirmRequired) {
			const confirmed = await showConfirmation(config.confirmMessage);
			if (!confirmed) {
				return null;
			}
		}

		cancelInProgress = true;

		try {
			// Execute cancel based on scenario
			const result = await executeCancel(scenario, reason);

			// Update UI
			handleCancelComplete(scenario, result);

			return result;
		} finally {
			cancelInProgress = false;
		}
	}

	/**
	 * Determine current scenario based on state
	 * @returns {string|null} The current cancel scenario
	 */
	function determineScenario() {
		const state = window.qicState?.getState?.() || window.qicState?.selectors?.getState?.();
		if (!state) return null;

		const agentState = state.agentState;

		// Check for streaming
		if (window.qicStreaming?.isStreaming?.()) {
			return 'mid-stream';
		}

		// Check for pending tool
		if (state.pendingToolCall) {
			return 'tool-pending';
		}

		// Check for pending permission
		if (document.querySelector('.qic-permission-card:not([hidden])')) {
			return 'permission-pending';
		}

		// Check for pending approval
		if (state.pendingChanges?.length > 0) {
			return 'approval-pending';
		}

		// Check if processing but no stream yet
		if (agentState === 'processing') {
			return 'pre-stream';
		}

		return null;
	}

	/**
	 * Execute the cancel action
	 * @param {string} scenario - The cancel scenario
	 * @param {string} reason - The reason for cancellation
	 * @returns {Promise<Object>} The cancel result
	 */
	async function executeCancel(scenario, reason) {
		const config = CANCEL_SCENARIOS[scenario];
		const result = {
			scenario,
			reason,
			preservePartial: config.preservePartial,
		};

		switch (config.effect) {
			case 'clear_pending':
				// Just notify backend, no cleanup needed
				window.vscode?.postMessage({
					type: 'cancel:request',
					payload: { reason, scenario }
				});
				break;

			case 'finalize_partial':
				// Finalize the partial message
				const partialContent = window.qicStreaming?.getContent?.();
				window.qicStreaming?.completeStream?.(null, { cancelled: true });

				result.partialContent = partialContent;

				window.vscode?.postMessage({
					type: 'cancel:request',
					payload: {
						reason,
						scenario,
						preservePartial: true,
						partialContent,
					}
				});
				break;

			case 'abort_tool':
				window.vscode?.postMessage({
					type: 'cancel:abort-tool',
					payload: { reason }
				});
				break;

			case 'deny_permission':
				// Close all permission cards with denial
				document.querySelectorAll('.qic-permission-card').forEach(card => {
					const requestId = card.dataset.requestId;
					window.QicApprovalManager?.respondToPermission?.(requestId, false, 'once', 'Cancelled');
				});
				break;

			case 'dismiss_changes':
				window.vscode?.postMessage({
					type: 'changes:dismiss-all',
					payload: { reason }
				});
				break;
		}

		return result;
	}

	/**
	 * Handle cancel completion
	 * @param {string} scenario - The cancel scenario
	 * @param {Object} result - The cancel result
	 */
	function handleCancelComplete(scenario, result) {
		// Show feedback
		let message = 'Cancelled';

		switch (scenario) {
			case 'mid-stream':
				message = result.preservePartial
					? 'Stopped. Partial response preserved.'
					: 'Stopped.';
				break;
			case 'tool-pending':
				message = 'Tool execution cancelled.';
				break;
			case 'permission-pending':
				message = 'Permission denied.';
				break;
			case 'approval-pending':
				message = 'Changes dismissed.';
				break;
		}

		// Show indicator
		showCancelIndicator(message);

		// Announce for screen readers
		announceMessage(message);

		// Re-enable input
		window.qicInputCore?.setEnabled?.(true);

		// End timeout tracking
		window.QicTimeoutManager?.endStage?.();
	}

	/**
	 * Show cancel indicator on message
	 * @param {string} message - The message to display
	 */
	function showCancelIndicator(message) {
		const indicator = document.createElement('div');
		indicator.className = 'qic-cancel-indicator';
		indicator.setAttribute('role', 'status');
		indicator.setAttribute('aria-live', 'polite');
		indicator.innerHTML = `
			<span class="codicon codicon-debug-stop" aria-hidden="true"></span>
			<span>${escapeHtml(message)}</span>
			<button class="qic-retry-btn" title="Retry last request">
				<span class="codicon codicon-refresh" aria-hidden="true"></span> Retry
			</button>
		`;

		indicator.querySelector('.qic-retry-btn')?.addEventListener('click', () => {
			retryLastRequest();
			indicator.remove();
		});

		// Insert after last message
		const messages = document.getElementById('messages');
		if (messages) {
			messages.appendChild(indicator);
			messages.scrollTop = messages.scrollHeight;
		}

		// Auto-remove after 10 seconds
		setTimeout(() => {
			indicator.classList.add('fading');
			setTimeout(() => indicator.remove(), 300);
		}, 10000);
	}

	/**
	 * Retry the last cancelled request
	 */
	function retryLastRequest() {
		window.vscode?.postMessage({ type: 'retry:last' });
	}

	/**
	 * Show confirmation dialog
	 * @param {string} message - The confirmation message
	 * @returns {Promise<boolean>} Whether the user confirmed
	 */
	async function showConfirmation(message) {
		return new Promise(resolve => {
			// Use VS Code-style modal if available, otherwise simple confirm
			if (window.QicErrorManager?.showConfirm) {
				window.QicErrorManager.showConfirm(message, resolve);
			} else {
				resolve(window.confirm(message));
			}
		});
	}

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	/**
	 * Announce message for screen readers
	 * @param {string} message - The message to announce
	 */
	function announceMessage(message) {
		// Use existing announcer or create one
		let announcer = document.getElementById('qic-announcer');
		if (!announcer) {
			announcer = document.createElement('div');
			announcer.id = 'qic-announcer';
			announcer.className = 'qic-sr-only';
			announcer.setAttribute('aria-live', 'polite');
			announcer.setAttribute('aria-atomic', 'true');
			document.body.appendChild(announcer);
		}
		announcer.textContent = message;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Keyboard Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleEscapeKey(e) {
		if (e.key === 'Escape') {
			const scenario = determineScenario();
			if (scenario) {
				e.preventDefault();
				requestCancel('user_requested');
			}
		}
	}

	function handleStopShortcut(e) {
		// Cmd+. (macOS stop shortcut) / Ctrl+. (Windows/Linux)
		if ((e.metaKey || e.ctrlKey) && e.key === '.') {
			e.preventDefault();
			requestCancel('user_requested');
		}
	}

	function setupKeyboardHandlers() {
		document.addEventListener('keydown', handleEscapeKey);
		document.addEventListener('keydown', handleStopShortcut);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle messages from the host
	 * @param {Object} msg - The message object
	 * @returns {boolean} Whether the message was handled
	 */
	function handleMessage(msg) {
		switch (msg.type) {
			case 'cancel:confirmed':
				// Backend confirmed cancel
				return true;

			case 'cancel:failed':
				// Cancel failed, show error
				window.QicErrorManager?.showError?.({
					code: 'CANCEL_FAILED',
					message: msg.payload?.message || 'Failed to cancel operation',
				});
				return true;

			default:
				return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		document.removeEventListener('keydown', handleEscapeKey);
		document.removeEventListener('keydown', handleStopShortcut);
		currentOperation = null;
		cancelInProgress = false;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicCancelManager = {
		requestCancel,
		determineScenario,
		handleMessage,
		dispose,
	};

	// Initialize
	setupKeyboardHandlers();

})();
