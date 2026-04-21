# QIC UI Implementation Prompts - Index

**Purpose:** Ordered, atomic prompts for implementing the QIC UI spec v1.4

---

## Execution Strategy

### Prompt Design Principles

1. **Atomic Completeness**: Each prompt produces a working, testable increment
2. **Clear Boundaries**: Explicit in-scope and out-of-scope items
3. **Dependency Tracking**: Prerequisites clearly stated
4. **Verification Steps**: Concrete acceptance criteria
5. **Rollback Strategy**: How to undo if issues arise
6. **Context Sufficiency**: All necessary background included

### Numbering Scheme

```
[Phase]-[Sequence]-[name].md

Phase 0: Cleanup           (00-XX)
Phase 1: Foundation        (01-XX)
Phase 2: Panel             (02-XX)
Phase 3: Native Integration (03-XX)
Phase 4: Context           (04-XX)
Phase 5: Changes           (05-XX)
Phase 6: Polish            (06-XX)
```

---

## Prompt Sequence

### Phase 0: Cleanup (Estimated: 3-4 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 00-01 | `00-01-dead-code-audit.md` | None | Yes |
| 00-02 | `00-02-remove-dead-html.md` | 00-01 | Yes |
| 00-03 | `00-03-remove-dead-javascript.md` | 00-02 | Yes |
| 00-04 | `00-04-remove-dead-css.md` | 00-03 | No |
| 00-05 | `00-05-fix-status-bar-persistence.md` | 00-01 | Yes |
| 00-06 | `00-06-cleanup-verification.md` | 00-02..05 | Yes |

### Phase 1: Foundation (Estimated: 5-6 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 01-01 | `01-01-state-service-interfaces.md` | Phase 0 | Yes |
| 01-02 | `01-02-state-service-implementation.md` | 01-01 | Yes |
| 01-03 | `01-03-protocol-v2-types.md` | 01-01 | Yes |
| 01-04 | `01-04-message-bridge.md` | 01-02, 01-03 | Yes |
| 01-05 | `01-05-webview-state-manager.md` | 01-03 | Yes |
| 01-06 | `01-06-service-registration.md` | 01-02, 01-04 | Yes |
| 01-07 | `01-07-foundation-verification.md` | 01-01..06 | Yes |

### Phase 2: Panel Structure (Estimated: 10-12 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 02-01 | `02-01-header-html-css.md` | Phase 1 | Yes |
| 02-02 | `02-02-header-javascript.md` | 02-01 | Yes |
| 02-03 | `02-03-conversation-structure.md` | 02-01 | Yes |
| 02-04 | `02-04-streaming-implementation.md` | 02-03, 01-05 | Yes |
| 02-05 | `02-05-input-area.md` | 02-01 | Yes |
| 02-06 | `02-06-input-lockout.md` | 02-05, 01-05 | Yes |
| 02-07 | `02-07-empty-state.md` | 02-03 | No |
| 02-08 | `02-08-panel-integration.md` | 02-01..07 | Yes |
| 02-09 | `02-09-panel-verification.md` | 02-08 | Yes |
| 02-10 | `02-10-first-run-experience.md` | 02-08 | Yes |
| 02-11 | `02-11-conversation-save-state.md` *(GAP-08 FIX)* | 02-08 | Yes |

### Phase 3: Native Integration (Estimated: 8-9 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 03-01 | `03-01-quick-pick-infrastructure.md` | Phase 2 | Yes |
| 03-02 | `03-02-history-quick-pick.md` | 03-01 | Yes |
| 03-03 | `03-03-checkpoints-quick-pick.md` | 03-01 | Yes |
| 03-04 | `03-04-provider-quick-pick.md` *(amended: BYOK)* | 03-01 | No |
| 03-05 | `03-05-status-bar-update.md` | Phase 2 | Yes |
| 03-06 | `03-06-remove-floating-panels.md` | 03-02, 03-03 | Yes |
| 03-07 | `03-07-native-verification.md` | 03-01..06 | Yes |
| 03-08 | `03-08-status-quota-quick-picks.md` | 03-01, 03-05 | Yes |
| 03-09 | `03-09-permission-dialog-flow.md` | 03-01 | Yes |

