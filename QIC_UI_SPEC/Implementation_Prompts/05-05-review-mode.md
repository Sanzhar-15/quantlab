# Prompt 05-05: Review Mode

**Phase:** 5 - Changes & Diff
**Dependencies:** 05-02 (Diff View)
**Estimated Effort:** 1.5 sessions
**Critical Path:** No

---

## Objective

Implement a dedicated review mode for stepping through multiple proposed changes sequentially, similar to a code review workflow. Users can navigate between changes, apply/reject each, and see progress through the change set.

---

## Context

When QIC proposes multiple file changes, review mode provides:
- Sequential navigation through changes
- Full diff view for each change
- Progress indicator (3/7 changes reviewed)
- Quick apply/reject/skip actions
- Summary at the end

This is useful for reviewing larger refactors or multi-file changes.

Reference: `QIC_UI_SPEC/Optimal_plan/09-CHANGES-DIFF.md`

---

## Scope

### In Scope
- Create review mode entry command
- Build change navigation system
- Show progress indicator
- Apply/Reject/Skip per change
- Summary view at completion
- Keyboard navigation
- Exit review mode command

### Out of Scope
- Partial apply within a file
- Comments/annotations on changes
- Collaborative review

---

## Pre-Conditions

- [ ] 05-02 complete (Diff View)
- [ ] Change cards working (05-01)
- [ ] Git branch created: `qic-ui/05-05-review-mode`

---

## Tasks

### 1. Create Review Mode Service

```typescript
// src/vs/workbench/contrib/qic/browser/qicReviewService.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IQicStateService, FileChange, ChangeSet } from '../common/state/qicStateService.js';
import { IQicDiffService } from './qicDiffService.js';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { localize } from 'vs/nls';
import { Emitter, Event } from 'vs/base/common/event';

export interface ReviewState {
  isActive: boolean;
  changeSetId: string | null;
  changes: FileChange[];
  currentIndex: number;
  reviewed: Map<string, 'applied' | 'rejected' | 'skipped'>;
}

export interface IQicReviewService {
  readonly onDidChangeState: Event<ReviewState>;
  readonly state: ReviewState;

  startReview(changeSetId: string): Promise<void>;
  nextChange(): Promise<void>;
  previousChange(): Promise<void>;
  applyCurrentChange(): Promise<void>;
  rejectCurrentChange(): Promise<void>;
  skipCurrentChange(): Promise<void>;
  finishReview(): Promise<void>;
  exitReview(): void;
}

export class QicReviewService extends Disposable implements IQicReviewService {
  private readonly onDidChangeStateEmitter = new Emitter<ReviewState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private _state: ReviewState = {
    isActive: false,
    changeSetId: null,
    changes: [],
    currentIndex: 0,
    reviewed: new Map(),
  };

  private readonly inReviewModeKey: IContextKey<boolean>;
  private readonly reviewProgressKey: IContextKey<string>;

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IQicStateService private readonly stateService: IQicStateService,
    @IQicDiffService private readonly diffService: IQicDiffService,
    @INotificationService private readonly notificationService: INotificationService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super();

    this.inReviewModeKey = contextKeyService.createKey('qic.inReviewMode', false);
    this.reviewProgressKey = contextKeyService.createKey('qic.reviewProgress', '');
  }

  get state(): ReviewState {
    return this._state;
  }

  /**
   * Start review mode for a change set
   */
  async startReview(changeSetId: string): Promise<void> {
    const changeSet = this.findChangeSet(changeSetId);
    if (!changeSet) {
      throw new Error(`Change set not found: ${changeSetId}`);
    }

    // Filter to pending changes only
    const pendingChanges = changeSet.changes.filter(c => c.status === 'pending');

    if (pendingChanges.length === 0) {
      this.notificationService.info(
        localize('qic.review.noChanges', 'No pending changes to review.')
      );
      return;
    }

    this._state = {
      isActive: true,
      changeSetId,
      changes: pendingChanges,
      currentIndex: 0,
      reviewed: new Map(),
    };

    this.inReviewModeKey.set(true);
    this.updateProgress();
    this.emitStateChange();

    // Show first change
    await this.showCurrentChange();

    this.notificationService.info(
      localize('qic.review.started', 'Review mode started: {0} changes to review', pendingChanges.length)
    );
  }

  /**
   * Navigate to next change
   */
  async nextChange(): Promise<void> {
    if (!this._state.isActive) return;

    if (this._state.currentIndex < this._state.changes.length - 1) {
      this._state.currentIndex++;
      this.updateProgress();
      this.emitStateChange();
      await this.showCurrentChange();
    } else {
      // At the end - show summary
      await this.showSummary();
    }
  }

  /**
   * Navigate to previous change
   */
  async previousChange(): Promise<void> {
    if (!this._state.isActive) return;

    if (this._state.currentIndex > 0) {
      this._state.currentIndex--;
      this.updateProgress();
      this.emitStateChange();
      await this.showCurrentChange();
    }
  }

  /**
   * Apply current change and move to next
   */
  async applyCurrentChange(): Promise<void> {
    if (!this._state.isActive) return;

    const change = this.getCurrentChange();
    if (!change) return;

    try {
      await this.stateService.applyChange(change.id);
      this._state.reviewed.set(change.id, 'applied');
      await this.nextChange();
    } catch (error) {
      this.notificationService.error(
        localize('qic.review.applyError', 'Failed to apply: {0}', error.message)
      );
    }
  }

  /**
   * Reject current change and move to next
   */
  async rejectCurrentChange(): Promise<void> {
    if (!this._state.isActive) return;

    const change = this.getCurrentChange();
    if (!change) return;

    this.stateService.rejectChange(change.id);
    this._state.reviewed.set(change.id, 'rejected');
    await this.nextChange();
  }

  /**
   * Skip current change and move to next
   */
  async skipCurrentChange(): Promise<void> {
    if (!this._state.isActive) return;

    const change = this.getCurrentChange();
    if (!change) return;

    this._state.reviewed.set(change.id, 'skipped');
    await this.nextChange();
  }

  /**
   * Finish review and apply all remaining pending changes
   */
  async finishReview(): Promise<void> {
    if (!this._state.isActive) return;

    const remaining = this._state.changes.filter(
      c => !this._state.reviewed.has(c.id)
    );

    for (const change of remaining) {
      try {
        await this.stateService.applyChange(change.id);
        this._state.reviewed.set(change.id, 'applied');
      } catch (error) {
        console.error(`Failed to apply ${change.path}:`, error);
      }
    }

    await this.showSummary();
  }

  /**
   * Exit review mode without finishing
   */
  exitReview(): void {
    this._state = {
      isActive: false,
      changeSetId: null,
      changes: [],
      currentIndex: 0,
      reviewed: new Map(),
    };

    this.inReviewModeKey.set(false);
    this.reviewProgressKey.set('');
    this.emitStateChange();
  }

  private getCurrentChange(): FileChange | undefined {
    return this._state.changes[this._state.currentIndex];
  }

  private async showCurrentChange(): Promise<void> {
    const change = this.getCurrentChange();
    if (!change) return;

    await this.diffService.showDiffForChange(change);
  }

  private async showSummary(): Promise<void> {
    const applied = Array.from(this._state.reviewed.values()).filter(s => s === 'applied').length;
    const rejected = Array.from(this._state.reviewed.values()).filter(s => s === 'rejected').length;
    const skipped = Array.from(this._state.reviewed.values()).filter(s => s === 'skipped').length;

    const message = localize(
      'qic.review.summary',
      'Review complete: {0} applied, {1} rejected, {2} skipped',
      applied, rejected, skipped
    );

    this.notificationService.info(message);
    this.exitReview();
  }

  private updateProgress(): void {
    const current = this._state.currentIndex + 1;
    const total = this._state.changes.length;
    this.reviewProgressKey.set(`${current}/${total}`);
  }

  private findChangeSet(id: string): ChangeSet | undefined {
    return this.stateService.state.changeSets?.find(cs => cs.id === id);
  }

  private emitStateChange(): void {
    this.onDidChangeStateEmitter.fire(this._state);
  }
}
```

