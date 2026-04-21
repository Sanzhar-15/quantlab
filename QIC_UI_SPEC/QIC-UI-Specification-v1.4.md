# QIC UI Specification v1.4

**Quantlab Intelligence Companion — VS Code Extension UI**  
**Version:** 1.4 | **Date:** February 2026 | **Status:** Final

---

# 1. Executive Summary

QIC is an AI assistant integrated into Quantlab's VS Code fork. This specification defines the complete UI.

## Design Goals

| Goal | Measure |
|------|---------|
| First productive use | < 5 minutes |
| Common workflow keystrokes | < 5 |
| Feature discoverability | 80% without docs |
| Approval fatigue | < 3 per request |
| Context transparency | User sees what AI sees |

## Version History

| Version | Changes |
|---------|---------|
| 1.0 | Initial release |
| 1.1 | Context inventory, @ mentions, change groups, permission explanations |
| 1.2 | Restored implementation detail |
| 1.3 | Complete TypeScript interfaces, protocol fixes |
| 1.4 | Conversation list protocol, state request, export/search, audit viewer, input states, confirmations |

---

# 2. Design Principles

1. **Work over maintenance** — 95% serves active tasks
2. **Keyboard-first, mouse-friendly** — Every action has shortcut
3. **Progressive disclosure** — Simple default, power on demand
4. **Editor-native** — Code review in editor, not panel
5. **Trust through transparency** — Show what AI sees/does/costs
6. **Recoverable** — Every action undoable
7. **Accessible** — WCAG 2.1 AA
8. **Fast** — <100ms UI interactions

## Degradation Levels

| Level | Name | Capabilities |
|-------|------|-------------|
| 0 | Normal | Full |
| 1 | Latency | Warning only |
| 2 | Reduced | Context → 16K |
| 3 | Limited | No web search/multi-file |
| 4 | Minimal | Text-only |

---

# 3. Design System

## Color Tokens

```css
/* Core */
--qic-fg-primary: light(#1a1a1a) dark(#e5e5e5);
--qic-fg-secondary: light(#525252) dark(#a3a3a3);
--qic-fg-muted: light(#a3a3a3) dark(#525252);
--qic-bg-primary: light(#ffffff) dark(#1e1e1e);
--qic-bg-secondary: light(#f5f5f5) dark(#262626);
--qic-bg-tertiary: light(#e5e5e5) dark(#333333);
--qic-border-default: light(#e5e5e5) dark(#3c3c3c);

/* Accent */
--qic-accent-primary: light(#2563eb) dark(#3b82f6);
--qic-accent-primary-hover: light(#1d4ed8) dark(#60a5fa);
--qic-accent-primary-muted: light(#dbeafe) dark(#1e3a5f);

/* Status */
--qic-status-success: light(#16a34a) dark(#22c55e);
--qic-status-success-bg: light(#dcfce7) dark(#14532d);
--qic-status-warning: light(#ca8a04) dark(#facc15);
--qic-status-warning-bg: light(#fef9c3) dark(#713f12);
--qic-status-error: light(#dc2626) dark(#ef4444);
--qic-status-error-bg: light(#fee2e2) dark(#7f1d1d);

/* Diff */
--qic-diff-add-line: light(#dcfce7) dark(#16532d);
--qic-diff-add-word: light(#bbf7d0) dark(#22c55e33);
--qic-diff-remove-line: light(#fee2e2) dark(#7f1d1d);
--qic-diff-remove-word: light(#fecaca) dark(#ef444433);

/* Chips */
--qic-chip-bg: light(#f0f0f0) dark(#333333);
--qic-chip-pinned-bg: light(#dbeafe) dark(#1e3a5f);

/* Strategy */
--qic-strategy-bg: light(#fef3c7) dark(#78350f33);
--qic-strategy-border: light(#f59e0b) dark(#fbbf24);
```

## High Contrast Mode

When `window.matchMedia('(forced-colors: active)')`:

```css
--qic-fg-primary: CanvasText;
--qic-bg-primary: Canvas;
--qic-accent-primary: LinkText;
--qic-border-default: CanvasText;
--qic-status-error: Mark;
/* All backgrounds become Canvas, all text CanvasText */
/* Focus: 2px solid Highlight */
```

## Typography

```css
--qic-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--qic-font-mono: 'SF Mono', 'Fira Code', monospace;
--qic-text-xs: 11px; --qic-text-sm: 12px; --qic-text-base: 13px; --qic-text-lg: 14px;
```

## Spacing & Sizes

```css
--qic-space-1: 4px; --qic-space-2: 8px; --qic-space-3: 12px; --qic-space-4: 16px;
--qic-height-header: 40px; --qic-height-button: 28px; --qic-height-chip: 24px; --qic-height-input: 36px;
--qic-width-panel-default: 350px; --qic-width-menu: 220px;
--qic-radius-sm: 3px; --qic-radius-md: 5px; --qic-radius-lg: 8px; --qic-radius-full: 9999px;
```

## Shadows & Z-Index

```css
--qic-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--qic-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1);
--qic-z-dropdown: 10; --qic-z-modal: 40; --qic-z-toast: 60;
```

## Animations