### Phase 4: Context System (Estimated: 6-7 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 04-01 | `04-01-context-chips-ui.md` | Phase 3 | Yes |
| 04-02 | `04-02-context-drawer.md` *(amended: GAP-11 lane budgets)* | 04-01 | Yes |
| 04-03 | `04-03-mention-autocomplete.md` | 04-01 | Yes |
| 04-04 | `04-04-context-state-integration.md` | 04-01..03 | Yes |
| 04-05 | `04-05-context-verification.md` | 04-01..04 | Yes |

### Phase 5: Changes & Diff (Estimated: 8-9 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 05-01 | `05-01-change-cards-ui.md` | Phase 4 | Yes |
| 05-02 | `05-02-diff-view.md` | 05-01 | Yes |
| 05-03 | `05-03-approval-flow.md` | 05-01 | Yes |
| 05-04 | `05-04-codelens-integration.md` | 05-02 | No |
| 05-05 | `05-05-review-mode.md` | 05-02 | No |
| 05-06 | `05-06-changes-verification.md` | 05-01..05 | Yes |
| 05-07 | `05-07-strategy-warning.md` | 05-03 | Yes |

### Phase 6: Polish (Estimated: 10-12 sessions)

| Prompt | File | Dependencies | Critical |
|--------|------|--------------|----------|
| 06-01 | `06-01-accessibility-audit.md` | Phase 5 | Yes |
| 06-02 | `06-02-accessibility-fixes.md` *(amended: GAP-15 design tokens)* | 06-01 | Yes |
| 06-03 | `06-03-error-display.md` *(amended: GAP-07 error codes)* | Phase 5 | Yes |
| 06-04 | `06-04-animation-polish.md` | Phase 5 | No |
| 06-05 | `06-05-edge-cases.md` | Phase 5 | Yes |
| 06-06 | `06-06-final-verification.md` | 06-01..05 | Yes |
| 06-07 | `06-07-legacy-cleanup.md` | 06-06 | Yes |
| 06-08 | `06-08-help-modal.md` | Phase 5 | No |
| 06-09 | `06-09-audit-log-viewer.md` | Phase 5 | Yes |
| 06-10 | `06-10-cancel-and-timeout.md` | 02-06 | Yes |
| 06-11 | `06-11-lane-and-feedback.md` | Phase 5 | Yes |
| 06-12 | `06-12-summarization-notification.md` *(GAP-09 FIX)* | Phase 5 | Yes |

---

## Execution Guidelines

### Before Starting a Prompt

1. Read the prompt completely
2. Verify all dependencies are complete
3. Create a git branch: `git checkout -b qic-ui/[prompt-id]`
4. Ensure tests are passing

### During Execution

1. Follow the prompt's scope strictly
2. Do NOT implement out-of-scope items
3. Add comments for deferred items: `// TODO: [prompt-id] - description`
4. Test incrementally

### After Completion

1. Run all verification steps
2. Update any referenced files
3. Create PR with prompt ID in title
4. Mark prompt as complete in this index

---

## Progress Tracking

| Phase | Status | Prompts Created | Prompts Planned |
|-------|--------|-----------------|-----------------|
| 0: Cleanup | **Ready** | 6 | 6 |
| 1: Foundation | **Ready** | 7 | 7 |
| 2: Panel | **Ready** | 11 | 11 |
| 3: Native | **Ready** | 9 | 9 |
| 4: Context | **Ready** | 5 | 5 |
| 5: Changes | **Ready** | 7 | 7 |
| 6: Polish | **Ready** | 12 | 12 |
| **Total** | **Complete** | **57** | **57** |

