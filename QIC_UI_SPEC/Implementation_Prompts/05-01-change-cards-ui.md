# Prompt 05-01: Change Cards UI

**Phase:** 5 - Changes & Diff
**Dependencies:** Phase 4 Complete
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement the change cards UI that displays proposed file changes from the LLM agent. Each change card shows the affected file, change type (create/modify/delete), and provides actions to view diff, apply, or reject changes.

---

## Context

When QIC proposes changes to files, the UI needs to clearly present:
- Which files are affected
- What type of change (new file, modification, deletion)
- Preview of the change
- Actions to accept/reject individually or in bulk
- Status of each change (pending, applied, rejected)

Change cards appear in the conversation flow as part of agent responses and can also be viewed in a dedicated changes panel.

Reference: `QIC_UI_SPEC/Optimal_plan/09-CHANGES-DIFF.md`

---

## Scope

### In Scope
- Create change card HTML/CSS component
- Display change type with appropriate icons
- Show file path and change summary
- Implement expand/collapse for change preview
- Add Apply/Reject action buttons
- Support bulk Apply All / Reject All
- Track change status (pending/applied/rejected)
- Render changes in conversation flow
- Handle multiple changes per response

### Out of Scope
- Diff view implementation (05-02)
- Approval flow modal (05-03)
- CodeLens integration (05-04)
- Undo/rollback of applied changes

---

## Pre-Conditions

- [ ] Phase 4 complete
- [ ] Conversation rendering works (02-03)
- [ ] Git branch created: `qic-ui/05-01-change-cards`

---

## Tasks

### 1. Define Change Types

```typescript
// src/vs/workbench/contrib/qic/common/types/changes.ts

export type ChangeType = 'create' | 'modify' | 'delete' | 'rename';

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict';

export interface FileChange {
  id: string;
  type: ChangeType;
  path: string;
  newPath?: string;  // For renames

  // Content
  originalContent?: string;
  newContent?: string;

  // Diff info
  additions: number;
  deletions: number;
  hunks?: DiffHunk[];

  // Status
  status: ChangeStatus;
  statusMessage?: string;

  // Metadata
  description?: string;
  timestamp: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface ChangeSet {
  id: string;
  messageId: string;
  changes: FileChange[];
  status: 'pending' | 'partial' | 'applied' | 'rejected';
  timestamp: number;
  description?: string;
}
```

### 2. Add Change Card HTML Structure

In `chat.template.html`, add change card template:

```html
<!-- Change Card Template (in message content) -->
<template id="change-card-template">
  <div class="change-card" data-change-id="" data-status="pending">
    <!-- Header -->
    <div class="change-card-header">
      <div class="change-card-icon">
        <span class="codicon"></span>
      </div>
      <div class="change-card-info">
        <div class="change-card-path"></div>
        <div class="change-card-meta">
          <span class="change-type-badge"></span>
          <span class="change-stats"></span>
        </div>
      </div>
      <div class="change-card-actions">
        <button class="change-action-btn view-diff" title="View Diff">
          <span class="codicon codicon-diff"></span>
        </button>
        <button class="change-action-btn apply" title="Apply Change">
          <span class="codicon codicon-check"></span>
        </button>
        <button class="change-action-btn reject" title="Reject Change">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </div>

    <!-- Expandable Preview -->
    <div class="change-card-preview collapsed">
      <div class="change-card-preview-header">
        <button class="preview-toggle">
          <span class="codicon codicon-chevron-right"></span>
          <span class="preview-label">Preview changes</span>
        </button>
      </div>
      <div class="change-card-preview-content">
        <pre class="change-preview-code"></pre>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="change-card-status">
      <span class="status-icon codicon"></span>
      <span class="status-text"></span>
    </div>
  </div>
</template>

<!-- Change Set Container Template -->
<template id="change-set-template">
  <div class="change-set" data-set-id="">
    <div class="change-set-header">
      <div class="change-set-title">
        <span class="codicon codicon-edit"></span>
        <span class="change-set-count"></span>
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
    <div class="change-set-cards">
      <!-- Individual change cards inserted here -->
    </div>
  </div>
</template>
```

### 3. Add Change Card CSS

In `chat.css`:

