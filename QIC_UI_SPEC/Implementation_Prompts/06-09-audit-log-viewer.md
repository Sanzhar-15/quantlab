# Prompt 06-09: Audit Log Viewer

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement the Audit Log Viewer that displays a filterable log of all QIC actions, including changes made, permissions granted, tools used, checkpoints created, and errors encountered. This is critical for compliance, debugging, and transparency.

---

## Context

From the spec (Section 11):
- Accessed via Menu → "View audit log"
- Filter UI with type toggles
- Entry types: All, Changes, Permissions, Tools, Checkpoints, Errors
- Each entry shows timestamp, action, details, and status
- Expandable entry detail view

This provides users visibility into everything QIC has done.

Reference: `QIC_UI_SPEC/QIC-UI-Specification-v1.4.md` Section 11

---

## Scope

### In Scope
- Audit log viewer panel/modal
- Filter by entry type
- Date range filter
- Entry list with pagination
- Entry detail expansion
- Export functionality
- Clear log option

### Out of Scope
- Audit log storage (backend)
- Log rotation policies
- Log shipping/external systems

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] Audit log service exists in backend
- [ ] Git branch created: `qic-ui/06-09-audit-log`

---

## Tasks

### 1. Define Audit Log Types

```typescript
// src/vs/workbench/contrib/qic/common/types/auditLog.ts

export type AuditEntryType =
    | 'change'
    | 'permission'
    | 'tool'
    | 'checkpoint'
    | 'error'
    | 'conversation'
    | 'context';

export type AuditEntrySeverity = 'info' | 'warning' | 'error';

export interface AuditLogEntry {
    id: string;
    type: AuditEntryType;
    severity: AuditEntrySeverity;
    timestamp: number;
    title: string;
    description: string;
    details?: Record<string, unknown>;

    // Context
    conversationId?: string;
    messageId?: string;
    filePath?: string;

    // Status
    status?: 'success' | 'failed' | 'pending';
    errorCode?: string;
}

export interface AuditLogFilter {
    types: AuditEntryType[];
    severity?: AuditEntrySeverity[];
    dateFrom?: number;
    dateTo?: number;
    searchQuery?: string;
}
```

### 2. Create Audit Log Viewer HTML

```html
<!-- Audit Log Viewer -->
<div id="audit-log-viewer" class="qic-audit-viewer" hidden>
    <div class="qic-audit-header">
        <h2>
            <span class="codicon codicon-list-unordered"></span>
            Audit Log
        </h2>
        <div class="qic-audit-actions">
            <button class="qic-btn icon-btn" data-action="export" title="Export log">
                <span class="codicon codicon-export"></span>
            </button>
            <button class="qic-btn icon-btn" data-action="clear" title="Clear log">
                <span class="codicon codicon-trash"></span>
            </button>
            <button class="qic-btn icon-btn" data-action="close" title="Close">
                <span class="codicon codicon-close"></span>
            </button>
        </div>
    </div>

    <!-- Filters -->
    <div class="qic-audit-filters">
        <div class="qic-filter-chips" role="group" aria-label="Filter by type">
            <button class="qic-filter-chip active" data-type="all">
                All
            </button>
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

    <!-- Entry List -->
    <div class="qic-audit-list" id="audit-entries" role="log" aria-label="Audit log entries">
        <!-- Entries rendered here -->
    </div>

    <!-- Pagination -->
    <div class="qic-audit-pagination" id="audit-pagination">
        <span class="qic-pagination-info">Showing 1-50 of 234</span>
        <div class="qic-pagination-controls">
            <button class="qic-btn icon-btn" data-action="prev" disabled>
                <span class="codicon codicon-chevron-left"></span>
            </button>
            <button class="qic-btn icon-btn" data-action="next">
                <span class="codicon codicon-chevron-right"></span>
            </button>
        </div>
    </div>

    <!-- Entry Detail (overlay) -->
    <div id="audit-detail" class="qic-audit-detail" hidden>
        <div class="qic-detail-header">
            <button class="qic-btn icon-btn" data-action="back">
                <span class="codicon codicon-chevron-left"></span>
            </button>
            <span class="qic-detail-title"></span>
        </div>
        <div class="qic-detail-content">
            <!-- Detail content -->
        </div>
    </div>
</div>

<!-- Entry Template -->
<template id="audit-entry-template">
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
</template>
```

### 3. Add Audit Log Styles