### 2. Create Review Mode UI

```html
<!-- In chat.template.html - Review Mode Bar -->
<div id="review-mode-bar" class="review-mode-bar hidden">
  <div class="review-mode-progress">
    <span class="review-progress-text">Reviewing: <span id="review-progress-current">1</span> / <span id="review-progress-total">5</span></span>
    <div class="review-progress-bar">
      <div class="review-progress-fill" style="width: 20%"></div>
    </div>
  </div>

  <div class="review-mode-file">
    <span class="codicon codicon-file"></span>
    <span id="review-current-file">src/main.ts</span>
  </div>

  <div class="review-mode-actions">
    <button class="review-btn" id="review-prev" title="Previous (Alt+[)">
      <span class="codicon codicon-chevron-left"></span>
    </button>
    <button class="review-btn apply" id="review-apply" title="Apply (Alt+A)">
      <span class="codicon codicon-check"></span>
      Apply
    </button>
    <button class="review-btn reject" id="review-reject" title="Reject (Alt+R)">
      <span class="codicon codicon-close"></span>
      Reject
    </button>
    <button class="review-btn" id="review-skip" title="Skip (Alt+S)">
      Skip
    </button>
    <button class="review-btn" id="review-next" title="Next (Alt+])">
      <span class="codicon codicon-chevron-right"></span>
    </button>
    <button class="review-btn exit" id="review-exit" title="Exit Review">
      Exit
    </button>
  </div>
</div>
```

