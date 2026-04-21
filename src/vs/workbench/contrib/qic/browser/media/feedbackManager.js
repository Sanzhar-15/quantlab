/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Feedback Manager
 * Handles response ratings and feedback collection
 * Phase 6 - Prompt 06-11: Lane Indicator & Feedback Buttons
 * GAP-14 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	const submittedFeedback = new Set(); // messageIds that have been rated
	let currentFeedback = null; // { messageId, rating }

	// ═══════════════════════════════════════════════════════════════════
	// DOM References (lazy loaded)
	// ═══════════════════════════════════════════════════════════════════

	let modal = null;

	function getModal() {
		if (!modal) {
			modal = document.getElementById('feedback-comment-modal');
		}
		return modal;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Add feedback buttons to a message element
	 * @param {HTMLElement} messageEl - The message element
	 * @param {string} messageId - The message ID
	 */
	function addFeedbackButtons(messageEl, messageId) {
		if (!messageEl || !messageId) return;

		if (submittedFeedback.has(messageId)) {
			const feedbackArea = messageEl.querySelector('.qic-message-feedback');
			if (feedbackArea) {
				showSubmittedState(feedbackArea);
			}
			return;
		}

		const feedbackArea = messageEl.querySelector('.qic-message-feedback');
		if (!feedbackArea) return;

		feedbackArea.hidden = false;
		feedbackArea.dataset.messageId = messageId;

		// Wire up buttons
		feedbackArea.querySelectorAll('.qic-feedback-btn').forEach(btn => {
			// Remove any existing listeners
			btn.replaceWith(btn.cloneNode(true));
		});

		// Re-query and add listeners
		feedbackArea.querySelectorAll('.qic-feedback-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				handleRatingClick(messageId, btn.dataset.rating, feedbackArea);
			});
		});
	}

	/**
	 * Create feedback buttons HTML
	 * @returns {string} HTML string for feedback buttons
	 */
	function createFeedbackButtonsHtml() {
		return `
			<div class="qic-message-feedback" hidden>
				<span class="qic-feedback-label">Was this helpful?</span>
				<button class="qic-feedback-btn" data-rating="positive" title="Yes, helpful" aria-label="Rate as helpful">
					<span class="codicon codicon-thumbsup" aria-hidden="true"></span>
				</button>
				<button class="qic-feedback-btn" data-rating="negative" title="No, not helpful" aria-label="Rate as not helpful">
					<span class="codicon codicon-thumbsdown" aria-hidden="true"></span>
				</button>
			</div>
		`;
	}

	/**
	 * Handle rating button click
	 * @param {string} messageId - The message ID
	 * @param {string} rating - The rating (positive/negative)
	 * @param {HTMLElement} feedbackArea - The feedback container
	 */
	function handleRatingClick(messageId, rating, feedbackArea) {
		// Update button states
		feedbackArea.querySelectorAll('.qic-feedback-btn').forEach(btn => {
			btn.classList.toggle('selected', btn.dataset.rating === rating);
			btn.disabled = true;
		});

		currentFeedback = { messageId, rating, feedbackArea };

		// For negative feedback, show comment modal
		if (rating === 'negative') {
			showCommentModal();
		} else {
			// Submit positive feedback immediately
			submitFeedback(messageId, rating);
			showSubmittedState(feedbackArea);
		}
	}

	/**
	 * Submit feedback to backend
	 * @param {string} messageId - The message ID
	 * @param {string} rating - The rating
	 * @param {string} comment - Optional comment
	 * @param {string[]} tags - Optional tags
	 */
	function submitFeedback(messageId, rating, comment, tags) {
		submittedFeedback.add(messageId);

		window.vscode?.postMessage({
			type: 'quality-signal',
			payload: {
				messageId,
				rating,
				comment: comment || undefined,
				tags: tags?.length ? tags : undefined,
			}
		});

		// Announce
		announceMessage('Feedback submitted. Thank you!');
	}

	/**
	 * Show submitted state
	 * @param {HTMLElement} feedbackArea - The feedback container
	 */
	function showSubmittedState(feedbackArea) {
		if (!(feedbackArea instanceof Element)) return;

		feedbackArea.classList.add('submitted');
		feedbackArea.innerHTML = `
			<div class="qic-feedback-submitted">
				<span class="codicon codicon-check" aria-hidden="true"></span>
				<span>Thanks for your feedback!</span>
			</div>
		`;
	}

	/**
	 * Check if feedback was already submitted for a message
	 * @param {string} messageId - The message ID
	 * @returns {boolean} Whether feedback was submitted
	 */
	function hasSubmittedFeedback(messageId) {
		return submittedFeedback.has(messageId);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Comment Modal
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show the comment modal
	 */
	function showCommentModal() {
		const modal = getModal();
		if (!modal || !currentFeedback) return;

		const icon = modal.querySelector('#feedback-modal-icon');
		const title = modal.querySelector('#feedback-modal-title');

		if (icon) {
			icon.className = 'codicon codicon-thumbsdown';
		}
		if (title) {
			title.textContent = 'Sorry to hear that!';
		}

		// Clear previous input
		const textarea = modal.querySelector('#feedback-comment');
		if (textarea) {
			textarea.value = '';
		}

		modal.querySelectorAll('.qic-feedback-tag input').forEach(cb => {
			cb.checked = false;
		});

		modal.hidden = false;

		// Focus textarea
		textarea?.focus();

		// Trap focus
		trapFocus(modal);
	}

	/**
	 * Hide the comment modal
	 */
	function hideCommentModal() {
		const modal = getModal();
		if (modal) {
			modal.hidden = true;
		}
	}

	/**
	 * Handle comment submit
	 */
	function handleCommentSubmit() {
		if (!currentFeedback) return;

		const modal = getModal();
		const comment = modal?.querySelector('#feedback-comment')?.value || '';
		const tags = Array.from(modal?.querySelectorAll('.qic-feedback-tag input:checked') || [])
			.map(cb => cb.value);

		submitFeedback(currentFeedback.messageId, currentFeedback.rating, comment, tags);

		hideCommentModal();
		showSubmittedState(currentFeedback.feedbackArea);

		currentFeedback = null;
	}

	/**
	 * Handle comment skip
	 */
	function handleCommentSkip() {
		if (!currentFeedback) return;

		// Submit without comment
		submitFeedback(currentFeedback.messageId, currentFeedback.rating);

		hideCommentModal();
		showSubmittedState(currentFeedback.feedbackArea);

		currentFeedback = null;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

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
	 * @param {HTMLElement} element - The element to trap focus within
	 */
	function trapFocus(element) {
		const focusableElements = element.querySelectorAll(
			'button:not([disabled]), textarea, input:not([disabled]), [tabindex]:not([tabindex="-1"])'
		);
		const firstFocusable = focusableElements[0];
		const lastFocusable = focusableElements[focusableElements.length - 1];

		element.addEventListener('keydown', function handleTab(e) {
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
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Setup event listeners
	 */
	function setupEventListeners() {
		const modal = getModal();
		if (!modal) return;

		// Modal actions
		modal.querySelector('[data-action="submit"]')?.addEventListener('click', handleCommentSubmit);
		modal.querySelector('[data-action="skip"]')?.addEventListener('click', handleCommentSkip);
		modal.querySelector('.qic-modal-close')?.addEventListener('click', handleCommentSkip);

		// Click outside
		modal.addEventListener('click', (e) => {
			if (e.target === modal) {
				handleCommentSkip();
			}
		});

		// Escape key
		modal.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				handleCommentSkip();
			}
		});

		// Enter in textarea submits (with Ctrl/Cmd)
		modal.querySelector('#feedback-comment')?.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				handleCommentSubmit();
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Initialize the feedback manager
	 */
	function init() {
		setupEventListeners();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicFeedbackManager = {
		addFeedbackButtons,
		createFeedbackButtonsHtml,
		hasSubmittedFeedback,
		init,
	};

	// Auto-init
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
