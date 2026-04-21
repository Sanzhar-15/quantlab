# Prompt 06-04: Animation Polish

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 1 session
**Critical Path:** No

---

## Objective

Add subtle, purposeful animations throughout the QIC UI to improve perceived performance, provide feedback, and create a polished user experience. All animations must respect the user's reduced motion preferences.

---

## Context

Animations should:
- **Provide feedback**: Confirm user actions
- **Guide attention**: Direct focus to important changes
- **Improve perceived performance**: Make waits feel shorter
- **Feel native**: Match VS Code's animation style

Animation principles:
- Keep durations short (150-300ms)
- Use easing functions (ease-out for entries, ease-in for exits)
- Respect prefers-reduced-motion
- Don't animate for decoration—animate with purpose

Reference: `QIC_UI_SPEC/Optimal_plan/12-POLISH.md`

---

## Scope

### In Scope
- Message appear animations
- Context chip add/remove animations
- Drawer expand/collapse
- Menu open/close
- Loading states
- Status transitions
- Hover/focus states
- Scroll behaviors

### Out of Scope
- Complex choreographed animations
- 3D transforms
- Particle effects
- Sound effects

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] Base UI components working
- [ ] Git branch created: `qic-ui/06-04-animations`

---

## Tasks

### 1. Define Animation Variables

```css
/* Animation CSS Custom Properties */
:root {
  /* Durations */
  --qic-duration-fast: 100ms;
  --qic-duration-normal: 200ms;
  --qic-duration-slow: 300ms;

  /* Easings */
  --qic-ease-out: cubic-bezier(0.0, 0.0, 0.2, 1);
  --qic-ease-in: cubic-bezier(0.4, 0.0, 1, 1);
  --qic-ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1);
  --qic-ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Reduced motion: disable all custom animations */
@media (prefers-reduced-motion: reduce) {
  :root {
    --qic-duration-fast: 0ms;
    --qic-duration-normal: 0ms;
    --qic-duration-slow: 0ms;
  }
}
```

### 2. Message Animations

```css
/* Message appear animation */
@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message {
  animation: messageSlideIn var(--qic-duration-normal) var(--qic-ease-out);
}

/* Streaming message - subtle pulse while receiving */
.message.streaming .message-content {
  position: relative;
}

.message.streaming .message-content::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 8px;
  height: 2px;
  background: var(--vscode-textLink-foreground);
  animation: cursorBlink 1s infinite;
}

@keyframes cursorBlink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

/* Code block appear */
.message pre {
  animation: fadeIn var(--qic-duration-fast) var(--qic-ease-out);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

### 3. Context Chip Animations

```css
/* Chip add animation */
@keyframes chipAdd {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.context-chip {
  animation: chipAdd var(--qic-duration-fast) var(--qic-ease-bounce);
}

/* Chip remove animation */
.context-chip.removing {
  animation: chipRemove var(--qic-duration-fast) var(--qic-ease-in) forwards;
}

@keyframes chipRemove {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.8);
  }
}

/* Chip hover effect */
.context-chip {
  transition: background-color var(--qic-duration-fast) ease,
              transform var(--qic-duration-fast) ease;
}

.context-chip:hover {
  transform: translateY(-1px);
}

.context-chip:active {
  transform: scale(0.98);
}
```

### 4. Drawer Animations

```css
/* Drawer expand/collapse */
.context-drawer {
  transition: max-height var(--qic-duration-slow) var(--qic-ease-in-out);
  overflow: hidden;
}

.context-drawer.collapsed {
  max-height: 0;
}

.context-drawer.expanded {
  max-height: 400px;
}

/* Drawer content fade */
.context-drawer-content {
  transition: opacity var(--qic-duration-normal) ease;
}

.context-drawer.collapsed .context-drawer-content {
  opacity: 0;
}

.context-drawer.expanded .context-drawer-content {
  opacity: 1;
}

/* Chevron rotation */
.context-drawer .toggle-icon {
  transition: transform var(--qic-duration-fast) ease;
}

.context-drawer.expanded .toggle-icon {
  transform: rotate(180deg);
}

/* Drawer item expand */
.context-drawer-item-content {
  transition: max-height var(--qic-duration-normal) var(--qic-ease-in-out);
  max-height: 0;
  overflow: hidden;
}

.context-drawer-item.expanded .context-drawer-item-content {
  max-height: 200px;
}
```

### 5. Menu Animations

```css
/* Menu dropdown */
@keyframes menuOpen {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes menuClose {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-8px) scale(0.95);
  }
}

.header-menu {
  transform-origin: top right;
}

.header-menu.opening {
  animation: menuOpen var(--qic-duration-fast) var(--qic-ease-out) forwards;
}

.header-menu.closing {
  animation: menuClose var(--qic-duration-fast) var(--qic-ease-in) forwards;
}