```css
/* Review Mode Bar Styles */

.review-mode-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-widget-border);
  position: sticky;
  top: 0;
  z-index: 50;
}

.review-mode-bar.hidden {
  display: none;
}

.review-mode-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.review-progress-text {
  font-size: 12px;
  white-space: nowrap;
}

.review-progress-bar {
  width: 100px;
  height: 4px;
  background: var(--vscode-progressBar-background);
  border-radius: 2px;
  overflow: hidden;
}

.review-progress-fill {
  height: 100%;
  background: var(--vscode-button-background);
  transition: width 0.3s ease;
}

.review-mode-file {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-mode-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.review-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.review-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.review-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.review-btn.apply {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.review-btn.apply:hover {
  background: var(--vscode-button-hoverBackground);
}

.review-btn.reject:hover {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
}

.review-btn.exit {
  margin-left: 8px;
}
```

### 3. Register Review Commands

```typescript
// In qic.contribution.ts

// Start review mode
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.startReview',
      title: localize('qic.startReview', 'QIC: Start Review Mode'),
      category: 'QIC',
    });
  }

  async run(accessor: ServicesAccessor, changeSetId?: string): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    if (changeSetId) {
      await reviewService.startReview(changeSetId);
    }
  }
});

// Review navigation
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewNext',
      title: localize('qic.reviewNext', 'QIC: Next Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.BracketRight,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    await reviewService.nextChange();
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewPrevious',
      title: localize('qic.reviewPrevious', 'QIC: Previous Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.BracketLeft,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    await reviewService.previousChange();
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewApply',
      title: localize('qic.reviewApply', 'QIC: Apply Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.KeyA,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    await reviewService.applyCurrentChange();
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewReject',
      title: localize('qic.reviewReject', 'QIC: Reject Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.KeyR,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    await reviewService.rejectCurrentChange();
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewSkip',
      title: localize('qic.reviewSkip', 'QIC: Skip Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.KeyS,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const reviewService = accessor.get(IQicReviewService);
    await reviewService.skipCurrentChange();
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.reviewExit',
      title: localize('qic.reviewExit', 'QIC: Exit Review Mode'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyCode.Escape,
        when: ContextKeyExpr.equals('qic.inReviewMode', true),
      },
    });
  }

  run(accessor: ServicesAccessor): void {
    const reviewService = accessor.get(IQicReviewService);
    reviewService.exitReview();
  }
});
```

### 4. Wire Review Mode UI

```javascript
// In main.js

class ReviewModeUI {
  constructor(reviewService) {
    this.reviewService = reviewService;
    this.bar = document.getElementById('review-mode-bar');
    this.progressCurrent = document.getElementById('review-progress-current');
    this.progressTotal = document.getElementById('review-progress-total');
    this.progressFill = this.bar?.querySelector('.review-progress-fill');
    this.currentFile = document.getElementById('review-current-file');

    this.setupEventListeners();
  }

  setupEventListeners() {
    document.getElementById('review-prev')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:previous' });
    });

    document.getElementById('review-next')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:next' });
    });

    document.getElementById('review-apply')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:apply' });
    });

    document.getElementById('review-reject')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:reject' });
    });

    document.getElementById('review-skip')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:skip' });
    });

    document.getElementById('review-exit')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'review:exit' });
    });
  }

  update(state) {
    if (!state.isActive) {
      this.bar?.classList.add('hidden');
      return;
    }

    this.bar?.classList.remove('hidden');

    const current = state.currentIndex + 1;
    const total = state.changes.length;

    this.progressCurrent.textContent = current;
    this.progressTotal.textContent = total;

    const percentage = (current / total) * 100;
    this.progressFill.style.width = `${percentage}%`;

    const currentChange = state.changes[state.currentIndex];
    if (currentChange) {
      this.currentFile.textContent = currentChange.path;
    }
  }
}
```

---

## Verification

### Success Criteria
- [ ] Start review from change set header
- [ ] Progress bar shows current/total
- [ ] Current file name displayed
- [ ] Next/Previous navigate changes
- [ ] Apply applies and moves to next
- [ ] Reject rejects and moves to next
- [ ] Skip moves to next without action
- [ ] Keyboard shortcuts work
- [ ] Summary shows at end
- [ ] Exit closes review mode
- [ ] Context keys update correctly

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Start review | Click "Review" on change set | Review mode starts |
| Progress | Check bar | Shows 1/N |
| Next | Alt+] or click Next | Next change shown |
| Previous | Alt+[ or click Prev | Previous shown |
| Apply | Alt+A or click Apply | Applied, next shown |
| Reject | Alt+R or click Reject | Rejected, next shown |
| Skip | Alt+S or click Skip | Skipped, next shown |
| End | Review all | Summary shown |
| Exit | Press Escape or Exit | Mode closed |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/qicReviewService.ts
git checkout src/vs/workbench/contrib/qic/browser/qic.contribution.ts
```

---

## Notes

- Review mode is optional enhancement for bulk changes
- Keyboard-driven workflow for efficiency
- Progress saves reviewed state if exited
- Consider adding batch apply/reject remaining
- Could add review notes/comments in future

