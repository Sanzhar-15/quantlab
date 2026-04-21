/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Help Modal Manager
 * Phase 6 - Prompt 06-08: Help & Shortcuts Modal
 *
 * Displays keyboard shortcuts, quick tips, and documentation links.
 * Triggered by Menu -> "Help & shortcuts" or Cmd+/
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Constants
	// ═══════════════════════════════════════════════════════════════════

	const DOCS_URL = 'https://docs.quantlab.io/qic';
	const ISSUES_URL = 'https://github.com/quantlab/qic/issues/new';

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let modal = null;
	let focusTrap = null;
	let previouslyFocused = null;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		modal = document.getElementById('help-modal');
		if (!modal) {
			createModal();
		}
		setupEventListeners();
	}

	function createModal() {
		modal = document.createElement('div');
		modal.id = 'help-modal';
		modal.className = 'qic-modal-overlay';
		modal.hidden = true;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-labelledby', 'help-modal-title');

		modal.innerHTML = `
			<div class="qic-modal qic-help-modal">
				<div class="qic-modal-header">
					<span class="codicon codicon-question"></span>
					<h2 id="help-modal-title">Help & Shortcuts</h2>
					<button class="qic-modal-close" aria-label="Close" data-action="close">
						<span class="codicon codicon-close"></span>
					</button>
				</div>

				<div class="qic-modal-body qic-help-content">
					<!-- Global Shortcuts -->
					<section class="qic-help-section">
						<h3>Global</h3>
						<div class="qic-shortcuts-list">
							<div class="qic-shortcut">
								<kbd>Cmd+L</kbd>
								<span>Focus QIC input</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Shift+N</kbd>
								<span>New conversation</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Shift+H</kbd>
								<span>Open history</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Shift+C</kbd>
								<span>Create checkpoint</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Ctrl+Z</kbd>
								<span>Restore checkpoint</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+/</kbd>
								<span>Show this help</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+.</kbd>
								<span>Stop generation</span>
							</div>
						</div>
					</section>

					<!-- Panel Shortcuts -->
					<section class="qic-help-section">
						<h3>Panel</h3>
						<div class="qic-shortcuts-list">
							<div class="qic-shortcut">
								<kbd>Cmd+Enter</kbd>
								<span>Send message</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Escape</kbd>
								<span>Cancel / Clear</span>
							</div>
							<div class="qic-shortcut">
								<kbd>@</kbd>
								<span>Mention file or symbol</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Up</kbd>
								<span>Edit last message (when empty)</span>
							</div>
						</div>
					</section>

					<!-- Diff Review Shortcuts -->
					<section class="qic-help-section">
						<h3>Diff Review</h3>
						<div class="qic-shortcuts-list">
							<div class="qic-shortcut">
								<kbd>Cmd+Enter</kbd>
								<span>Accept change</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Escape</kbd>
								<span>Reject change</span>
							</div>
							<div class="qic-shortcut">
								<kbd>F7</kbd>
								<span>Next file</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Shift+F7</kbd>
								<span>Previous file</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Shift+R</kbd>
								<span>Open review mode</span>
							</div>
						</div>
					</section>

					<!-- Review Mode -->
					<section class="qic-help-section">
						<h3>Review Mode</h3>
						<div class="qic-shortcuts-list">
							<div class="qic-shortcut">
								<kbd>↓</kbd> / <kbd>↑</kbd>
								<span>Navigate files</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>
								<span>Navigate hunks</span>
							</div>
							<div class="qic-shortcut">
								<kbd>J</kbd> / <kbd>K</kbd>
								<span>Vim-style navigation</span>
							</div>
							<div class="qic-shortcut">
								<kbd>A</kbd>
								<span>Accept current file</span>
							</div>
							<div class="qic-shortcut">
								<kbd>R</kbd>
								<span>Reject current file</span>
							</div>
							<div class="qic-shortcut">
								<kbd>Cmd+Shift+A</kbd>
								<span>Accept all</span>
							</div>
						</div>
					</section>

					<!-- Tips -->
					<section class="qic-help-section">
						<h3>Tips</h3>
						<ul class="qic-tips-list">
							<li>Use <code>@filename</code> to add files as context</li>
							<li>Click file names in responses to open them</li>
							<li>Checkpoints are created automatically before changes</li>
							<li>Use "Explain" to understand code before modifying</li>
							<li>Pin frequently used context items for persistence</li>
						</ul>
					</section>
				</div>

				<div class="qic-modal-footer qic-help-footer">
					<a href="#" class="qic-help-link" data-action="docs">
						<span class="codicon codicon-book"></span> Documentation
					</a>
					<a href="#" class="qic-help-link" data-action="report">
						<span class="codicon codicon-github"></span> Report issue
					</a>
					<button class="qic-btn qic-btn-primary" data-action="close">Close</button>
				</div>
			</div>
		`;

		document.body.appendChild(modal);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	function show() {
		if (!modal) return;

		modal.hidden = false;
		previouslyFocused = document.activeElement;
		setupFocusTrap();

		// Focus close button
		requestAnimationFrame(() => {
			modal.querySelector('[data-action="close"]')?.focus();
		});

		// Announce for screen readers
		announce('Help and shortcuts dialog opened');
	}

	function hide() {
		if (!modal) return;

		modal.hidden = true;
		removeFocusTrap();

		// Restore focus
		if (previouslyFocused && previouslyFocused.focus) {
			previouslyFocused.focus();
		}
		previouslyFocused = null;
	}

	function toggle() {
		if (modal?.hidden) {
			show();
		} else {
			hide();
		}
	}

	function isVisible() {
		return modal && !modal.hidden;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Focus Trap
	// ═══════════════════════════════════════════════════════════════════

	function setupFocusTrap() {
		const focusableElements = modal.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		);

		if (focusableElements.length === 0) return;

		const firstFocusable = focusableElements[0];
		const lastFocusable = focusableElements[focusableElements.length - 1];

		focusTrap = (e) => {
			if (e.key === 'Tab') {
				if (e.shiftKey) {
					if (document.activeElement === firstFocusable) {
						e.preventDefault();
						lastFocusable.focus();
					}
				} else {
					if (document.activeElement === lastFocusable) {
						e.preventDefault();
						firstFocusable.focus();
					}
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				hide();
			}
		};

		modal.addEventListener('keydown', focusTrap);
	}

	function removeFocusTrap() {
		if (focusTrap) {
			modal.removeEventListener('keydown', focusTrap);
			focusTrap = null;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Actions
	// ═══════════════════════════════════════════════════════════════════

	function handleAction(action) {
		const vscode = window.vscode || window.vscodeApi;

		switch (action) {
			case 'close':
				hide();
				break;

			case 'docs':
				if (vscode) {
					vscode.postMessage({
						type: 'open-external',
						payload: { url: DOCS_URL }
					});
				}
				break;

			case 'report':
				if (vscode) {
					vscode.postMessage({
						type: 'open-external',
						payload: { url: ISSUES_URL }
					});
				}
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	function setupEventListeners() {
		if (!modal) return;

		// Action buttons and links
		modal.addEventListener('click', (e) => {
			const actionEl = e.target.closest('[data-action]');
			if (actionEl) {
				e.preventDefault();
				handleAction(actionEl.dataset.action);
				return;
			}

			// Click outside modal content to close
			if (e.target === modal) {
				hide();
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function announce(message) {
		const announcer = document.getElementById('qic-announcer');
		if (announcer) {
			announcer.textContent = message;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicHelpModal = {
		show,
		hide,
		toggle,
		isVisible,
		init,
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
