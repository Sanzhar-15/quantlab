# Quantlab Phase 6 Polish and Compliance - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 2-4 weeks
Goal: Complete all remaining V8.1 compliance tasks across tokens, notifications, error recovery, drag-and-drop, onboarding, accessibility, and final polish.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 6 plan: `Quantlab_On/Deeper_implementation_plan/Phase_6_Polish_Compliance.md`
- Phase 1 implementation plan (view system + tab stripe + ARIA): `Quantlab_On/Actual implementation/Phase_1_Core_View_System.md`
- Phase 2 implementation plan (chrome + panels + history): `Quantlab_On/Actual implementation/Phase_2_Window_Chrome_Activity_Bar_History.md`
- Phase 3 implementation plan (chart view): `Quantlab_On/Actual implementation/Phase_3_Chart_View_MVP.md`
- Phase 4 implementation plan (action view + history): `Quantlab_On/Actual implementation/Phase_4_Action_View_MVP.md`
- Phase 5 implementation plan (trade view): `Quantlab_On/Actual implementation/Phase_5_Trade_View_MVP.md`

Note: The Quantlab extension root is `extensions/quantlab` (built-in extension per Phase 1 decisions).

## Phase 6 Objectives
1. Implement V8.1 design tokens and theme integration across all Quantlab webviews and workbench surfaces.
2. Ship a spec-compliant notifications system: toasts, badges, and optional sounds.
3. Implement error states and recovery flows for Chart, Action, Trade, and global engine failures.
4. Complete drag-and-drop behaviors for symbols, runs, and watchlist entries.
5. Implement onboarding flow and contextual feature discovery tips.
6. Finish accessibility requirements (keyboard, screen reader labels, reduced motion).
7. Final polish and compliance verification (theme QA, text review, performance).

## Scope
In scope:
- Tokens CSS and theme variable plumbing.
- Notifications manager, badge counts, toast actions, and settings.
- Error state UI components and recovery action wiring.
- Drag-and-drop sources and drop targets per spec.
- Onboarding modal + tooltip discovery + trigger plumbing.
- Accessibility pass for controls, labels, and announcements.
- Final polish, QA checklist, and test coverage.

Out of scope:
- New view features or engine capabilities beyond Phase 5.
- Additional brokers or data providers.
- New panels beyond spec.
- Large-scale UX redesign beyond V8.1.

## Quality and Compliance Principles
- No regressions to core VS Code workflows.
- No view is blocked by compliance work (only improved).
- Notifications, onboarding, and tooltips must be dismissible and non-blocking (except critical error modals).
- All colors flow through tokens to prevent theme breakage.
- Accessibility is tested with keyboard-only workflows.

## Backend Optimization Principles (No UX Changes)
- Single source of truth for tokens and theme variables; avoid drift across webviews.
- Coalesce high-frequency updates (badges, progress, trade fills) without dropping user-visible events.
- Keep all state writes bounded and debounced (notifications, onboarding, unviewed counts).
- Use stable IDs and routing keys (strategyPath, runId, sessionId) to prevent cross-tab leakage.
- Avoid webview reloads; prefer incremental postMessage updates.
- Bounded buffers for notifications/logs to prevent memory growth.

## Phase 6 Decisions (Locked)
1. Use a centralized ThemeProvider to push tokens and theme variables to all webviews.
2. Use a NotificationManager in the extension host to orchestrate toasts, badges, and sounds.
3. Use a unified ErrorRecovery service to map errors to UI actions and recovery paths.
4. Implement drag-and-drop via VS Code drag controllers plus webview drop handlers.
5. Implement onboarding as a dedicated webview modal for first launch and lightweight tooltips for discovery.
6. Store onboarding state in `globalState` and keep it user-scoped.
7. Accessibility improvements are enforced in both workbench patches and webviews.

## Non-Negotiable V8.1 Requirements (Phase 6 Relevant)
- Design tokens use `--ql-` prefix and include view stripe colors, status colors, and typography. (Spec 8)
- Toasts appear bottom-right and auto-dismiss after 5 seconds; errors persist until dismissed. (Spec 11.2)
- History button shows unviewed count; Trade panel shows open orders count. (Spec 11.4)
- Error states are actionable with recovery options for Chart, Action, Trade, and global engine errors. (Spec 10)
- Drag-and-drop behavior for symbols, runs, watchlists, and editor insertions. (Spec 12)
- History run drag supports Compare area selection. (Spec 12.3)
- First launch onboarding modal with 3 options and view discovery tooltip on first view switch. (Spec 13)
- All view buttons, dropdowns, and panels are keyboard-navigable and screen reader friendly. (Spec 9)
- Reduced motion disables animations and animated progress. (Spec 9.4)

