/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Streaming Manager
 * Handles token buffering and smooth rendering for streaming responses
 * GAP-03 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		MARKDOWN_DEBOUNCE_MS: 500,   // Re-render markdown max every 500ms during streaming
		MARKDOWN_MIN_DELTA: 200,     // Skip re-parse if fewer than 200 chars added since last render
		SCROLL_THRESHOLD_PX: 100,    // Auto-scroll if within 100px of bottom
		MAX_BUFFER_SIZE: 10000,      // Flush if buffer exceeds this
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentStreamId = null;
	let tokenBuffer = '';
	let fullContent = '';
	let renderFrameId = null;
	let markdownTimeoutId = null;
	let streamElement = null;
	let renderedElement = null;
	let messagesContainer = null;
	let userScrolledAway = false;
	let lastRenderedLength = 0;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Start streaming a new message
	 * @param {string} messageId
	 */
	function startStream(messageId) {
		// Cleanup any existing stream
		if (currentStreamId) {
			console.warn('[Streaming] Starting new stream while one is active');
			completeStream(currentStreamId);
		}

		currentStreamId = messageId;
		tokenBuffer = '';
		fullContent = '';
		lastRenderedLength = 0;
		userScrolledAway = false;

		// Get or create message element
		messagesContainer = document.getElementById('messages');
		if (!messagesContainer) {
			console.error('[Streaming] Messages container not found');
			return;
		}

		// Create streaming message element
		const messageEl = createStreamingMessage(messageId);
		messagesContainer.appendChild(messageEl);

		streamElement = messageEl.querySelector('.qic-stream-text');
		renderedElement = messageEl.querySelector('.qic-rendered-content');

		// Initial scroll to bottom
		scrollToBottom(true);

		// Track if user scrolls away
		messagesContainer.addEventListener('scroll', handleScroll);
	}

	/**
	 * Add tokens to the stream
	 * @param {string} tokens
	 */
	function addTokens(tokens) {
		if (!currentStreamId) {
			console.warn('[Streaming] Received tokens but no active stream');
			return;
		}

		tokenBuffer += tokens;
		fullContent += tokens;

		// Force render if buffer is large
		if (tokenBuffer.length > CONFIG.MAX_BUFFER_SIZE) {
			flushBuffer();
		}

		// Schedule render if not already scheduled (synced with display refresh)
		if (!renderFrameId) {
			renderFrameId = requestAnimationFrame(flushBuffer);
		}
	}

	/**
	 * Complete the stream
	 * @param {string} messageId
	 * @param {Object} [metadata]
	 */
	function completeStream(messageId, metadata) {
		if (currentStreamId !== messageId) {
			console.warn('[Streaming] Complete called for different stream');
		}

		// Flush any remaining tokens
		flushBuffer();

		// Clear scheduled renders
		if (renderFrameId) {
			cancelAnimationFrame(renderFrameId);
			renderFrameId = null;
		}
		if (markdownTimeoutId) {
			clearTimeout(markdownTimeoutId);
			markdownTimeoutId = null;
		}

		// Final markdown render (always full parse)
		lastRenderedLength = 0;
		renderMarkdown(true);

		// Update message element
		const messageEl = document.querySelector(`.qic-message[data-id="${messageId}"]`);
		if (messageEl) {
			messageEl.classList.remove('qic-streaming');

			// Remove cursor
			const cursor = messageEl.querySelector('.qic-cursor');
			cursor?.remove();

			// Update timestamp
			const timeEl = messageEl.querySelector('.qic-message-time');
			if (timeEl) {
				timeEl.textContent = formatTime(new Date());
			}

			// Show rendered content, hide raw
			if (streamElement) streamElement.hidden = true;
			if (renderedElement) renderedElement.hidden = false;
		}

		// Remove scroll listener
		messagesContainer?.removeEventListener('scroll', handleScroll);

		// Final scroll
		if (!userScrolledAway) {
			scrollToBottom(true);
		}

		// Reset state
		currentStreamId = null;
		streamElement = null;
		renderedElement = null;
		tokenBuffer = '';
		fullContent = '';
		lastRenderedLength = 0;
	}

	/**
	 * Cancel the current stream
	 * @param {string} messageId
	 */
	function cancelStream(messageId) {
		if (currentStreamId !== messageId && currentStreamId !== null) {
			console.warn('[Streaming] Cancel called for different stream');
			return;
		}

		// Flush buffer
		flushBuffer();

		// Clear scheduled renders
		if (renderFrameId) {
			cancelAnimationFrame(renderFrameId);
			renderFrameId = null;
		}
		if (markdownTimeoutId) {
			clearTimeout(markdownTimeoutId);
			markdownTimeoutId = null;
		}

		// Update message element
		const messageEl = document.querySelector(`.qic-message[data-id="${messageId}"]`);
		if (messageEl) {
			messageEl.classList.remove('qic-streaming');
			messageEl.classList.add('qic-cancelled');

			// Remove cursor, add cancelled indicator
			const cursor = messageEl.querySelector('.qic-cursor');
			cursor?.remove();

			const content = messageEl.querySelector('.qic-message-content');
			if (content && fullContent.trim()) {
				content.innerHTML += '<span class="qic-cancelled-indicator">[Cancelled]</span>';
			}
		}

		// Remove scroll listener
		messagesContainer?.removeEventListener('scroll', handleScroll);

		// Reset state
		currentStreamId = null;
		streamElement = null;
		renderedElement = null;
		tokenBuffer = '';
		fullContent = '';
		lastRenderedLength = 0;
	}

	/**
	 * Check if currently streaming
	 * @returns {boolean}
	 */
	function isStreaming() {
		return currentStreamId !== null;
	}

	/**
	 * Get current stream ID
	 * @returns {string|null}
	 */
	function getStreamId() {
		return currentStreamId;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Internal Functions
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Flush the token buffer to the DOM
	 */
	function flushBuffer() {
		renderFrameId = null;

		if (!tokenBuffer || !streamElement) return;

		// Append text content (safe from XSS)
		streamElement.textContent = fullContent;
		tokenBuffer = '';

		// Auto-scroll if near bottom
		if (!userScrolledAway && isNearBottom()) {
			scrollToBottom();
		}

		// Schedule markdown render
		scheduleMarkdownRender();
	}

	/**
	 * Schedule markdown render (debounced)
	 */
	function scheduleMarkdownRender() {
		if (markdownTimeoutId) return;

		markdownTimeoutId = setTimeout(() => {
			markdownTimeoutId = null;
			renderMarkdown(false);
		}, CONFIG.MARKDOWN_DEBOUNCE_MS);
	}

	/**
	 * Render markdown content
	 * @param {boolean} isFinal
	 */
	function renderMarkdown(isFinal) {
		if (!renderedElement || !fullContent) return;

		// Skip mid-stream re-parse if fewer than MARKDOWN_MIN_DELTA chars added
		if (!isFinal && (fullContent.length - lastRenderedLength) < CONFIG.MARKDOWN_MIN_DELTA) {
			return;
		}

		try {
			// Use marked.js if available, otherwise basic rendering
			if (typeof marked !== 'undefined') {
				renderedElement.innerHTML = marked.parse(fullContent, {
					breaks: true,
					gfm: true
				});
			} else {
				// Basic fallback: preserve newlines, escape HTML
				renderedElement.innerHTML = escapeHtml(fullContent)
					.replace(/\n/g, '<br>')
					.replace(/`([^`]+)`/g, '<code>$1</code>');
			}

			lastRenderedLength = fullContent.length;

			// Syntax highlight code blocks if available
			if (isFinal && typeof hljs !== 'undefined') {
				renderedElement.querySelectorAll('pre code').forEach(block => {
					hljs.highlightElement(block);
				});
			}
		} catch (e) {
			console.error('[Streaming] Markdown render error:', e);
			renderedElement.textContent = fullContent;
		}
	}

	/**
	 * Check if scroll is near bottom
	 * @returns {boolean}
	 */
	function isNearBottom() {
		if (!messagesContainer) return true;

		const scrollBottom = messagesContainer.scrollHeight
			- messagesContainer.scrollTop
			- messagesContainer.clientHeight;

		return scrollBottom < CONFIG.SCROLL_THRESHOLD_PX;
	}

	/**
	 * Scroll to bottom
	 * @param {boolean} [instant=false]
	 */
	function scrollToBottom(instant = false) {
		if (!messagesContainer) return;

		messagesContainer.scrollTo({
			top: messagesContainer.scrollHeight,
			behavior: instant ? 'auto' : 'smooth'
		});
	}

	/**
	 * Handle scroll events to detect user scrolling away
	 */
	function handleScroll() {
		if (!isNearBottom()) {
			userScrolledAway = true;
		} else {
			userScrolledAway = false;
		}
	}

	/**
	 * Create streaming message element
	 * @param {string} messageId
	 * @returns {HTMLElement}
	 */
	function createStreamingMessage(messageId) {
		const article = document.createElement('article');
		article.className = 'qic-message qic-message-assistant qic-streaming';
		article.dataset.id = messageId;
		article.setAttribute('role', 'article');
		article.innerHTML = `
			<header class="qic-message-header">
				<span class="qic-message-avatar" aria-hidden="true">◇</span>
				<span class="qic-message-author">QIC</span>
				<span class="qic-message-time" aria-live="polite">streaming...</span>
			</header>
			<div class="qic-message-content">
				<span class="qic-stream-text" aria-live="polite"></span>
				<span class="qic-cursor" aria-hidden="true"></span>
				<div class="qic-rendered-content" hidden></div>
			</div>
		`;
		return article;
	}

	/**
	 * Format time for display
	 * @param {Date} date
	 * @returns {string}
	 */
	function formatTime(date) {
		return date.toLocaleTimeString([], {
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Use shared escapeHtml from qicUtils (with fallback guard)
	const escapeHtml = window.qicUtils?.escapeHtml ?? function(text) {
		if (!text) return '';
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	};

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		if (renderFrameId) {
			cancelAnimationFrame(renderFrameId);
			renderFrameId = null;
		}
		if (markdownTimeoutId) {
			clearTimeout(markdownTimeoutId);
			markdownTimeoutId = null;
		}
		messagesContainer?.removeEventListener('scroll', handleScroll);
		currentStreamId = null;
		streamElement = null;
		renderedElement = null;
		messagesContainer = null;
		tokenBuffer = '';
		fullContent = '';
		lastRenderedLength = 0;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.qicStreaming = {
		startStream,
		addTokens,
		completeStream,
		cancelStream,
		isStreaming,
		getStreamId,
		dispose,

		// For debugging
		_debug: {
			getBuffer: () => tokenBuffer,
			getFullContent: () => fullContent,
			forceFlush: flushBuffer
		}
	};

})();
