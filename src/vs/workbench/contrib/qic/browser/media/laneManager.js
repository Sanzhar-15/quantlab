/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Lane Manager
 * Handles lane indicator and transitions
 * Phase 6 - Prompt 06-11: Lane Indicator & Feedback Buttons
 * GAP-12 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const LANE_CONFIGS = {
		'chat-ask': {
			displayName: 'Ask',
			icon: 'codicon-comment-discussion',
			maxContext: 16000,
			description: 'Answer questions about code',
		},
		'chat-gather': {
			displayName: 'Gather',
			icon: 'codicon-search',
			maxContext: 32000,
			description: 'Gather context for complex tasks',
		},
		'chat-plan': {
			displayName: 'Plan',
			icon: 'codicon-checklist',
			maxContext: 64000,
			description: 'Plan implementation strategy',
		},
		'chat-act': {
			displayName: 'Code',
			icon: 'codicon-code',
			maxContext: 200000,
			description: 'Execute code changes',
		},
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentLane = null;
	let tooltipVisible = false;
	let toastTimeout = null;

	// ═══════════════════════════════════════════════════════════════════
	// DOM References (lazy loaded)
	// ═══════════════════════════════════════════════════════════════════

	let indicator = null;
	let badge = null;
	let tooltip = null;
	let toast = null;

	function getElements() {
		if (!indicator) {
			indicator = document.getElementById('lane-indicator');
			badge = indicator?.querySelector('.qic-lane-badge');
			tooltip = document.getElementById('lane-tooltip');
			toast = document.getElementById('lane-transition-toast');
		}
		return { indicator, badge, tooltip, toast };
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Set the current lane
	 * @param {string} lane - The lane identifier
	 */
	function setLane(lane) {
		const prevLane = currentLane;
		currentLane = lane;

		const { indicator, badge, tooltip } = getElements();
		if (!indicator) return;

		const config = LANE_CONFIGS[lane];
		if (!config) {
			indicator.hidden = true;
			return;
		}

		// Update badge
		indicator.hidden = false;
		indicator.dataset.lane = lane;

		const icon = badge?.querySelector('.qic-lane-icon');
		const name = badge?.querySelector('.qic-lane-name');

		if (icon) {
			icon.className = `qic-lane-icon codicon ${config.icon}`;
		}
		if (name) {
			name.textContent = config.displayName;
		}

		// Update tooltip
		if (tooltip) {
			const desc = tooltip.querySelector('.qic-lane-desc');
			const context = tooltip.querySelector('.qic-lane-context strong');

			if (desc) {
				desc.textContent = config.description;
			}
			if (context) {
				context.textContent = formatTokens(config.maxContext);
			}
		}

		// Show transition toast if lane changed
		if (prevLane && prevLane !== lane) {
			showTransitionToast(prevLane, lane);
		}

		// Update context drawer limit if available
		window.QicContextDrawer?.setLimit?.(config.maxContext);
	}

	/**
	 * Get current lane
	 * @returns {string|null} Current lane identifier
	 */
	function getCurrentLane() {
		return currentLane;
	}

	/**
	 * Get current lane config
	 * @returns {Object|null} Current lane configuration
	 */
	function getCurrentConfig() {
		return currentLane ? LANE_CONFIGS[currentLane] : null;
	}

	/**
	 * Get context limit for current lane
	 * @returns {number} Context limit in tokens
	 */
	function getContextLimit() {
		return getCurrentConfig()?.maxContext || 16000;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Tooltip
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show the lane tooltip
	 */
	function showTooltip() {
		const { tooltip } = getElements();
		if (tooltip) {
			tooltip.hidden = false;
			tooltipVisible = true;
		}
	}

	/**
	 * Hide the lane tooltip
	 */
	function hideTooltip() {
		const { tooltip } = getElements();
		if (tooltip) {
			tooltip.hidden = true;
			tooltipVisible = false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Transition Toast
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show lane transition toast
	 * @param {string} fromLane - Previous lane
	 * @param {string} toLane - New lane
	 */
	function showTransitionToast(fromLane, toLane) {
		const { toast } = getElements();
		if (!toast) return;

		const toConfig = LANE_CONFIGS[toLane];
		if (!toConfig) return;

		// Clear any existing timeout
		if (toastTimeout) {
			clearTimeout(toastTimeout);
		}

		const icon = toast.querySelector('.codicon');
		const text = toast.querySelector('.qic-lane-toast-text');

		if (icon) {
			icon.className = `codicon ${toConfig.icon}`;
		}
		if (text) {
			text.textContent = `Switched to ${toConfig.displayName} mode`;
		}

		toast.hidden = false;
		toast.classList.remove('hiding');

		// Announce for screen readers
		announceMessage(`Mode changed to ${toConfig.displayName}`);

		// Auto-hide after 3 seconds
		toastTimeout = setTimeout(() => {
			toast.classList.add('hiding');
			setTimeout(() => {
				toast.hidden = true;
				toast.classList.remove('hiding');
			}, 200);
		}, 3000);
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
		if (tokens >= 1000) {
			return `${Math.round(tokens / 1000)}K`;
		}
		return tokens.toString();
	}

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
			case 'lane:changed':
			case 'lane:set':
				const lane = msg.payload?.lane || msg.lane;
				if (lane) {
					setLane(lane);
				}
				return true;

			default:
				return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Setup event listeners
	 */
	function setupEventListeners() {
		const { badge } = getElements();
		if (!badge) return;

		badge.addEventListener('mouseenter', showTooltip);
		badge.addEventListener('mouseleave', hideTooltip);
		badge.addEventListener('focus', showTooltip);
		badge.addEventListener('blur', hideTooltip);

		// Keyboard support for tooltip
		badge.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				if (tooltipVisible) {
					hideTooltip();
				} else {
					showTooltip();
				}
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Initialize the lane manager
	 */
	function init() {
		setupEventListeners();

		// Set default lane if not set
		if (!currentLane) {
			setLane('chat-ask');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicLaneManager = {
		setLane,
		getCurrentLane,
		getCurrentConfig,
		getContextLimit,
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
