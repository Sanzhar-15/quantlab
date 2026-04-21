/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Shared Utilities
 * Provides common utility functions used across all QIC webview modules.
 * Must be loaded BEFORE all other QIC scripts.
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// HTML Escaping (cached element to avoid GC pressure)
	// ═══════════════════════════════════════════════════════════════════

	const _escapeDiv = document.createElement('div');

	/**
	 * Escape HTML special characters to prevent XSS.
	 * Uses a single cached DOM element instead of creating a new one per call.
	 * @param {string} text
	 * @returns {string}
	 */
	function escapeHtml(text) {
		if (!text) return '';
		_escapeDiv.textContent = text;
		return _escapeDiv.innerHTML;
	}

	/**
	 * Escape text for use in HTML attributes.
	 * @param {string} text
	 * @returns {string}
	 */
	function escapeAttr(text) {
		if (!text) return '';
		return String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	// ═══════════════════════════════════════════════════════════════════
	// Timing Utilities
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Debounce a function call.
	 * @param {Function} fn
	 * @param {number} ms
	 * @returns {Function}
	 */
	function debounce(fn, ms) {
		let timerId = null;
		const debounced = function(...args) {
			if (timerId !== null) {
				clearTimeout(timerId);
			}
			timerId = setTimeout(() => {
				timerId = null;
				fn.apply(this, args);
			}, ms);
		};
		debounced.cancel = function() {
			if (timerId !== null) {
				clearTimeout(timerId);
				timerId = null;
			}
		};
		return debounced;
	}

	/**
	 * Throttle a function call.
	 * @param {Function} fn
	 * @param {number} ms
	 * @returns {Function}
	 */
	function throttle(fn, ms) {
		let lastCall = 0;
		let timerId = null;
		const throttled = function(...args) {
			const now = Date.now();
			const remaining = ms - (now - lastCall);
			if (remaining <= 0) {
				if (timerId !== null) {
					clearTimeout(timerId);
					timerId = null;
				}
				lastCall = now;
				fn.apply(this, args);
			} else if (timerId === null) {
				timerId = setTimeout(() => {
					lastCall = Date.now();
					timerId = null;
					fn.apply(this, args);
				}, remaining);
			}
		};
		throttled.cancel = function() {
			if (timerId !== null) {
				clearTimeout(timerId);
				timerId = null;
			}
		};
		return throttled;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Dispose Infrastructure
	// ═══════════════════════════════════════════════════════════════════

	/** @type {Set<Function>} */
	const _disposables = new Set();

	/**
	 * Register a cleanup function to be called on dispose.
	 * @param {Function} fn
	 * @returns {Function} Unregister function
	 */
	function registerDisposable(fn) {
		_disposables.add(fn);
		return () => _disposables.delete(fn);
	}

	/**
	 * Call all registered disposables and clear the registry.
	 */
	function disposeAll() {
		for (const fn of _disposables) {
			try {
				fn();
			} catch (e) {
				console.error('[qicUtils] Dispose error:', e);
			}
		}
		_disposables.clear();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.qicUtils = {
		escapeHtml,
		escapeAttr,
		debounce,
		throttle,
		registerDisposable,
		disposeAll,
	};

})();
