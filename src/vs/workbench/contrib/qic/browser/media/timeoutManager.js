/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Timeout Manager
 * Handles timeout warnings and recovery
 * Phase 6 - Prompt 06-10: Cancel Semantics & Timeout Handling
 * GAP-02 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const TIMEOUTS = {
		processing: {
			warning: 30000,    // 30 seconds - show warning
			extended: 60000,   // 1 minute - show extended warning
			hard: 120000,      // 2 minutes - auto-cancel option
		},
		tool_execution: {
			warning: 15000,    // 15 seconds
			extended: 30000,   // 30 seconds
			hard: 60000,       // 1 minute
		},
		waiting_approval: {
			warning: 300000,   // 5 minutes
			hard: 600000,      // 10 minutes (soft reminder)
		},
	};

	const MESSAGES = {
		processing: {
			warning: 'Taking longer than usual...',
			extended: 'Still working. This is taking a while.',
			hard: 'Request may have stalled. Consider cancelling.',
		},
		tool_execution: {
			warning: 'Tool execution in progress...',
			extended: 'Tool is still running.',
			hard: 'Tool execution taking too long.',
		},
		waiting_approval: {
			warning: 'Waiting for your approval.',
			hard: 'Changes are still pending approval.',
		},
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentStage = null;
	let stageStartTime = null;
	let timers = {};
	let warningBanner = null;
	let elapsedInterval = null;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Start tracking a stage
	 * @param {string} stage - The stage to track
	 */
	function startStage(stage) {
		clearTimers();
		currentStage = stage;
		stageStartTime = Date.now();

		const config = TIMEOUTS[stage];
		if (!config) return;

		// Set warning timers
		if (config.warning) {
			timers.warning = setTimeout(() => {
				showWarning(stage, 'warning');
			}, config.warning);
		}

		if (config.extended) {
			timers.extended = setTimeout(() => {
				showWarning(stage, 'extended');
			}, config.extended);
		}

		if (config.hard) {
			timers.hard = setTimeout(() => {
				showWarning(stage, 'hard');
			}, config.hard);
		}
	}

	/**
	 * End tracking current stage
	 */
	function endStage() {
		clearTimers();
		hideWarning();
		currentStage = null;
		stageStartTime = null;
	}

	/**
	 * Clear all timers
	 */
	function clearTimers() {
		Object.values(timers).forEach(t => clearTimeout(t));
		timers = {};

		if (elapsedInterval) {
			clearInterval(elapsedInterval);
			elapsedInterval = null;
		}
	}

	/**
	 * Get elapsed time in current stage
	 * @returns {number} Elapsed time in milliseconds
	 */
	function getElapsed() {
		if (!stageStartTime) return 0;
		return Date.now() - stageStartTime;
	}

	/**
	 * Get current stage
	 * @returns {string|null} Current stage
	 */
	function getCurrentStage() {
		return currentStage;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Warning Banner
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show warning banner
	 * @param {string} stage - The current stage
	 * @param {string} level - The warning level
	 */
	function showWarning(stage, level) {
		const message = MESSAGES[stage]?.[level] || 'Taking longer than expected...';

		if (!warningBanner) {
			createWarningBanner();
		}

		// Update message
		const messageEl = warningBanner.querySelector('.qic-timeout-message');
		if (messageEl) {
			messageEl.textContent = message;
		}

		// Update styling based on level
		warningBanner.dataset.level = level;

		// Show/hide cancel button based on level
		const cancelBtn = warningBanner.querySelector('.qic-timeout-cancel');
		if (cancelBtn) {
			cancelBtn.hidden = level !== 'hard';
		}

		// Update elapsed time
		updateElapsedTime();

		// Start elapsed time updater if not running
		if (!elapsedInterval) {
			elapsedInterval = setInterval(updateElapsedTime, 1000);
		}

		warningBanner.hidden = false;

		// Announce for screen readers
		announceMessage(message);
	}

	/**
	 * Hide warning banner
	 */
	function hideWarning() {
		if (warningBanner) {
			warningBanner.hidden = true;
		}
	}

	/**
	 * Create warning banner element
	 */
	function createWarningBanner() {
		warningBanner = document.createElement('div');
		warningBanner.className = 'qic-timeout-banner';
		warningBanner.setAttribute('role', 'status');
		warningBanner.setAttribute('aria-live', 'polite');
		warningBanner.hidden = true;

		warningBanner.innerHTML = `
			<span class="codicon codicon-loading qic-timeout-spinner" aria-hidden="true"></span>
			<span class="qic-timeout-message"></span>
			<span class="qic-timeout-elapsed" aria-label="Elapsed time"></span>
			<button class="qic-timeout-cancel qic-btn secondary" hidden aria-label="Cancel operation">
				Cancel
			</button>
		`;

		warningBanner.querySelector('.qic-timeout-cancel')?.addEventListener('click', () => {
			window.QicCancelManager?.requestCancel?.('timeout');
		});

		// Insert at top of messages
		const messagesContainer = document.querySelector('.qic-messages-container');
		const messages = document.getElementById('messages');
		if (messagesContainer) {
			messagesContainer.insertBefore(warningBanner, messages);
		} else if (messages?.parentNode) {
			messages.parentNode.insertBefore(warningBanner, messages);
		}
	}

	/**
	 * Update elapsed time display
	 */
	function updateElapsedTime() {
		if (!warningBanner || warningBanner.hidden) return;

		const elapsed = getElapsed();
		const seconds = Math.floor(elapsed / 1000);
		const minutes = Math.floor(seconds / 60);

		let text;
		if (minutes > 0) {
			text = `${minutes}m ${seconds % 60}s`;
		} else {
			text = `${seconds}s`;
		}

		const elapsedEl = warningBanner.querySelector('.qic-timeout-elapsed');
		if (elapsedEl) {
			elapsedEl.textContent = text;
			elapsedEl.setAttribute('aria-label', `Elapsed time: ${text}`);
		}
	}

	/**
	 * Announce message for screen readers
	 * @param {string} message - The message to announce
	 */
	function announceMessage(message) {
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
	// State Change Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle state changes
	 * @param {Object} newState - The new state
	 * @param {Object} oldState - The previous state
	 */
	function handleStateChange(newState, oldState) {
		const agentState = newState?.agentState;
		const prevAgentState = oldState?.agentState;

		if (agentState === prevAgentState) return;

		switch (agentState) {
			case 'processing':
				startStage('processing');
				break;

			case 'waiting_approval':
				startStage('waiting_approval');
				break;

			case 'idle':
			case 'error':
				endStage();
				break;
		}
	}

	/**
	 * Handle tool start for tool-specific timeouts
	 * @param {Object} toolInfo - Tool information
	 */
	function handleToolStart(toolInfo) {
		// Switch to tool execution timeout tracking
		if (currentStage === 'processing') {
			clearTimers();
			startStage('tool_execution');
		}
	}

	/**
	 * Handle tool completion
	 * @param {Object} result - Tool result
	 */
	function handleToolComplete(result) {
		// Return to processing timeout tracking if still processing
		const state = window.qicState?.getState?.() || window.qicState?.selectors?.getState?.();
		if (state?.agentState === 'processing') {
			clearTimers();
			startStage('processing');
		}
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
			case 'tool:start':
			case 'tool-call-started':
				handleToolStart(msg.payload);
				return true;

			case 'tool:result':
			case 'tool-call-result':
				handleToolComplete(msg.payload);
				return true;

			default:
				return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicTimeoutManager = {
		startStage,
		endStage,
		getElapsed,
		getCurrentStage,
		handleStateChange,
		handleToolStart,
		handleToolComplete,
		handleMessage,
	};

})();
