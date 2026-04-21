/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Audit Log Manager
 * Phase 6 - Prompt 06-09: Audit Log Viewer
 *
 * Displays a filterable log of all QIC actions including:
 * - Changes made
 * - Permissions granted
 * - Tools used
 * - Checkpoints created
 * - Errors encountered
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Constants
	// ═══════════════════════════════════════════════════════════════════

	const PAGE_SIZE = 50;

	const TYPE_ICONS = {
		change: 'codicon-edit',
		permission: 'codicon-shield',
		tool: 'codicon-tools',
		checkpoint: 'codicon-history',
		error: 'codicon-error',
		conversation: 'codicon-comment-discussion',
		context: 'codicon-file-code',
	};

	const TYPE_LABELS = {
		change: 'Change',
		permission: 'Permission',
		tool: 'Tool',
		checkpoint: 'Checkpoint',
		error: 'Error',
		conversation: 'Conversation',
		context: 'Context',
	};

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let viewer = null;
	let entries = [];
	let filteredEntries = [];
	let currentPage = 0;
	let totalEntries = 0;
	let currentFilter = { types: ['all'] };
	let searchQuery = '';

	// ═══════════════════════════════════════════════════════════════════
	// Initialization
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		viewer = document.getElementById('audit-log-viewer');
		if (!viewer) {
			createViewer();
		}
		setupEventListeners();
	}

	function createViewer() {
		viewer = document.createElement('div');
		viewer.id = 'audit-log-viewer';
		viewer.className = 'qic-audit-viewer';
		viewer.hidden = true;

		viewer.innerHTML = `
			<div class="qic-audit-header">
				<h2>
					<span class="codicon codicon-list-unordered"></span>
					Audit Log
				</h2>
				<div class="qic-audit-actions">
					<button class="qic-btn qic-icon-btn" data-action="export" title="Export log" aria-label="Export log">
						<span class="codicon codicon-export"></span>
					</button>
					<button class="qic-btn qic-icon-btn" data-action="clear" title="Clear log" aria-label="Clear log">
						<span class="codicon codicon-trash"></span>
					</button>
					<button class="qic-btn qic-icon-btn" data-action="close" title="Close" aria-label="Close">
						<span class="codicon codicon-close"></span>
					</button>
				</div>
			</div>

			<div class="qic-audit-filters">
				<div class="qic-filter-chips" role="group" aria-label="Filter by type">
					<button class="qic-filter-chip active" data-type="all">All</button>
					<button class="qic-filter-chip" data-type="change">
						<span class="codicon codicon-edit"></span> Changes
					</button>
					<button class="qic-filter-chip" data-type="permission">
						<span class="codicon codicon-shield"></span> Permissions
					</button>
					<button class="qic-filter-chip" data-type="tool">
						<span class="codicon codicon-tools"></span> Tools
					</button>
					<button class="qic-filter-chip" data-type="checkpoint">
						<span class="codicon codicon-history"></span> Checkpoints
					</button>
					<button class="qic-filter-chip" data-type="error">
						<span class="codicon codicon-error"></span> Errors
					</button>
				</div>

				<div class="qic-audit-search">
					<span class="codicon codicon-search"></span>
					<input
						type="text"
						id="audit-search"
						placeholder="Search log..."
						aria-label="Search audit log"
					>
				</div>
			</div>

			<div class="qic-audit-list" id="audit-entries" role="log" aria-label="Audit log entries">
			</div>

			<div class="qic-audit-pagination" id="audit-pagination">
				<span class="qic-pagination-info">No entries</span>
				<div class="qic-pagination-controls">
					<button class="qic-btn qic-icon-btn" data-action="prev" disabled aria-label="Previous page">
						<span class="codicon codicon-chevron-left"></span>
					</button>
					<button class="qic-btn qic-icon-btn" data-action="next" disabled aria-label="Next page">
						<span class="codicon codicon-chevron-right"></span>
					</button>
				</div>
			</div>

			<div id="audit-detail" class="qic-audit-detail" hidden>
				<div class="qic-detail-header">
					<button class="qic-btn qic-icon-btn" data-action="back" aria-label="Back to list">
						<span class="codicon codicon-chevron-left"></span>
					</button>
					<span class="qic-detail-title"></span>
				</div>
				<div class="qic-detail-content">
				</div>
			</div>
		`;

		// Add template
		const template = document.createElement('template');
		template.id = 'audit-entry-template';
		template.innerHTML = `
			<div class="qic-audit-entry" role="listitem" tabindex="0">
				<div class="qic-entry-icon">
					<span class="codicon"></span>
				</div>
				<div class="qic-entry-content">
					<div class="qic-entry-title"></div>
					<div class="qic-entry-desc"></div>
				</div>
				<div class="qic-entry-meta">
					<span class="qic-entry-time"></span>
					<span class="qic-entry-status"></span>
				</div>
				<button class="qic-entry-expand" aria-label="View details">
					<span class="codicon codicon-chevron-right"></span>
				</button>
			</div>
		`;

		document.body.appendChild(viewer);
		document.body.appendChild(template);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	function show() {
		if (!viewer) return;
		viewer.hidden = false;
		loadEntries();

		// Announce for screen readers
		announce('Audit log viewer opened');

		// Focus search input
		requestAnimationFrame(() => {
			const searchInput = document.getElementById('audit-search');
			searchInput?.focus();
		});
	}

	function hide() {
		if (!viewer) return;
		viewer.hidden = true;
		hideDetail();
	}

	function toggle() {
		if (viewer?.hidden) {
			show();
		} else {
			hide();
		}
	}

	function isVisible() {
		return viewer && !viewer.hidden;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Data Loading
	// ═══════════════════════════════════════════════════════════════════

	function loadEntries() {
		const vscode = window.vscode || window.vscodeApi;
		if (!vscode) return;

		vscode.postMessage({
			type: 'audit:get-entries',
			payload: {
				filter: currentFilter,
				page: currentPage,
				pageSize: PAGE_SIZE,
			}
		});
	}

	function setEntries(newEntries, total) {
		entries = newEntries || [];
		totalEntries = total || 0;
		applyFilters();
		renderEntries();
		updatePagination();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Filtering
	// ═══════════════════════════════════════════════════════════════════

	function setFilter(types) {
		currentFilter.types = types;
		currentPage = 0;
		loadEntries();

		// Update UI
		viewer?.querySelectorAll('.qic-filter-chip').forEach(chip => {
			const chipType = chip.dataset.type;
			chip.classList.toggle('active',
				types.includes(chipType) || (types.includes('all') && chipType === 'all')
			);
		});
	}

	function setSearchQuery(query) {
		searchQuery = query.toLowerCase();
		applyFilters();
		renderEntries();
	}

	function applyFilters() {
		filteredEntries = entries.filter(entry => {
			// Type filter (client-side for search)
			if (!currentFilter.types.includes('all') &&
				!currentFilter.types.includes(entry.type)) {
				return false;
			}

			// Search filter
			if (searchQuery) {
				const searchable = `${entry.title} ${entry.description}`.toLowerCase();
				if (!searchable.includes(searchQuery)) {
					return false;
				}
			}

			return true;
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	function renderEntries() {
		const entriesList = document.getElementById('audit-entries');
		if (!entriesList) return;

		entriesList.innerHTML = '';

		if (filteredEntries.length === 0) {
			renderEmptyState(entriesList);
			return;
		}

		const template = document.getElementById('audit-entry-template');
		if (!template) return;

		filteredEntries.forEach(entry => {
			const el = template.content.cloneNode(true).firstElementChild;
			if (!el) return;

			el.dataset.id = entry.id;
			el.dataset.type = entry.type;

			// Icon
			const icon = el.querySelector('.qic-entry-icon .codicon');
			if (icon) {
				icon.classList.add(TYPE_ICONS[entry.type] || 'codicon-circle');
			}

			// Content
			const titleEl = el.querySelector('.qic-entry-title');
			const descEl = el.querySelector('.qic-entry-desc');
			if (titleEl) titleEl.textContent = entry.title;
			if (descEl) descEl.textContent = entry.description;

			// Meta
			const timeEl = el.querySelector('.qic-entry-time');
			if (timeEl) timeEl.textContent = formatTime(entry.timestamp);

			if (entry.status) {
				const statusEl = el.querySelector('.qic-entry-status');
				if (statusEl) {
					statusEl.textContent = entry.status;
					statusEl.classList.add(entry.status);
				}
			}

			// Click handler
			el.addEventListener('click', () => showDetail(entry));
			el.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					showDetail(entry);
				}
			});

			entriesList.appendChild(el);
		});
	}

	function renderEmptyState(container) {
		container.innerHTML = `
			<div class="qic-audit-empty">
				<span class="codicon codicon-list-unordered"></span>
				<p>No audit log entries</p>
				<span>Actions will appear here as you use QIC</span>
			</div>
		`;
	}

	function updatePagination() {
		const paginationInfo = viewer?.querySelector('.qic-pagination-info');
		if (!paginationInfo) return;

		if (totalEntries === 0) {
			paginationInfo.textContent = 'No entries';
		} else {
			const start = currentPage * PAGE_SIZE + 1;
			const end = Math.min(start + PAGE_SIZE - 1, totalEntries);
			paginationInfo.textContent = `Showing ${start}-${end} of ${totalEntries}`;
		}

		// Update button states
		const prevBtn = viewer?.querySelector('[data-action="prev"]');
		const nextBtn = viewer?.querySelector('[data-action="next"]');

		if (prevBtn) prevBtn.disabled = currentPage === 0;
		if (nextBtn) nextBtn.disabled = (currentPage + 1) * PAGE_SIZE >= totalEntries;
	}

	function formatTime(timestamp) {
		const date = new Date(timestamp);
		const now = new Date();

		if (date.toDateString() === now.toDateString()) {
			return date.toLocaleTimeString(undefined, {
				hour: 'numeric',
				minute: '2-digit',
			});
		}

		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Detail View
	// ═══════════════════════════════════════════════════════════════════

	function showDetail(entry) {
		const detailView = document.getElementById('audit-detail');
		if (!detailView) return;

		detailView.hidden = false;

		const title = detailView.querySelector('.qic-detail-title');
		const content = detailView.querySelector('.qic-detail-content');

		if (title) title.textContent = entry.title;

		if (content) {
			content.innerHTML = `
				<div class="qic-detail-section">
					<h4>Type</h4>
					<p>${escapeHtml(TYPE_LABELS[entry.type] || entry.type)}</p>
				</div>
				<div class="qic-detail-section">
					<h4>Timestamp</h4>
					<p>${new Date(entry.timestamp).toLocaleString()}</p>
				</div>
				<div class="qic-detail-section">
					<h4>Description</h4>
					<p>${escapeHtml(entry.description)}</p>
				</div>
				${entry.status ? `
				<div class="qic-detail-section">
					<h4>Status</h4>
					<p class="qic-entry-status ${entry.status}">${escapeHtml(entry.status)}</p>
				</div>
				` : ''}
				${entry.details ? `
				<div class="qic-detail-section">
					<h4>Details</h4>
					<pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre>
				</div>
				` : ''}
				${entry.errorCode ? `
				<div class="qic-detail-section">
					<h4>Error Code</h4>
					<p>${escapeHtml(entry.errorCode)}</p>
				</div>
				` : ''}
				${entry.filePath ? `
				<div class="qic-detail-section">
					<h4>File</h4>
					<p><a href="#" class="qic-file-link" data-file="${escapeAttr(entry.filePath)}">${escapeHtml(entry.filePath)}</a></p>
				</div>
				` : ''}
				${entry.conversationId ? `
				<div class="qic-detail-section">
					<h4>Conversation ID</h4>
					<p>${escapeHtml(entry.conversationId)}</p>
				</div>
				` : ''}
			`;

			// Wire file link
			const fileLink = content.querySelector('.qic-file-link');
			if (fileLink) {
				fileLink.addEventListener('click', (e) => {
					e.preventDefault();
					const vscode = window.vscode || window.vscodeApi;
					vscode?.postMessage({
						type: 'open-file',
						payload: { path: fileLink.dataset.file }
					});
				});
			}
		}

		// Focus back button
		requestAnimationFrame(() => {
			detailView.querySelector('[data-action="back"]')?.focus();
		});
	}

	function hideDetail() {
		const detailView = document.getElementById('audit-detail');
		if (detailView) {
			detailView.hidden = true;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Actions
	// ═══════════════════════════════════════════════════════════════════

	function exportLog() {
		const vscode = window.vscode || window.vscodeApi;
		vscode?.postMessage({
			type: 'audit:export',
			payload: { filter: currentFilter }
		});
	}

	function clearLog() {
		// Show confirmation using custom modal or native confirm
		const confirmed = confirm('Are you sure you want to clear the audit log? This cannot be undone.');
		if (confirmed) {
			const vscode = window.vscode || window.vscodeApi;
			vscode?.postMessage({ type: 'audit:clear' });
			entries = [];
			filteredEntries = [];
			totalEntries = 0;
			renderEntries();
			updatePagination();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Listeners
	// ═══════════════════════════════════════════════════════════════════

	function setupEventListeners() {
		if (!viewer) return;

		// Filter chips
		viewer.querySelectorAll('.qic-filter-chip').forEach(chip => {
			chip.addEventListener('click', () => {
				const type = chip.dataset.type;
				if (type === 'all') {
					setFilter(['all']);
				} else {
					setFilter([type]);
				}
			});
		});

		// Search
		const searchInput = document.getElementById('audit-search');
		let searchDebounce = null;
		searchInput?.addEventListener('input', (e) => {
			clearTimeout(searchDebounce);
			searchDebounce = setTimeout(() => {
				setSearchQuery(e.target.value);
			}, 150);
		});

		// Actions (using event delegation)
		viewer.addEventListener('click', (e) => {
			const actionEl = e.target.closest('[data-action]');
			if (!actionEl) return;

			const action = actionEl.dataset.action;
			switch (action) {
				case 'close':
					hide();
					break;
				case 'export':
					exportLog();
					break;
				case 'clear':
					clearLog();
					break;
				case 'back':
					hideDetail();
					break;
				case 'prev':
					if (currentPage > 0) {
						currentPage--;
						loadEntries();
					}
					break;
				case 'next':
					if ((currentPage + 1) * PAGE_SIZE < totalEntries) {
						currentPage++;
						loadEntries();
					}
					break;
			}
		});

		// Keyboard navigation
		viewer.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				const detailView = document.getElementById('audit-detail');
				if (detailView && !detailView.hidden) {
					hideDetail();
				} else {
					hide();
				}
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'audit:entries':
				setEntries(message.payload?.entries, message.payload?.total);
				break;
			case 'audit:entry-added':
				// Real-time update - prepend to list
				if (message.payload) {
					entries.unshift(message.payload);
					totalEntries++;
					applyFilters();
					renderEntries();
					updatePagination();
				}
				break;
			case 'audit:cleared':
				entries = [];
				filteredEntries = [];
				totalEntries = 0;
				renderEntries();
				updatePagination();
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	// Use shared utilities from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;
	const escapeAttr = window.qicUtils.escapeAttr;

	function announce(message) {
		const announcer = document.getElementById('qic-announcer');
		if (announcer) {
			announcer.textContent = message;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicAuditLog = {
		show,
		hide,
		toggle,
		isVisible,
		setEntries,
		handleMessage,
		init,
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