/* Menu item hover */
.menu-item {
  transition: background-color var(--qic-duration-fast) ease;
}
```

### 6. Autocomplete Animations

```css
/* Autocomplete dropdown */
@keyframes acOpen {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.mention-autocomplete {
  animation: acOpen var(--qic-duration-fast) var(--qic-ease-out);
}

/* Item focus transition */
.mention-item {
  transition: background-color var(--qic-duration-fast) ease;
}
```

### 7. Change Card Animations

```css
/* Change card appear */
@keyframes cardSlideIn {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.change-card {
  animation: cardSlideIn var(--qic-duration-normal) var(--qic-ease-out);
}

/* Stagger multiple cards */
.change-set-cards .change-card:nth-child(1) { animation-delay: 0ms; }
.change-set-cards .change-card:nth-child(2) { animation-delay: 50ms; }
.change-set-cards .change-card:nth-child(3) { animation-delay: 100ms; }
.change-set-cards .change-card:nth-child(4) { animation-delay: 150ms; }
.change-set-cards .change-card:nth-child(5) { animation-delay: 200ms; }

/* Card status change */
.change-card {
  transition: border-color var(--qic-duration-normal) ease,
              background-color var(--qic-duration-normal) ease,
              opacity var(--qic-duration-normal) ease;
}

/* Applied state transition */
.change-card[data-status="applied"] {
  /* Smooth transition to success state */
}

.change-card[data-status="rejected"] {
  /* Smooth fade to muted state */
}
```

### 8. Loading States

```css
/* Typing indicator */
@keyframes typingDot {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.6;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
}

.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-foreground);
  animation: typingDot 1.4s infinite;
}

.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }

/* Skeleton loading */
@keyframes shimmer {
  from {
    background-position: -200% 0;
  }
  to {
    background-position: 200% 0;
  }
}

.skeleton {
  background: linear-gradient(
    90deg,
    var(--vscode-editor-background) 25%,
    var(--vscode-list-hoverBackground) 50%,
    var(--vscode-editor-background) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
}

/* Processing spinner */
@keyframes spin {
  to { transform: rotate(360deg); }
}

.processing-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--vscode-foreground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

### 9. Status Bar Animations

```css
/* Status change */
.qic-status-bar {
  transition: color var(--qic-duration-fast) ease,
              background-color var(--qic-duration-fast) ease;
}

/* Processing pulse */
.qic-status-bar.processing::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--vscode-button-background);
  opacity: 0;
  animation: statusPulse 2s infinite;
}

@keyframes statusPulse {
  0%, 100% { opacity: 0; }
  50% { opacity: 0.1; }
}
```

### 10. Scroll Behaviors

```css
/* Smooth scroll to new messages */
.conversation {
  scroll-behavior: smooth;
}

/* Respect preference */
@media (prefers-reduced-motion: reduce) {
  .conversation {
    scroll-behavior: auto;
  }
}
```

### 11. Button Interactions

```css
/* Button press effect */
.btn {
  transition: transform var(--qic-duration-fast) ease,
              background-color var(--qic-duration-fast) ease;
}

.btn:active {
  transform: scale(0.97);
}

/* Send button special effect */
.send-btn {
  transition: all var(--qic-duration-fast) ease;
}

.send-btn:hover:not(:disabled) {
  transform: scale(1.05);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.95);
}

/* Disabled state fade */
.btn:disabled {
  transition: opacity var(--qic-duration-normal) ease;
}
```

### 12. Focus Ring Animations

```css
/* Animated focus ring */
@keyframes focusRing {
  from {
    box-shadow: 0 0 0 0 var(--vscode-focusBorder);
  }
  to {
    box-shadow: 0 0 0 2px var(--vscode-focusBorder);
  }
}

/* Apply to focusable elements */
.context-chip:focus,
.change-card:focus-within {
  animation: focusRing var(--qic-duration-fast) var(--qic-ease-out) forwards;
}
```

---

## Verification

### Success Criteria
- [ ] All animations smooth (60fps)
- [ ] Animations under 300ms
- [ ] Reduced motion disables animations
- [ ] No janky transitions
- [ ] Loading states clear
- [ ] Feedback feels responsive
- [ ] Animations serve purpose

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Message appear | Send message | Slides in smoothly |
| Chip add | Add context | Scales in |
| Chip remove | Remove context | Scales out |
| Drawer expand | Toggle drawer | Smooth expand |
| Menu open | Click menu | Fades in from top |
| Card appear | Receive changes | Cards stagger in |
| Reduced motion | Enable pref | No animations |

### Performance Tests

| Animation | Target FPS | Actual | Pass |
|-----------|------------|--------|------|
| Message appear | 60 | | ☐ |
| Chip animations | 60 | | ☐ |
| Drawer expand | 60 | | ☐ |
| Menu open/close | 60 | | ☐ |
| Loading spinner | 60 | | ☐ |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Use CSS animations over JS when possible
- GPU-accelerate with transform/opacity
- Avoid animating layout properties (width, height, margin)
- Test on lower-end devices
- Consider using will-change sparingly
- Match VS Code's subtle animation style