```css
/* ========================================
   Change Set Container
   ======================================== */

.change-set {
  margin: 12px 0;
  border: 1px solid var(--vscode-widget-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.change-set-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-widget-border);
}

.change-set-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  font-size: 13px;
}

.change-set-actions {
  display: flex;
  gap: 8px;
}

.change-set-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.change-set-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.change-set-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.change-set-btn.apply-all {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.change-set-btn.apply-all:hover {
  background: var(--vscode-button-hoverBackground);
}

.change-set-cards {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ========================================
   Individual Change Card
   ======================================== */

.change-card {
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  background: var(--vscode-editor-background);
  overflow: hidden;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.change-card:hover {
  border-color: var(--vscode-focusBorder);
}

.change-card:focus-within {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

/* Status variants */
.change-card[data-status="applied"] {
  border-color: var(--vscode-gitDecoration-addedResourceForeground);
  background: rgba(var(--vscode-gitDecoration-addedResourceForeground-rgb), 0.05);
}

.change-card[data-status="rejected"] {
  border-color: var(--vscode-gitDecoration-deletedResourceForeground);
  opacity: 0.6;
}

.change-card[data-status="conflict"] {
  border-color: var(--vscode-editorWarning-foreground);
  background: rgba(var(--vscode-editorWarning-foreground-rgb), 0.05);
}

/* ========================================
   Change Card Header
   ======================================== */

.change-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
}

.change-card-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 16px;
}

/* Icon backgrounds by change type */
.change-card[data-type="create"] .change-card-icon {
  background: rgba(var(--vscode-gitDecoration-addedResourceForeground-rgb), 0.2);
  color: var(--vscode-gitDecoration-addedResourceForeground);
}

.change-card[data-type="modify"] .change-card-icon {
  background: rgba(var(--vscode-gitDecoration-modifiedResourceForeground-rgb), 0.2);
  color: var(--vscode-gitDecoration-modifiedResourceForeground);
}

.change-card[data-type="delete"] .change-card-icon {
  background: rgba(var(--vscode-gitDecoration-deletedResourceForeground-rgb), 0.2);
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.change-card[data-type="rename"] .change-card-icon {
  background: rgba(var(--vscode-gitDecoration-renamedResourceForeground-rgb), 0.2);
  color: var(--vscode-gitDecoration-renamedResourceForeground);
}

.change-card-info {
  flex: 1;
  min-width: 0;
}

.change-card-path {
  font-weight: 500;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.change-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.change-type-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  font-weight: 500;
}

.change-card[data-type="create"] .change-type-badge {
  background: var(--vscode-gitDecoration-addedResourceForeground);
  color: var(--vscode-editor-background);
}

.change-card[data-type="modify"] .change-type-badge {
  background: var(--vscode-gitDecoration-modifiedResourceForeground);
  color: var(--vscode-editor-background);
}

.change-card[data-type="delete"] .change-type-badge {
  background: var(--vscode-gitDecoration-deletedResourceForeground);
  color: var(--vscode-editor-background);
}

.change-card[data-type="rename"] .change-type-badge {
  background: var(--vscode-gitDecoration-renamedResourceForeground);
  color: var(--vscode-editor-background);
}

.change-stats {
  display: flex;
  gap: 6px;
}

.change-stats .additions {
  color: var(--vscode-gitDecoration-addedResourceForeground);
}

.change-stats .deletions {
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}

/* ========================================
   Change Card Actions
   ======================================== */

.change-card-actions {
  display: flex;
  gap: 4px;
}

.change-action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-button-secondaryBackground);
  border: none;
  border-radius: 4px;
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.change-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.change-action-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: -2px;
}

.change-action-btn.apply {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.change-action-btn.apply:hover {
  background: var(--vscode-button-hoverBackground);
}

.change-action-btn.reject:hover {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
}

/* Disabled state for processed changes */
.change-card[data-status="applied"] .change-card-actions,
.change-card[data-status="rejected"] .change-card-actions {
  display: none;
}

/* ========================================
   Change Card Preview
   ======================================== */

.change-card-preview {
  border-top: 1px solid var(--vscode-widget-border);
}

.change-card-preview.collapsed .change-card-preview-content {
  display: none;
}

.change-card-preview-header {
  padding: 6px 12px;
}

.preview-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 12px;
}

.preview-toggle:hover {
  text-decoration: underline;
}

.preview-toggle .codicon {
  transition: transform 0.2s ease;
}

.change-card-preview:not(.collapsed) .preview-toggle .codicon {
  transform: rotate(90deg);
}

.change-card-preview-content {
  max-height: 300px;
  overflow: auto;
  background: var(--vscode-textCodeBlock-background);
}

.change-preview-code {
  margin: 0;
  padding: 12px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  color: var(--vscode-editor-foreground);
}

/* Diff highlighting in preview */
.change-preview-code .diff-add {
  background: rgba(var(--vscode-gitDecoration-addedResourceForeground-rgb), 0.2);
  display: block;
}

.change-preview-code .diff-del {
  background: rgba(var(--vscode-gitDecoration-deletedResourceForeground-rgb), 0.2);
  display: block;
}

.change-preview-code .diff-context {
  display: block;
}

/* ========================================
   Change Card Status
   ======================================== */

.change-card-status {
  display: none;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  border-top: 1px solid var(--vscode-widget-border);
}

.change-card[data-status="applied"] .change-card-status,
.change-card[data-status="rejected"] .change-card-status,
.change-card[data-status="conflict"] .change-card-status {
  display: flex;
}

.change-card[data-status="applied"] .change-card-status {
  color: var(--vscode-gitDecoration-addedResourceForeground);
}

.change-card[data-status="applied"] .change-card-status .status-icon::before {
  content: "\eab2"; /* check */
}

.change-card[data-status="rejected"] .change-card-status {
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.change-card[data-status="rejected"] .change-card-status .status-icon::before {
  content: "\eb98"; /* close */
}

.change-card[data-status="conflict"] .change-card-status {
  color: var(--vscode-editorWarning-foreground);
}

.change-card[data-status="conflict"] .change-card-status .status-icon::before {
  content: "\ea6c"; /* warning */
}
```