## Dependencies from Phases 1-5
- ViewManager and TabViewState (Phase 1).
- Title bar Symbol/Timeframe selectors and History button (Phase 2).
- HistoryState and History dropdown/panel (Phase 2/4).
- Data panel and watchlists (Phase 2).
- Chart view provider and overlays (Phase 3).
- Action view state machine and job events (Phase 4).
- Trade view and SessionManager events (Phase 5).

## Workbench Patch Plan (Phase 6)
All workbench patches are recorded in `extensions/quantlab/docs/PATCHES_PHASE_6.md`.

1. History button badge rendering:
   - Extend title bar DOM to show unviewed count as a compact badge.
   - Update `aria-label` to include count (e.g. "History, 3 unviewed").
2. Global selector drag-and-drop:
   - Add dragover/drop listeners to symbol selector button for symbol drops.
   - Map drop to `quantlab.setGlobalSymbol`.
3. Onboarding tooltip anchors:
   - Add data attributes on view buttons and history button for tooltip placement.
4. Accessibility labels:
   - Ensure tab elements include view name in ARIA label (already in Phase 1) and update if needed.
5. Toast container (spec position):
   - Add a lightweight toast stack container anchored to bottom-right of the editor area.
   - Expose `quantlab.showToast` and `quantlab.dismissToast` commands to drive it.
   - Ensure toasts use tokens and respect reduced motion.

If any of the above are not feasible in the current fork, document in patch notes and implement extension-side fallback (status bar badge, in-panel tooltips).

## Implementation Plan

### 1. Phase 6 file layout and registrations
Extend the Quantlab extension structure under `extensions/quantlab`:

```
extensions/quantlab/
  package.json
  src/
    types/
      notifications.ts
      errors.ts
      onboarding.ts
    ui/
      tokens/
        themes.ts
        ThemeProvider.ts
      notifications/
        NotificationManager.ts
        ToastService.ts
        BadgeManager.ts
        SoundPlayer.ts
      errors/
        ErrorRecovery.ts
        ViewErrorStates.ts
      dragdrop/
        DragDropManager.ts
        SymbolDragSource.ts
        RunDragSource.ts
        DropTargets.ts
      onboarding/
        OnboardingManager.ts
        WelcomeModal.ts
        TooltipGuide.ts
        FeatureDiscovery.ts
      accessibility/
        KeyboardManager.ts
        AriaLabeler.ts
        ReducedMotion.ts
        ScreenReaderAnnouncer.ts
    utils/
      PerformanceMonitor.ts
  media/
    tokens.css
    toast.css
    tooltip.css
    errorState.css
  webview/
    shared/
      toast.ts
      tooltip.ts
      errorState.ts
```

Registration in `extensions/quantlab/src/extension.ts`:
- Initialize ThemeProvider and register all webviews.
- Initialize NotificationManager and expose for other modules.
- Initialize ErrorRecovery and wire to engine/session events.
- Initialize DragDropManager and DropTargets.
- Initialize OnboardingManager on activation.
- Initialize KeyboardManager and ReducedMotion.

### 2. Design tokens and theme integration
Tokens:
- Create `media/tokens.css` as the single source of truth with all V8.1 tokens:
  - View stripe colors and width.
  - Status colors and complexity colors.
  - Typography tokens.
  - Optional spacing, radius, shadow, and z-index tokens only if already used by existing webview CSS.
- Load `media/tokens.css` into all webviews via `asWebviewUri`, no duplicated copies in bundles.

Theme integration:
- `themes.ts` detects VS Code theme and maps to `light`, `dark`, `high-contrast`.
- `ThemeProvider` sends theme variables to webviews and exposes `getInlineStyles()`.
- Update Chart/Action/Trade webview HTML builders to inject tokens CSS and theme variables.
- Update workbench tab stripe CSS (if not already) to read from tokens.
- Cache the last theme payload per webview and skip redundant updates.

Package.json contributions:
- Add `contributes.colors` for Quantlab view and status colors.
- Ensure all view stripe colors use `--ql-view-*` variables rather than hard-coded values.

