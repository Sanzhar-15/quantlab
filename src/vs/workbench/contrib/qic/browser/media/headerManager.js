/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Header Manager
 * Handles header button interactions and menu for the new v2 header
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════════════
	// Elements
	// ═══════════════════════════════════════════════════════════════════════════

	let statusBtn = null;
	let menuBtn = null;
	let newChatBtn = null;
	let menuDropdown = null;
	let statusIndicator = null;
	let unsubscribe = null;
	let menuItemHandlers = [];

	// ═══════════════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════════════

	function init() {
		// Check if new header exists (feature flag enabled)
		statusBtn = document.getElementById('status-btn');
		menuBtn = document.getElementById('menu-btn');
		newChatBtn = document.getElementById('new-chat-btn');
		menuDropdown = document.getElementById('menu-dropdown');

		// If new header elements not found, we're using legacy header
		if (!statusBtn && !menuBtn) {
			console.log('[HeaderManager] New header not found, using legacy header');
			return;
		}

		// Find status indicator
		statusIndicator = statusBtn?.querySelector('.qic-status-indicator');

		// ACCESSIBILITY: Set up initial ARIA states (ISSUE #002, #003, #019)
		setupAccessibility();
		setupEventListeners();
		subscribeToState();
	}

	function setupAccessibility() {
		// Menu button ARIA attributes (ISSUE #019)
		if (menuBtn) {
			menuBtn.setAttribute('aria-expanded', 'false');
			menuBtn.setAttribute('aria-haspopup', 'menu');
			if (menuDropdown?.id) {
				menuBtn.setAttribute('aria-controls', menuDropdown.id);
			}
			// Icon-only button needs aria-label (ISSUE #008)
			if (!menuBtn.getAttribute('aria-label')) {
				menuBtn.setAttribute('aria-label', 'Open menu');
			}
		}

		// Menu dropdown role (ISSUE #003)
		if (menuDropdown) {
			menuDropdown.setAttribute('role', 'menu');
		}

		// Status button aria-label (ISSUE #008)
		if (statusBtn && !statusBtn.getAttribute('aria-label')) {
			statusBtn.setAttribute('aria-label', 'QIC status');
		}

		// New chat button aria-label (ISSUE #008)
		if (newChatBtn && !newChatBtn.getAttribute('aria-label')) {
			newChatBtn.setAttribute('aria-label', 'New conversation');
		}
	}

	function setupEventListeners() {
		// Status button - opens status Quick Pick
		if (statusBtn) {
			statusBtn.addEventListener('click', handleStatusClick);
			statusBtn.addEventListener('keydown', handleButtonKeydown);
		}

		// Menu button - toggles dropdown
		if (menuBtn) {
			menuBtn.addEventListener('click', handleMenuClick);
			menuBtn.addEventListener('keydown', handleButtonKeydown);
		}

		// New chat button
		if (newChatBtn) {
			newChatBtn.addEventListener('click', handleNewChatClick);
			newChatBtn.addEventListener('keydown', handleButtonKeydown);
		}

		// Menu dropdown items
		if (menuDropdown) {
			const menuItems = menuDropdown.querySelectorAll('.qic-menu-item');
			menuItems.forEach(item => {
				const clickHandler = (e) => {
					const action = item.dataset.action;
					if (action) {
						handleMenuItemClick(action);
					}
				};
				const keyHandler = (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						const action = item.dataset.action;
						if (action) {
							handleMenuItemClick(action);
						}
					}
				};
				item.addEventListener('click', clickHandler);
				item.addEventListener('keydown', keyHandler);
				menuItemHandlers.push({ item, clickHandler, keyHandler });
			});
		}

		// Close menu when clicking outside
		document.addEventListener('click', handleDocumentClick);

		// Close menu on Escape
		document.addEventListener('keydown', handleGlobalKeydown);
	}

	function subscribeToState() {
		if (!window.qicState) {
			console.warn('[HeaderManager] State manager not available');
			return;
		}

		// Subscribe to specific paths instead of all state changes
		const unsub1 = window.qicState.subscribeTo('serviceStatus', () => {
			updateStatusIndicator();
			updateButtonStates();
		});
		const unsub2 = window.qicState.subscribeTo('agentState', () => {
			updateStatusIndicator();
		});
		unsubscribe = () => { unsub1(); unsub2(); };

		// Initial update
		updateStatusIndicator();
		updateButtonStates();
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════════════

	function handleStatusClick(e) {
		e.preventDefault();
		e.stopPropagation();

		// Close menu if open
		closeMenu();

		// Trigger status Quick Pick
		if (typeof vscode !== 'undefined') {
			vscode.postMessage({ type: 'quickPick:status' });
		}
	}

	function handleMenuClick(e) {
		e.preventDefault();
		e.stopPropagation();

		toggleMenu();
	}

	function handleNewChatClick(e) {
		e.preventDefault();

		// Check if allowed
		const serviceStatus = window.qicState?.selectors?.getServiceStatus?.() ?? 'ready';
		if (serviceStatus === 'error') {
			showToast('Cannot create new chat while QIC is in error state');
			return;
		}

		if (typeof vscode !== 'undefined') {
			vscode.postMessage({ type: 'new-chat' });
		}
	}

	function handleButtonKeydown(e) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			e.target.click();
		}
	}

	function handleDocumentClick(e) {
		if (menuDropdown && menuBtn) {
			if (!menuDropdown.contains(e.target) && !menuBtn.contains(e.target)) {
				closeMenu();
			}
		}
	}

	function handleGlobalKeydown(e) {
		if (e.key === 'Escape') {
			closeMenu();
		}
	}

	function handleMenuItemClick(action) {
		closeMenu();

		if (typeof vscode === 'undefined') {
			console.warn('[HeaderManager] vscode not available');
			return;
		}

		switch (action) {
			case 'history':
				vscode.postMessage({ type: 'quickPick:history' });
				break;
			case 'rename':
				vscode.postMessage({ type: 'rename-conversation' });
				break;
			case 'checkpoints':
				vscode.postMessage({ type: 'quickPick:checkpoints' });
				break;
			case 'create-checkpoint':
				vscode.postMessage({ type: 'create-checkpoint' });
				break;
			case 'permissions':
				vscode.postMessage({ type: 'show-permissions' });
				break;
			case 'audit':
				vscode.postMessage({ type: 'request-audit-log' });
				break;
			case 'provider':
				vscode.postMessage({ type: 'quickPick:provider' });
				break;
			case 'settings':
				vscode.postMessage({ type: 'open-settings' });
				break;
			case 'help':
				vscode.postMessage({ type: 'show-help' });
				break;
			case 'export':
				vscode.postMessage({ type: 'export-conversation' });
				break;
			default:
				console.warn('[HeaderManager] Unknown menu action:', action);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Menu Management
	// ═══════════════════════════════════════════════════════════════════════════

	function toggleMenu() {
		if (!menuDropdown) return;

		const isOpen = !menuDropdown.hidden;
		if (isOpen) {
			closeMenu();
		} else {
			openMenu();
		}
	}

	function openMenu() {
		if (!menuDropdown) return;

		menuDropdown.hidden = false;
		if (menuBtn) {
			menuBtn.setAttribute('aria-expanded', 'true');
		}

		// Ensure menu items are focusable (ISSUE #003)
		const menuItems = menuDropdown.querySelectorAll('.qic-menu-item');
		menuItems.forEach((item, index) => {
			item.setAttribute('tabindex', '0');
			item.setAttribute('role', 'menuitem');
			// Add unique id for aria-activedescendant
			if (!item.id) {
				item.id = `qic-menu-item-${index}`;
			}
		});

		// Focus first item
		const firstItem = menuDropdown.querySelector('.qic-menu-item');
		firstItem?.focus();
	}

	function closeMenu() {
		if (!menuDropdown) return;

		menuDropdown.hidden = true;
		if (menuBtn) {
			menuBtn.setAttribute('aria-expanded', 'false');
		}

		// Return focus to menu button (ISSUE #018)
		menuBtn?.focus();
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// State Updates
	// ═══════════════════════════════════════════════════════════════════════════

	function updateStatusIndicator() {
		if (!statusIndicator && !statusBtn) return;
		if (!window.qicState) return;

		const serviceStatus = window.qicState.selectors?.getServiceStatus?.() ?? 'initializing';
		const agentState = window.qicState.selectors?.getAgentState?.() ?? 'idle';

		// Update status indicator dot
		if (statusIndicator) {
			statusIndicator.dataset.status = serviceStatus;

			// Add visually hidden text for screen readers (ISSUE #009)
			let srText = statusIndicator.querySelector('.sr-only');
			if (!srText) {
				srText = document.createElement('span');
				srText.className = 'sr-only';
				statusIndicator.appendChild(srText);
			}
			srText.textContent = getStatusText(serviceStatus, agentState);
		}

		// Update tooltip
		if (statusBtn) {
			const statusText = getStatusText(serviceStatus, agentState);
			statusBtn.title = statusText;
			statusBtn.setAttribute('aria-label', statusText);
		}
	}

	function updateButtonStates() {
		if (!window.qicState) return;

		const serviceStatus = window.qicState.selectors?.getServiceStatus?.() ?? 'ready';
		const isError = serviceStatus === 'error';

		// Disable new chat button when in error state
		if (newChatBtn) {
			newChatBtn.disabled = isError;
			const mod = navigator.platform?.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';
			newChatBtn.title = isError ? 'QIC is in error state' : `New conversation (${mod}+Shift+N)`;
		}
	}

	function getStatusText(serviceStatus, agentState) {
		const serviceTexts = {
			'initializing': 'QIC is starting up...',
			'ready': 'QIC is ready',
			'degraded': 'QIC is running with limited functionality',
			'error': 'QIC encountered an error',
		};

		const agentTexts = {
			'idle': '',
			'processing': ' - Processing...',
			'waiting_approval': ' - Waiting for approval',
			'error': ' - Error',
			'suspended': ' - Suspended',
		};

		return (serviceTexts[serviceStatus] || 'QIC') + (agentTexts[agentState] || '');
	}

	function showToast(message) {
		// Use shared toast if available
		if (window.qicToast?.show) {
			window.qicToast.show(message);
			return;
		}

		// Create simple toast
		const existing = document.querySelector('.qic-toast');
		if (existing) existing.remove();

		const toast = document.createElement('div');
		toast.className = 'qic-toast';
		toast.textContent = message;
		document.body.appendChild(toast);

		// Animate in
		requestAnimationFrame(() => {
			toast.classList.add('qic-toast-visible');
		});

		// Remove after delay
		setTimeout(() => {
			toast.classList.remove('qic-toast-visible');
			setTimeout(() => toast.remove(), 300);
		}, 2000);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════════════

	function dispose() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		statusBtn?.removeEventListener('click', handleStatusClick);
		statusBtn?.removeEventListener('keydown', handleButtonKeydown);
		menuBtn?.removeEventListener('click', handleMenuClick);
		menuBtn?.removeEventListener('keydown', handleButtonKeydown);
		newChatBtn?.removeEventListener('click', handleNewChatClick);
		newChatBtn?.removeEventListener('keydown', handleButtonKeydown);
		document.removeEventListener('click', handleDocumentClick);
		document.removeEventListener('keydown', handleGlobalKeydown);
		for (const { item, clickHandler, keyHandler } of menuItemHandlers) {
			item.removeEventListener('click', clickHandler);
			item.removeEventListener('keydown', keyHandler);
		}
		menuItemHandlers = [];
		statusBtn = null;
		menuBtn = null;
		newChatBtn = null;
		menuDropdown = null;
		statusIndicator = null;
	}

	// Register for global cleanup
	window.qicUtils?.registerDisposable(dispose);

	// ═══════════════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════════════

	window.qicHeader = {
		init,
		dispose,
		openMenu,
		closeMenu,
		updateStatusIndicator,

		// For debugging
		_debug: {
			getMenuDropdown: () => menuDropdown,
			getStatusIndicator: () => statusIndicator
		}
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		// Delay slightly to ensure other scripts are loaded
		setTimeout(init, 0);
	}

})();
