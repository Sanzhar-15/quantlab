# Prompt 00 — QIC Scaffold & Quantlab Workbench Integration

**Phase**: Pre-Phase (Before Phase 0)
**Prerequisites**: None (this is the first prompt)
**Estimated Scope**: ~15 files created, ~3 files modified

---

## Objective

Create the QIC (Quantlab Intelligence Console) module scaffold within the Quantlab codebase and register it as a built-in workbench contribution in the auxiliary bar (right-hand side panel). This establishes the project skeleton that all subsequent prompts build upon.

**CRITICAL CONTEXT**: Quantlab is a VS Code fork. QIC is NOT a standalone extension — it is a built-in workbench contribution, similar to how Cursor AI implements their RHS AI bar. The code lives directly inside the workbench source tree at `src/vs/workbench/contrib/qic/`.

---

## Spec References

- QIC Spec v6.2: §1.x Executive Summary (lines 1–200) — What QIC is
- QIC Spec v6.2: §3.1 Component Overview (lines 2071–2119) — Architecture overview
- Implementation Plan v3: Phase 0 Scaffold (lines 330–427) — Extension scaffold & activation

## Audit Fixes Incorporated

- **I-3 (CRITICAL)**: Security egress blocker stub must exist from the very start. Create a block-all-by-default `EgressBoundaryEnforcer` stub.
- **C-1 (CRITICAL)**: Follow the implementation plan's 12-phase structure (NOT the spec's Section 15.1 phasing).

---

## Codebase Context

Study these existing patterns before implementing:

1. **Workbench contribution registration**: `src/vs/workbench/workbench.common.main.ts` — Central import hub. QIC must be imported here.
2. **Auxiliary bar**: `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` — RHS panel implementation.
3. **View container registration**: `src/vs/workbench/common/views.ts` — `ViewContainerLocation.AuxiliaryBar` enum value.
4. **Existing contribution pattern**: `src/vs/workbench/contrib/chat/browser/chat.contribution.ts` — Study how VS Code's built-in chat registers view containers, views, actions, and services.
5. **Service injection**: `src/vs/platform/instantiation/common/extensions.ts` — `registerSingleton()` pattern.
6. **Quantlab-specific patterns**: `src/vs/workbench/browser/parts/editor/editor.contribution.ts` — How Quantlab registers its custom services.

---

## Implementation Instructions

### 0. Investigate Existing AI Infrastructure

**Before scaffolding QIC**, read and analyze the existing AI module at `extensions/quantlab/src/ai/` — specifically these files:
- `provider.ts` — `ClaudeProvider` class with streaming, `content_block_delta` handling
- `consent.ts` — Data consent tracking with categories (strategy_code, error_messages, etc.)
- `sanitize.ts` — Pattern-based sensitive data redaction
- `audit.ts` — Per-request audit logging with metrics
- `context.ts` — Context building for AI requests
- `types.ts` — AI/LLM type definitions

**Document what can be reused vs what QIC needs to extend.** This analysis directly informs:
- Prompt 06 (Security Foundation) — ConsentStore and SecretScanner should extend, not duplicate, the existing consent and sanitization systems
- Prompt 08 (Gateway & Provider Adapters) — AnthropicAdapter should reuse connection configuration from the existing ClaudeProvider
- Prompt 14 (Security Hardening) — SecurityAuditLogger should complement, not replace, the existing audit system

Create a brief analysis file at `src/vs/workbench/contrib/qic/AI_INFRASTRUCTURE_ANALYSIS.md` summarizing:
1. Which existing components QIC can directly reuse
2. Which existing components QIC needs to extend
3. Which components QIC must build new (no existing equivalent)

### 1. Create the QIC Directory Structure

```
src/vs/workbench/contrib/qic/
├── browser/
│   ├── qic.contribution.ts          # Main contribution registration (like chat.contribution.ts)
│   ├── qicPanel.ts                   # Main QIC panel view pane
│   └── media/
│       └── qic.css                   # QIC-specific styles
├── common/
│   ├── qicService.ts                 # IQicService interface + service identifier
│   ├── qicContextKeys.ts            # Context keys for QIC state
│   └── constants.ts                  # QIC constants (view IDs, command IDs)
└── README.md                         # Module documentation (keep minimal)
```

