/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Edge Case Utilities
 * Phase 6 - Prompt 06-05: Edge Cases
 *
 * Handles edge cases and boundary conditions including:
 * - Empty states
 * - Text overflow
 * - Rapid/concurrent actions
 * - Interrupted operations
 * - Stale state handling
 * - Data validation
 * - Network edge cases
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Text Truncation Utilities
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Truncate string in the middle
	 */
	function truncateMiddle(str, maxLength) {
		if (!str || str.length <= maxLength) return str;

		const half = Math.floor((maxLength - 3) / 2);
		return `${str.slice(0, half)}...${str.slice(-half)}`;
	}

	/**
	 * Format file path with intelligent truncation
	 */
	function formatFilePath(path, maxLength = 40) {
		if (!path) return '';
		if (path.length <= maxLength) return path;

		const filename = path.split('/').pop() || path.split('\\').pop() || path;

		// If filename alone is too long, truncate it
		if (filename.length > maxLength) {
			return truncateMiddle(filename, maxLength);
		}

		// Show as much path as possible, prioritizing filename
		const remaining = maxLength - filename.length - 4; // ".../"
		if (remaining > 0) {
			return `...${path.slice(-maxLength + 3)}`;
		}

		return truncateMiddle(filename, maxLength);
	}

	/**
	 * Truncate text with ellipsis
	 */
	function truncateEnd(str, maxLength) {
		if (!str || str.length <= maxLength) return str;
		return str.slice(0, maxLength - 3) + '...';
	}

	// ═══════════════════════════════════════════════════════════════════
	// Debouncing and Throttling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Debounce function calls
	 */
	class Debouncer {
		constructor(delay = 150) {
			this.delay = delay;
			this.timer = null;
		}

		run(fn) {
			this.cancel();
			this.timer = setTimeout(fn, this.delay);
		}

		cancel() {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
		}
	}

	/**
	 * Throttle function calls
	 */
	class Throttler {
		constructor(delay = 100) {
			this.delay = delay;
			this.lastRun = 0;
			this.timer = null;
		}

		run(fn) {
			const now = Date.now();
			const timeSinceLastRun = now - this.lastRun;

			if (timeSinceLastRun >= this.delay) {
				this.lastRun = now;
				fn();
			} else {
				// Schedule for end of throttle window
				this.cancel();
				this.timer = setTimeout(() => {
					this.lastRun = Date.now();
					fn();
				}, this.delay - timeSinceLastRun);
			}
		}

		cancel() {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Action Guards (Prevent Duplicate Actions)
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Prevent concurrent execution of the same action
	 */
	class ActionGuard {
		constructor() {
			this.pending = new Set();
		}

		async guard(actionId, fn) {
			if (this.pending.has(actionId)) {
				console.warn(`[ActionGuard] Action "${actionId}" already in progress`);
				return undefined;
			}

			this.pending.add(actionId);
			try {
				return await fn();
			} finally {
				this.pending.delete(actionId);
			}
		}

		isPending(actionId) {
			return this.pending.has(actionId);
		}

		cancelAll() {
			this.pending.clear();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Operation Tracking
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Track and manage ongoing operations
	 */
	class OperationTracker {
		constructor() {
			this.operations = new Map();
		}

		start(opId, cleanup) {
			this.operations.set(opId, {
				cleanup,
				startTime: Date.now()
			});
		}

		complete(opId) {
			this.operations.delete(opId);
		}

		cancel(opId) {
			const op = this.operations.get(opId);
			if (op) {
				try {
					op.cleanup?.();
				} catch (e) {
					console.error(`[OperationTracker] Error in cleanup for ${opId}:`, e);
				}
				this.operations.delete(opId);
			}
		}

		cancelAll() {
			for (const [opId, op] of this.operations) {
				try {
					op.cleanup?.();
				} catch (e) {
					console.error(`[OperationTracker] Error in cleanup for ${opId}:`, e);
				}
			}
			this.operations.clear();
		}

		isActive(opId) {
			return this.operations.has(opId);
		}

		getDuration(opId) {
			const op = this.operations.get(opId);
			return op ? Date.now() - op.startTime : 0;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Data Validation
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Validate incoming message format
	 */
	function validateMessage(message) {
		if (!message || typeof message !== 'object') {
			console.error('[Validation] Invalid message: not an object');
			return null;
		}

		if (!message.type || typeof message.type !== 'string') {
			console.error('[Validation] Invalid message: missing type');
			return null;
		}

		return message;
	}

	/**
	 * Validate context item
	 */
	function validateContextItem(item) {
		if (!item || typeof item !== 'object') {
			console.error('[Validation] Invalid context item: not an object');
			return null;
		}

		const required = ['id', 'type'];
		for (const field of required) {
			if (!item[field]) {
				console.error(`[Validation] Invalid context item: missing ${field}`);
				return null;
			}
		}

		const validTypes = ['file', 'selection', 'symbol', 'url', 'image', 'folder', 'terminal', 'docs', 'diagnostic'];
		if (!validTypes.includes(item.type)) {
			console.warn(`[Validation] Unknown context item type: ${item.type}`);
			// Don't reject, just warn - may be a new type
		}

		return item;
	}

	/**
	 * Sanitize user input
	 */
	function sanitizeInput(input) {
		if (typeof input !== 'string') return '';

		// Remove null bytes
		input = input.replace(/\0/g, '');

		// Limit length
		const MAX_LENGTH = 100000;
		if (input.length > MAX_LENGTH) {
			input = input.slice(0, MAX_LENGTH);
		}

		return input;
	}

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	// ═══════════════════════════════════════════════════════════════════
	// Network Helpers
	// ═══════════════════════════════════════════════════════════════════

	const SLOW_NETWORK_THRESHOLD = 5000; // 5 seconds

	/**
	 * Wrap promise with slow network detection
	 */
	function withSlowNetworkFeedback(promise, onSlow, onComplete) {
		let timer = null;
		let slowNotified = false;

		timer = setTimeout(() => {
			slowNotified = true;
			onSlow?.();
		}, SLOW_NETWORK_THRESHOLD);

		return promise.finally(() => {
			clearTimeout(timer);
			if (slowNotified) {
				onComplete?.();
			}
		});
	}

	/**
	 * Check if online
	 */
	function isOnline() {
		return navigator.onLine !== false;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Panel/Window Utilities
	// ═══════════════════════════════════════════════════════════════════

	const COMPACT_MODE_WIDTH = 300;

	/**
	 * Setup resize observer for compact mode
	 */
	function setupResizeObserver(callback) {
		if (typeof ResizeObserver === 'undefined') return null;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				callback({ width, height });
			}
		});

		observer.observe(document.body);
		return observer;
	}

	/**
	 * Handle compact mode based on width
	 */
	function updateCompactMode(width) {
		if (width < COMPACT_MODE_WIDTH) {
			document.body.classList.add('compact-mode');
		} else {
			document.body.classList.remove('compact-mode');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Paste/Drop Handling
	// ═══════════════════════════════════════════════════════════════════

	const MAX_PASTE_LENGTH = 50000;

	/**
	 * Check if paste is too large
	 */
	function isPasteTooLarge(text) {
		return text && text.length > MAX_PASTE_LENGTH;
	}

	/**
	 * Format byte size for display
	 */
	function formatBytes(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Pagination
	// ═══════════════════════════════════════════════════════════════════

	const DEFAULT_PAGE_SIZE = 100;

	/**
	 * Paginate an array of items
	 */
	function paginateItems(items, page = 0, pageSize = DEFAULT_PAGE_SIZE) {
		const start = page * pageSize;
		const paged = items.slice(start, start + pageSize);

		if (items.length > start + pageSize) {
			// Add "Load more" indicator
			paged.push({
				__isLoadMore: true,
				remaining: items.length - start - pageSize,
				nextPage: page + 1
			});
		}

		return {
			items: paged,
			page,
			pageSize,
			total: items.length,
			hasMore: items.length > start + pageSize
		};
	}

	// ═══════════════════════════════════════════════════════════════════
	// State Sync Helpers
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Check if revision is stale
	 */
	function isStaleRevision(expected, actual) {
		return expected !== actual;
	}

	/**
	 * Request full state sync
	 */
	function requestStateSync() {
		const vscode = window.vscodeApi || (window.acquireVsCodeApi && window.acquireVsCodeApi());
		if (vscode) {
			vscode.postMessage({ type: 'state:requestSync' });
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		// Setup resize observer
		setupResizeObserver(({ width }) => {
			updateCompactMode(width);
		});

		// Setup online/offline handlers
		window.addEventListener('offline', () => {
			document.body.classList.add('is-offline');
			window.QicErrorManager?.showBanner({
				id: 'offline',
				severity: 'warning',
				title: 'Offline',
				message: 'You appear to be offline. Some features may be unavailable.',
				recoverable: false
			});
		});

		window.addEventListener('online', () => {
			document.body.classList.remove('is-offline');
			window.QicErrorManager?.hideBanner();
		});

		// Setup visibility change handler
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				// Could trigger state refresh here if needed
				document.body.classList.remove('was-hidden');
			} else {
				document.body.classList.add('was-hidden');
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicEdgeCaseUtils = {
		// Text utilities
		truncateMiddle,
		truncateEnd,
		formatFilePath,
		escapeHtml,

		// Classes
		Debouncer,
		Throttler,
		ActionGuard,
		OperationTracker,

		// Validation
		validateMessage,
		validateContextItem,
		sanitizeInput,

		// Network
		withSlowNetworkFeedback,
		isOnline,
		SLOW_NETWORK_THRESHOLD,

		// Pagination
		paginateItems,
		DEFAULT_PAGE_SIZE,

		// Panel
		setupResizeObserver,
		updateCompactMode,
		COMPACT_MODE_WIDTH,

		// Paste/Drop
		isPasteTooLarge,
		formatBytes,
		MAX_PASTE_LENGTH,

		// State
		isStaleRevision,
		requestStateSync,

		// Init
		init,
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		setTimeout(init, 0);
	}

})();