```css
/* Streaming dots */
@keyframes qic-dots { 0%,20% { opacity: 0.3 } 50% { opacity: 1 } 80%,100% { opacity: 0.3 } }
.dot:nth-child(1) { animation: qic-dots 1.2s infinite 0ms }
.dot:nth-child(2) { animation: qic-dots 1.2s infinite 150ms }
.dot:nth-child(3) { animation: qic-dots 1.2s infinite 300ms }

/* Cursor blink */
@keyframes qic-blink { 0%,50% { opacity: 1 } 51%,100% { opacity: 0 } }
.cursor { animation: qic-blink 1.06s infinite }

/* Status pulse */
@keyframes qic-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
.processing { animation: qic-pulse 1.5s infinite }

/* Drawer expand */
.drawer { transition: height 200ms cubic-bezier(0,0,0.2,1) }

/* Reduced motion: disable all */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

---

# 4. Panel Component

## Structure

```
┌─────────────────────────────────────────┐
│ HEADER (40px)                           │
├─────────────────────────────────────────┤
│ CONVERSATION (flex, virtualized)        │
├─────────────────────────────────────────┤
│ CONTEXT CHIPS (auto)                    │
├─────────────────────────────────────────┤
│ INPUT (36-200px)                        │
└─────────────────────────────────────────┘
```

## Header

`[◇] QIC                    [⋮]   [+]`

- Logo: 20×20px, click → Status quick pick
- Menu [⋮]: 28×28px, opens dropdown
- New [+]: 28×28px, `Cmd+Shift+N`

## Menu Dropdown (220px)

```
⟲ Conversation history
✎ Rename conversation
────────────────────
◷ View checkpoints
⊕ Create checkpoint
────────────────────
☰ View permissions
⊘ View audit log
────────────────────
◈ Switch provider
⚙ Settings
? Help & shortcuts
```

## Conversation Area

**Virtualized** (react-window). 16px gap between messages.

### Message Structure

```
┌─────────────────────────────────────────┐
│ AUTHOR · TIMESTAMP            [⟲] [✎] │
│ CONTENT                                 │
│ [BRANCHES: v1 v2 ▾]                     │ ← Only on assistant if regenerated
└─────────────────────────────────────────┘
```

**Hover actions:**
- User messages: Edit [✎], Copy [⧉]
- Assistant messages: Regenerate [⟲], Copy [⧉]

### Branch/Regeneration UI

When **assistant** message has been regenerated:

```
┌─────────────────────────────────────────┐
│ QIC · 10:24 AM                    [⟲]  │
│ The Sharpe ratio calculation...        │
│ [v1] [v2 ●] [v3]                       │ ← ● = current
└─────────────────────────────────────────┘
```

When **user** message has been edited:

```
┌─────────────────────────────────────────┐
│ You · 10:23 AM                    [✎]  │
│ Fix the Sharpe calculation bug         │
│ [edited]                               │ ← Simple indicator, no branch switch
└─────────────────────────────────────────┘
```

- Regenerate branches: Pills below content, click to switch
- Edit branches: Creates new conversation fork (original archived)
- Right-click pill → "Delete this version"

## Input Area

36px min, 200px max. Padding: 8px 36px 8px 12px.

### Input States

| State | Condition | Appearance |
|-------|-----------|------------|
| Placeholder | Empty, enabled | "Ask anything..." in muted |
| Focused | Has focus | Accent border + shadow |
| Typing | Has content | Normal, send button active |
| Disabled | Streaming OR disconnected OR permission pending | 0.6 opacity, cursor not-allowed |
| Error | Context exceeded | Error border, "Message too long" |

**Send button:** 24×24px absolute right. Disabled when input disabled.

## @ Mention System

**Trigger:** `@` character in input.

### Autocomplete Dropdown (280×320px max)

```
┌─────────────────────────────────────────┐
│ FILES                                   │
│ 📄 risk_metrics.py              Recent │
│ 📄 backtest.py                         │
├─────────────────────────────────────────┤
│ SYMBOLS                                 │
│ ƒ  sharpe_ratio                        │
├─────────────────────────────────────────┤
│ FOLDERS                                 │
│ 📁 strategies/                          │
├─────────────────────────────────────────┤
│ DOCS                                    │
│ 📚 pandas                               │
└─────────────────────────────────────────┘
```

**Ranking:** Recency > Frequency > Alphabetical within each category.

**Behavior:** Fuzzy search, ↑↓ navigate, Enter/Tab select, Escape cancel.

**Chip in input:** `[filename ×]` — pill shape, removable via backspace.

## Conversation Management

- **Title:** AI-generated after first response (via `conversation:titleUpdated` message), max 50 chars
- **Edit (user):** Creates conversation fork, original becomes archived branch
- **Regenerate (assistant):** Creates new branch, switchable via pills

---

# 5. Context Management

## Context Chips Row

```
┌─────────────────────────────────────────┐
│ ▼ Context                   12K / 32K  │
│ [📄 main.py ×] [⌷ L50-60 ×] [+3 more]  │
└─────────────────────────────────────────┘
```

### Chip Types

| Type | Icon | Source |
|------|------|--------|
| File | 📄 | Current file or @mentioned |
| Selection | ⌷ | Selected text (shows line range) |
| Terminal | ▣ | Terminal output |
| Folder | 📁 | @mentioned folder |
| Symbol | ƒ | @mentioned symbol |
| Docs | 📚 | @mentioned documentation |

### Token Counter States

| State | Display | Color |
|-------|---------|-------|
| Normal (< 80%) | `12K / 32K` | muted |
| Warning (80-95%) | `28K / 32K ⚠` | warning |
| Critical (> 95%) | `31K / 32K ⚠` | error |

## Context Drawer (Expandable)

```
┌─────────────────────────────────────────┐
│ ▲ Context                   12K / 32K  │
├─────────────────────────────────────────┤
│ SYSTEM                           1.2K  │
│ CONVERSATION                     4.8K  │
│ FILES                            5.2K  │
│ ├ 📄 main.py              2.1K   [×]   │
│ ├ 📄 risk_metrics.py 📌   1.8K   [×]   │
│ └ ⌷ Selection             1.3K   [×]   │
│ TERMINAL                         0.8K  │
│ └ Last 100 lines          0.8K   [×]   │
├─────────────────────────────────────────┤
│ [+ Add file] [+ Add folder] [Clear all] │
└─────────────────────────────────────────┘
```

## Auto-Include Rules

| Item | When Included | Removable |
|------|---------------|-----------|
| System prompt | Always | No |
| Conversation | Always | No |
| Current file | If open and focused | Yes |
| Selection | If selected when sending | Yes |
| Terminal | If output in last 5 min | Yes |
| @Mentions | When explicitly @mentioned | Yes |
| Pinned | Until unpinned | Yes (unpin) |

### Terminal Context

- **Which:** Active terminal (most recently focused)
- **Amount:** Last 100 lines or 2K tokens, whichever smaller

### Pinned Persistence

Pins persist per-workspace across sessions and conversations.

---

# 6. Conversation Patterns

## Code Block

```
┌─────────────────────────────────────────┐
│ python                      [⧉]  [⎗]  │
├─────────────────────────────────────────┤
│ def sharpe_ratio(returns):             │
│     return returns.mean() / returns.std()│
└─────────────────────────────────────────┘
```

## Change Summary (Context-Aware)

**If file is open:** Summary card only:
```
📄 risk_metrics.py +12 -3      [Jump to code]
```

**If file is closed:** Full inline diff in panel.

## Button Variants

| Variant | Background | Text | Border |
|---------|------------|------|--------|
| Primary | accent | white | none |
| Secondary | transparent | fg-primary | border-default |
| Ghost | transparent | fg-secondary | none |
| Danger | transparent | error | error |

## Permission Request

```
I need permission to run:
┌────────────────────────────────────────┐
│ pip install scipy                      │
└────────────────────────────────────────┘

