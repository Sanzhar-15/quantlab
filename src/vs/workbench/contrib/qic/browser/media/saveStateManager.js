/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Save State Manager
 * Handles conversation save state and auto-save
 * Phase 2 - Prompt 02-11
 * GAP-08 FIX
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const CONFIG = {
		autoSaveDelayMs: 2000,
		autoSaveEnabled: true,
		showSaveIndicator: true,
		warnOnUnsavedSwitch: true,
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentState = {
		conversationId: null,
		status: 'saved',
		lastSavedAt: null,
		isDirty: false,
		error: null
	};

	let autoSaveTimeout = null;
	let pendingSwitchAction = null;
	let stateChangeCallback = null;

	// ═══════════════════════════════════════════════════════════════════
	// DOM Elements
	// ═══════════════════════════════════════════════════════════════════

	let indicator = null;
	let modifiedDot = null;
	let warningDialog = null;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Mark conversation as modified (dirty)
	 */
	function markDirty() {
		if (!currentState.isDirty) {
			currentState.isDirty = true;
			currentState.status = 'unsaved';
			updateIndicator();
		}

		// Schedule auto-save
		if (CONFIG.autoSaveEnabled) {
			scheduleAutoSave();
		}
	}

	/**
	 * Mark conversation as saved
	 */
	function markSaved() {
		currentState.isDirty = false;
		currentState.status = 'saved';
		currentState.lastSavedAt = Date.now();
		currentState.error = null;
		updateIndicator();

		// Clear any pending auto-save
		clearAutoSave();
	}

	/**
	 * Set save status
	 */
	function setStatus(status, error) {
		currentState.status = status;
		if (error) {
			currentState.error = error;
		}
		updateIndicator();
	}

	/**
	 * Check if can switch conversations
	 * Returns Promise that resolves to true if switch allowed
	 */
	async function canSwitchConversation() {
		if (!currentState.isDirty || !CONFIG.warnOnUnsavedSwitch) {
			return true;
		}

		return showUnsavedWarning();
	}

	/**
	 * Trigger manual save
	 */
	function triggerSave() {
		if (!currentState.isDirty) {
			return;
		}

		setStatus('saving');

		vscode.postMessage({
			type: 'conversation:save',
			payload: {
				conversationId: currentState.conversationId,
			}
		});
	}

	/**
	 * Set current conversation
	 */
	function setConversation(conversationId, isDirty = false) {
		currentState.conversationId = conversationId;
		currentState.isDirty = isDirty;
		currentState.status = isDirty ? 'unsaved' : 'saved';
		currentState.lastSavedAt = isDirty ? null : Date.now();
		currentState.error = null;
		updateIndicator();
	}

	/**
	 * Get current save state
	 */
	function getState() {
		return { ...currentState };
	}

	// ═══════════════════════════════════════════════════════════════════
	// Auto-Save
	// ═══════════════════════════════════════════════════════════════════

	function scheduleAutoSave() {
		clearAutoSave();

		autoSaveTimeout = setTimeout(() => {
			if (currentState.isDirty) {
				triggerSave();
			}
		}, CONFIG.autoSaveDelayMs);
	}

	function clearAutoSave() {
		if (autoSaveTimeout) {
			clearTimeout(autoSaveTimeout);
			autoSaveTimeout = null;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// UI Updates
	// ═══════════════════════════════════════════════════════════════════

	function updateIndicator() {
		if (!indicator || !CONFIG.showSaveIndicator) {
			return;
		}

		indicator.hidden = false;
		indicator.dataset.status = currentState.status;

		const icon = indicator.querySelector('.qic-save-icon');
		const text = indicator.querySelector('.qic-save-text');

		if (!icon || !text) return;

		switch (currentState.status) {
			case 'saved':
				icon.className = 'qic-save-icon codicon codicon-check';
				text.textContent = formatSavedTime(currentState.lastSavedAt);
				break;

			case 'saving':
				icon.className = 'qic-save-icon codicon codicon-sync';
				text.textContent = 'Saving...';
				break;

			case 'unsaved':
				icon.className = 'qic-save-icon codicon codicon-circle-filled';
				text.textContent = 'Unsaved';
				break;

			case 'error':
				icon.className = 'qic-save-icon codicon codicon-error';
				text.textContent = 'Save failed';
				break;
		}

		// Update modified dot
		if (modifiedDot) {
			modifiedDot.hidden = !currentState.isDirty;
		}
	}

	function formatSavedTime(timestamp) {
		if (!timestamp) return 'Saved';

		const now = Date.now();
		const diff = now - timestamp;

		if (diff < 5000) {
			return 'Just saved';
		} else if (diff < 60000) {
			return 'Saved';
		} else {
			const date = new Date(timestamp);
			return `Saved at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Unsaved Warning Dialog
	// ═══════════════════════════════════════════════════════════════════

	function showUnsavedWarning() {
		return new Promise((resolve) => {
			if (!warningDialog) {
				resolve(true);
				return;
			}

			pendingSwitchAction = resolve;
			warningDialog.hidden = false;

			// Focus save button
			warningDialog.querySelector('[data-action="save"]')?.focus();
		});
	}

	function hideUnsavedWarning() {
		if (warningDialog) {
			warningDialog.hidden = true;
		}
		pendingSwitchAction = null;
	}

	function handleWarningAction(action) {
		const resolve = pendingSwitchAction;
		hideUnsavedWarning();

		if (!resolve) return;

		switch (action) {
			case 'save':
				// Save first, then allow switch
				triggerSave();
				// Wait for save confirmation
				const handler = (state) => {
					if (state.status === 'saved') {
						resolve(true);
					} else if (state.status === 'error') {
						resolve(false);
					}
				};
				// Listen for next state change
				onNextStateChange(handler);
				break;

			case 'discard':
				// Discard changes, allow switch
				currentState.isDirty = false;
				currentState.status = 'saved';
				updateIndicator();
				resolve(true);
				break;

			case 'cancel':
				// Don't switch
				resolve(false);
				break;
		}
	}

	function onNextStateChange(callback) {
		stateChangeCallback = callback;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'conversation:saved':
				markSaved();
				if (stateChangeCallback) {
					stateChangeCallback(currentState);
					stateChangeCallback = null;
				}
				break;

			case 'conversation:save-error':
				setStatus('error', message.payload?.error);
				if (stateChangeCallback) {
					stateChangeCallback(currentState);
					stateChangeCallback = null;
				}
				break;

			case 'conversation:loaded':
				setConversation(message.payload?.conversationId, false);
				break;

			case 'save-state:change':
				// Handle external save state updates
				if (message.payload?.saving) {
					setStatus('saving');
				} else if (message.payload?.saved) {
					markSaved();
				} else if (message.payload?.error) {
					setStatus('error', message.payload.error);
				}
				break;

			case 'mark-dirty':
				markDirty();
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	function setupEventListeners() {
		// Get DOM elements
		indicator = document.getElementById('save-state-indicator');
		modifiedDot = document.getElementById('conversation-modified');
		warningDialog = document.getElementById('unsaved-warning-dialog');

		// Warning dialog actions
		warningDialog?.querySelectorAll('[data-action]').forEach(btn => {
			btn.addEventListener('click', () => {
				handleWarningAction(btn.dataset.action);
			});
		});

		// Escape to cancel warning
		warningDialog?.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				handleWarningAction('cancel');
			}
		});

		// Click outside to cancel
		warningDialog?.addEventListener('click', (e) => {
			if (e.target === warningDialog) {
				handleWarningAction('cancel');
			}
		});

		// Keyboard shortcut to save (Cmd+S)
		document.addEventListener('keydown', (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 's') {
				e.preventDefault();
				triggerSave();
			}
		});

		// Mark dirty when user sends a message
		window.addEventListener('qic:submit', () => {
			markDirty();
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		setupEventListeners();
		updateIndicator();
	}

	// Export
	window.QicSaveStateManager = {
		markDirty,
		markSaved,
		setStatus,
		canSwitchConversation,
		triggerSave,
		setConversation,
		getState,
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
