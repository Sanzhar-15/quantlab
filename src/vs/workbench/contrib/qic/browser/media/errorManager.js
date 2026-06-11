/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Error Manager
 * Phase 6 - Prompt 06-03: Error Display
 *
 * Manages error display throughout the QIC UI including:
 * - Inline errors in conversation
 * - Toast notifications
 * - Connection error banners
 * - Validation errors on inputs
 * - Accessible error announcements
 */

(function() {
	'use strict';

	// ===================================================================
	// Error Code Map (GAP-07)
	// ===================================================================

	const ERROR_CODE_MAP = {
		// Tool Errors
		'QIC-T001': { title: 'Tool Not Found', message: 'The requested tool is not available.', severity: 'error', displayMethod: 'inline' },
		'QIC-T002': { title: 'Tool Execution Failed', message: 'The tool encountered an error.', severity: 'error', displayMethod: 'inline', recoveryAction: 'Retry' },
		'QIC-T003': { title: 'Tool Timeout', message: 'The tool took too long to complete.', severity: 'warning', displayMethod: 'inline', recoveryAction: 'Retry' },
		'QIC-T004': { title: 'Tool Permission Denied', message: 'You denied permission for this tool.', severity: 'info', displayMethod: 'inline', autoDismiss: 5000 },
		'QIC-T005': { title: 'Tool Arguments Invalid', message: 'The tool received invalid arguments.', severity: 'error', displayMethod: 'inline' },

		// Provider Errors
		'QIC-P001': { title: 'Provider Unavailable', message: 'The LLM provider is currently unavailable.', severity: 'error', displayMethod: 'banner', recoveryAction: 'Switch Provider' },
		'QIC-P002': { title: 'Provider Degraded', message: 'Some features may be limited.', severity: 'warning', displayMethod: 'toast', autoDismiss: 10000 },
		'QIC-P003': { title: 'Model Not Available', message: 'The requested model is not available.', severity: 'error', displayMethod: 'inline' },
		'QIC-P004': { title: 'Context Too Large', message: 'The context exceeds the model\'s limit.', severity: 'error', displayMethod: 'inline', recoveryAction: 'Reduce context' },
		'QIC-P005': { title: 'Rate Limited', message: 'Too many requests. Please wait.', severity: 'warning', displayMethod: 'banner' },
		'QIC-P006': { title: 'Authentication Failed', message: 'Your API key is invalid or expired.', severity: 'critical', displayMethod: 'modal' },

		// Network Errors
		'QIC-N001': { title: 'Connection Failed', message: 'Unable to connect to the Orion service.', severity: 'error', displayMethod: 'banner', recoveryAction: 'Retry' },
		'QIC-N002': { title: 'Request Timeout', message: 'The request timed out.', severity: 'warning', displayMethod: 'inline', recoveryAction: 'Retry' },
		'QIC-N003': { title: 'Offline', message: 'You appear to be offline.', severity: 'warning', displayMethod: 'banner' },
		'QIC-N004': { title: 'Server Error', message: 'The server encountered an error.', severity: 'error', displayMethod: 'inline' },

		// Conversation Errors
		'QIC-C001': { title: 'Conversation Not Found', message: 'The conversation could not be loaded.', severity: 'error', displayMethod: 'toast' },
		'QIC-C002': { title: 'Message Too Long', message: 'Your message exceeds the maximum length.', severity: 'warning', displayMethod: 'inline', autoDismiss: 5000 },
		'QIC-C003': { title: 'Empty Message', message: 'Please enter a message.', severity: 'info', displayMethod: 'inline', autoDismiss: 3000 },

		// File Errors
		'QIC-F001': { title: 'File Not Found', message: 'The file could not be found.', severity: 'error', displayMethod: 'inline' },
		'QIC-F002': { title: 'File Read Error', message: 'Unable to read the file.', severity: 'error', displayMethod: 'inline' },
		'QIC-F003': { title: 'File Write Error', message: 'Unable to write changes.', severity: 'error', displayMethod: 'inline', recoveryAction: 'Retry' },
		'QIC-F004': { title: 'File Conflict', message: 'The file has been modified.', severity: 'warning', displayMethod: 'inline', recoveryAction: 'Regenerate' },

		// Cancellation
		'QIC-Y001': { title: 'Request Cancelled', message: 'The request was cancelled.', severity: 'info', displayMethod: 'inline', autoDismiss: 3000 },
		'QIC-Y002': { title: 'Operation Cancelled', message: 'The operation was cancelled.', severity: 'info', displayMethod: 'toast', autoDismiss: 3000 },

		// Internal Errors
		'QIC-X001': { title: 'Internal Error', message: 'An unexpected error occurred.', severity: 'error', displayMethod: 'inline' },
		'QIC-X002': { title: 'State Sync Error', message: 'State synchronization failed.', severity: 'warning', displayMethod: 'toast' },
	};

	// ===================================================================
	// State
	// ===================================================================

	const errors = new Map();
	let container = null;
	let announcer = null;
	let toastContainer = null;

	// ===================================================================
	// Initialization
	// ===================================================================

	function init() {
		container = document.getElementById('messages');
		announcer = document.getElementById('qic-announcer');

		// Create toast container if needed
		toastContainer = document.getElementById('qic-toast-container');
		if (!toastContainer) {
			toastContainer = document.createElement('div');
			toastContainer.id = 'qic-toast-container';
			toastContainer.className = 'qic-toast-container';
			toastContainer.setAttribute('aria-live', 'polite');
			document.body.appendChild(toastContainer);
		}

		setupEventListeners();
	}

	function setupEventListeners() {
		// Delegate error dismissal
		document.addEventListener('click', (e) => {
			if (e.target.closest('.qic-error-dismiss')) {
				const errorEl = e.target.closest('.qic-error');
				dismiss(errorEl?.dataset.errorId);
			}

			if (e.target.closest('.qic-error-action[data-action]')) {
				const btn = e.target.closest('.qic-error-action');
				const errorEl = e.target.closest('.qic-error');
				handleAction(errorEl?.dataset.errorId, btn.dataset.action, btn.dataset.command);
			}

			// Connection banner retry
			if (e.target.closest('.qic-connection-error-retry')) {
				notifyHost('connection:retry');
			}
		});

		// Keyboard support
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				const focusedError = document.activeElement?.closest('.qic-error');
				if (focusedError) {
					dismiss(focusedError.dataset.errorId);
				}
			}
		});
	}

	// ===================================================================
	// Public API
	// ===================================================================

	/**
	 * Display an error by code
	 */
	function displayByCode(errorCode, additionalInfo = {}) {
		const config = ERROR_CODE_MAP[errorCode] || ERROR_CODE_MAP['QIC-X001'];

		const error = {
			id: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
			code: errorCode,
			title: additionalInfo.title || config.title,
			message: additionalInfo.message || config.message,
			severity: config.severity,
			details: additionalInfo.details,
			recoverable: !!config.recoveryAction,
			retryAction: config.recoveryAction,
			retryCommand: config.recoveryCommand,
			operationId: additionalInfo.operationId,
		};

		switch (config.displayMethod) {
			case 'toast':
				showToast(error, config.autoDismiss);
				break;
			case 'inline':
				showInline(error, config.autoDismiss);
				break;
			case 'banner':
				showBanner(error);
				break;
			case 'modal':
				showModal(error);
				break;
			default:
				showInline(error, config.autoDismiss);
		}

		// Announce for screen readers
		announce(error);

		// Log for debugging
		console.error(`[QIC Error] ${errorCode}:`, error);

		return error.id;
	}

	/**
	 * Display an error object directly
	 */
	function show(error, options = {}) {
		const {
			showInline: inline = true,
			showNotification = false,
			showStatusBar = true,
			showToast: toast = false,
			autoDismiss = 0
		} = options;

		// Store error
		errors.set(error.id, error);

		// Show based on options
		if (toast) {
			showToast(error, autoDismiss);
		} else if (inline) {
			showInline(error, autoDismiss);
		}

		// Show notification via extension
		if (showNotification) {
			notifyHost('error:notification', {
				severity: error.severity,
				title: error.title,
				message: error.message,
			});
		}

		// Update status bar
		if (showStatusBar) {
			notifyHost('error:statusBar', {
				severity: error.severity,
				message: error.title,
			});
		}

		// Announce for screen readers
		announce(error);

		return error.id;
	}

	// ===================================================================
	// Display Methods
	// ===================================================================

	/**
	 * Show inline error in conversation
	 */
	function showInline(error, autoDismiss = 0) {
		if (!container) { return; }

		errors.set(error.id, error);

		const errorEl = document.createElement('div');
		errorEl.className = 'qic-error';
		errorEl.dataset.errorId = error.id;
		errorEl.dataset.severity = error.severity;
		errorEl.setAttribute('role', 'alert');
		errorEl.setAttribute('aria-live', 'assertive');
		errorEl.setAttribute('tabindex', '-1');

		errorEl.innerHTML = `
			<div class="qic-error-header">
				<span class="qic-error-icon codicon" aria-hidden="true"></span>
				<span class="qic-error-title">${escapeHtml(error.title)}</span>
				${error.code ? `<span class="qic-error-code">${escapeHtml(error.code)}</span>` : ''}
				<button class="qic-error-dismiss" aria-label="Dismiss error">
					<span class="codicon codicon-close" aria-hidden="true"></span>
				</button>
			</div>
			<div class="qic-error-body">
				<p class="qic-error-message">${escapeHtml(error.message)}</p>
				${error.details ? `
					<details class="qic-error-details">
						<summary>Details</summary>
						<pre class="qic-error-details-content">${escapeHtml(error.details)}</pre>
					</details>
				` : ''}
			</div>
			${renderActions(error)}
		`;

		container.appendChild(errorEl);
		scrollToError(errorEl);

		// Auto-dismiss
		if (autoDismiss > 0) {
			setTimeout(() => dismiss(error.id), autoDismiss);
		}
	}

	/**
	 * Show toast notification
	 */
	function showToast(error, autoDismiss = 5000) {
		if (!toastContainer) { return; }

		errors.set(error.id, error);

		const toast = document.createElement('div');
		toast.className = `qic-toast qic-toast-${error.severity}`;
		toast.dataset.errorId = error.id;
		toast.setAttribute('role', 'alert');

		toast.innerHTML = `
			<span class="qic-toast-icon codicon" aria-hidden="true"></span>
			<div class="qic-toast-content">
				<span class="qic-toast-title">${escapeHtml(error.title)}</span>
				<span class="qic-toast-message">${escapeHtml(error.message)}</span>
			</div>
			<button class="qic-toast-dismiss" aria-label="Dismiss">
				<span class="codicon codicon-close" aria-hidden="true"></span>
			</button>
		`;

		toast.querySelector('.qic-toast-dismiss').addEventListener('click', () => {
			dismissToast(toast, error.id);
		});

		toastContainer.appendChild(toast);

		// Animate in
		requestAnimationFrame(() => {
			toast.classList.add('visible');
		});

		// Auto-dismiss
		if (autoDismiss > 0) {
			setTimeout(() => dismissToast(toast, error.id), autoDismiss);
		}
	}

	function dismissToast(toast, errorId) {
		toast.classList.remove('visible');
		toast.classList.add('dismissing');
		setTimeout(() => {
			toast.remove();
			errors.delete(errorId);
		}, 300);
	}

	/**
	 * Show connection error banner
	 */
	function showBanner(error) {
		// Remove existing banner
		hideBanner();

		errors.set(error.id, error);

		const banner = document.createElement('div');
		banner.className = `qic-connection-error qic-connection-error-${error.severity}`;
		banner.dataset.errorId = error.id;
		banner.setAttribute('role', 'alert');

		banner.innerHTML = `
			<span class="codicon codicon-${getSeverityIcon(error.severity)}" aria-hidden="true"></span>
			<span class="qic-connection-error-message">${escapeHtml(error.message)}</span>
			${error.recoverable ? `
				<button class="qic-connection-error-retry">${escapeHtml(error.retryAction || 'Retry')}</button>
			` : ''}
			<button class="qic-connection-error-dismiss" aria-label="Dismiss">
				<span class="codicon codicon-close" aria-hidden="true"></span>
			</button>
		`;

		banner.querySelector('.qic-connection-error-dismiss')?.addEventListener('click', () => {
			hideBanner();
		});

		if (error.retryCommand) {
			banner.querySelector('.qic-connection-error-retry')?.addEventListener('click', () => {
				notifyHost('error:retry', { command: error.retryCommand, operationId: error.operationId });
			});
		}

		// Insert after header
		const header = document.querySelector('.qic-header, .qic-header-v2');
		if (header) {
			header.parentNode.insertBefore(banner, header.nextSibling);
		} else {
			document.body.insertBefore(banner, document.body.firstChild);
		}
	}

	/**
	 * Hide connection error banner
	 */
	function hideBanner() {
		const existing = document.querySelector('.qic-connection-error');
		if (existing) {
			const errorId = existing.dataset.errorId;
			existing.remove();
			if (errorId) { errors.delete(errorId); }
		}
	}

	/**
	 * Show modal error (critical errors)
	 */
	function showModal(error) {
		errors.set(error.id, error);

		// For critical errors, we defer to the extension to show a proper modal
		notifyHost('error:modal', {
			id: error.id,
			severity: error.severity,
			title: error.title,
			message: error.message,
			details: error.details,
			recoveryAction: error.retryAction,
			recoveryCommand: error.retryCommand,
		});
	}

	// ===================================================================
	// Validation Errors
	// ===================================================================

	/**
	 * Show validation error on input
	 */
	function showValidationError(inputId, message) {
		hideValidationError(inputId);

		const input = document.getElementById(inputId);
		if (!input) { return; }

		const errorEl = document.createElement('div');
		errorEl.className = 'qic-validation-error';
		errorEl.setAttribute('role', 'alert');
		errorEl.id = `${inputId}-error`;
		errorEl.innerHTML = `
			<span class="codicon codicon-error" aria-hidden="true"></span>
			<span>${escapeHtml(message)}</span>
		`;

		input.setAttribute('aria-invalid', 'true');
		input.setAttribute('aria-describedby', errorEl.id);
		input.classList.add('has-error');
		input.parentNode.insertBefore(errorEl, input.nextSibling);

		// Announce
		announce({ severity: 'error', title: 'Validation Error', message });
	}

	/**
	 * Hide validation error
	 */
	function hideValidationError(inputId) {
		const input = document.getElementById(inputId);
		const errorEl = document.getElementById(`${inputId}-error`);

		if (input) {
			input.removeAttribute('aria-invalid');
			input.removeAttribute('aria-describedby');
			input.classList.remove('has-error');
		}
		errorEl?.remove();
	}

	// ===================================================================
	// Error Management
	// ===================================================================

	/**
	 * Dismiss an error
	 */
	function dismiss(errorId) {
		if (!errorId) { return; }

		const errorEl = document.querySelector(`[data-error-id="${errorId}"]`);
		if (errorEl) {
			errorEl.classList.add('dismissing');
			setTimeout(() => errorEl.remove(), 200);
		}

		errors.delete(errorId);
	}

	/**
	 * Dismiss all errors
	 */
	function dismissAll() {
		errors.forEach((_, errorId) => dismiss(errorId));
	}

	/**
	 * Handle error action button click
	 */
	function handleAction(errorId, action, command) {
		const error = errors.get(errorId);

		switch (action) {
			case 'retry':
				notifyHost('error:retry', {
					operationId: error?.operationId,
					command: command || error?.retryCommand,
				});
				dismiss(errorId);
				break;

			case 'dismiss':
				dismiss(errorId);
				break;

			case 'command':
				if (command) {
					notifyHost('error:command', { command });
				}
				dismiss(errorId);
				break;
		}
	}

	// ===================================================================
	// Accessibility
	// ===================================================================

	/**
	 * Announce error for screen readers
	 */
	function announce(error) {
		if (!announcer) { return; }

		const announcement = `${error.severity}: ${error.title}. ${error.message}`;
		announcer.textContent = '';
		setTimeout(() => {
			announcer.textContent = announcement;
		}, 50);
	}

	// ===================================================================
	// Message Handling
	// ===================================================================

	function handleMessage(message) {
		switch (message.type) {
			case 'error:show':
				if (message.code) {
					displayByCode(message.code, message);
				} else if (message.error) {
					show(message.error, message.options);
				}
				break;

			case 'error:dismiss':
				dismiss(message.errorId);
				break;

			case 'error:dismissAll':
				dismissAll();
				break;

			case 'error:showBanner':
				showBanner(message.error);
				break;

			case 'error:hideBanner':
				hideBanner();
				break;

			case 'error:validation':
				if (message.show) {
					showValidationError(message.inputId, message.message);
				} else {
					hideValidationError(message.inputId);
				}
				break;

			case 'connection:status':
				if (message.status === 'disconnected') {
					showBanner({
						id: 'connection_error',
						severity: 'warning',
						title: 'Connection Lost',
						message: message.message || 'Connection to Orion service lost.',
						recoverable: true,
						retryAction: 'Reconnect',
					});
				} else if (message.status === 'connected') {
					hideBanner();
				}
				break;
		}
	}

	// ===================================================================
	// Helpers
	// ===================================================================

	function renderActions(error) {
		if (!error.recoverable && !error.retryAction) {
			return '';
		}

		let actionsHtml = '<div class="qic-error-actions">';

		if (error.retryAction) {
			actionsHtml += `
				<button class="qic-error-action primary" data-action="retry" ${error.retryCommand ? `data-command="${escapeAttr(error.retryCommand)}"` : ''}>
					${escapeHtml(error.retryAction)}
				</button>
			`;
		}

		if (error.helpLink) {
			actionsHtml += `
				<a class="qic-error-action secondary" href="${escapeAttr(error.helpLink)}" target="_blank">
					Learn More
				</a>
			`;
		}

		actionsHtml += '</div>';
		return actionsHtml;
	}

	function getSeverityIcon(severity) {
		const icons = {
			info: 'info',
			warning: 'warning',
			error: 'error',
			critical: 'error',
		};
		return icons[severity] || 'error';
	}

	function scrollToError(errorEl) {
		errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	function notifyHost(type, data = {}) {
		const vscode = window.vscodeApi || (window.acquireVsCodeApi && window.acquireVsCodeApi());
		if (vscode) {
			vscode.postMessage({ type, ...data });
		}
	}

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	// ===================================================================
	// Export
	// ===================================================================

	window.QicErrorManager = {
		init,
		show,
		displayByCode,
		dismiss,
		dismissAll,
		showBanner,
		hideBanner,
		showValidationError,
		hideValidationError,
		handleMessage,
		getError: (id) => errors.get(id),
		hasErrors: () => errors.size > 0,
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		setTimeout(init, 0);
	}

})();