### 3. Notifications system (toasts, badges, sounds)
Types and manager:
- Add `src/types/notifications.ts` with `QuantlabNotification`, triggers, and settings.
- Create `NotificationManager` that listens to:
  - HistoryState (job complete/failed).
  - Action view job events (progress -> completion).
  - Trade session events (fills, status changes, risk alerts).
- Manager writes to ToastService, BadgeManager, and optional SoundPlayer.
- Track viewed state at the History entry level (`viewedAt` timestamp) to compute unviewed counts without a separate store.
- Drop notifications for stale or unknown runIds/sessionIds to prevent cross-tab leakage.

Toast behavior:
- Auto-dismiss after 5000 ms for non-error notifications.
- Error and critical alerts persist until dismissed.
- Actions:
  - Job complete: "View Results"
  - Job failed: "View Logs"
  - Trade executed: optional "View Trade Panel"
  - Risk alert: "View Trade Panel" (modal for critical)
- When a user opens a run from a toast action, mark that run as viewed in HistoryState.

Toast presentation strategy:
- Primary path: workbench toast container (patch) renders bottom-right and stacks toasts spec-compliantly.
- ToastService calls `quantlab.showToast` with `{ id, type, title, message, actions, durationMs }` and `quantlab.dismissToast` for manual closes.
- Webview toasts are used only for view-local messages and reuse the same CSS tokens.
- If the workbench patch is not present, fall back to VS Code notifications and record the deviation in patch notes.
- Ensure toast styles use tokens, have `aria-live="polite"`, and respect reduced motion.

Badges:
- History button badge uses HistoryState unviewed count.
- Trade panel badge shows total open orders across sessions.
- BadgeManager centralizes updates and de-dupes changes.
- Coalesce badge updates (100-250 ms) to avoid UI churn.

Sounds:
- Optional sounds for fills, alerts, and job completion (settings gated).
- Use a lightweight webview-based audio helper where feasible; fallback to visual indicator if audio is unavailable.
- Preload sound assets once per session and reuse buffers to avoid repeated I/O.

Settings:
- `quantlab.notifications.showJobComplete`
- `quantlab.notifications.showJobFailed`
- `quantlab.notifications.showTradeExecuted`
- `quantlab.notifications.showRiskAlerts`
- `quantlab.notifications.showSessionStatus`
- `quantlab.notifications.soundEnabled`
- `quantlab.notifications.soundVolume`
- `quantlab.notifications.playFillSound`
- `quantlab.notifications.playAlertSound`
- `quantlab.notifications.playCompleteSound`
- Register all notification settings in `extensions/quantlab/package.json`.

### 4. Error states and recovery
Types and recovery manager:
- Add `src/types/errors.ts` for `QuantlabError` and recovery options.
- Implement `ErrorRecovery` to map chart/action/trade/global errors to recovery actions.
- Deduplicate repeated errors by `(source, code, context)` within a short window to prevent toast storms.
- Ensure only one global modal is active at a time; queue subsequent critical errors.

Chart view errors:
- No data for symbol: show message and "Change Symbol".
- Visualization error: show line number and "Edit Visualization Code".
- Chart crash: show "Reload Chart".

Action view errors:
- Job failed: show stack trace and "View Logs" + "Retry".
- Configuration invalid: inline validation errors and focus on fields.
- Data unavailable: show "Adjust Date Range".

Trade view errors:
- Broker disconnected: banner + auto-reconnect + "Retry".
- Order rejected: show reason and allow modify/resubmit.
- Session crashed: show "View Logs" + "Restart".

Global engine error:
- Modal with "View Details", "Report Issue", "Restart Engine".
- Ensure autosave and session pause are explicitly messaged.

Webview error UI:
- Create `ViewErrorStates.ts` and shared CSS for error cards.
- All error UI includes `role="alert"` and descriptive text for screen readers.
- Preserve the underlying view state so recovery actions can re-render without reinitializing the webview.

### 5. Drag-and-drop behaviors
Drag sources:
- Data panel symbols and watchlist symbols.
- History panel runs.

Drop targets:
- Chart view: symbol drop changes chart symbol; run drop loads artifacts.
- Global symbol selector: accept symbol drops to update global state.
- Editor: insert `"SYMBOL"` or `# Run ID: <id>` at cursor (DocumentDropEdit).
- Watchlist to watchlist: move or copy symbols (default copy; move when modifier key is held).
- Compare area (Action view): run drop adds run to compare selection.

