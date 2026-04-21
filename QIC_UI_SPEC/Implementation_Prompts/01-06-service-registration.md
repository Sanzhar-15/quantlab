# Prompt 01-06: Service Registration

**Phase:** 1 - Foundation
**Dependencies:** 01-02 (State Service), 01-04 (Message Bridge)
**Estimated Effort:** 0.5 session
**Critical Path:** Yes

---

## Objective

Register the `QicStateService` as a VS Code singleton service and integrate the message bridge into the QIC panel.

---

## Context

VS Code uses dependency injection. Services must be:
1. Registered with a decorator
2. Registered with `registerSingleton`
3. Injected via constructor

Reference: `QIC_UI_SPEC/Optimal_plan/03-STATE-AND-PROTOCOL.md`

---

## Scope

### In Scope
- Register QicStateService as singleton
- Update QicChatViewPane to use state service
- Initialize message bridge in panel
- Wire basic message flow

### Out of Scope
- Full message handling (migration period)
- UI updates (Phase 2)
- Removing legacy code

---

## Pre-Conditions

- [ ] 01-02 complete (QicStateService implemented)
- [ ] 01-04 complete (Message bridge implemented)
- [ ] Git branch created: `qic-ui/01-06-registration`

---

## Tasks

### 1. Export Service from Index

If not already, ensure exports are available:

```typescript
// src/vs/workbench/contrib/qic/common/state/index.ts (create if needed)
export * from './qicStateService.js';
```

### 2. Register Singleton

```typescript
// src/vs/workbench/contrib/qic/browser/qic.contribution.ts

import { registerSingleton, InstantiationType } from 'vs/platform/instantiation/common/extensions';
import { IQicStateService, QicStateService } from '../common/state/qicStateService.js';

// Add to existing registrations
registerSingleton(IQicStateService, QicStateService, InstantiationType.Eager);
```

### 3. Update QicChatViewPane Constructor

```typescript
// src/vs/workbench/contrib/qic/browser/qicPanel.ts

import { IQicStateService } from '../common/state/qicStateService.js';
import { QicMessageBridge } from './messageBridge.js';

export class QicChatViewPane extends ViewPane {
    private messageBridge: QicMessageBridge | undefined;

    constructor(
        options: IViewPaneOptions,
        @IKeybindingService keybindingService: IKeybindingService,
        @IContextMenuService contextMenuService: IContextMenuService,
        @IConfigurationService configurationService: IConfigurationService,
        @IContextKeyService contextKeyService: IContextKeyService,
        @IViewDescriptorService viewDescriptorService: IViewDescriptorService,
        @IInstantiationService instantiationService: IInstantiationService,
        @IOpenerService openerService: IOpenerService,
        @IThemeService themeService: IThemeService,
        @ITelemetryService telemetryService: ITelemetryService,
        @IHoverService hoverService: IHoverService,
        // ADD: State service injection
        @IQicStateService private readonly stateService: IQicStateService,
        // ... other services
    ) {
        super(options, keybindingService, contextMenuService, configurationService,
              contextKeyService, viewDescriptorService, instantiationService,
              openerService, themeService, telemetryService, hoverService);
    }
```

### 4. Initialize Message Bridge

```typescript
// In QicChatViewPane, after webview is created

protected override renderBody(container: HTMLElement): void {
    super.renderBody(container);

    // ... existing webview creation code ...

    // Initialize message bridge
    this.messageBridge = new QicMessageBridge(
        this.stateService,
        (msg) => this.webview?.postMessage(msg)
    );
    this._register(this.messageBridge);
}
```

### 5. Wire Message Handling

```typescript
// In message handler

private handleWebviewMessage(msg: any): void {
    // Try V2 message bridge first
    if (this.messageBridge?.handleWebviewMessage(msg)) {
        return; // Handled by bridge
    }

    // Fall back to legacy handling
    switch (msg.type) {
        case 'user-message':
            // ... existing code
            break;
        // ... etc
    }
}
```

### 6. Update Webview Ready Handling

```typescript
// When webview sends 'ready', bridge handles it automatically
// But we may need to do additional setup

private onWebviewReady(): void {
    // Bridge already handles 'ready' message
    // Any additional initialization here

    // Example: set initial service status
    this.stateService.setServiceStatus('ready');
}
```

### 7. Update Panel Disposal

```typescript
override dispose(): void {
    // Message bridge disposed via _register

    // ... existing disposal code ...

    super.dispose();
}
```

---

## Verification

### Success Criteria
- [ ] Service registered without errors
- [ ] Panel instantiates with state service
- [ ] Message bridge created
- [ ] Basic message flow works
- [ ] No runtime errors

### Verification Commands
```bash
# Build
npm run compile

# Check for injection errors (run VS Code)
# Open Developer Tools > Console
# Look for "Cannot find service" errors
```

### Manual Verification

1. Open VS Code with extension
2. Open QIC panel
3. Check console for errors
4. Verify panel renders
5. Send a message - should still work (legacy path)

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/qic.contribution.ts
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
```

---

## Code Changes

### Files Modified
| File | Change |
|------|--------|
| `qic.contribution.ts` | Add service registration |
| `qicPanel.ts` | Add injection, create bridge |

---

## Notes

- Keep legacy message handling during migration
- Bridge handles V2 messages, legacy code handles V1
- Both can coexist
- Don't break existing functionality
