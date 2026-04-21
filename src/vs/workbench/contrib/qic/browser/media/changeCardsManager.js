/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Change Cards Manager
 * Phase 5 - Prompt 05-01
 *
 * Manages the display and interaction of file change cards in the conversation.
 * Change cards show proposed file changes from the LLM agent with options to
 * apply, reject, or view diff.
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Configuration
	// ═══════════════════════════════════════════════════════════════════

	const ICONS = {
		create: 'codicon-new-file',
		modify: 'codicon-edit',
		delete: 'codicon-trash',
		rename: 'codicon-file-symlink-file',
	};

	const TYPE_LABELS = {
		create: 'New',
		modify: 'Modified',
		delete: 'Deleted',
		rename: 'Renamed',
	};

	const STATUS_MESSAGES = {
		applied: 'Applied successfully',
		rejected: 'Change rejected',
		conflict: 'Conflict detected',
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	/** @type {Map<string, object>} */
	const changeSets = new Map();

	let changeCardTemplate = null;
	let changeSetTemplate = null;

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		changeCardTemplate = document.getElementById('change-card-template');
		changeSetTemplate = document.getElementById('change-set-template');

		setupEventListeners();
	}

	function setupEventListeners() {
		// Delegate events for change cards
		document.addEventListener('click', handleClick);

		// Phase 6 (06-02): Add keyboard navigation for accessibility
		document.addEventListener('keydown', handleKeyDown);
	}

	// Phase 6 (06-02): Keyboard event handler for change cards
	function handleKeyDown(e) {
		const card = e.target.closest('.change-card');
		const actionBtn = e.target.closest('.change-action-btn');

		// Handle Enter/Space on action buttons
		if (actionBtn && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			actionBtn.click();
			return;
		}

		// Handle keyboard shortcuts on change cards
		if (card && !actionBtn) {
			const changeId = card.dataset.changeId;
			if (!changeId) return;

			switch (e.key) {
				case 'Enter':
				case ' ':
					e.preventDefault();
					viewDiff(changeId);
					break;
				case 'a':
				case 'A':
					if (!e.ctrlKey && !e.metaKey) {
						e.preventDefault();
						applyChange(changeId);
					}
					break;
				case 'r':
				case 'R':
					if (!e.ctrlKey && !e.metaKey) {
						e.preventDefault();
						rejectChange(changeId);
					}
					break;
				case 'd':
				case 'D':
					if (!e.ctrlKey && !e.metaKey) {
						e.preventDefault();
						viewDiff(changeId);
					}
					break;
			}
		}
	}

	function handleClick(e) {
		// View diff
		if (e.target.closest('.change-action-btn.view-diff')) {
			const card = e.target.closest('.change-card');
			if (card) {
				viewDiff(card.dataset.changeId);
			}
			return;
		}

		// Apply single
		if (e.target.closest('.change-action-btn.apply')) {
			const card = e.target.closest('.change-card');
			if (card) {
				applyChange(card.dataset.changeId);
			}
			return;
		}

		// Reject single
		if (e.target.closest('.change-action-btn.reject')) {
			const card = e.target.closest('.change-card');
			if (card) {
				rejectChange(card.dataset.changeId);
			}
			return;
		}

		// Apply all
		if (e.target.closest('.change-set-btn.apply-all')) {
			const set = e.target.closest('.change-set');
			if (set) {
				applyAll(set.dataset.setId);
			}
			return;
		}

		// Reject all
		if (e.target.closest('.change-set-btn.reject-all')) {
			const set = e.target.closest('.change-set');
			if (set) {
				rejectAll(set.dataset.setId);
			}
			return;
		}

		// Toggle preview
		if (e.target.closest('.preview-toggle')) {
			const preview = e.target.closest('.change-card-preview');
			if (preview) {
				preview.classList.toggle('collapsed');
			}
			return;
		}

		// Open file
		if (e.target.closest('.change-action-btn.open-file')) {
			const card = e.target.closest('.change-card');
			if (card) {
				openFile(card.dataset.changeId);
			}
			return;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Render a change set in the conversation
	 * @param {object} changeSet - The change set to render
	 * @param {HTMLElement} container - The container to render into
	 * @returns {HTMLElement} The rendered change set element
	 */
	function renderChangeSet(changeSet, container) {
		changeSets.set(changeSet.id, changeSet);

		const setEl = createChangeSetElement(changeSet);
		container.appendChild(setEl);
		return setEl;
	}

	/**
	 * Create a change set element
	 */
	function createChangeSetElement(changeSet) {
		// Use template if available, otherwise create manually
		if (changeSetTemplate) {
			const clone = changeSetTemplate.content.cloneNode(true);
			const setDiv = clone.querySelector('.change-set');

			setDiv.dataset.setId = changeSet.id;

			// Update header
			const countEl = setDiv.querySelector('.change-set-count');
			if (countEl) {
				const count = changeSet.changes.length;
				countEl.textContent = `${count} file${count !== 1 ? 's' : ''} changed`;
			}

			// Add description if present
			if (changeSet.description) {
				const titleEl = setDiv.querySelector('.change-set-title');
				if (titleEl) {
					const descSpan = document.createElement('span');
					descSpan.className = 'change-set-description';
					descSpan.textContent = ` — ${changeSet.description}`;
					titleEl.appendChild(descSpan);
				}
			}

			// Render individual cards
			const cardsContainer = setDiv.querySelector('.change-set-cards');
			for (const change of changeSet.changes) {
				const cardEl = createChangeCardElement(change);
				cardsContainer.appendChild(cardEl);
			}

			return setDiv;
		}

		// Manual creation fallback
		const setDiv = document.createElement('div');
		setDiv.className = 'change-set';
		setDiv.dataset.setId = changeSet.id;

		const count = changeSet.changes.length;

		setDiv.innerHTML = `
			<div class="change-set-header">
				<div class="change-set-title">
					<span class="codicon codicon-edit"></span>
					<span class="change-set-count">${count} file${count !== 1 ? 's' : ''} changed</span>
					${changeSet.description ? `<span class="change-set-description"> — ${escapeHtml(changeSet.description)}</span>` : ''}
				</div>
				<div class="change-set-actions">
					<button class="change-set-btn apply-all" title="Apply All">
						<span class="codicon codicon-check-all"></span>
						Apply All
					</button>
					<button class="change-set-btn reject-all" title="Reject All">
						<span class="codicon codicon-close-all"></span>
						Reject All
					</button>
				</div>
			</div>
			<div class="change-set-cards"></div>
		`;

		const cardsContainer = setDiv.querySelector('.change-set-cards');
		for (const change of changeSet.changes) {
			const cardEl = createChangeCardElement(change);
			cardsContainer.appendChild(cardEl);
		}

		return setDiv;
	}

	/**
	 * Create a single change card element
	 */
	function createChangeCardElement(change) {
		// Use template if available
		if (changeCardTemplate) {
			const clone = changeCardTemplate.content.cloneNode(true);
			const card = clone.querySelector('.change-card');

			card.dataset.changeId = change.id;
			card.dataset.type = change.type;
			card.dataset.status = change.status;

			// Icon
			const icon = card.querySelector('.change-card-icon .codicon');
			if (icon) {
				icon.className = `codicon ${ICONS[change.type] || 'codicon-file'}`;
			}

			// Path
			const pathEl = card.querySelector('.change-card-path');
			if (pathEl) {
				if (change.type === 'rename' && change.newPath) {
					pathEl.textContent = `${change.path} → ${change.newPath}`;
				} else {
					pathEl.textContent = change.path;
				}
			}

			// Type badge
			const badge = card.querySelector('.change-type-badge');
			if (badge) {
				badge.textContent = TYPE_LABELS[change.type] || change.type;
			}

			// Stats
			const stats = card.querySelector('.change-stats');
			if (stats) {
				stats.innerHTML = `
					<span class="additions">+${change.additions || 0}</span>
					<span class="deletions">-${change.deletions || 0}</span>
				`;
			}

			// Preview content
			const previewCode = card.querySelector('.change-preview-code');
			if (previewCode) {
				previewCode.innerHTML = formatPreview(change);
			}

			// Status
			if (change.status !== 'pending') {
				updateCardStatusDisplay(card, change.status, change.statusMessage);
			}

			return card;
		}

		// Manual creation fallback
		const card = document.createElement('div');
		card.className = 'change-card';
		card.dataset.changeId = change.id;
		card.dataset.type = change.type;
		card.dataset.status = change.status;

		const pathDisplay = change.type === 'rename' && change.newPath
			? `${escapeHtml(change.path)} → ${escapeHtml(change.newPath)}`
			: escapeHtml(change.path);

		// Phase 6 (06-02): Add accessibility attributes
		const filename = change.path.split('/').pop() || change.path;
		const ariaLabel = `${TYPE_LABELS[change.type] || change.type} ${filename}, plus ${change.additions || 0}, minus ${change.deletions || 0}`;
		card.setAttribute('role', 'region');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-label', ariaLabel);

		card.innerHTML = `
			<div class="change-card-header">
				<div class="change-card-icon" aria-hidden="true">
					<span class="codicon ${ICONS[change.type] || 'codicon-file'}"></span>
				</div>
				<div class="change-card-info">
					<div class="change-card-path">${pathDisplay}</div>
					<div class="change-card-meta">
						<span class="change-type-badge">${TYPE_LABELS[change.type] || change.type}</span>
						<span class="change-stats">
							<span class="additions">+${change.additions || 0}</span>
							<span class="deletions">-${change.deletions || 0}</span>
						</span>
					</div>
				</div>
				<div class="change-card-actions">
					<button class="change-action-btn view-diff" title="View Diff" aria-label="View diff for ${escapeHtml(filename)}">
						<span class="codicon codicon-diff" aria-hidden="true"></span>
					</button>
					<button class="change-action-btn apply" title="Apply Change" aria-label="Apply change to ${escapeHtml(filename)}">
						<span class="codicon codicon-check" aria-hidden="true"></span>
					</button>
					<button class="change-action-btn reject" title="Reject Change" aria-label="Reject change to ${escapeHtml(filename)}">
						<span class="codicon codicon-close" aria-hidden="true"></span>
					</button>
				</div>
			</div>
			<div class="change-card-preview collapsed">
				<div class="change-card-preview-header">
					<button class="preview-toggle" aria-expanded="false">
						<span class="codicon codicon-chevron-right" aria-hidden="true"></span>
						<span class="preview-label">Preview changes</span>
					</button>
				</div>
				<div class="change-card-preview-content">
					<pre class="change-preview-code">${formatPreview(change)}</pre>
				</div>
			</div>
			<div class="change-card-status" role="status" aria-live="polite">
				<span class="status-icon codicon" aria-hidden="true"></span>
				<span class="status-text"></span>
			</div>
		`;

		if (change.status !== 'pending') {
			updateCardStatusDisplay(card, change.status, change.statusMessage);
		}

		return card;
	}

	/**
	 * Format preview content with diff highlighting
	 */
	function formatPreview(change) {
		if (!change.hunks || change.hunks.length === 0) {
			// Show new content for create, or summary for delete
			if (change.type === 'create' && change.newContent) {
				const content = change.newContent.substring(0, 1000);
				return escapeHtml(content) + (change.newContent.length > 1000 ? '\n...' : '');
			}
			if (change.type === 'delete') {
				return '<span class="diff-del">[File will be deleted]</span>';
			}
			return '<span class="diff-context">[No preview available]</span>';
		}

		// Format hunks as diff
		return change.hunks.map(hunk => {
			const lines = hunk.content.split('\n');
			return lines.map(line => {
				if (line.startsWith('+')) {
					return `<span class="diff-add">${escapeHtml(line)}</span>`;
				}
				if (line.startsWith('-')) {
					return `<span class="diff-del">${escapeHtml(line)}</span>`;
				}
				return `<span class="diff-context">${escapeHtml(line)}</span>`;
			}).join('');
		}).join('\n');
	}

	// ═══════════════════════════════════════════════════════════════════
	// Actions
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * View diff in editor
	 */
	function viewDiff(changeId) {
		notifyHost('change:viewDiff', { changeId });
	}

	/**
	 * Apply a single change
	 */
	function applyChange(changeId) {
		const card = document.querySelector(`[data-change-id="${changeId}"]`);
		if (!card || card.dataset.status !== 'pending') return;

		// Optimistic update
		updateCardStatus(card, 'applying', 'Applying...');

		notifyHost('change:apply', { changeId });
	}

	/**
	 * Reject a single change
	 */
	function rejectChange(changeId) {
		const card = document.querySelector(`[data-change-id="${changeId}"]`);
		if (!card || card.dataset.status !== 'pending') return;

		updateCardStatus(card, 'rejected', 'Rejected');

		notifyHost('change:reject', { changeId });
	}

	/**
	 * Open file in editor
	 */
	function openFile(changeId) {
		notifyHost('change:openFile', { changeId });
	}

	/**
	 * Apply all changes in a set
	 */
	function applyAll(setId) {
		const changeSet = changeSets.get(setId);
		if (!changeSet) return;

		const pendingChanges = changeSet.changes.filter(c => c.status === 'pending');
		for (const change of pendingChanges) {
			applyChange(change.id);
		}
	}

	/**
	 * Reject all changes in a set
	 */
	function rejectAll(setId) {
		const changeSet = changeSets.get(setId);
		if (!changeSet) return;

		const pendingChanges = changeSet.changes.filter(c => c.status === 'pending');
		for (const change of pendingChanges) {
			rejectChange(change.id);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Status Updates
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Update card status from extension message
	 */
	function updateCardStatus(card, status, message) {
		if (typeof card === 'string') {
			card = document.querySelector(`[data-change-id="${card}"]`);
		}
		if (!card) return;

		updateCardStatusDisplay(card, status, message);

		// Update the change set status if all cards processed
		const setEl = card.closest('.change-set');
		if (setEl) {
			updateSetStatus(setEl);
		}
	}

	/**
	 * Update card visual status
	 */
	function updateCardStatusDisplay(card, status, message) {
		card.dataset.status = status;

		const statusText = card.querySelector('.status-text');
		if (statusText) {
			statusText.textContent = message || STATUS_MESSAGES[status] || '';
		}
	}

	/**
	 * Update change set status based on card statuses
	 */
	function updateSetStatus(setEl) {
		const cards = setEl.querySelectorAll('.change-card');
		const statuses = Array.from(cards).map(c => c.dataset.status);

		const allProcessed = statuses.every(s => s !== 'pending' && s !== 'applying');

		// Hide bulk actions if all processed
		const bulkActions = setEl.querySelector('.change-set-actions');
		if (allProcessed && bulkActions) {
			bulkActions.style.display = 'none';
		}

		// Update set data attribute
		if (allProcessed) {
			const allApplied = statuses.every(s => s === 'applied');
			const allRejected = statuses.every(s => s === 'rejected');
			setEl.dataset.status = allApplied ? 'applied' : allRejected ? 'rejected' : 'partial';
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle messages from extension
	 */
	function handleMessage(message) {
		switch (message.type) {
			case 'change:statusUpdate':
				updateCardStatus(message.changeId, message.status, message.message);
				break;

			case 'change:setData':
				// Render new change set (called from message renderer)
				if (message.changeSet && message.container) {
					renderChangeSet(message.changeSet, document.getElementById(message.container));
				}
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	function notifyHost(type, data) {
		const vscode = window.vscode || (window.acquireVsCodeApi && window.acquireVsCodeApi());
		if (vscode) {
			vscode.postMessage({ type, ...data });
		}
	}

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	window.QicChangeCards = {
		init,
		renderChangeSet,
		updateCardStatus,
		handleMessage,
		// For debugging
		_debug: {
			changeSets,
			formatPreview,
		}
	};

	// Initialize when DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