Implementation:
- Use `TreeDragAndDropController` for Data and History panels.
- Use custom MIME types `quantlab/symbol` and `quantlab/run`, plus `text/plain`.
- Add webview drop handlers for Chart view with drop highlight styling.
- Add Action view drop handler to accept run drops into compare selection.
- Add a drop handler for global selector in workbench patch.
- Keep drag payloads minimal (symbol/runId only) and validate payloads before acting.
- File drag behaviors (Explorer -> tab/group) remain default VS Code behavior.

### 6. Onboarding flow and feature discovery
Onboarding state:
- Add `src/types/onboarding.ts` with `OnboardingState`, `OnboardingStep`, and `FeatureDiscoveryTrigger`.
- Persist in `globalState` key `quantlab.onboarding`.
- Do not show discovery tips if the user selected "Skip Tour".

Welcome modal:
- Implement `WelcomeModal` as a small webview panel (centered modal).
- Buttons:
  - Start with Template -> `quantlab.newFromTemplate`.
  - Open Existing -> `workbench.action.files.openFile`.
  - Skip Tour -> mark skipped.
- Lazy-load onboarding webview assets to keep activation fast.

View discovery tooltip:
- On first view switch, show tooltip anchored to view buttons.
- Tooltip explains Editor, Chart, Action, Trade, and right-click for multi-pane.

Feature discovery triggers:
- First backtest complete -> tip "View results in Chart".
- First parameter edit -> tip "Apply to Code to save permanently".
- First Trade view -> tip "Complete checklist before live trading".
- 10+ runs -> tip "Pin important runs in History".
- Tips show once per user; store dismissed tip IDs to prevent repeats.

### 7. Accessibility implementation
Keyboard navigation:
- Ensure view buttons are tab-focusable and activatable via Enter/Space.
- History dropdown supports arrow key navigation (QuickPick already compliant).
- Provide commands for focusing panels (existing Ctrl+Q 1-4 bindings).

Screen reader labels:
- View buttons: "Chart view button", "Action view button", "Trade view button".
- Tabs: include view name in ARIA label (already in Phase 1 patch).
- History entries: include run type, id, strategy name, status, and key metric.
- Progress announcements at 25/50/75/100 percent milestones.
- Ensure status indicators include text or icons in addition to color to meet contrast guidance.

Reduced motion:
- Add `quantlab.accessibility.reducedMotion` setting (`auto|always|never`).
- CSS disables transitions and animations when reduced motion is active.
- JS reduces progress bar animation and avoids auto-scroll.
- In webviews, honor `window.matchMedia('(prefers-reduced-motion: reduce)')` when `auto`.
- Register the reduced motion setting in `extensions/quantlab/package.json`.

Announcements:
- Implement `ScreenReaderAnnouncer` for key events:
  - View switches.
  - Job completion (success/fail).
  - Critical risk alerts.
- Use an `aria-live` region in webviews for non-modal announcements.

### 8. Webview integration updates
Chart view:
- Import tokens.css and theme variables.
- Add drop handling for symbols and runs.
- Use ErrorState components for no data and visualization errors.
- Route chart errors through `ErrorRecovery` so recovery actions are consistent.

Action view:
- Use tokens for status colors and metrics.
- Emit job progress announcements at milestones.
- Use error components for failed jobs and data issues.
- Emit notification triggers for job complete/failed (with runId).
- Accept run drops into the compare area and forward to HistoryState compare selection.

Trade view:
- Use tokens for PnL and status colors.
- Use error components for broker disconnect and session failures.
- Ensure open orders count updates Trade panel badge.
- Emit notification triggers for fills, session status changes, and risk alerts.

Shared:
- Use `AriaLabeler` for consistent ARIA labels in webview components.
- Respect reduced motion in all animations and transitions.
- Enforce message routing by tabInstanceId/sessionId to prevent cross-tab leakage.

### 9. Chrome, panels, and state wiring
History:
- Mark runs as viewed when opened from History dropdown or panel.
- Update History badge count in title bar.
- Persist `viewedAt` on the History entry to make counts stable across reloads.
- Badge count includes completed and failed runs only (not running/queued).

Trade panel badge:
- Compute open orders across active sessions and show count badge on Trade panel icon or header.
- Update badge only when the aggregate count changes.
- Prefer `TreeViewBadge` if available; otherwise update the panel header text without altering workflow.

