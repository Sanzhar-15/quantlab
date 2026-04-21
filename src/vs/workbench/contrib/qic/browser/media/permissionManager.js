/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Permission Manager (Webview)
 * Handles permission card display and user responses
 * Phase 3 - Prompt 03-09 (GAP-06 FIX)
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	const pendingPermissions = new Map(); // requestId -> cardElement
	let permissionContainer = null;

	// ═══════════════════════════════════════════════════════════════════
	// Risk Configuration
	// ═══════════════════════════════════════════════════════════════════

	const RISK_ICONS = {
		low: 'codicon-info',
		medium: 'codicon-warning',
		high: 'codicon-error',
	};

	const RISK_TITLES = {
		low: 'Permission Required',
		medium: 'Permission Required',
		high: 'Elevated Permission Required',
	};

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Show a permission request card
	 * @param {Object} request - Permission request object
	 */
	function showPermissionRequest(request) {
		ensureContainer();

		const card = createPermissionCard(request);
		pendingPermissions.set(request.requestId, card);
		permissionContainer.appendChild(card);

		// Focus the allow button for keyboard users
		setTimeout(() => {
			card.querySelector('[data-action="allow"]')?.focus();
		}, 100);

		// Announce for screen readers
		if (window.QicAnnouncer) {
			window.QicAnnouncer.announce(`Permission required for ${request.toolDisplayName}`);
		}
	}

	/**
	 * Remove a permission card (timeout or processed)
	 * @param {string} requestId
	 */
	function removePermissionCard(requestId) {
		const card = pendingPermissions.get(requestId);
		if (!card) return;

		card.classList.add('removing');
		setTimeout(() => {
			card.remove();
			pendingPermissions.delete(requestId);
		}, 200);
	}

	/**
	 * Handle permission timeout from host
	 * @param {string} requestId
	 */
	function handleTimeout(requestId) {
		removePermissionCard(requestId);
		if (window.QicAnnouncer) {
			window.QicAnnouncer.announce('Permission request timed out');
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Card Creation
	// ═══════════════════════════════════════════════════════════════════

	function createPermissionCard(request) {
		const template = document.getElementById('permission-card-template');
		if (!template) {
			console.error('[PermissionManager] Template not found');
			return document.createElement('div');
		}

		const card = template.content.cloneNode(true).firstElementChild;
		if (!card) {
			return document.createElement('div');
		}

		card.dataset.requestId = request.requestId;
		card.dataset.risk = request.riskLevel || 'medium';

		// Set icon
		const icon = card.querySelector('.qic-permission-icon');
		if (icon) {
			icon.classList.add(RISK_ICONS[request.riskLevel || 'medium']);
		}

		// Set title
		const titleEl = card.querySelector('.qic-permission-title');
		if (titleEl) {
			titleEl.textContent = RISK_TITLES[request.riskLevel || 'medium'];
		}

		// Set tool name
		const toolEl = card.querySelector('.qic-permission-tool');
		if (toolEl) {
			toolEl.textContent = request.toolDisplayName || request.toolName;
		}

		// Set description
		const descEl = card.querySelector('.qic-permission-desc');
		if (descEl) {
			descEl.textContent = request.description || '';
		}

		// Set details if provided
		const detailsContent = card.querySelector('.qic-permission-details-content');
		const detailsElement = card.querySelector('.qic-permission-details');
		if (request.details && detailsContent) {
			detailsContent.textContent = request.details;
		} else if (detailsElement) {
			detailsElement.hidden = true;
		}

		// Wire up buttons
		const allowBtn = card.querySelector('[data-action="allow"]');
		if (allowBtn) {
			allowBtn.addEventListener('click', () => {
				respondToPermission(request.requestId, true, getSelectedScope(card));
			});
		}

		const denyBtn = card.querySelector('[data-action="deny"]');
		if (denyBtn) {
			denyBtn.addEventListener('click', () => {
				respondToPermission(request.requestId, false, 'once');
			});
		}

		// Keyboard support
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				respondToPermission(request.requestId, false, 'once', 'Dismissed by user');
			}
		});

		return card;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Response Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Send permission response to host
	 * GAP-06 FIX: This response resolves the host Promise
	 */
	function respondToPermission(requestId, granted, scope, reason) {
		// Remove the card
		removePermissionCard(requestId);

		// Get vscode API
		const vscode = window.vscodeApi || (window.acquireVsCodeApi && window.acquireVsCodeApi());
		if (!vscode) {
			console.error('[PermissionManager] VS Code API not available');
			return;
		}

		// Send response to host
		vscode.postMessage({
			type: 'permission:response',
			payload: {
				requestId,
				granted,
				scope,
				reason: reason || (granted ? undefined : 'User denied'),
			}
		});

		// Announce result
		if (window.QicAnnouncer) {
			const message = granted
				? `Permission granted (${scope})`
				: 'Permission denied';
			window.QicAnnouncer.announce(message);
		}
	}

	function getSelectedScope(card) {
		const selected = card.querySelector('input[name="scope"]:checked');
		return selected?.value || 'once';
	}

	// ═══════════════════════════════════════════════════════════════════
	// Container Management
	// ═══════════════════════════════════════════════════════════════════

	function ensureContainer() {
		if (permissionContainer) return;

		permissionContainer = document.getElementById('permission-container');
		if (!permissionContainer) {
			permissionContainer = document.createElement('div');
			permissionContainer.id = 'permission-container';
			permissionContainer.className = 'qic-permission-container';
			permissionContainer.setAttribute('role', 'region');
			permissionContainer.setAttribute('aria-label', 'Permission requests');

			// Insert after messages, before input
			const conversation = document.getElementById('conversation-area');
			if (conversation) {
				conversation.appendChild(permissionContainer);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'permission:request':
				showPermissionRequest(message.payload);
				break;
			case 'permission:timeout':
				if (message.payload?.requestId) {
					handleTimeout(message.payload.requestId);
				}
				break;
		}
	}

	/**
	 * Initialize the permission manager
	 */
	function init() {
		ensureContainer();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicPermissionManager = {
		showPermissionRequest,
		removePermissionCard,
		handleTimeout,
		handleMessage,
		init,
	};
})();
