/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Webview State Manager
 * Handles revision-based state synchronization with VS Code host
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════════════
	// State Storage
	// ═══════════════════════════════════════════════════════════════════════════

	/** @type {Object|null} Current state */
	let state = null;

	/** @type {number} Current revision number */
	let currentRevision = 0;

	/** @type {Set<Function>} State change listeners */
	const listeners = new Set();

	/** @type {Map<string, Set<Function>>} Filtered listeners keyed by path prefix */
	const filteredListeners = new Map();

	/** @type {boolean} Whether we've received initial state */
	let initialized = false;

	// ═══════════════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Get current state (read-only)
	 * @returns {Object|null}
	 */
	function getState() {
		return state;
	}

	/**
	 * Get current revision
	 * @returns {number}
	 */
	function getRevision() {
		return currentRevision;
	}

	/**
	 * Check if state is initialized
	 * @returns {boolean}
	 */
	function isInitialized() {
		return initialized;
	}

	/**
	 * Subscribe to state changes
	 * @param {Function} listener - Called with (state, patch) on change
	 * @returns {Function} Unsubscribe function
	 */
	function subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/**
	 * Subscribe to state changes for a specific path prefix.
	 * Listener is only called when patch.path starts with the given prefix,
	 * or on full state updates (patch === null).
	 * @param {string} pathPrefix - e.g., 'conversation', 'agentState', 'serviceStatus'
	 * @param {Function} listener - Called with (state, patch) on matching changes
	 * @returns {Function} Unsubscribe function
	 */
	function subscribeTo(pathPrefix, listener) {
		if (!filteredListeners.has(pathPrefix)) {
			filteredListeners.set(pathPrefix, new Set());
		}
		filteredListeners.get(pathPrefix).add(listener);
		return () => {
			const set = filteredListeners.get(pathPrefix);
			if (set) {
				set.delete(listener);
				if (set.size === 0) {
					filteredListeners.delete(pathPrefix);
				}
			}
		};
	}

	/**
	 * Get a specific value from state using dot notation
	 * @param {string} path - e.g., 'conversation.messages'
	 * @param {*} defaultValue - Value if path not found
	 * @returns {*}
	 */
	function get(path, defaultValue = undefined) {
		if (!state) return defaultValue;

		const parts = path.split('.');
		let current = state;

		for (const part of parts) {
			if (current === null || current === undefined) {
				return defaultValue;
			}
			current = current[part];
		}

		return current !== undefined ? current : defaultValue;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Handle incoming message from host
	 * @param {Object} msg - Message from host
	 * @returns {boolean} Whether message was handled
	 */
	function handleMessage(msg) {
		if (!msg || typeof msg !== 'object') return false;

		switch (msg.type) {
			case 'state:full':
				return handleFullState(msg);

			case 'state:patch':
				return handlePatch(msg);

			case 'state:sync':
				// Host is checking if we're in sync
				sendRevisionAck();
				return true;

			default:
				return false;
		}
	}

	/**
	 * Handle full state message
	 * @param {Object} msg
	 * @returns {boolean}
	 */
	function handleFullState(msg) {
		if (typeof msg.revision !== 'number') {
			console.warn('[StateManager] Full state missing revision');
			return false;
		}

		state = msg.payload;
		currentRevision = msg.revision;
		initialized = true;

		notifyListeners(null); // null patch means full update
		sendRevisionAck();

		console.log('[StateManager] Full state received, revision:', currentRevision);
		return true;
	}

	/**
	 * Handle patch message
	 * @param {Object} msg
	 * @returns {boolean}
	 */
	function handlePatch(msg) {
		if (typeof msg.revision !== 'number') {
			console.warn('[StateManager] Patch missing revision');
			return false;
		}

		// Not initialized yet - request full state
		if (!state) {
			console.warn('[StateManager] Received patch but no state, requesting full');
			requestFullState();
			return false;
		}

		// Check for revision gap
		if (msg.revision > currentRevision + 1) {
			console.warn('[StateManager] Gap detected:', currentRevision, '->', msg.revision);
			requestFullState();
			return false;
		}

		// Ignore old revisions
		if (msg.revision <= currentRevision) {
			console.log('[StateManager] Ignoring old revision:', msg.revision);
			return true;
		}

		// Apply patch
		const patch = msg.payload;
		state = applyPatch(state, patch);
		currentRevision = msg.revision;

		notifyListeners(patch);
		sendRevisionAck();

		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Patch Application
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Apply a patch to state (immutable)
	 * @param {Object} currentState - Current state
	 * @param {Object} patch - Patch to apply
	 * @returns {Object} New state
	 */
	function applyPatch(currentState, patch) {
		const path = patch.path;
		const value = patch.value;

		// Special case: full state replacement
		if (path === '*') {
			return { ...value, revision: patch.revision };
		}

		// Build new state with patch applied
		const newState = { ...currentState, revision: patch.revision };
		const parts = path.split('.');

		if (parts.length === 1) {
			// Top-level property
			newState[parts[0]] = value;
		} else {
			// Nested property - need to rebuild path
			setNestedValue(newState, parts, value);
		}

		return newState;
	}

	/**
	 * Set a nested value immutably
	 * @param {Object} obj - Object to modify (will be mutated at top level)
	 * @param {string[]} path - Path parts
	 * @param {*} value - Value to set
	 */
	function setNestedValue(obj, path, value) {
		let current = obj;

		for (let i = 0; i < path.length - 1; i++) {
			const key = path[i];
			// Create shallow copy of each level
			current[key] = { ...current[key] };
			current = current[key];
		}

		// Set the final value
		current[path[path.length - 1]] = value;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Communication with Host
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Send revision acknowledgment to host
	 */
	function sendRevisionAck() {
		if (typeof vscode !== 'undefined') {
			vscode.postMessage({
				type: 'revision:ack',
				revision: currentRevision
			});
		}
	}

	/**
	 * Request full state from host (gap recovery)
	 */
	function requestFullState() {
		if (typeof vscode !== 'undefined') {
			vscode.postMessage({
				type: 'state:request'
			});
		}
	}

	/**
	 * Signal that webview is ready
	 */
	function signalReady() {
		if (typeof vscode !== 'undefined') {
			vscode.postMessage({
				type: 'ready'
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Listener Notification
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Notify all listeners of state change
	 * @param {Object|null} patch - The patch that was applied, or null for full update
	 */
	function notifyListeners(patch) {
		// Notify unfiltered (global) listeners
		for (const listener of listeners) {
			try {
				listener(state, patch);
			} catch (e) {
				console.error('[StateManager] Listener error:', e);
			}
		}

		// Notify filtered listeners
		for (const [prefix, prefixListeners] of filteredListeners) {
			// Fire on full state updates (null patch) or matching path
			if (!patch || (patch.path && (patch.path === prefix || patch.path.startsWith(prefix + '.') || patch.path === '*'))) {
				for (const listener of prefixListeners) {
					try {
						listener(state, patch);
					} catch (e) {
						console.error('[StateManager] Filtered listener error:', e);
					}
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Selectors (convenience helpers)
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Memoize a selector: caches result until currentRevision changes.
	 * @param {Function} selectorFn
	 * @returns {Function}
	 */
	function memoizeSelector(selectorFn) {
		let cachedRevision = -1;
		let cachedResult = undefined;
		return function() {
			if (currentRevision !== cachedRevision) {
				cachedRevision = currentRevision;
				cachedResult = selectorFn();
			}
			return cachedResult;
		};
	}

	const selectors = {
		/** Get service status */
		getServiceStatus: memoizeSelector(() => get('serviceStatus', 'initializing')),

		/** Get agent state */
		getAgentState: memoizeSelector(() => get('agentState', 'idle')),

		/** Get connection info */
		getConnection: memoizeSelector(() => get('connection', {})),

		/** Get messages */
		getMessages: memoizeSelector(() => get('conversation.messages', [])),

		/** Get context items */
		getContextItems: memoizeSelector(() => get('context.items', [])),

		/** Get pending permission */
		getPendingPermission: memoizeSelector(() => get('permissions.pending', null)),

		/** Get pending changes */
		getPendingChanges: memoizeSelector(() => get('conversation.pendingChanges', null)),

		/** Get active tool calls */
		getActiveToolCalls: memoizeSelector(() => get('conversation.activeToolCalls', [])),

		/** Get current lane */
		getCurrentLane: memoizeSelector(() => get('currentLane', 'chat-ask')),

		/** Check if streaming */
		isStreaming: memoizeSelector(() => get('conversation.isStreaming', false)),

		/** Get token usage */
		getTokenUsage: memoizeSelector(() => ({
			used: get('context.totalTokens', 0),
			max: get('context.maxTokens', 32000)
		})),

		/** Get quota info */
		getQuota: memoizeSelector(() => get('quota', { used: 0, limit: 100000, estimatedCost: 0, resetDate: '' })),

		/** Get checkpoints */
		getCheckpoints: memoizeSelector(() => get('checkpoints', [])),

		/** Get granted permissions */
		getGrantedPermissions: memoizeSelector(() => get('permissions.granted', [])),

		/** Get conversation ID */
		getConversationId: memoizeSelector(() => get('conversation.id', '')),

		/** Get conversation title */
		getConversationTitle: memoizeSelector(() => get('conversation.title', 'New Conversation'))
	};

	// ═══════════════════════════════════════════════════════════════════════════
	// Export Global API
	// ═══════════════════════════════════════════════════════════════════════════

	window.qicState = {
		// Core API
		getState,
		getRevision,
		isInitialized,
		subscribe,
		subscribeTo,
		get,

		// Message handling
		handleMessage,
		signalReady,

		// Selectors
		selectors,

		// For debugging
		_debug: {
			getCurrentRevision: () => currentRevision,
			getListenerCount: () => listeners.size,
			forceRefresh: requestFullState
		}
	};

})();