### 4. Implement Change Cards Manager

In `main.js`:

```javascript
// ========================================
// Change Cards Manager
// ========================================

class ChangeCardsManager {
  constructor() {
    this.changeSets = new Map(); // setId -> ChangeSet
    this.changeCardTemplate = document.getElementById('change-card-template');
    this.changeSetTemplate = document.getElementById('change-set-template');

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Delegate events for change cards
    document.addEventListener('click', (e) => {
      // View diff
      if (e.target.closest('.change-action-btn.view-diff')) {
        const card = e.target.closest('.change-card');
        this.viewDiff(card.dataset.changeId);
        return;
      }

      // Apply single
      if (e.target.closest('.change-action-btn.apply')) {
        const card = e.target.closest('.change-card');
        this.applyChange(card.dataset.changeId);
        return;
      }

      // Reject single
      if (e.target.closest('.change-action-btn.reject')) {
        const card = e.target.closest('.change-card');
        this.rejectChange(card.dataset.changeId);
        return;
      }

      // Apply all
      if (e.target.closest('.change-set-btn.apply-all')) {
        const set = e.target.closest('.change-set');
        this.applyAll(set.dataset.setId);
        return;
      }

      // Reject all
      if (e.target.closest('.change-set-btn.reject-all')) {
        const set = e.target.closest('.change-set');
        this.rejectAll(set.dataset.setId);
        return;
      }

      // Toggle preview
      if (e.target.closest('.preview-toggle')) {
        const preview = e.target.closest('.change-card-preview');
        preview.classList.toggle('collapsed');
        return;
      }
    });
  }

  /**
   * Render a change set in the conversation
   */
  renderChangeSet(changeSet, container) {
    this.changeSets.set(changeSet.id, changeSet);

    const setEl = this.changeSetTemplate.content.cloneNode(true);
    const setDiv = setEl.querySelector('.change-set');

    setDiv.dataset.setId = changeSet.id;

    // Update header
    const countEl = setDiv.querySelector('.change-set-count');
    countEl.textContent = `${changeSet.changes.length} file${changeSet.changes.length !== 1 ? 's' : ''} changed`;

    // Render individual cards
    const cardsContainer = setDiv.querySelector('.change-set-cards');
    for (const change of changeSet.changes) {
      const cardEl = this.renderChangeCard(change);
      cardsContainer.appendChild(cardEl);
    }

    container.appendChild(setDiv);
    return setDiv;
  }

  /**
   * Render a single change card
   */
  renderChangeCard(change) {
    const cardEl = this.changeCardTemplate.content.cloneNode(true);
    const card = cardEl.querySelector('.change-card');

    card.dataset.changeId = change.id;
    card.dataset.type = change.type;
    card.dataset.status = change.status;

    // Icon
    const icon = card.querySelector('.change-card-icon .codicon');
    icon.className = `codicon ${this.getChangeIcon(change.type)}`;

    // Path
    const pathEl = card.querySelector('.change-card-path');
    if (change.type === 'rename' && change.newPath) {
      pathEl.textContent = `${change.path} → ${change.newPath}`;
    } else {
      pathEl.textContent = change.path;
    }

    // Type badge
    const badge = card.querySelector('.change-type-badge');
    badge.textContent = this.getChangeTypeLabel(change.type);

    // Stats
    const stats = card.querySelector('.change-stats');
    stats.innerHTML = `
      <span class="additions">+${change.additions}</span>
      <span class="deletions">-${change.deletions}</span>
    `;

    // Preview content
    const previewCode = card.querySelector('.change-preview-code');
    previewCode.innerHTML = this.formatPreview(change);

    // Status
    if (change.status !== 'pending') {
      this.updateCardStatus(card, change.status, change.statusMessage);
    }

    return card;
  }

  /**
   * Get icon for change type
   */
  getChangeIcon(type) {
    const icons = {
      create: 'codicon-new-file',
      modify: 'codicon-edit',
      delete: 'codicon-trash',
      rename: 'codicon-file-symlink-file',
    };
    return icons[type] || 'codicon-file';
  }

  /**
   * Get label for change type
   */
  getChangeTypeLabel(type) {
    const labels = {
      create: 'New',
      modify: 'Modified',
      delete: 'Deleted',
      rename: 'Renamed',
    };
    return labels[type] || type;
  }

  /**
   * Format preview content with diff highlighting
   */
  formatPreview(change) {
    if (!change.hunks || change.hunks.length === 0) {
      // Show new content for create, or summary for delete
      if (change.type === 'create' && change.newContent) {
        return this.escapeHtml(change.newContent.substring(0, 1000));
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
          return `<span class="diff-add">${this.escapeHtml(line)}</span>`;
        }
        if (line.startsWith('-')) {
          return `<span class="diff-del">${this.escapeHtml(line)}</span>`;
        }
        return `<span class="diff-context">${this.escapeHtml(line)}</span>`;
      }).join('');
    }).join('\n');
  }

  /**
   * View diff in editor
   */
  viewDiff(changeId) {
    vscode.postMessage({
      type: 'change:viewDiff',
      changeId
    });
  }

  /**
   * Apply a single change
   */
  async applyChange(changeId) {
    const card = document.querySelector(`[data-change-id="${changeId}"]`);
    if (!card || card.dataset.status !== 'pending') return;

    // Optimistic update
    this.updateCardStatus(card, 'applying', 'Applying...');

    vscode.postMessage({
      type: 'change:apply',
      changeId
    });
  }

  /**
   * Reject a single change
   */
  rejectChange(changeId) {
    const card = document.querySelector(`[data-change-id="${changeId}"]`);
    if (!card || card.dataset.status !== 'pending') return;

    this.updateCardStatus(card, 'rejected', 'Rejected');

    vscode.postMessage({
      type: 'change:reject',
      changeId
    });
  }

  /**
   * Apply all changes in a set
   */
  applyAll(setId) {
    const changeSet = this.changeSets.get(setId);
    if (!changeSet) return;

    const pendingChanges = changeSet.changes.filter(c => c.status === 'pending');
    for (const change of pendingChanges) {
      this.applyChange(change.id);
    }
  }

  /**
   * Reject all changes in a set
   */
  rejectAll(setId) {
    const changeSet = this.changeSets.get(setId);
    if (!changeSet) return;

    const pendingChanges = changeSet.changes.filter(c => c.status === 'pending');
    for (const change of pendingChanges) {
      this.rejectChange(change.id);
    }
  }

  /**
   * Update card status
   */
  updateCardStatus(card, status, message) {
    card.dataset.status = status;

    const statusText = card.querySelector('.status-text');
    if (statusText) {
      statusText.textContent = message || this.getStatusMessage(status);
    }

    // Update the change set status if all cards processed
    const setEl = card.closest('.change-set');
    if (setEl) {
      this.updateSetStatus(setEl);
    }
  }

  /**
   * Update change set status
   */
  updateSetStatus(setEl) {
    const cards = setEl.querySelectorAll('.change-card');
    const statuses = Array.from(cards).map(c => c.dataset.status);

    const allApplied = statuses.every(s => s === 'applied');
    const allRejected = statuses.every(s => s === 'rejected');
    const allProcessed = statuses.every(s => s !== 'pending');

    // Hide bulk actions if all processed
    const bulkActions = setEl.querySelector('.change-set-actions');
    if (allProcessed && bulkActions) {
      bulkActions.style.display = 'none';
    }
  }

  /**
   * Get default status message
   */
  getStatusMessage(status) {
    const messages = {
      applied: 'Applied successfully',
      rejected: 'Change rejected',
      conflict: 'Conflict detected',
    };
    return messages[status] || '';
  }

  /**
   * Handle messages from extension
   */
  handleMessage(message) {
    switch (message.type) {
      case 'change:statusUpdate':
        const card = document.querySelector(`[data-change-id="${message.changeId}"]`);
        if (card) {
          this.updateCardStatus(card, message.status, message.message);
        }
        break;

      case 'change:setData':
        // Render new change set (called from message renderer)
        break;
    }
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

// Initialize
let changeCardsManager;
document.addEventListener('DOMContentLoaded', () => {
  changeCardsManager = new ChangeCardsManager();
});
```

