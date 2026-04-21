/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Message Manager
 * Handles message rendering and conversation display
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		MESSAGE_BATCH_SIZE: 50,
		SCROLL_BUTTON_THRESHOLD: 200,
		FILE_REFERENCE_REGEX: /\[\[([^\]]+)\]\]/g,
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let messagesContainer = null;
	let emptyState = null;
	let scrollBtn = null;
	let loadSentinel = null;
	let renderedMessageIds = new Set();
	let messageElementMap = new Map();
	let unsubscribe = null;
	let intersectionObserver = null;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		messagesContainer = document.getElementById('messages');
		emptyState = document.getElementById('empty-state');
		scrollBtn = document.getElementById('scroll-to-bottom');
		loadSentinel = document.getElementById('load-more-sentinel');

		if (!messagesContainer) {
			console.error('[MessageManager] Messages container not found');
			return;
		}

		setupEventListeners();
		setupIntersectionObserver();
		subscribeToState();
	}

	function setupEventListeners() {
		// Scroll button
		scrollBtn?.addEventListener('click', () => scrollToBottom(true));

		// Track scroll position for scroll button visibility
		messagesContainer.addEventListener('scroll', handleScroll);

		// Delegate click for file references and actions
		messagesContainer.addEventListener('click', handleMessageClick);
	}

	function setupIntersectionObserver() {
		if (!loadSentinel) return;

		intersectionObserver = new IntersectionObserver((entries) => {
			if (entries[0].isIntersecting) {
				loadMoreMessages();
			}
		}, { rootMargin: '100px' });

		intersectionObserver.observe(loadSentinel);
	}

	function subscribeToState() {
		if (!window.qicState) {
			console.warn('[MessageManager] State manager not available');
			return;
		}

		unsubscribe = window.qicState.subscribeTo('conversation', (state, patch) => {
			renderMessages();
		});

		// Initial render
		renderMessages();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function handleScroll() {
		const isNearBottom = isScrollNearBottom();
		if (scrollBtn) {
			scrollBtn.hidden = isNearBottom;
		}
	}

	function handleMessageClick(e) {
		const target = e.target;

		// File reference click
		if (target.classList.contains('qic-file-ref')) {
			e.preventDefault();
			const path = target.dataset.path;
			const isFolder = target.dataset.isFolder === 'true';
			vscode.postMessage({ type: 'open-file-reference', path, isFolder });
			return;
		}

		// Copy code button
		if (target.classList.contains('qic-copy-code-btn') || target.closest('.qic-copy-code-btn')) {
			const codeBlock = target.closest('.qic-code-block');
			const code = codeBlock?.querySelector('code')?.textContent || '';
			vscode.postMessage({ type: 'copy-code', code });
			showCopyFeedback(target);
			return;
		}

		// Insert code button
		if (target.classList.contains('qic-insert-code-btn') || target.closest('.qic-insert-code-btn')) {
			const codeBlock = target.closest('.qic-code-block');
			const code = codeBlock?.querySelector('code')?.textContent || '';
			vscode.postMessage({ type: 'insert-code', code });
			return;
		}

		// Retry button
		if (target.classList.contains('qic-retry-btn')) {
			const messageId = target.closest('.qic-message')?.dataset.id;
			if (messageId) {
				vscode.postMessage({ type: 'retry', payload: { messageId } });
			}
			return;
		}

		// Regenerate button
		if (target.classList.contains('qic-regenerate-btn')) {
			const messageId = target.closest('.qic-message')?.dataset.id;
			if (messageId) {
				vscode.postMessage({ type: 'regenerate', payload: { messageId } });
			}
			return;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Rendering
	// ═══════════════════════════════════════════════════════════════════

	function renderMessages() {
		const state = window.qicState?.getState?.();
		if (!state) return;

		const messages = state.conversation?.messages || [];
		const toolCalls = state.conversation?.activeToolCalls || [];

		// Show/hide empty state
		if (emptyState) {
			emptyState.hidden = messages.length > 0;
		}
		if (messagesContainer) {
			messagesContainer.hidden = messages.length === 0;
		}

		// Render messages
		messages.forEach(message => {
			if (!renderedMessageIds.has(message.id)) {
				appendMessage(message);
				renderedMessageIds.add(message.id);
			} else {
				updateMessage(message);
			}
		});

		// Render active tool calls
		renderToolCalls(toolCalls);

		// Auto-scroll if at bottom
		if (isScrollNearBottom()) {
			scrollToBottom();
		}
	}

	function appendMessage(message) {
		const element = createMessageElement(message);
		messagesContainer.appendChild(element);
		messageElementMap.set(message.id, element);
	}

	function updateMessage(message) {
		// O(1) lookup via map instead of querySelector O(n)
		const element = messageElementMap.get(message.id);
		if (!element) return;

		// Update content only if changed (skip unnecessary innerHTML regeneration)
		const contentEl = element.querySelector('.qic-message-content');
		if (contentEl && !element.classList.contains('qic-streaming')) {
			const content = message.content || '';
			const fingerprint = content.length + ':' + content.charCodeAt(0) + ':' + content.charCodeAt(content.length - 1);
			if (element.dataset.contentHash !== fingerprint) {
				contentEl.innerHTML = renderContent(content, message.role);
				element.dataset.contentHash = fingerprint;
			}
		}

		// Update error state
		if (message.error) {
			element.classList.add('qic-message-error');
			let errorEl = element.querySelector('.qic-error-card');
			if (!errorEl) {
				errorEl = createErrorCard(message.error);
				element.appendChild(errorEl);
			}
		}
	}

	function createMessageElement(message) {
		const article = document.createElement('article');
		article.className = `qic-message qic-message-${message.role}`;
		article.dataset.id = message.id;
		article.setAttribute('role', 'listitem');

		const isUser = message.role === 'user';
		const isSystem = message.role === 'system';

		article.innerHTML = `
			<header class="qic-message-header">
				<span class="qic-message-avatar" aria-hidden="true">${getAvatar(message.role)}</span>
				<span class="qic-message-author">${getAuthorName(message.role)}</span>
				<time class="qic-message-time" datetime="${message.timestamp}">
					${formatTime(message.timestamp)}
				</time>
				${!isUser && !isSystem ? `
					<div class="qic-message-actions">
						<button class="qic-action-btn qic-regenerate-btn" title="Regenerate">
							<span class="codicon codicon-refresh"></span>
						</button>
					</div>
				` : ''}
			</header>
			<div class="qic-message-content">
				${renderContent(message.content, message.role)}
			</div>
			${message.mentions?.length ? renderMentions(message.mentions) : ''}
			${message.changes ? renderChangeSummary(message.changes) : ''}
			${message.error ? createErrorCard(message.error).outerHTML : ''}
			${message.role === 'assistant' ? `
				<div class="qic-message-feedback" hidden>
					<span class="qic-feedback-label">Was this helpful?</span>
					<button class="qic-feedback-btn" data-rating="positive" title="Yes, helpful" aria-label="Rate as helpful">
						<span class="codicon codicon-thumbsup" aria-hidden="true"></span>
					</button>
					<button class="qic-feedback-btn" data-rating="negative" title="No, not helpful" aria-label="Rate as not helpful">
						<span class="codicon codicon-thumbsdown" aria-hidden="true"></span>
					</button>
				</div>
			` : ''}
		`;

		// Add feedback button handlers for assistant messages
		if (message.role === 'assistant' && window.QicFeedbackManager) {
			// Use setTimeout to ensure DOM is ready
			setTimeout(() => {
				window.QicFeedbackManager.addFeedbackButtons(article, message.id);
			}, 0);
		}

		return article;
	}

	function renderContent(content, role) {
		if (!content) return '';

		// Escape HTML first
		let html = escapeHtml(content);

		// Convert file references [[path]] to clickable links
		html = html.replace(CONFIG.FILE_REFERENCE_REGEX, (match, path) => {
			const isFolder = path.endsWith('/');
			const displayPath = path.length > 40 ? '...' + path.slice(-37) : path;
			return `<a href="#" class="qic-file-ref" data-path="${escapeAttr(path)}" data-is-folder="${isFolder}" title="${escapeAttr(path)}">${escapeHtml(displayPath)}</a>`;
		});

		// Basic markdown rendering (full implementation can use marked.js)
		// Code blocks
		html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
			return `
				<div class="qic-code-block" data-language="${escapeAttr(lang)}">
					<div class="qic-code-header">
						<span class="qic-code-language">${lang || 'text'}</span>
						<div class="qic-code-actions">
							<button class="qic-copy-code-btn" title="Copy">
								<span class="codicon codicon-copy"></span>
							</button>
							<button class="qic-insert-code-btn" title="Insert at cursor">
								<span class="codicon codicon-insert"></span>
							</button>
						</div>
					</div>
					<pre><code>${escapeHtml(code.trim())}</code></pre>
				</div>
			`;
		});

		// Inline code
		html = html.replace(/`([^`]+)`/g, '<code class="qic-inline-code">$1</code>');

		// Bold
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

		// Italic
		html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

		// Line breaks
		html = html.replace(/\n/g, '<br>');

		return html;
	}

	function renderMentions(mentions) {
		if (!mentions?.length) return '';

		return `
			<div class="qic-message-mentions">
				${mentions.map(m => `
					<span class="qic-mention-chip qic-mention-${m.type}">
						<span class="codicon codicon-${getMentionIcon(m.type)}"></span>
						${escapeHtml(m.displayName)}
					</span>
				`).join('')}
			</div>
		`;
	}

	function renderChangeSummary(changes) {
		if (!changes) return '';

		// Check if this is a ChangeSet (Phase 5 format) or legacy format
		if (changes.id && changes.changes && Array.isArray(changes.changes)) {
			// Phase 5 ChangeSet - create a container and defer to QicChangeCards
			const containerId = `change-set-container-${changes.id}`;
			// Schedule rendering after DOM is updated
			setTimeout(() => {
				const container = document.getElementById(containerId);
				if (container && window.QicChangeCards) {
					window.QicChangeCards.renderChangeSet(changes, container);
				}
			}, 0);

			return `<div id="${containerId}" class="change-set-container"></div>`;
		}

		// Legacy format fallback
		const fileCount = changes.files?.length || 0;
		return `
			<div class="qic-changes-summary">
				<span class="codicon codicon-edit"></span>
				<span>${fileCount} file${fileCount !== 1 ? 's' : ''} changed</span>
				<button class="qic-view-changes-btn">View Changes</button>
			</div>
		`;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Tool Call Rendering
	// ═══════════════════════════════════════════════════════════════════

	function renderToolCalls(toolCalls) {
		// Remove old tool call cards
		messagesContainer.querySelectorAll('.qic-tool-call-card').forEach(el => {
			if (!toolCalls.find(tc => tc.id === el.dataset.id)) {
				el.remove();
			}
		});

		toolCalls.forEach(toolCall => {
			let card = messagesContainer.querySelector(`.qic-tool-call-card[data-id="${toolCall.id}"]`);

			if (!card) {
				card = createToolCallCard(toolCall);
				messagesContainer.appendChild(card);
			} else {
				updateToolCallCard(card, toolCall);
			}
		});
	}

	function createToolCallCard(toolCall) {
		const div = document.createElement('div');
		div.className = `qic-tool-call-card qic-tool-${toolCall.status}`;
		div.dataset.id = toolCall.id;
		div.setAttribute('role', 'status');

		div.innerHTML = `
			<div class="qic-tool-header">
				<span class="qic-tool-icon">
					${toolCall.status === 'running' ? '<span class="codicon codicon-loading qic-spin"></span>' : ''}
					${toolCall.status === 'complete' ? '<span class="codicon codicon-check"></span>' : ''}
					${toolCall.status === 'error' ? '<span class="codicon codicon-error"></span>' : ''}
				</span>
				<span class="qic-tool-name">${escapeHtml(toolCall.name)}</span>
				<span class="qic-tool-status">${getToolStatusText(toolCall.status)}</span>
			</div>
			${toolCall.args ? `
				<details class="qic-tool-args">
					<summary>Arguments</summary>
					<pre><code>${escapeHtml(JSON.stringify(toolCall.args, null, 2))}</code></pre>
				</details>
			` : ''}
			${toolCall.result ? `
				<div class="qic-tool-result ${toolCall.isError ? 'qic-tool-result-error' : ''}">
					<pre><code>${escapeHtml(toolCall.result)}</code></pre>
				</div>
			` : ''}
		`;

		return div;
	}

	function updateToolCallCard(card, toolCall) {
		card.className = `qic-tool-call-card qic-tool-${toolCall.status}`;

		const statusEl = card.querySelector('.qic-tool-status');
		if (statusEl) {
			statusEl.textContent = getToolStatusText(toolCall.status);
		}

		const iconEl = card.querySelector('.qic-tool-icon');
		if (iconEl) {
			iconEl.innerHTML = toolCall.status === 'running'
				? '<span class="codicon codicon-loading qic-spin"></span>'
				: toolCall.status === 'complete'
					? '<span class="codicon codicon-check"></span>'
					: '<span class="codicon codicon-error"></span>';
		}

		if (toolCall.result && !card.querySelector('.qic-tool-result')) {
			const resultEl = document.createElement('div');
			resultEl.className = `qic-tool-result ${toolCall.isError ? 'qic-tool-result-error' : ''}`;
			resultEl.innerHTML = `<pre><code>${escapeHtml(toolCall.result)}</code></pre>`;
			card.appendChild(resultEl);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Error Card
	// ═══════════════════════════════════════════════════════════════════

	function createErrorCard(error) {
		const div = document.createElement('div');
		div.className = 'qic-error-card';
		div.setAttribute('role', 'alert');

		div.innerHTML = `
			<div class="qic-error-header">
				<span class="codicon codicon-error"></span>
				<span class="qic-error-title">${escapeHtml(error.title || 'Error')}</span>
				${error.code ? `<span class="qic-error-code">${escapeHtml(error.code)}</span>` : ''}
			</div>
			<div class="qic-error-message">${escapeHtml(error.message)}</div>
			${error.recoverable ? `
				<div class="qic-error-actions">
					<button class="qic-retry-btn">Retry</button>
				</div>
			` : ''}
		`;

		return div;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function loadMoreMessages() {
		// Request more messages from host
		vscode.postMessage({
			type: 'messages:loadMore',
			payload: { offset: renderedMessageIds.size, limit: CONFIG.MESSAGE_BATCH_SIZE }
		});
	}

	function scrollToBottom(instant = false) {
		if (!messagesContainer) return;
		messagesContainer.scrollTo({
			top: messagesContainer.scrollHeight,
			behavior: instant ? 'auto' : 'smooth'
		});
	}

	function isScrollNearBottom() {
		if (!messagesContainer) return true;
		const threshold = CONFIG.SCROLL_BUTTON_THRESHOLD;
		return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
	}

	function getAvatar(role) {
		switch (role) {
			case 'user': return '👤';
			case 'assistant': return '◇';
			case 'system': return '⚙';
			default: return '?';
		}
	}

	function getAuthorName(role) {
		switch (role) {
			case 'user': return 'You';
			case 'assistant': return 'QIC';
			case 'system': return 'System';
			default: return 'Unknown';
		}
	}

	function getMentionIcon(type) {
		const icons = {
			'file': 'file',
			'folder': 'folder',
			'symbol': 'symbol-method',
			'docs': 'book',
			'selection': 'selection',
			'terminal': 'terminal',
		};
		return icons[type] || 'file';
	}

	function getToolStatusText(status) {
		switch (status) {
			case 'running': return 'Running...';
			case 'complete': return 'Complete';
			case 'error': return 'Failed';
			default: return status;
		}
	}

	function formatTime(timestamp) {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	function showCopyFeedback(target) {
		const btn = target.closest('.qic-copy-code-btn');
		if (!btn) return;
		btn.innerHTML = '<span class="codicon codicon-check"></span>';
		setTimeout(() => {
			btn.innerHTML = '<span class="codicon codicon-copy"></span>';
		}, 1500);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════

	function dispose() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (intersectionObserver) {
			intersectionObserver.disconnect();
			intersectionObserver = null;
		}
		messagesContainer?.removeEventListener('scroll', handleScroll);
		messagesContainer?.removeEventListener('click', handleMessageClick);
		renderedMessageIds.clear();
		messageElementMap.clear();
		messagesContainer = null;
		emptyState = null;
		scrollBtn = null;
		loadSentinel = null;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	window.qicMessages = {
		init,
		renderMessages,
		scrollToBottom,
		appendMessage,
		dispose,
		clearMessages: () => {
			if (messagesContainer) messagesContainer.innerHTML = '';
			renderedMessageIds.clear();
			messageElementMap.clear();
		},

		// For debugging
		_debug: {
			getRenderedIds: () => renderedMessageIds,
			isNearBottom: isScrollNearBottom
		}
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