### 2. Define Constants (`common/constants.ts`)

```typescript
// View container and view IDs
export const QIC_VIEW_CONTAINER_ID = 'workbench.view.qic';
export const QIC_CHAT_VIEW_ID = 'workbench.view.qic.chat';
export const QIC_TITLE = 'QIC';

// Command IDs
export const TOGGLE_QIC_COMMAND_ID = 'workbench.action.toggleQIC';
export const QIC_NEW_CHAT_COMMAND_ID = 'qic.newChat';
export const QIC_FOCUS_INPUT_COMMAND_ID = 'qic.focusInput';

// Storage keys
export const QIC_STATE_STORAGE_KEY = 'qic.state';

// Output channel
export const QIC_OUTPUT_CHANNEL_ID = 'QIC';
```

### 3. Define the QIC Service Interface (`common/qicService.ts`)

Create `IQicService` as the main service interface for QIC. This will be expanded in later prompts. For now, it needs:

```typescript
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQicService = createDecorator<IQicService>('qicService');

export interface IQicService {
    readonly _serviceBrand: undefined;

    // Will be expanded in subsequent prompts
    isReady(): boolean;
    getState(): QicState;
}

export type QicState = 'initializing' | 'ready' | 'degraded' | 'error';
```

### 4. Register the QIC View Container (`browser/qic.contribution.ts`)