Global selectors:
- Accept symbol drops via patched title bar handler.
- Ensure symbol drop triggers `GlobalState.setSymbol` and UI refresh.

### 10. Performance and stability improvements
Performance monitoring:
- Add `PerformanceMonitor` helper for activation, view switch, and toast display.
- Log warnings when targets are exceeded in dev builds.

Stability:
- Coalesce badge updates (e.g., 100-250ms).
- Limit notification history to a bounded ring (max 200).
- Avoid webview reloads for toast or tooltip changes.
- Lazy-load onboarding and tooltip assets; do not block activation.
- Reuse webview state caches for tokens/theme to avoid reflow on every message.

### 11. Final polish checklist
- UI text consistency (title case for commands, buttons, tooltips).
- Icons verified in light/dark/high-contrast themes.
- Reduced motion verified in both webviews and workbench.
- No hard-coded colors remain in webview CSS.
- Accessibility review (screen reader labels and keyboard focus).

## Testing and Verification

### Unit tests
- Token definitions and theme detection.
- NotificationManager trigger filtering and action wiring.
- Badge count updates for History and Trade.
- ErrorRecovery mapping for chart/action/trade/global errors.
- Onboarding state transitions and persistence.
- Reduced motion settings logic.
- History `viewedAt` persistence and unviewed count computation.

### Integration tests
- Job complete triggers toast and increments History badge.
- Job failed shows persistent error toast with "View Logs".
- Symbol drag from Data panel to Chart view changes chart symbol.
- Run drag from History to Chart view loads artifacts.
- Run drag from History to Compare area adds run to comparison.
- Drag symbol to global selector updates symbol and re-renders chart.
- Onboarding welcome modal appears only on first launch.
- View discovery tooltip appears on first view switch only.
- Trade fills trigger toast + badge update without duplicate toasts on reconnect.

### Manual verification checklist
- Toasts appear bottom-right and dismiss after 5 seconds (non-error).
- Error toasts persist until dismissed.
- Toasts appear in Editor view (no webview) via workbench container.
- History button badge updates when runs are viewed.
- Trade panel badge updates with open orders.
- Chart no-data error shows correct recovery actions.
- Action job failure shows logs and retry.
- Broker disconnect shows banner and retry.
- Reduced motion disables animations in views.
- Screen reader announces progress at 25 percent intervals.

## Exit Gates
- All V8.1 sections 8-13 implemented and verified.
- Accessibility requirements met (keyboard-only pass).
- No regressions in view switching or panel navigation.
- Notification and error flows exercised end-to-end.
- All Phase 6 tests pass.

## Performance Targets
- Extension activation overhead added by Phase 6 under 200 ms.
- Toast display under 50 ms from trigger.
- Drag start under 16 ms (no dropped frames).
- View switch overhead under 100 ms.

## Appendix: Settings Matrix (Phase 6)
- `quantlab.notifications.showJobComplete`: boolean
- `quantlab.notifications.showJobFailed`: boolean
- `quantlab.notifications.showTradeExecuted`: boolean
- `quantlab.notifications.showRiskAlerts`: boolean
- `quantlab.notifications.showSessionStatus`: boolean
- `quantlab.notifications.soundEnabled`: boolean
- `quantlab.notifications.soundVolume`: number (0-1)
- `quantlab.notifications.playFillSound`: boolean
- `quantlab.notifications.playAlertSound`: boolean
- `quantlab.notifications.playCompleteSound`: boolean
- `quantlab.accessibility.reducedMotion`: auto | always | never

## Appendix: Drag-and-Drop Matrix (Spec 12)
- Data panel symbol -> Chart view: change chart symbol.
- Data panel symbol -> Global selector: change global symbol.
- Data panel symbol -> Editor: insert symbol string.
- Watchlist symbol -> watchlist: move or copy.
- History run -> Chart view: load run artifacts.
- History run -> Editor: insert run ID reference.
- History run -> Compare area: add to comparison.

## Appendix: Error Matrix (Spec 10)
- Chart no data: message + change symbol action.
- Visualization error: line number + edit visualization code.
- Chart crash: reload button.
- Action job failed: stack trace + view logs + retry.
- Config invalid: inline validation + focus fields.
- Data unavailable: adjust date range.
- Trade broker disconnect: retry + settings.
- Order rejected: show reason + modify.
- Session crashed: view logs + restart.
- Global engine error: modal with view details/report/restart.