### 5. Integrate with Message Renderer

Update the message renderer to handle change sets:

```javascript
// In MessageManager or conversation renderer

renderAssistantMessage(message) {
  // ... existing rendering ...

  // Check for change sets in message
  if (message.changeSets && message.changeSets.length > 0) {
    for (const changeSet of message.changeSets) {
      changeCardsManager.renderChangeSet(changeSet, messageContentEl);
    }
  }
}
```

### 6. Add Extension Handlers

In `qicPanel.ts`:

```typescript
case 'change:viewDiff':
  this.handleViewDiff(message.changeId);
  return;

case 'change:apply':
  this.handleApplyChange(message.changeId);
  return;

case 'change:reject':
  this.handleRejectChange(message.changeId);
  return;

private async handleViewDiff(changeId: string): Promise<void> {
  // TODO: 05-02 - Open diff view
  vscode.commands.executeCommand('qic.showDiff', changeId);
}

private async handleApplyChange(changeId: string): Promise<void> {
  try {
    await this.changeManager.applyChange(changeId);
    this.postMessage({
      type: 'change:statusUpdate',
      changeId,
      status: 'applied',
      message: 'Applied successfully'
    });
  } catch (error) {
    this.postMessage({
      type: 'change:statusUpdate',
      changeId,
      status: 'conflict',
      message: error.message
    });
  }
}

private async handleRejectChange(changeId: string): Promise<void> {
  this.changeManager.rejectChange(changeId);
  this.postMessage({
    type: 'change:statusUpdate',
    changeId,
    status: 'rejected',
    message: 'Rejected'
  });
}
```