```css
/* ========================================
   Audit Log Viewer Styles
   ======================================== */

.qic-audit-viewer {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    z-index: 50;
}

.qic-audit-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
}

.qic-audit-header h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.qic-audit-actions {
    display: flex;
    gap: 4px;
}

/* Filters */
.qic-audit-filters {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
}

.qic-filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}

.qic-filter-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    border-radius: 16px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
}

.qic-filter-chip:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.qic-filter-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.qic-filter-chip .codicon {
    font-size: 12px;
}

.qic-audit-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
}

.qic-audit-search input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--vscode-input-foreground);
    font-size: 13px;
}

.qic-audit-search input:focus {
    outline: none;
}

.qic-audit-search input::placeholder {
    color: var(--vscode-input-placeholderForeground);
}

/* Entry List */
.qic-audit-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
}

.qic-audit-entry {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    cursor: pointer;
    transition: background-color 0.1s ease;
}

.qic-audit-entry:hover {
    background: var(--vscode-list-hoverBackground);
}

.qic-audit-entry:focus {
    outline: none;
    background: var(--vscode-list-focusBackground);
}

.qic-entry-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-badge-background);
    border-radius: 6px;
    flex-shrink: 0;
}

.qic-audit-entry[data-type="change"] .qic-entry-icon {
    background: var(--qic-accent-primary-muted);
    color: var(--qic-accent-primary);
}

.qic-audit-entry[data-type="permission"] .qic-entry-icon {
    background: var(--qic-status-warning-bg);
    color: var(--qic-status-warning);
}

.qic-audit-entry[data-type="tool"] .qic-entry-icon {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}

.qic-audit-entry[data-type="checkpoint"] .qic-entry-icon {
    background: var(--qic-status-success-bg);
    color: var(--qic-status-success);
}

.qic-audit-entry[data-type="error"] .qic-entry-icon {
    background: var(--qic-status-error-bg);
    color: var(--qic-status-error);
}

.qic-entry-content {
    flex: 1;
    min-width: 0;
}

.qic-entry-title {
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.qic-entry-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.qic-entry-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex-shrink: 0;
}

.qic-entry-time {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.qic-entry-status {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
}

.qic-entry-status.success {
    background: var(--qic-status-success-bg);
    color: var(--qic-status-success);
}

.qic-entry-status.failed {
    background: var(--qic-status-error-bg);
    color: var(--qic-status-error);
}

.qic-entry-status.pending {
    background: var(--qic-status-warning-bg);
    color: var(--qic-status-warning);
}

.qic-entry-expand {
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    opacity: 0;
    transition: opacity 0.1s ease;
}

.qic-audit-entry:hover .qic-entry-expand {
    opacity: 1;
}

/* Pagination */
.qic-audit-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border);
}

.qic-pagination-info {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-pagination-controls {
    display: flex;
    gap: 4px;
}

/* Detail View */
.qic-audit-detail {
    position: absolute;
    inset: 0;
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    z-index: 51;
}

.qic-detail-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
}

.qic-detail-title {
    font-weight: 600;
    font-size: 14px;
}

.qic-detail-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
}

.qic-detail-section {
    margin-bottom: 20px;
}

.qic-detail-section h4 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 8px 0;
}

.qic-detail-section pre {
    padding: 12px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 6px;
    font-size: 12px;
    overflow-x: auto;
}

/* Empty state */
.qic-audit-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
}

.qic-audit-empty .codicon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.5;
}
```