Why: Required for statistical tests.
Affects: 🐍 Python environment only.

[Allow] [Allow for session] [Deny]
```

## Post-Change Actions

```
✓ Changes applied    [Run tests] [Run backtest] [Done]
```

## Streaming UX

| Phase | Display |
|-------|---------|
| Pre-stream | `● ● ●` animated |
| Streaming | Content + blinking `█` cursor |
| Complete | Timestamp updates, cursor removed |
| Cancelled | Partial + `[Cancelled]` + `[Retry]` |

## Cancel Semantics

| Scenario | Behavior |
|----------|----------|
| Pre-stream | No message shown |
| Mid-stream | Partial preserved + `[Cancelled]` |
| Pending changes | Changes remain pending |
| Permission | Returns to previous state |

## Multi-File Change Summary

```
┌─────────────────────────────────────────┐
│ CORE LOGIC                              │
│ → risk_metrics.py             +12 -3   │
│ ○ models/position.py           +5 -2   │
│                       [Accept group]    │
├─────────────────────────────────────────┤
│ TESTS                                   │
│ ○ tests/test_risk.py          +45 -0   │
│                       [Accept group]    │
└─────────────────────────────────────────┘
[Accept all] [Reject all] [Review all]
```

### Change Group Patterns

| Group | Patterns |
|-------|----------|
| Core | `**/*.py` NOT tests/config/docs |
| Tests | `**/test_*.py`, `**/*_test.py`, `**/tests/**` |
| Config | `**/*.json`, `**/*.yaml`, `**/*.toml`, `**/config/**` |
| Docs | `**/*.md`, `**/*.rst`, `**/docs/**` |
| Formatting | Whitespace-only diffs |

### Partial Failure

```
⚠ 2 of 4 files applied. 2 failed:
├ ✗ config.json — File is locked
├ ✗ utils.py — Merge conflict
[Retry failed] [Skip failed] [View details]
```

### pendingChanges Lifecycle

| Event | pendingChanges State |
|-------|---------------------|
| Changes proposed | Set to ChangeSet |
| Accept all | Set to null |
| Reject all | Set to null |
| Partial (mixed) | Kept with updated statuses |
| All resolved individually | Set to null when last resolved |
| New message sent | Kept (user can still review) |
| New conversation | Set to null |

---

# 7. Editor Integration

## CodeLens

```
[✓ Accept] [✗ Reject] [? Explain] — QIC: Fixed calculation
```

Shortcuts: `Cmd+Enter` accept, `Escape` reject.

## Diff Decorations

| Type | Gutter | Line BG | Word BG |
|------|--------|---------|---------|
| Added | + (success) | diff-add-line | diff-add-word |
| Removed | - (error) | diff-remove-line | diff-remove-word |

## Strategy Warning

```
⚠ Strategy File — Changes may affect live trading
```

Modal (if `qic.strategyConfirmation` enabled):
- ☐ "I understand this affects live trading" (required)
- ☐ "Don't ask again this session"
- [Cancel] [Simulate First] [Apply]

## Multi-File Navigation

| Shortcut | Action |
|----------|--------|
| `F7` | Next file |
| `Shift+F7` | Previous file |
| `Cmd+Shift+A` | Accept all |
| `Cmd+Shift+Backspace` | Reject all |

## Unified Review Mode (`Cmd+Shift+R`)

| Key | Action |
|-----|--------|
| `↓` / `↑` | Navigate files |
| `Tab` / `Shift+Tab` | Navigate hunks |
| `J` / `K` | Vim file nav |
| `A` | Accept file |
| `R` | Reject file |
| `Cmd+Enter` | Accept all |
| `Escape` | Close |

---

# 8. Status Bar

```
│ QIC ● │ 47K/100K │ ⟳ 3 │
```

## Status Item

| State | Indicator | Color |
|-------|-----------|-------|
| Connected | ● | success |
| Processing | ● (pulse) | accent |
| Degraded | ◐ | warning |
| Error | ● | error |
| Disconnected | ○ | muted |
| Offline | ◇ | muted |

## Quota Item

| State | Display |
|-------|---------|
| Normal (<80%) | `47K/100K` |
| Warning (80-95%) | Yellow |
| Critical (>95%) | Red + ⚠ |
| Exceeded | Red + 🛑 |

## Checkpoint Item

`⟳ {count}` or `⟳ ...` (creating).

---

# 9. Quick Picks

## Status Quick Pick

```
● Connected — QIC Cloud · 143ms
────────────────────────────────
> Switch provider
> Test connection
> View status page
```

## Quota Quick Pick

```
47,231 / 100,000 (47%)
████████████████░░░░░░░░░░░
Est: $4.72 used · $5.28 remaining
Resets in 12 days
────────────────────────────────
> View usage history
> Upgrade plan
> Switch to Ollama (unlimited)
```

## Checkpoint Quick Pick

```
> ⟳ Restore...  > + Create now
────────────────────────────────
2m ago    Before: Fixed Sharpe     3 files
15m ago   "pre-refactor" (manual)  7 files
1h ago    Before: Added tests     12 files
────────────────────────────────
> Export all  > Clear old
```

## Provider Quick Pick

```
● QIC Cloud              Connected
○ Ollama (llama3:8b)     Available
○ Offline Mode
```

## History Quick Pick

```
🔍 Search conversations...
────────────────────────────────
TODAY
Fix Sharpe calculation   10:23 AM · 8 msg
Add Sortino ratio         9:15 AM · 5 msg
YESTERDAY
Refactor risk module      3:42 PM · 23 msg
────────────────────────────────
> Export all  > Clear all
```

Right-click → Delete, Rename, Export.

---

# 10. Modals & Dialogs

## Help & Shortcuts Modal

Triggered by Menu → "Help & shortcuts" or `Cmd+/`.

```
┌─────────────────────────────────────────────────────┐
│ Help & Shortcuts                              [×]  │
├─────────────────────────────────────────────────────┤
│ GLOBAL                                              │
│ Cmd+L          Focus QIC input                     │
│ Cmd+Shift+N    New conversation                    │
│ Cmd+Shift+H    Open history                        │
│ Cmd+Shift+C    Create checkpoint                   │
│ Cmd+Ctrl+Z     Restore checkpoint                  │
│                                                     │
│ PANEL                                               │
│ Cmd+Enter      Send message                        │
│ Escape         Cancel / Clear                      │
│ @              Mention file/symbol                 │
│                                                     │
│ DIFF REVIEW                                         │
│ Cmd+Enter      Accept change                       │
│ Escape         Reject change                       │
│ F7             Next file                           │
│ Cmd+Shift+R    Open review mode                    │
├─────────────────────────────────────────────────────┤
│ [Documentation]  [Report issue]  [Close]           │
└─────────────────────────────────────────────────────┘
```

Width: 480px. Max-height: 80vh. Scrollable.

## Confirmation Dialogs

Standard VS Code modal style. Focus trapped within dialog.

### Clear All Context

```
┌─────────────────────────────────────────┐
│ Clear Context?                          │
├─────────────────────────────────────────┤
│ This will remove all files, selections, │
│ and terminal output from context.       │
│ Pinned items will also be unpinned.     │
├─────────────────────────────────────────┤
│                    [Cancel]  [Clear]    │
└─────────────────────────────────────────┘
```

### Clear Conversation History

```
┌─────────────────────────────────────────┐
│ Clear All History?                      │
├─────────────────────────────────────────┤
│ This will permanently delete all        │
│ {n} conversations. This cannot be       │
│ undone.                                 │
├─────────────────────────────────────────┤
│                  [Cancel]  [Delete All] │
└─────────────────────────────────────────┘
```

### Delete Conversation

```
┌─────────────────────────────────────────┐
│ Delete Conversation?                    │
├─────────────────────────────────────────┤
│ "{title}" will be permanently deleted.  │
├─────────────────────────────────────────┤
│                    [Cancel]  [Delete]   │
└─────────────────────────────────────────┘
```

### Focus Trap

All modals:
- Focus first focusable element on open
- Tab cycles within modal
- Escape closes (returns focus to trigger)
- Click outside closes (optional per dialog)

---

# 11. Audit Log Viewer

Triggered by Menu → "View audit log".

```
┌─────────────────────────────────────────────────────────────┐
│ Audit Log                                [Export]     [×]  │
├─────────────────────────────────────────────────────────────┤
│ Filter: [All ▾] [Today ▾]  🔍 Search...                    │
├─────────────────────────────────────────────────────────────┤
│ 10:45:23  CHANGE    Accepted risk_metrics.py (+12 -3)      │
│ 10:45:20  PERMISSION Allowed pip install scipy (session)   │
│ 10:44:15  TOOL_CALL  execute_python: test_sharpe.py        │
│ 10:43:02  CHECKPOINT Created "Before: Fix Sharpe"          │
│ 10:42:58  CHANGE    Proposed 3 files                       │
│ ...                                                         │
├─────────────────────────────────────────────────────────────┤
│ Showing 50 of 234 entries              [Load more]         │
└─────────────────────────────────────────────────────────────┘
```

### Filters

- Type: All, Changes, Permissions, Tool Calls, Checkpoints, Errors
- Time: Today, Last 7 days, Last 30 days, All time

### Entry Detail (on click)

```
┌─────────────────────────────────────────┐
│ PERMISSION · 10:45:20                   │
├─────────────────────────────────────────┤
│ Action: pip install scipy               │
│ Scope: session                          │
│ Granted by: User                        │
│ Session: abc123                         │
│ Hash: 7f3a...                           │
├─────────────────────────────────────────┤
│ [Copy JSON]                   [Close]   │
└─────────────────────────────────────────┘
```

---

# 12. First-Run Experience

## Flow

Welcome → Provider Selection → Setup → Success

## Provider Selection

| | QIC Cloud | Ollama |
|-|-----------|--------|
| Capability | Full | Good |
| Privacy | Standard/Private | Complete |
| Cost | Usage limits | Free |
| Offline | No | Yes |

## Private Tier Features

| Feature | Standard | Private |
|---------|----------|---------|
| Code analysis | Cloud | Local |
| Web search | ✓ | ✗ |
| Multi-file | ✓ | 3 files max |
| Context | 32K | 16K |

---

# 13. States Catalog

## Empty States

| State | Content |
|-------|---------|
| New conversation | Logo + "How can I help?" + suggestions |
| No history | "Start chatting to see history" |
| No checkpoints | Explanation + [Create now] |
| No audit entries | "No activity recorded yet" |

## Loading States

| State | Display |
|-------|---------|
| Initial | Spinner + "Loading QIC..." |
| Connecting | Spinner + provider name |
| Pre-stream | ● ● ● |
| Reconnecting | Toast "(2/5)" |
| Searching | Spinner in search field |

---

# 14. Error Handling

## Error Catalog

| Code | Message | Actions |
|------|---------|---------|
| NETWORK_UNAVAILABLE | "No internet connection" | Retry, Ollama |
| NETWORK_TIMEOUT | "Request timed out" | Retry, Cancel |
| AUTH_INVALID | "Invalid API key" | Edit, Help |
| AUTH_EXPIRED | "API key expired" | Renew, Help |
| RATE_LIMITED | "Too many requests. Retry in {n}s" | Auto-countdown |
| QUOTA_EXCEEDED | "Monthly quota exceeded" | Upgrade, Ollama |
| SERVER_ERROR | "Server error. We're on it." | Retry, Report |
| SERVER_MAINTENANCE | "Maintenance until {time}" | Ollama, Status |
| OLLAMA_NOT_RUNNING | "Ollama not detected" | Retry, Guide |
| OLLAMA_MODEL_MISSING | "Model not installed" | Install, Choose |
| FILE_NOT_FOUND | "File not found" | Refresh, Select |
| CONTEXT_EXCEEDED | "Context too large" | Manage, New chat |
| CHECKPOINT_CORRUPT | "Checkpoint corrupted" | Delete, Another |
| CHANGE_PARTIAL | "Some files failed" | Retry, Skip |
| INTERNAL_ERROR | "Something went wrong" | Retry, Report |

---

# 15. Keyboard Shortcuts

## Global

| Shortcut | Action |
|----------|--------|
| `Cmd+L` | Focus input |
| `Cmd+Shift+N` | New conversation |
| `Cmd+Shift+H` | History |
| `Cmd+Shift+C` | Create checkpoint |
| `Cmd+Ctrl+Z` | Restore checkpoint |
| `Cmd+Shift+R` | Review mode |
| `Cmd+/` | Help & shortcuts |

## Panel

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Send |
| `Escape` | Clear/cancel |
| `Up` | Edit previous |
| `@` | Mentions |

## Editor (Diff)

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Accept |
| `Escape` | Reject |
| `F7` / `Shift+F7` | Next/prev |
| `Cmd+Shift+A` | Accept all |

---

# 16. Accessibility

## WCAG 2.1 AA

| Criterion | Implementation |
|-----------|----------------|
| 1.1.1 Non-text | All icons have aria-label |
| 1.4.3 Contrast | 4.5:1 minimum |
| 1.4.11 Non-text | 3:1 for UI |
| 2.1.1 Keyboard | All accessible |
| 2.4.3 Focus Order | Logical tab |
| 2.4.7 Focus Visible | 3px outline |

## Screen Reader Announcements

| Event | Announcement |
|-------|--------------|
| Sending | "Sending message" |
| Streaming | "Receiving" (once) |
| Complete | "Response complete" |
| Changes | "Changes to {n} files" |
| Error | "Error: {title}" |
| Permission | "Permission requested" |

## Focus Management

| Action | Target |
|--------|--------|
| Panel opens | Input |
| Modal closes | Trigger |
| Diff shown | CodeLens |

---

# 17. Settings

```jsonc
{
  // Provider
  "qic.provider": "qic-cloud",
  "qic.ollama.model": "llama3:8b",
  "qic.ollama.url": "http://localhost:11434",  // Custom endpoint
  
  // Privacy
  "qic.dataTier": "standard",
  "qic.allowWebSearch": true,
  "qic.telemetry": false,
  "qic.excludePatterns": ["**/.env", "**/secrets/**"],
  
  // Safety
  "qic.checkpoints.auto": true,
  "qic.checkpoints.maxCount": 50,
  "qic.strategyFolders": ["strategies/", "live/"],
  "qic.strategyConfirmation": true,
  
  // Context
  "qic.context.autoIncludeCurrentFile": true,
  "qic.context.autoIncludeSelection": true,
  "qic.context.autoIncludeTerminal": true,
  "qic.context.terminalMaxLines": 100,
  "qic.context.terminalMaxTokens": 2000,
  
  // Network
  "qic.network.timeout": 30000,      // Request timeout (ms)
  "qic.network.retryCount": 3,       // Auto-retry attempts
  "qic.network.retryDelay": 1000,    // Delay between retries (ms)
  
  // Post-change
  "qic.postChangeAction": "ask",
  
  // Audit
  "qic.audit.enabled": false,
  "qic.audit.maxEntries": 10000
}
```

---

# 18. Data Models

```typescript
// ═══════════════════════════════════════════════════════════════════════
// CORE STATE
// ═══════════════════════════════════════════════════════════════════════

interface QICState {
  revision: number;
  
  connection: {
    status: 'connected' | 'connecting' | 'degraded' | 'disconnected' | 'blocked';
    provider: 'qic-cloud' | 'ollama' | 'offline';
    degradationLevel: 0 | 1 | 2 | 3 | 4;
    latencyMs: number;
  };
  
  context: {
    items: ContextItem[];
    totalTokens: number;
    maxTokens: number;
  };
  
  conversation: {
    id: string;
    title: string;
    messages: Message[];
    isStreaming: boolean;
    pendingChanges: ChangeSet | null;
  };
  
  quota: {
    used: number;
    limit: number;
    estimatedCost: number;
    resetDate: string;
  };
  
  checkpoints: Checkpoint[];
  
  permissions: {
    granted: Permission[];
    pending: PermissionRequest | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CONVERSATIONS (for history list)
// ═══════════════════════════════════════════════════════════════════════

interface ConversationSummary {
  id: string;
  title: string;
  timestamp: string;       // Last message time
  messageCount: number;
  preview?: string;        // First ~50 chars of last message
}

// ═══════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  status: 'sending' | 'streaming' | 'complete' | 'error' | 'cancelled';
  mentions?: Mention[];
  metadata?: MessageMetadata;
  branches?: Branch[];         // Only for assistant (regenerate)
  activeBranchId?: string;
  isEdited?: boolean;          // Only for user (edit)
}

interface Mention {
  id: string;
  type: 'file' | 'folder' | 'symbol' | 'docs';
  path: string;
  displayName: string;
  tokens: number;
}

interface MessageMetadata {
  changes?: ChangeSet;
  error?: ErrorInfo;
  tokensUsed?: number;
}

interface Branch {
  id: string;
  content: string;
  timestamp: string;
  status: 'complete' | 'error' | 'cancelled';
}

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════

interface ContextItem {
  id: string;
  type: 'file' | 'selection' | 'terminal' | 'folder' | 'symbol' | 'docs';
  source: string;
  displayName: string;
  tokens: number;
  removable: boolean;
  pinned: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// CHANGES
// ═══════════════════════════════════════════════════════════════════════

interface ChangeSet {
  id: string;
  description: string;
  changes: Change[];
  groups: ChangeGroup[];
  checkpointId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'partial';
}

interface ChangeGroup {
  id: string;
  name: string;
  category: 'core' | 'tests' | 'config' | 'docs' | 'formatting';
  changeIds: string[];
  status: 'pending' | 'accepted' | 'rejected';
}

interface Change {
  id: string;
  file: string;
  type: 'create' | 'modify' | 'delete' | 'rename';
  oldPath?: string;
  diff: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'rejected' | 'failed';
  error?: string;
  isStrategyFile: boolean;
  groupId: string;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

// ═══════════════════════════════════════════════════════════════════════
// CHECKPOINTS
// ═══════════════════════════════════════════════════════════════════════

interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  files: CheckpointFile[];
  isManual: boolean;
  changeSetId?: string;
}

interface CheckpointFile {
  path: string;
  hash: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════

interface Permission {
  id: string;
  tool: string;
  scope: 'once' | 'session' | 'always';
  grantedAt: string;
  usageCount: number;
}

interface PermissionRequest {
  id: string;
  tool: string;
  command: string;
  explanation: {
    why: string;
    affects: string;
    scope: PermissionScope;
  };
  isHighRisk: boolean;
}

type PermissionScope = 
  | { type: 'file-read'; pattern: string }
  | { type: 'file-write'; pattern: string }
  | { type: 'python-env' }
  | { type: 'network'; hosts: string[] }
  | { type: 'terminal' }
  | { type: 'system' };

// ═══════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════

interface ErrorInfo {
  code: string;
  title: string;
  message: string;
  recoverable: boolean;
  retryAfter?: number;
  actions: ErrorAction[];
}

interface ErrorAction {
  label: string;
  command: string;
  args?: unknown[];
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════

interface AuditEntry {
  id: string;
  timestamp: string;
  type: 'tool_call' | 'permission' | 'change' | 'checkpoint' | 'error';
  data: Record<string, unknown>;
  sessionId: string;
  prevHash: string;
  hash: string;
}

// ═══════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════

interface SearchResult {
  conversationId: string;
  messageId: string;
  snippet: string;        // Highlighted match
  timestamp: string;
}
```

---

# 19. Message Protocol

## Revision-Based Sync

All Host→Webview messages include monotonic `revision`. Webview ignores `revision <= current`.

## Host → Webview

```typescript
type HostMessage =
  // State
  | { type: 'state:full'; revision: number; payload: QICState }
  | { type: 'state:patch'; revision: number; payload: Partial<QICState> }
  | { type: 'state:sync'; revision: number }
  
  // Streaming
  | { type: 'message:start'; revision: number; payload: { id: string } }
  | { type: 'message:chunk'; revision: number; payload: { id: string; content: string; kind: 'text' | 'code' } }
  | { type: 'message:complete'; revision: number; payload: { id: string; metadata?: MessageMetadata } }
  | { type: 'message:error'; revision: number; payload: { id: string; error: ErrorInfo } }
  
  // Conversation management
  | { type: 'conversation:titleUpdated'; revision: number; payload: { id: string; title: string } }
  | { type: 'conversations:list'; revision: number; payload: { conversations: ConversationSummary[] } }
  | { type: 'conversations:searchResults'; revision: number; payload: { query: string; results: SearchResult[] } }
  
  // Changes
  | { type: 'changes:pending'; revision: number; payload: ChangeSet }
  | { type: 'changes:resolved'; revision: number; payload: { id: string; status: 'accepted' | 'rejected' | 'partial' } }
  | { type: 'changes:fileStatus'; revision: number; payload: { changeSetId: string; changeId: string; status: 'accepted' | 'rejected' | 'failed'; error?: string } }
  
  // Permissions
  | { type: 'permission:request'; revision: number; payload: PermissionRequest }
  | { type: 'permission:resolved'; revision: number; payload: { id: string; granted: boolean } }
  
  // Context
  | { type: 'context:update'; revision: number; payload: { items: ContextItem[]; totalTokens: number; maxTokens: number } }
  
  // Checkpoints
  | { type: 'checkpoint:created'; revision: number; payload: Checkpoint }
  | { type: 'checkpoint:restored'; revision: number; payload: { id: string; filesChanged: number } }
  
  // Audit
  | { type: 'audit:entries'; revision: number; payload: { entries: AuditEntry[]; total: number; hasMore: boolean } }
  
  // Export
  | { type: 'export:ready'; revision: number; payload: { type: 'conversation' | 'audit'; format: 'json' | 'markdown' | 'csv'; data: string } };
```

## Webview → Host

```typescript
type WebviewMessage =
  // Lifecycle
  | { type: 'ready' }
  | { type: 'revision:ack'; revision: number }
  | { type: 'state:request' }  // Request full state (for recovery)
  
  // Messages
  | { type: 'send'; payload: { content: string; mentions: Mention[] } }
  | { type: 'cancel' }
  | { type: 'retry'; payload: { messageId: string } }
  | { type: 'regenerate'; payload: { messageId: string } }
  | { type: 'edit'; payload: { messageId: string; newContent: string; mentions: Mention[] } }
  | { type: 'switchBranch'; payload: { messageId: string; branchId: string } }
  | { type: 'deleteBranch'; payload: { messageId: string; branchId: string } }
  
  // Conversations
  | { type: 'newChat' }
  | { type: 'loadConversation'; payload: { conversationId: string } }
  | { type: 'deleteConversation'; payload: { conversationId: string } }
  | { type: 'renameConversation'; payload: { conversationId: string; title: string } }
  | { type: 'conversations:requestList' }
  | { type: 'conversations:search'; payload: { query: string } }
  | { type: 'conversations:export'; payload: { conversationId: string; format: 'json' | 'markdown' } }
  | { type: 'conversations:exportAll'; payload: { format: 'json' | 'markdown' } }
  
  // Changes
  | { type: 'changes:accept'; payload: { changeSetId: string; changeId: string } }
  | { type: 'changes:reject'; payload: { changeSetId: string; changeId: string } }
  | { type: 'changes:acceptGroup'; payload: { changeSetId: string; groupId: string } }
  | { type: 'changes:rejectGroup'; payload: { changeSetId: string; groupId: string } }
  | { type: 'changes:acceptAll'; payload: { changeSetId: string } }
  | { type: 'changes:rejectAll'; payload: { changeSetId: string } }
  | { type: 'changes:retryFailed'; payload: { changeSetId: string } }
  
  // Permissions
  | { type: 'permission:allow'; payload: { id: string; scope: 'once' | 'session' | 'always' } }
  | { type: 'permission:deny'; payload: { id: string } }
  | { type: 'permission:revoke'; payload: { id: string } }
  
  // Context
  | { type: 'context:add'; payload: { type: string; path: string } }
  | { type: 'context:remove'; payload: { id: string } }
  | { type: 'context:pin'; payload: { id: string } }
  | { type: 'context:unpin'; payload: { id: string } }
  | { type: 'context:clear' }
  
  // Checkpoints
  | { type: 'checkpoint:create'; payload: { description?: string } }
  | { type: 'checkpoint:restore'; payload: { id: string } }
  | { type: 'checkpoint:delete'; payload: { id: string } }
  | { type: 'checkpoint:exportAll'; payload: { format: 'json' } }
  
  // Audit
  | { type: 'audit:request'; payload: { filter?: string; timeRange?: string; offset?: number; limit?: number } }
  | { type: 'audit:export'; payload: { format: 'json' | 'csv' } };
```

## Reconciliation

| Scenario | Handling |
|----------|----------|
| `revision <= current` | Ignore |
| Gap detected | Send `state:request` |
| Connection drop | Reconnect → Host sends `state:sync` → Webview sends `revision:ack` → Delta or full |

---

# 20. Performance

## Timing Budgets

| Metric | Budget |
|--------|--------|
| Panel render | < 200ms |
| Input response | < 50ms |
| Token render | < 16ms |
| Quick pick open | < 100ms |

## Size Budgets

| Metric | Budget |
|--------|--------|
| Extension | < 2MB |
| Webview JS | < 500KB |
| Memory (idle) | < 50MB |
| Memory (active) | < 150MB |

## Scalability

| Dimension | Limit | Degradation |
|-----------|-------|-------------|
| Messages | 500 | Pagination |
| Files | 50 | Pagination |
| Context | 50 | Auto-remove |
| Checkpoints | 50 | LRU |
| Audit entries | 10000 | Rotation |

---

# 21. Security

## Threat Mitigations

| Threat | Mitigation |
|--------|------------|
| API key theft | SecretStorage |
| Malicious code | User approval |
| Exfiltration | excludePatterns |
| XSS | CSP |
| Audit tampering | Hash chain |

## Sensitive Patterns

```
**/.env  **/.env.*  **/secrets/**  **/*.pem  **/*.key  
**/id_rsa*  **/.git/config  **/.npmrc  **/credentials*
```

## CSP

```
default-src 'none';
script-src 'nonce-{n}';
style-src 'unsafe-inline';
font-src ${webview.cspSource};
img-src ${webview.cspSource} data: https:;
connect-src https://api.qic.quantlab.io wss://api.qic.quantlab.io;
```

---

# 22. Implementation Phases

| Phase | Weeks | Focus |
|-------|-------|-------|
| 0 | 1 | Foundation, protocol |
| 1 | 2-3 | Conversation, streaming |
| 2 | 4 | Context, mentions |
| 3 | 5-6 | Changes, review |
| 4 | 7-8 | Permissions, checkpoints |
| 5 | 9 | First-run, settings |
| 6 | 10 | Status, quick picks |
| 7 | 11-12 | Polish, modals |
| 8 | 13 | Audit viewer |
| 9 | 14-15 | Testing, launch |

---

# 23. Component Checklist

| Component | Priority | Phase |
|-----------|----------|-------|
| Panel | P0 | 1 |
| Context chips + drawer | P0 | 2 |
| @ Mentions | P0 | 2 |
| Code block | P0 | 1 |
| Change summary | P0 | 3 |
| Change groups | P0 | 3 |
| Permission request | P0 | 4 |
| CodeLens + decorations | P0 | 3 |
| Status bar | P0 | 6 |
| Quick picks (5) | P0 | 6 |
| Review mode | P1 | 3 |
| Strategy warning | P0 | 4 |
| Post-change actions | P1 | 4 |
| First-run | P0 | 5 |
| Branch UI | P1 | 7 |
| Help modal | P1 | 7 |
| Confirmations | P1 | 7 |
| Audit viewer | P2 | 8 |
| All states | P0 | 1 |

---

# 24. Future Considerations

1. **Inline chat (`Cmd+K`)** — Selection-based chat
2. **Multi-workspace** — Cross-project context
3. **Collaboration** — Shared conversations
4. **Voice input** — Speech-to-text
5. **Custom tools** — User permission scopes

---

**End of Specification v1.4**