### Amendments Applied
- `03-04-provider-quick-pick.md` - Added BYOK (Bring Your Own Key) support
- `03-05-status-bar-update.md` - Added code completion status indicator
- `04-02-context-drawer.md` - Added GAP-11 lane-specific token budgets
- `06-02-accessibility-fixes.md` - Added GAP-15 visual design tokens (focus ring, selection, syntax highlighting)
- `06-03-error-display.md` - Added GAP-07 comprehensive error code mapping (24+ codes)

### Key Prompts Created (57 total)

**Phase 0 - Complete (6/6):**
- `00-01-dead-code-audit.md`
- `00-02-remove-dead-html.md`
- `00-03-remove-dead-javascript.md`
- `00-04-remove-dead-css.md`
- `00-05-fix-status-bar-persistence.md`
- `00-06-cleanup-verification.md`

**Phase 1 - Complete (7/7):**
- `01-01-state-service-interfaces.md`
- `01-02-state-service-implementation.md`
- `01-03-protocol-v2-types.md`
- `01-04-message-bridge.md`
- `01-05-webview-state-manager.md`
- `01-06-service-registration.md`
- `01-07-foundation-verification.md`

**Phase 2 - Complete (11/11):**
- `02-01-header-html-css.md`
- `02-02-header-javascript.md` - Header interactivity, menu dropdown
- `02-03-conversation-structure.md` - Message rendering, tool calls, file refs
- `02-04-streaming-implementation.md` (GAP-03 FIX) - Token buffering
- `02-05-input-area.md` - Auto-resize, keyboard shortcuts
- `02-06-input-lockout.md` (GAP-17 FIX) - Concurrent request prevention
- `02-07-empty-state.md` - Welcome UI, quick actions
- `02-08-panel-integration.md` - Full panel wiring, GAP-16 FIX
- `02-09-panel-verification.md` - Comprehensive testing checklist
- `02-10-first-run-experience.md` **[NEW]** - First-run onboarding wizard with provider selection, consent, privacy tiers
- `02-11-conversation-save-state.md` **[NEW]** (GAP-08 FIX) - Conversation persistence UX with save indicator, auto-save, unsaved warning

**Phase 3 - Complete (9/9):**
- `03-01-quick-pick-infrastructure.md` - Quick Pick base, menu system
- `03-02-history-quick-pick.md` - Conversation history with date grouping, search
- `03-03-checkpoints-quick-pick.md` - Checkpoint restore/delete with file preview
- `03-04-provider-quick-pick.md` **[AMENDED: BYOK]** - Provider selection with status indicators, BYOK support
- `03-05-status-bar-update.md` **[AMENDED: Completion Status]** - Dual state model (GAP-01), quota display, completion status
- `03-06-remove-floating-panels.md` - Legacy panel cleanup
- `03-07-native-verification.md` - 98-item verification checklist
- `03-08-status-quota-quick-picks.md` **[NEW]** - Dedicated Status and Quota Quick Picks from status bar
- `03-09-permission-dialog-flow.md` **[NEW]** (GAP-06 FIX) - Permission dialog Promise resolution flow

**Phase 4 - Complete (5/5):**
- `04-01-context-chips-ui.md` - Context chips with type-specific icons, animations
- `04-02-context-drawer.md` **[AMENDED: GAP-11]** - Expandable drawer with lane-specific token budgets
- `04-03-mention-autocomplete.md` - @-mention with file/symbol search, keyboard nav
- `04-04-context-state-integration.md` - State service, persistence, LLM integration
- `04-05-context-verification.md` - 119-item verification checklist

**Phase 5 - Complete (7/7):**
- `05-01-change-cards-ui.md` - Change cards for file modifications with apply/reject
- `05-02-diff-view.md` - VS Code diff editor integration with virtual documents
- `05-03-approval-flow.md` (GAP-05 integration)
- `05-04-codelens-integration.md` - CodeLens for inline change indicators (optional)
- `05-05-review-mode.md` - Sequential change review workflow (optional)
- `05-06-changes-verification.md` - 92-item verification checklist
- `05-07-strategy-warning.md` **[NEW]** - Strategy file warning modal for strategies/live/ folders

