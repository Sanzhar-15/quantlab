/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Summarization Manager
 * Handles summarization notifications and summary viewing
 * Phase 6 - Prompt 06-12: Summarization Notification
 * GAP-09 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let state = {
		inProgress: false,
		lastSummary: null,
		lastEvent: null,
	};

	let dismissTimeout = null;

	// ═══════════════════════════════════════════════════════════════════
	// DOM References (lazy loaded)
	// ═══════════════════════════════════════════════════════════════════

	let toast = null;
	let progressBanner = null;
	let modal = null;

	function getElements() {
		if (!toast) {
			toast = document.getElementById('summarization-toast');
			progressBanner = document.getElementById('summarization-progress');
			modal = document.getElementById('summary-viewer-modal');
		}
		return { toast, progressBanner, modal };
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle summarization event from backend
	 * @param {Object} event - The summarization event
	 */
	function handleSummarizationEvent(event) {
		state.lastEvent = event;

		switch (event.type) {
			case 'started':
				showProgress();
				break;

			case 'completed':
				hideProgress();
				state.lastSummary = event.summary;
				showCompletionToast(event);
				break;

			case 'failed':
				hideProgress();
				showFailureToast(event);
				break;
		}
	}

	/**
	 * Show the summary viewer modal
	 */
	function showSummaryViewer() {
		const { modal } = getElements();
		if (!modal || !state.lastSummary) return;

		// Populate modal
		const messageCount = modal.querySelector('#summary-message-count');
		const tokensSaved = modal.querySelector('#summary-tokens-saved');
		const content = modal.querySelector('#summary-content');

		if (state.lastEvent) {
			if (messageCount) {
				messageCount.textContent = state.lastEvent.messageCount || '?';
			}
			if (tokensSaved) {
				tokensSaved.textContent = formatTokens(state.lastEvent.tokensSaved);
			}
		}

		if (content) {
			content.innerHTML = formatSummary(state.lastSummary);
		}

		modal.hidden = false;

		// Focus close button
		const closeBtn = modal.querySelector('[data-action="close"]');
		closeBtn?.focus();

		// Trap focus within modal
		trapFocus(modal);

		// Announce
		announceMessage('Conversation summary opened');
	}

	/**
	 * Hide the summary viewer modal
	 */
	function hideSummaryViewer() {
		const { modal } = getElements();
		if (modal) {
			modal.hidden = true;
		}
	}

	/**
	 * Check if summarization is in progress
	 * @returns {boolean}
	 */
	function isInProgress() {
		return state.inProgress;
	}

	/**
	 * Get last summary text
	 * @returns {string|null}
	 */
	function getLastSummary() {
		return state.lastSummary;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Progress Banner
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show the progress banner
	 */
	function showProgress() {
		state.inProgress = true;
		const { progressBanner } = getElements();
		if (progressBanner) {
			progressBanner.hidden = false;
		}

		// Announce
		announceMessage('Optimizing conversation context');
	}

	/**
	 * Hide the progress banner
	 */
	function hideProgress() {
		state.inProgress = false;
		const { progressBanner } = getElements();
		if (progressBanner) {
			progressBanner.hidden = true;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Toast Notifications
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show completion toast
	 * @param {Object} event - The completion event
	 */
	function showCompletionToast(event) {
		const { toast } = getElements();
		if (!toast) return;

		// Update savings display
		const savingsEl = toast.querySelector('.qic-summarization-savings');
		const savingsText = toast.querySelector('.savings-text');

		if (event.tokensSaved && savingsEl && savingsText) {
			savingsText.textContent = `${formatTokens(event.tokensSaved)} tokens freed`;
			savingsEl.hidden = false;
		} else if (savingsEl) {
			savingsEl.hidden = true;
		}

		// Show toast
		toast.hidden = false;
		toast.classList.remove('hiding');

		// Announce
		const messageCount = event.messageCount || 'Earlier';
		const tokensSaved = formatTokens(event.tokensSaved);
		announceMessage(
			`Context optimized. ${messageCount} messages were summarized, saving ${tokensSaved} tokens.`
		);

		// Auto-dismiss after 10 seconds
		clearTimeout(dismissTimeout);
		dismissTimeout = setTimeout(() => {
			dismissToast();
		}, 10000);
	}

	/**
	 * Show failure toast
	 * @param {Object} event - The failure event
	 */
	function showFailureToast(event) {
		// Use error display system
		window.vscode?.postMessage({
			type: 'notification',
			payload: {
				severity: 'warning',
				message: 'Context optimization failed. You may experience reduced context capacity.',
			}
		});

		// Also announce for screen readers
		announceMessage('Context optimization failed');
	}

	/**
	 * Dismiss the toast notification
	 */
	function dismissToast() {
		const { toast } = getElements();
		if (!toast) return;

		toast.classList.add('hiding');
		setTimeout(() => {
			toast.hidden = true;
			toast.classList.remove('hiding');
		}, 200);

		clearTimeout(dismissTimeout);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Format token count for display
	 * @param {number} tokens - Token count
	 * @returns {string} Formatted string
	 */
	function formatTokens(tokens) {
		if (!tokens) return '0';
		if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(1)}K`;
		}
		return tokens.toString();
	}

	/**
	 * Format summary text for display
	 * @param {string} summary - Raw summary text
	 * @returns {string} HTML formatted summary
	 */
	function formatSummary(summary) {
		if (!summary) return '<p>Summary not available.</p>';

		// Convert markdown-style formatting
		return summary
			.split('\n\n')
			.map(para => `<p>${escapeHtml(para)}</p>`)
			.join('');
	}

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	/**
	 * Announce message for screen readers
	 * @param {string} message - Message to announce
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

	/**
	 * Trap focus within an element
	 * @param {HTMLElement} element - Element to trap focus within
	 */
	function trapFocus(element) {
		const focusableElements = element.querySelectorAll(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		);
		const firstFocusable = focusableElements[0];
		const lastFocusable = focusableElements[focusableElements.length - 1];

		function handleKeyDown(e) {
			if (e.key !== 'Tab') return;

			if (e.shiftKey) {
				if (document.activeElement === firstFocusable) {
					e.preventDefault();
					lastFocusable?.focus();
				}
			} else {
				if (document.activeElement === lastFocusable) {
					e.preventDefault();
					firstFocusable?.focus();
				}
			}
		}

		element.addEventListener('keydown', handleKeyDown);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Setup event listeners
	 */
	function setupEventListeners() {
		const { toast, modal } = getElements();

		// Toast actions
		toast?.querySelector('[data-action="view-summary"]')?.addEventListener('click', () => {
			dismissToast();
			showSummaryViewer();
		});

		toast?.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
			dismissToast();
		});

		// Modal actions
		modal?.querySelectorAll('[data-action="close"]').forEach(btn => {
			btn.addEventListener('click', hideSummaryViewer);
		});

		// Click outside modal
		modal?.addEventListener('click', (e) => {
			if (e.target === modal) {
				hideSummaryViewer();
			}
		});

		// Escape key for modal
		modal?.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				hideSummaryViewer();
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle messages from the host
	 * @param {Object} message - The message object
	 * @returns {boolean} Whether the message was handled
	 */
	function handleMessage(message) {
		switch (message.type) {
			case 'summarization:started':
				handleSummarizationEvent({ type: 'started', ...message.payload });
				return true;

			case 'summarization:completed':
				handleSummarizationEvent({ type: 'completed', ...message.payload });
				return true;

			case 'summarization:failed':
				handleSummarizationEvent({ type: 'failed', ...message.payload });
				return true;

			case 'show-summary':
				showSummaryViewer();
				return true;

			default:
				return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Initialize the summarization manager
	 */
	function init() {
		setupEventListeners();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicSummarizationManager = {
		handleSummarizationEvent,
		showSummaryViewer,
		hideSummaryViewer,
		isInProgress,
		getLastSummary,
		handleMessage,
		init,
	};

	// Auto-init
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