---

## Verification

### Success Criteria
- [ ] Change cards render in messages
- [ ] Create/modify/delete/rename types display correctly
- [ ] Correct icons and colors per type
- [ ] File path displays
- [ ] Addition/deletion stats show
- [ ] Preview expands/collapses
- [ ] View Diff button triggers diff
- [ ] Apply button applies change
- [ ] Reject button rejects change
- [ ] Status updates after action
- [ ] Applied cards show success state
- [ ] Rejected cards show rejected state
- [ ] Apply All works for set
- [ ] Reject All works for set
- [ ] Bulk actions hide after all processed

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| New file card | Agent creates file | Green "New" badge |
| Modified card | Agent modifies file | Blue "Modified" badge |
| Delete card | Agent deletes file | Red "Deleted" badge |
| Rename card | Agent renames file | Purple "Renamed" badge |
| Expand preview | Click preview toggle | Preview shows |
| View diff | Click diff button | Diff opens |
| Apply single | Click apply | Status → applied |
| Reject single | Click reject | Status → rejected |
| Apply all | Click Apply All | All applied |
| Reject all | Click Reject All | All rejected |
| Conflict | Apply to modified file | Conflict status |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.template.html
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
git checkout src/vs/workbench/contrib/qic/browser/media/main.js
```

---

## Notes

- Change cards should match VS Code's git decoration colors
- Stats (+/-) follow GitHub's diff style
- Preview truncates at 1000 chars for performance
- Conflict detection happens on apply, not on receive
- Consider adding undo for applied changes in future
- Applied changes create checkpoints automatically

