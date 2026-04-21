/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Main Webview Script
 * Initializes all modules and handles message routing
 * Phase 2 - Prompt 02-08: Panel Integration
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// VS Code API
	// ═══════════════════════════════════════════════════════════════════

	// @ts-ignore
	const vscode = acquireVsCodeApi();
	window.vscode = vscode;

	// ═══════════════════════════════════════════════════════════════════
	// Global Announcer for Screen Readers
	// ═══════════════════════════════════════════════════════════════════

	window.QicAnnouncer = {
		/**
		 * Announce a message for screen readers
		 * @param {string} message - The message to announce
		 * @param {string} priority - 'polite' or 'assertive'
		 */
		announce: function(message, priority = 'polite') {
			let announcer = document.getElementById('qic-announcer');
			if (!announcer) {
				announcer = document.createElement('div');
				announcer.id = 'qic-announcer';
				announcer.className = 'qic-sr-only sr-only';
				announcer.setAttribute('aria-live', priority);
				announcer.setAttribute('aria-atomic', 'true');
				document.body.appendChild(announcer);
			}
			// Clear and set to trigger announcement
			announcer.textContent = '';
			setTimeout(() => {
				announcer.textContent = message;
			}, 50);
		}
	};

	// ═══════════════════════════════════════════════════════════════════
	// Message Handler
	// ═══════════════════════════════════════════════════════════════════

	window.addEventListener('message', (event) => {
		const msg = event.data;

		// State messages (handled by state manager)
		if (window.qicState?.handleMessage(msg)) {
			return;
		}

		// Route to appropriate handler
		switch (msg.type) {
			// ─────────────────────────────────────────────────────────────
			// Streaming messages
			// ─────────────────────────────────────────────────────────────
			case 'message:start':
				window.qicStreaming?.startStream(msg.payload?.id);
				hideEmptyState();
				break;

			case 'stream-token':  // Protocol V1 - Remove after V2 migration
			case 'message:chunk':
				const content = msg.payload?.content ?? msg.text;
				window.qicStreaming?.addTokens(content);
				break;

			case 'message-complete':  // Protocol V1 - Remove after V2 migration
			case 'message:complete':
				const completeId = msg.payload?.id ?? msg.messageId;
				window.qicStreaming?.completeStream(completeId, msg.payload?.metadata);
				break;

			case 'message:error':
				window.qicStreaming?.cancelStream(msg.payload?.id);
				showError(msg.payload);
				break;

			// ─────────────────────────────────────────────────────────────
			// Tool calls
			// ─────────────────────────────────────────────────────────────
			case 'tool-call-started':
			case 'tool:start':
				// Handled by state manager
				break;

			case 'tool-call-result':
			case 'tool:result':
				// Handled by state manager
				break;

			// ─────────────────────────────────────────────────────────────
			// State changes (Protocol V1) - Remove after V2 migration
			// ─────────────────────────────────────────────────────────────
			case 'state-change':
				// Handled via state subscription in inputManager
				break;

			// ─────────────────────────────────────────────────────────────
			// UI messages
			// ─────────────────────────────────────────────────────────────
			case 'error':
				showError({ code: msg.code, message: msg.message });
				break;

			case 'clear-chat':
				window.qicMessages?.clearMessages();
				showEmptyState();
				break;

			case 'restore-history':
				restoreHistory(msg.messages);
				break;

			case 'set-theme':
			case 'theme:change':
				setTheme(msg.theme ?? msg.payload?.theme);
				break;

			// ─────────────────────────────────────────────────────────────
			// Permission/Approval dialogs
			// ─────────────────────────────────────────────────────────────
			case 'permission-request':
			case 'permission:request':
				showPermissionDialog(msg);
				break;

			case 'diff-preview':
			case 'changes:pending':
				showDiffPreview(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Context updates
			// ─────────────────────────────────────────────────────────────
			case 'context:update':
				window.qicInputCore?.updateContextChips(msg.payload?.items || []);
				break;

			// Phase 4: Context chips and drawer messages (04-01, 04-02)
			case 'context:set':
			case 'context:added':
			case 'context:removed':
			case 'context:cleared':
			case 'context:updateState':
				window.QicContextChips?.handleMessage(msg);
				break;

			case 'context:content':
				window.QicContextDrawer?.handleMessage(msg);
				break;

			case 'context:openDrawer':
				window.QicContextDrawer?.open();
				break;

			// Phase 4: Mention autocomplete (04-03)
			case 'mention:results':
				window.QicMentionAutocomplete?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Quota updates
			// ─────────────────────────────────────────────────────────────
			case 'quota-update':
				// Will be handled by status bar (Phase 3)
				break;

			// ─────────────────────────────────────────────────────────────
			// Save state indicator (GAP-08)
			// ─────────────────────────────────────────────────────────────
			case 'save-state:change':
			case 'conversation:saved':
			case 'conversation:save-error':
			case 'conversation:loaded':
			case 'mark-dirty':
				window.QicSaveStateManager?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// First-run experience (02-10)
			// ─────────────────────────────────────────────────────────────
			case 'show-first-run':
				window.QicFirstRun?.show();
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 5: Change Cards (05-01)
			// ─────────────────────────────────────────────────────────────
			case 'change:statusUpdate':
				window.QicChangeCards?.handleMessage(msg);
				break;

			case 'change:setData':
				window.QicChangeCards?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Error Display (06-03)
			// ─────────────────────────────────────────────────────────────
			case 'error:show':
			case 'error:dismiss':
			case 'error:dismissAll':
			case 'error:showBanner':
			case 'error:hideBanner':
			case 'error:validation':
			case 'connection:status':
				window.QicErrorManager?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Help Modal (06-08)
			// ─────────────────────────────────────────────────────────────
			case 'show-help':
				window.QicHelpModal?.show();
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Audit Log Viewer (06-09)
			// ─────────────────────────────────────────────────────────────
			case 'show-audit-log':
				window.QicAuditLog?.show();
				break;

			case 'audit:entries':
			case 'audit:entry-added':
			case 'audit:cleared':
				window.QicAuditLog?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Cancel & Timeout (06-10)
			// ─────────────────────────────────────────────────────────────
			case 'cancel:confirmed':
			case 'cancel:failed':
				window.QicCancelManager?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Lane Indicator (06-11)
			// ─────────────────────────────────────────────────────────────
			case 'lane:changed':
			case 'lane:set':
				window.QicLaneManager?.handleMessage(msg);
				window.QicContextDrawer?.handleMessage(msg);
				break;

			// ─────────────────────────────────────────────────────────────
			// Phase 6: Summarization Notification (06-12)
			// ─────────────────────────────────────────────────────────────
			case 'summarization:started':
			case 'summarization:completed':
			case 'summarization:failed':
			case 'show-summary':
				window.QicSummarizationManager?.handleMessage(msg);
				break;

			default:
				// Log unhandled messages in development
				if (msg.type) {
					console.log('[Main] Unhandled message type:', msg.type);
				}
		}
	});

	// ═══════════════════════════════════════════════════════════════════
	// Custom Event Handlers (from modules)
	// ═══════════════════════════════════════════════════════════════════

	// Submit/cancel are handled exclusively by inputManager.js (lockout, debounce, mentions).
	// main.js only hides empty state when a submit occurs.
	window.addEventListener('qic:submit', () => {
		hideEmptyState();
	});

	// Context toggle
	window.addEventListener('qic:context-toggle', (e) => {
		// Toggle context drawer (04-02)
		window.QicContextDrawer?.toggle();
	});

	// Context remove
	window.addEventListener('qic:context-remove', (e) => {
		vscode.postMessage({
			type: 'context:remove',
			payload: { id: e.detail.id }
		});
	});

	// Focus input event
	window.addEventListener('qic:focus-input', () => {
		window.qicInputCore?.focus();
	});

	// ═══════════════════════════════════════════════════════════════════
	// Helper Functions
	// ═══════════════════════════════════════════════════════════════════

	function extractMentions(text) {
		const mentions = [];
		const regex = /@([\w./\-]+)/g;
		let match;
		while ((match = regex.exec(text)) !== null) {
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

	function showError(error) {
		console.error('[QIC Error]', error);
		// Show toast notification
		if (window.qicToast?.show) {
			window.qicToast.show(error?.message || 'An error occurred', 'error');
		}
	}

	function setTheme(theme) {
		if (!theme) return;
		document.documentElement.setAttribute('data-theme', theme);
		document.body.setAttribute('data-theme', theme);
	}

	function restoreHistory(messages) {
		if (!messages || !Array.isArray(messages)) return;

		// Convert legacy message format and render
		const converted = messages.map((m, i) => ({
			id: `restored-${i}`,
			role: m.role,
			content: m.content,
			timestamp: m.timestamp
		}));

		// Hide empty state if we have messages
		if (converted.length > 0) {
			hideEmptyState();
		}

		// Messages will be rendered via state update or directly
		if (window.qicMessages?.renderMessages) {
			window.qicMessages.renderMessages(converted);
		}
	}

	function showPermissionDialog(msg) {
		const requestId = msg.requestId ?? msg.payload?.id;
		const toolName = msg.toolName ?? msg.payload?.toolName;
		if (!requestId) { return; }

		// Auto-approve tool permissions for the session.
		// TODO: Replace with inline approval UI (approve/deny buttons) in a future prompt.
		vscode.postMessage({
			type: 'permission-response',
			requestId,
			granted: true,
			scope: 'session',
		});
	}

	function showDiffPreview(msg) {
		const editScriptHash = msg.editScriptHash ?? msg.payload?.editScriptHash;
		if (!editScriptHash) { return; }

		// Auto-approve diff previews for now.
		// TODO: Replace with inline diff viewer (approve/reject) in a future prompt.
		vscode.postMessage({
			type: 'approve-diff',
			editScriptHash,
			approved: true,
		});
	}

	function showEmptyState() {
		const emptyState = document.getElementById('empty-state');
		const messages = document.getElementById('messages');
		if (emptyState) emptyState.hidden = false;
		if (messages) messages.hidden = true;
	}

	function hideEmptyState() {
		const emptyState = document.getElementById('empty-state');
		const messages = document.getElementById('messages');
		if (emptyState) emptyState.hidden = true;
		if (messages) messages.hidden = false;
	}

	function updateSaveIndicator(payload) {
		// GAP-08: Conversation save state indicator
		const indicator = document.getElementById('save-indicator');
		if (!indicator) return;

		if (payload?.saving) {
			indicator.classList.add('qic-saving');
			indicator.title = 'Saving...';
		} else if (payload?.saved) {
			indicator.classList.remove('qic-saving');
			indicator.classList.add('qic-saved');
			indicator.title = 'Saved';
			// Remove saved indicator after brief display
			setTimeout(() => {
				indicator.classList.remove('qic-saved');
			}, 2000);
		} else if (payload?.error) {
			indicator.classList.remove('qic-saving');
			indicator.classList.add('qic-save-error');
			indicator.title = 'Failed to save';
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		try {
			// Wire quick action buttons (empty state)
			document.querySelectorAll('.qic-quick-action').forEach(btn => {
				btn.addEventListener('click', () => {
					const prompt = btn.dataset.prompt;
					if (prompt) {
						window.qicInputCore?.setValue(prompt);
						window.qicInputCore?.focus();
					}
				});
			});

			// Initialize context drawer with chips manager
			if (window.QicContextDrawer && window.QicContextChips) {
				window.QicContextDrawer.init(window.QicContextChips);
			}

			// Initialize mention autocomplete
			const chatInput = document.getElementById('chat-input');
			if (window.QicMentionAutocomplete && chatInput && window.QicContextChips) {
				window.QicMentionAutocomplete.init(chatInput, window.QicContextChips);
			}

			// Determine initial empty state visibility
			const hasMessages = window.qicState?.selectors?.getMessages()?.length > 0;
			if (hasMessages) {
				hideEmptyState();
			} else {
				showEmptyState();
			}

			// Subscribe to state changes for timeout tracking (06-10) and lane updates (06-11)
			let previousState = null;
			const unsubMain = window.qicState?.subscribe?.((newState) => {
				// Timeout tracking
				if (window.QicTimeoutManager?.handleStateChange) {
					window.QicTimeoutManager.handleStateChange(newState, previousState);
				}
				// Lane updates
				if (newState?.lane && newState.lane !== previousState?.lane) {
					window.QicLaneManager?.setLane(newState.lane);
				}
				previousState = newState;
			});
			if (unsubMain) {
				window.qicUtils?.registerDisposable(unsubMain);
			}
		} catch (e) {
			console.error('[Main] init() error:', e);
		} finally {
			// Signal ready to host (V2 protocol) — MUST always fire
			vscode.postMessage({ type: 'ready' });
			// Protocol V1 ready signal - Remove after V2 migration
			vscode.postMessage({ type: 'webview-ready' });
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	window.qicMain = {
		showEmptyState,
		hideEmptyState,
		setTheme,
		showError,

		// For debugging
		_debug: {
			extractMentions,
			restoreHistory
		}
	};

	// Wait for DOM
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