**Phase 6 - Complete (12/12):**
- `06-01-accessibility-audit.md` - WCAG 2.1 AA audit checklist
- `06-02-accessibility-fixes.md` **[AMENDED: GAP-15]** - Common a11y fixes with visual design tokens (focus ring, selection, syntax highlighting)
- `06-03-error-display.md` **[AMENDED: GAP-07]** - Error handling with 24+ error code mapping
- `06-04-animation-polish.md` - CSS animations with reduced-motion support (optional)
- `06-05-edge-cases.md` - Empty states, overflow, concurrent actions handling
- `06-06-final-verification.md` - Final verification checklist
- `06-07-legacy-cleanup.md` - Final cleanup of deprecated code
- `06-08-help-modal.md` **[NEW]** - Help & shortcuts modal (480px, keyboard shortcuts by category)
- `06-09-audit-log-viewer.md` **[NEW]** - Audit log filter UI with type toggles, pagination, export
- `06-10-cancel-and-timeout.md` **[NEW]** (GAP-02, GAP-10 FIX) - Cancel semantics and timeout warnings
- `06-11-lane-and-feedback.md` **[NEW]** (GAP-12, GAP-14 FIX) - Lane indicator and quality feedback buttons
- `06-12-summarization-notification.md` **[NEW]** (GAP-09 FIX) - Auto-summarization notification with toast, progress banner, view summary modal

---

## Critical Path

The minimum prompts required for a functional UI:

```
00-01 → 00-02 → 00-03 → 00-05 → 00-06
                ↓
01-01 → 01-02 → 01-03 → 01-04 → 01-05 → 01-06 → 01-07
                                ↓
02-01 → 02-02 → 02-03 → 02-04 → 02-05 → 02-06 → 02-08 → 02-09 → 02-10 → 02-11
                                                ↓               ↓           ↓
                                            06-10           (First Run)  (Save State)
                                                ↓
03-01 → 03-02 → 03-03 → 03-05 → 03-06 → 03-07
    ↓                       ↓
  03-09                   03-08
    ↓                       ↓
04-01 → 04-02 → 04-04 → 04-05
                ↓
05-01 → 05-02 → 05-03 → 05-06
                    ↓
                  05-07
                    ↓
06-01 → 06-02 → 06-03 → 06-05 → 06-06 → 06-07
                    ↓       ↓       ↓
                06-09   06-11   06-12
```

### GAP Fixes Summary

| GAP | Issue | Fixed By |
|-----|-------|----------|
| GAP-01 | Dual state model | 03-05 |
| GAP-02 | State timeout handling | 06-10 |
| GAP-03 | Streaming token buffer | 02-04 |
| GAP-04 | ~~Tool call streaming~~ | N/A (removed - backend handles internally) |
| GAP-05 | ApprovalToken security | 05-03 |
| GAP-06 | Permission dialog Promise | 03-09 |
| GAP-07 | Error code mapping | 06-03 (amended) |
| GAP-08 | Conversation persistence UX | 02-11 |
| GAP-09 | Auto-summarization notification | 06-12 |
| GAP-10 | Cancel semantics | 06-10 |
| GAP-11 | Lane-specific budgets | 04-02 (amended) |
| GAP-12 | Lane indicator UI | 06-11 |
| GAP-13 | DataTier privacy integration | 02-10 |
| GAP-14 | Quality feedback | 06-11 |
| GAP-15 | Visual design tokens | 06-02 (amended) |
| GAP-16 | Backend wiring | 02-08 |
| GAP-17 | Input lockout | 02-06 |

**All 16 GAPs addressed** (GAP-04 removed per audit - not a gap). Non-critical prompts can be executed in parallel or deferred.
