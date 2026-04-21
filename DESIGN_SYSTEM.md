# Quantlab Design System

**Version**: 1.0.0
**Status**: DRAFT
**Decision Reference**: K67

This document defines the visual design language, component patterns, and accessibility requirements for Quantlab.

---

## 1. Design Principles

### 1.1 Core Principles

1. **Clarity over Decoration**: Every element serves a purpose. Avoid visual noise.
2. **Information Density**: Trading requires high information density without clutter.
3. **Immediate Feedback**: Actions should have instant visual confirmation.
4. **Error Prevention**: Make dangerous actions (live trading) visually distinct.
5. **Accessibility First**: All functionality must be keyboard-accessible.

### 1.2 Trading-Specific Principles

- **Red/Green Convention**: Red = loss/sell, Green = profit/buy (configurable for colorblind users)
- **Live vs Backtest Distinction**: Live trading UI must be visually distinct
- **Risk Visibility**: Risk levels and limits always visible during trading

---

## 2. Color System

### 2.1 Base Colors

```css
/* Background */
--ql-bg-primary: #1e1e1e;      /* Main background */
--ql-bg-secondary: #252526;    /* Panel backgrounds */
--ql-bg-tertiary: #2d2d30;     /* Elevated surfaces */
--ql-bg-hover: #3c3c3c;        /* Hover states */
--ql-bg-active: #4a4a4a;       /* Active/selected states */

/* Text */
--ql-text-primary: #cccccc;    /* Primary text */
--ql-text-secondary: #858585;  /* Secondary text */
--ql-text-disabled: #5a5a5a;   /* Disabled text */
--ql-text-inverse: #1e1e1e;    /* Text on light backgrounds */

/* Borders */
--ql-border-primary: #3c3c3c;
--ql-border-secondary: #2d2d30;
--ql-border-focus: #007acc;
```

### 2.2 Semantic Colors

```css
/* Trading Colors */
--ql-profit: #4caf50;          /* Green - profit, buy */
--ql-loss: #f44336;            /* Red - loss, sell */
--ql-neutral: #9e9e9e;         /* Gray - unchanged */

/* Status Colors */
--ql-info: #2196f3;            /* Information */
--ql-success: #4caf50;         /* Success */
--ql-warning: #ff9800;         /* Warning */
--ql-error: #f44336;           /* Error */

/* Live Trading Accent */
--ql-live-accent: #ff5722;     /* Orange - indicates live trading */
--ql-live-bg: #3d2a22;         /* Live trading background tint */
```

### 2.3 Colorblind-Safe Palette

```css
/* Alternative palette for deuteranopia/protanopia */
--ql-profit-safe: #2196f3;     /* Blue for profit */
--ql-loss-safe: #ff9800;       /* Orange for loss */
```

---

## 3. Typography

### 3.1 Font Stack

```css
/* UI Text */
--ql-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;

/* Code/Monospace */
--ql-font-mono: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Droid Sans Mono', monospace;

/* Numbers in Tables */
--ql-font-tabular: 'SF Mono', 'Monaco', monospace;
font-variant-numeric: tabular-nums;
```

### 3.2 Font Sizes

```css
--ql-font-xs: 11px;
--ql-font-sm: 12px;
--ql-font-base: 13px;
--ql-font-md: 14px;
--ql-font-lg: 16px;
--ql-font-xl: 18px;
--ql-font-xxl: 24px;
```

### 3.3 Font Weights

```css
--ql-weight-normal: 400;
--ql-weight-medium: 500;
--ql-weight-semibold: 600;
--ql-weight-bold: 700;
```

---

## 4. Spacing

### 4.1 Spacing Scale

```css
--ql-space-1: 4px;
--ql-space-2: 8px;
--ql-space-3: 12px;
--ql-space-4: 16px;
--ql-space-5: 20px;
--ql-space-6: 24px;
--ql-space-8: 32px;
--ql-space-10: 40px;
--ql-space-12: 48px;
```

### 4.2 Component Spacing

| Element | Padding | Gap |
|---------|---------|-----|
| Button | 8px 16px | - |
| Input | 6px 12px | - |
| Card | 16px | - |
| List Item | 8px 12px | - |
| Table Cell | 8px 12px | - |

---

## 5. Component Patterns

### 5.1 Buttons

```
Primary:   Blue background, white text (actions)
Secondary: Transparent, border (cancel/neutral)
Danger:    Red background (destructive actions)
Ghost:     No border (inline actions)

States: default, hover, active, disabled, loading
```

### 5.2 Trading-Specific Components