### 4. Create Audit Log Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/auditLogManager.js
// @ts-nocheck
/**
 * QIC Audit Log Manager
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

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let entries = [];
    let filteredEntries = [];
    let currentPage = 0;
    let currentFilter = { types: ['all'] };
    let searchQuery = '';

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const viewer = document.getElementById('audit-log-viewer');
    const entriesList = document.getElementById('audit-entries');
    const detailView = document.getElementById('audit-detail');
    const searchInput = document.getElementById('audit-search');
    const paginationInfo = viewer?.querySelector('.qic-pagination-info');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    function show() {
        if (!viewer) return;
        viewer.hidden = false;
        loadEntries();

        // Announce
        window.QicAnnouncer?.announce('Audit log viewer opened');
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

    // ═══════════════════════════════════════════════════════════════════
    // Data Loading
    // ═══════════════════════════════════════════════════════════════════

    function loadEntries() {
        // Request entries from host
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
        entries = newEntries;
        applyFilters();
        renderEntries();
        updatePagination(total);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Filtering
    // ═══════════════════════════════════════════════════════════════════

    function setFilter(types) {
        currentFilter.types = types;
        currentPage = 0;
        loadEntries();

        // Update UI
        viewer.querySelectorAll('.qic-filter-chip').forEach(chip => {
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
            // Type filter
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
        if (!entriesList) return;

        entriesList.innerHTML = '';

        if (filteredEntries.length === 0) {
            renderEmptyState();
            return;
        }

        const template = document.getElementById('audit-entry-template');

        filteredEntries.forEach(entry => {
            const el = template.content.cloneNode(true).firstElementChild;
            el.dataset.id = entry.id;
            el.dataset.type = entry.type;

            // Icon
            const icon = el.querySelector('.qic-entry-icon .codicon');
            icon.classList.add(TYPE_ICONS[entry.type] || 'codicon-circle');

            // Content
            el.querySelector('.qic-entry-title').textContent = entry.title;
            el.querySelector('.qic-entry-desc').textContent = entry.description;

            // Meta
            el.querySelector('.qic-entry-time').textContent = formatTime(entry.timestamp);

            if (entry.status) {
                const status = el.querySelector('.qic-entry-status');
                status.textContent = entry.status;
                status.classList.add(entry.status);
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

    function renderEmptyState() {
        entriesList.innerHTML = `
            <div class="qic-audit-empty">
                <span class="codicon codicon-list-unordered"></span>
                <p>No audit log entries</p>
                <span>Actions will appear here as you use QIC</span>
            </div>
        `;
    }

    function updatePagination(total) {
        if (!paginationInfo) return;

        const start = currentPage * PAGE_SIZE + 1;
        const end = Math.min(start + PAGE_SIZE - 1, total);
        paginationInfo.textContent = `Showing ${start}-${end} of ${total}`;

        // Update button states
        const prevBtn = viewer.querySelector('[data-action="prev"]');
        const nextBtn = viewer.querySelector('[data-action="next"]');

        if (prevBtn) prevBtn.disabled = currentPage === 0;
        if (nextBtn) nextBtn.disabled = end >= total;
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
        if (!detailView) return;

        detailView.hidden = false;

        const title = detailView.querySelector('.qic-detail-title');
        const content = detailView.querySelector('.qic-detail-content');

        title.textContent = entry.title;

        content.innerHTML = `
            <div class="qic-detail-section">
                <h4>Type</h4>
                <p>${entry.type}</p>
            </div>
            <div class="qic-detail-section">
                <h4>Timestamp</h4>
                <p>${new Date(entry.timestamp).toLocaleString()}</p>
            </div>
            <div class="qic-detail-section">
                <h4>Description</h4>
                <p>${entry.description}</p>
            </div>
            ${entry.details ? `
            <div class="qic-detail-section">
                <h4>Details</h4>
                <pre>${JSON.stringify(entry.details, null, 2)}</pre>
            </div>
            ` : ''}
            ${entry.errorCode ? `
            <div class="qic-detail-section">
                <h4>Error Code</h4>
                <p>${entry.errorCode}</p>
            </div>
            ` : ''}
            ${entry.filePath ? `
            <div class="qic-detail-section">
                <h4>File</h4>
                <p><a href="#" data-file="${entry.filePath}">${entry.filePath}</a></p>
            </div>
            ` : ''}
        `;

        // Focus back button
        detailView.querySelector('[data-action="back"]')?.focus();
    }

    function hideDetail() {
        if (detailView) {
            detailView.hidden = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Actions
    // ═══════════════════════════════════════════════════════════════════

    function exportLog() {
        vscode.postMessage({
            type: 'audit:export',
            payload: { filter: currentFilter }
        });
    }

    function clearLog() {
        // Confirm before clearing
        if (confirm('Are you sure you want to clear the audit log? This cannot be undone.')) {
            vscode.postMessage({ type: 'audit:clear' });
            entries = [];
            filteredEntries = [];
            renderEntries();
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
        searchInput?.addEventListener('input', (e) => {
            setSearchQuery(e.target.value);
        });

        // Actions
        viewer.querySelectorAll('[data-action]').forEach(el => {
            el.addEventListener('click', () => {
                switch (el.dataset.action) {
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
                        currentPage++;
                        loadEntries();
                        break;
                }
            });
        });

        // Keyboard
        viewer.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!detailView?.hidden) {
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
                setEntries(message.payload.entries, message.payload.total);
                break;
            case 'audit:entry-added':
                // Real-time update
                entries.unshift(message.payload);
                applyFilters();
                renderEntries();
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicAuditLog = {
        show,
        hide,
        toggle,
        setEntries,
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
```

### 5. Register Command

```typescript
// Register audit log command
CommandsRegistry.registerCommand('qic.showAuditLog', async (accessor) => {
    const panelService = accessor.get(IQicPanelService);
    panelService.postMessage({ type: 'show-audit-log' });
});

// Add to menu
MenuRegistry.appendMenuItem(MenuId.QicMenu, {
    command: {
        id: 'qic.showAuditLog',
        title: localize('qic.auditLog', 'View Audit Log'),
    },
    group: '2_view',
    order: 3,
});
```

---

## Verification

### Success Criteria
- [ ] Audit log viewer opens from menu
- [ ] All entry types displayed correctly
- [ ] Filter chips work
- [ ] Search filters entries
- [ ] Pagination works
- [ ] Entry detail view works
- [ ] Export functionality works
- [ ] Clear log works with confirmation
- [ ] Real-time updates appear
- [ ] Accessible with keyboard

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Open viewer | Menu → View Audit Log | Viewer opens |
| Filter changes | Click "Changes" chip | Only changes shown |
| Filter errors | Click "Errors" chip | Only errors shown |
| Search | Type in search box | Filtered results |
| View detail | Click entry | Detail view opens |
| Export | Click export | File saved |
| Clear | Click clear, confirm | Log cleared |
| Pagination | Navigate pages | Correct entries shown |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/auditLogManager.js
```

---

## Notes

- Entries are paginated for performance
- Real-time updates prepend to list
- Export creates JSON or CSV file
- Clear requires confirmation
- Consider adding date range filter
- Consider adding entry retention policy