Follow the pattern from `chat.contribution.ts`. Use `.js` extensions in all imports (Quantlab's ESM convention). Use `localize()` from `nls.js` for all user-facing strings. Extend `Disposable` for automatic cleanup.

**Required imports** (use exact Quantlab patterns):

```typescript
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry }
  from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
```

Registration steps:

1. Register a view container in `ViewContainerLocation.AuxiliaryBar` with:
   - ID: `QIC_VIEW_CONTAINER_ID`
   - Title: `localize('qic', 'QIC')` (use localize for all user-facing strings)
   - Icon: Use `Codicon.sparkle` (or a custom QIC icon)
   - Order: Place it as the first item in the auxiliary bar

2. Register the QIC chat view inside this container:
   - ID: `QIC_CHAT_VIEW_ID`
   - Name: `localize('qicChat', 'Chat')`
   - Use `SyncDescriptor` pointing to the QIC panel class

3. Register the toggle command (`TOGGLE_QIC_COMMAND_ID`) that:
   - Opens/focuses the auxiliary bar with QIC visible
   - Keybinding: `Ctrl+Shift+I` (or `Cmd+Shift+I` on Mac)
   - **When QIC panel is opened for the first time, automatically show the auxiliary bar if hidden** using `IWorkbenchLayoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART)`
   - Add QIC toggle to the existing Layout Control Menu (`MenuId.LayoutControlMenu`) so it appears alongside other layout toggles

4. Register `IQicService` as a singleton (delayed instantiation)

### 5. Create the QIC Panel (`browser/qicPanel.ts`)

Create a `QicChatViewPane` class that extends `ViewPane` (from `src/vs/workbench/browser/parts/views/viewPane.ts`):

- Override `renderBody()` to create a simple placeholder container with:
  - A div for chat messages area (empty for now)
  - A div for the input area (with a simple text input and send button)
  - Text: "QIC is initializing..."
- Override `layoutBody()` for proper sizing
- Inject `IQicService` via constructor

This is a **placeholder** — the real chat UI comes in Prompt 18. The goal here is to verify the panel renders in the auxiliary bar.

### 6. Create QIC Context Keys (`common/qicContextKeys.ts`)

```typescript
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const QIC_PANEL_VISIBLE = new RawContextKey<boolean>('qicPanelVisible', false);
export const QIC_HAS_PROVIDER = new RawContextKey<boolean>('qicHasProvider', false);
export const QIC_IS_PROCESSING = new RawContextKey<boolean>('qicIsProcessing', false);
export const QIC_IS_READY = new RawContextKey<boolean>('qicIsReady', false);
```

### 7. Create the Egress Blocker Stub (Audit Fix I-3)

Create `src/vs/workbench/contrib/qic/common/egressBlocker.ts`:

```typescript
/**
 * STUB: Block-all-by-default egress boundary enforcer.
 * This ensures NO data leaves the system until Phase 2 (Security Foundation)
 * replaces this with the real EgressBoundaryEnforcer.
 *
 * [STUB] — Must be replaced by Phase 2.
 */
export class EgressBoundaryEnforcer {
    async checkEgress(boundary: string, data: unknown): Promise<{ allowed: boolean; reason?: string }> {
        console.warn('[STUB] EgressBoundaryEnforcer.checkEgress — BLOCKING all egress');
        return { allowed: false, reason: 'QIC security not yet initialized. Egress blocked by default.' };
    }
}
```

### 8. Register in Workbench Main

Add the QIC contribution import to `src/vs/workbench/workbench.common.main.ts`:

```typescript
// QIC - Quantlab Intelligence Console
import './contrib/qic/browser/qic.contribution.js';
```

Place this alongside the other `contrib` imports (near the chat contribution import).

### 9. Add Basic CSS (`browser/media/qic.css`)

Minimal styles for the placeholder panel:

```css
.qic-chat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
}

.qic-messages-area {
    flex: 1;
    overflow-y: auto;
}

.qic-input-area {
    display: flex;
    gap: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
}

.qic-input-area input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 4px 8px;
    border-radius: 2px;
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` | Main contribution registration |
| `src/vs/workbench/contrib/qic/browser/qicPanel.ts` | Chat panel view pane (placeholder) |
| `src/vs/workbench/contrib/qic/browser/media/qic.css` | QIC styles |
| `src/vs/workbench/contrib/qic/common/qicService.ts` | IQicService interface |
| `src/vs/workbench/contrib/qic/common/qicContextKeys.ts` | Context keys |
| `src/vs/workbench/contrib/qic/common/constants.ts` | Constants |
| `src/vs/workbench/contrib/qic/common/egressBlocker.ts` | Egress stub (audit fix I-3) |

## Files to Modify

| File | Change |
|------|--------|
| `src/vs/workbench/workbench.common.main.ts` | Add QIC contribution import |

---

## Acceptance Criteria

```
□ QIC directory structure created at src/vs/workbench/contrib/qic/
□ QIC panel appears in the auxiliary bar (right side) when toggled
□ Ctrl+Shift+I (Cmd+Shift+I on Mac) toggles the QIC panel
□ QIC panel shows placeholder content ("QIC is initializing...")
□ IQicService is registered and injectable
□ EgressBoundaryEnforcer stub exists and blocks all egress by default
□ Context keys are registered (qicPanelVisible, qicHasProvider, etc.)
□ TypeScript compilation succeeds with no errors (npx tsc --noEmit)
□ Quantlab launches without errors with the new QIC panel
```

---

## Anti-Patterns to Avoid

- Do NOT create QIC as a standalone VS Code extension. It must be a workbench contribution.
- Do NOT add any external dependencies yet — this is pure scaffold.
- Do NOT implement real AI functionality — this is just the skeleton.
- Do NOT use `vscode.*` extension API — use internal workbench APIs (`src/vs/...`).

---

## Audit Fixes Applied

| Fix ID | Severity | Description |
|--------|----------|-------------|
| **III-QI1** | CRITICAL | Added "Investigate Existing AI Infrastructure" step (Section 0) before scaffolding, requiring analysis of `extensions/quantlab/src/ai/` to prevent duplicate infrastructure in Prompts 06, 08, 14 |
| **III-QI7** | MEDIUM | Updated registration code section with exact Quantlab import patterns, `.js` ESM extensions, `localize()` for user-facing strings, and `Disposable` for lifecycle management |
| **III-QI8** | MEDIUM | Added auxiliary bar auto-show via `IWorkbenchLayoutService.setPartHidden()` on first QIC open, and registration of QIC toggle in `MenuId.LayoutControlMenu` |