#### Position Card
```
┌─────────────────────────────────┐
│ AAPL           +$1,234  +2.5%   │
│ 100 shares @ $152.30            │
│ [P&L indicator bar]             │
└─────────────────────────────────┘
```

#### Order Entry
```
┌─────────────────────────────────┐
│ BUY  │ SELL  │ (toggle)         │
├─────────────────────────────────┤
│ Symbol: [AAPL        ]          │
│ Qty:    [100         ]          │
│ Type:   [MARKET      v]         │
│ Limit:  [           ] (if LIMIT)│
├─────────────────────────────────┤
│ Est. Cost: $15,230              │
│ Buying Power: $84,770           │
├─────────────────────────────────┤
│ [Review Order]                  │
└─────────────────────────────────┘
```

#### Live Session Indicator
```
┌─────────────────────────────────┐
│ 🔴 LIVE  │  Session: 2h 34m     │
│ P&L: +$1,234  │  5 positions    │
└─────────────────────────────────┘
```

---

## 6. Iconography

### 6.1 Icon Guidelines

- Use VS Code Codicon set where possible
- 16x16px default size
- Single color (inherits text color)
- Consistent stroke width (1.5px)

### 6.2 Trading Icons

| Icon | Meaning |
|------|---------|
| ▲ | Buy / Long |
| ▼ | Sell / Short |
| ● | Active position |
| ◐ | Partial fill |
| ✓ | Filled |
| ✕ | Cancelled/Rejected |
| ⚠ | Warning |
| 🔴 | Live trading |

---

## 7. Motion and Animation

### 7.1 Duration

```css
--ql-duration-instant: 50ms;
--ql-duration-fast: 100ms;
--ql-duration-normal: 200ms;
--ql-duration-slow: 300ms;
```

### 7.2 Easing

```css
--ql-ease-default: cubic-bezier(0.4, 0, 0.2, 1);
--ql-ease-in: cubic-bezier(0.4, 0, 1, 1);
--ql-ease-out: cubic-bezier(0, 0, 0.2, 1);
```

### 7.3 Animation Guidelines

- Prefer `transform` and `opacity` for performance
- No animation on critical trading actions (instant feedback)
- Reduce motion for users with `prefers-reduced-motion`

---

## 8. Accessibility

### 8.1 WCAG 2.1 AA Compliance

- **Contrast**: Minimum 4.5:1 for text, 3:1 for large text
- **Focus**: Visible focus indicators on all interactive elements
- **Keyboard**: All functionality accessible via keyboard
- **Screen Reader**: ARIA labels on all controls

### 8.2 Focus Indicators

```css
:focus-visible {
  outline: 2px solid var(--ql-border-focus);
  outline-offset: 2px;
}
```

### 8.3 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + B` | Toggle sidebar |
| `Cmd/Ctrl + Shift + B` | Run backtest |
| `Cmd/Ctrl + Shift + F` | Flatten all (with confirmation) |
| `Escape` | Cancel current action |
| `Tab` / `Shift+Tab` | Navigate between elements |

### 8.4 Screen Reader Labels

```html
<button aria-label="Buy 100 shares of AAPL at market price">
  Buy AAPL
</button>

<div role="status" aria-live="polite">
  Order filled: 100 AAPL @ $152.30
</div>
```

---

## 9. Responsive Behavior

### 9.1 Minimum Sizes

- **Window**: 1024 × 768 minimum
- **Chart Panel**: 400px minimum width
- **Side Panel**: 250px minimum, 400px maximum

### 9.2 Panel Behavior

- Panels collapse to icons at narrow widths
- Chart maintains aspect ratio
- Tables scroll horizontally if needed

---

## 10. Dark/Light Mode

### 10.1 Theme Support

- **Dark Mode**: Primary (default)
- **Light Mode**: Supported
- **System**: Follow OS preference

### 10.2 Light Mode Overrides

```css
[data-theme="light"] {
  --ql-bg-primary: #ffffff;
  --ql-bg-secondary: #f5f5f5;
  --ql-text-primary: #1e1e1e;
  /* ... additional overrides */
}
```

---

## 11. Implementation Notes

### 11.1 CSS Custom Properties

All design tokens exposed as CSS custom properties for runtime theming.

### 11.2 Component Library

Components built with:
- React (webview)
- VS Code's built-in UI toolkit (native)

### 11.3 Testing

- Visual regression tests for all components
- Accessibility audit with axe-core
- Color contrast validation

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-26 | Initial design system stub |

---

*This design system is a living document. Updates require design review.*
