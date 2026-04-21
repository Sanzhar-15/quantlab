# LHS Drawing Toolbar - Master Architecture

## Overview

This document defines the optimal Left-Hand Side (LHS) drawing toolbar for a professional trading charting platform. The design prioritizes speed, intuition, and workflow efficiency for technical analysis.

## Design Principles

1. **10 Main Buttons + Compact Dock** - Fits any screen without scrolling
2. **Click = Last Used Tool** - Single click activates the most recently used tool in that group
3. **Hold = Full Menu** - Long press reveals all tools in that category
4. **≤2 Clicks for Any Tool** - No deep nesting; maximum 2 levels
5. **Intent-Based Naming** - Button names match trader mental models
6. **State/Action Separation** - Controls (snap/lock/visibility) are visually distinct from creation tools

---

## Visual Structure

```
┌─────────────────────────────────────┐
│          ⋮⋮ DRAG HANDLE            │
└─────────────────────────────────────┘

╭─────────────────────────────────────╮
│                                     │
│      ══ SECTION A: META ══          │
│                                     │
│   🔍 HUB                            │
│                                     │
│      ─ ─ ─ ─ ─ ─ ─ ─ ─              │
│                                     │
│      ══ SECTION B: MARK ══          │
│                                     │
│   ─  LEVELS                         │
│   ╱  TREND                          │
│   ⫽  STRUCTURE                      │
│   ▭  ZONES                          │
│                                     │
│      ─ ─ ─ ─ ─ ─ ─ ─ ─              │
│                                     │
│     ══ SECTION C: ANALYZE ══        │
│                                     │
│   ϕ  OVERLAYS                       │
│   ◇  PATTERNS                       │
│                                     │
│      ─ ─ ─ ─ ─ ─ ─ ─ ─              │
│                                     │
│     ══ SECTION D: EXECUTE ══        │
│                                     │
│   ◎  PLAN                           │
│   📏 MEASURE                        │
│                                     │
│      ─ ─ ─ ─ ─ ─ ─ ─ ─              │
│                                     │
│    ══ SECTION E: ANNOTATE ══        │
│                                     │
│   T  ANNOTATE                       │
│                                     │
│      ═══════════════════            │
│                                     │
│     ══ SECTION F: CONTROL ══        │
│                                     │
│   ┌─────────┬─────────┐             │
│   │ 🧲 SNAP │ 🔒 LOCK │             │
│   ├─────────┼─────────┤             │
│   │ 👁 VIS  │ 🗑 DEL  │             │
│   └─────────┴─────────┘             │
│                                     │
│   ┌─────────────────────┐           │
│   │      ··· MORE       │           │
│   └─────────────────────┘           │
│                                     │
╰─────────────────────────────────────╯

┌─────────────────────────────────────┐
│          ⋮⋮ DRAG HANDLE            │
└─────────────────────────────────────┘
```

---

## Section Summary

| Section | Buttons | Purpose |
|---------|---------|---------|
| **A: META** | Hub | Navigation, discovery, personalization |
| **B: MARK** | Levels, Trend, Structure, Zones | Core chart markup geometry |
| **C: ANALYZE** | Overlays, Patterns | Analytical frameworks |
| **D: EXECUTE** | Plan, Measure | Trade planning & quantification |
| **E: ANNOTATE** | Annotate | Documentation & communication |
| **F: CONTROL** | 2×2 Dock + More | State management |

---

## Interaction Patterns

### Click Behavior
- **Single Click** → Activate last-used tool in that group
- If no tool used yet → Activate the default tool for that group

### Hold/Long-Press Behavior
- **Hold (300ms+)** → Open the tool panel/menu
- Panel appears to the RIGHT of the toolbar (never obscuring chart center)

### Panel Behavior
- Panels close when:
  - User clicks outside the panel
  - User selects a tool
  - User presses Escape
- Panels remain open if user is hovering/interacting

### Last-Used Memory
- Each button remembers the last tool selected within its group
- Persisted to localStorage
- Survives page refresh and sessions

---

## Visual Design Specifications

### Toolbar Container
- **Position**: Floating, left-hand side, vertically centered
- **Background**: Semi-transparent dark (rgba(30, 30, 35, 0.95))
- **Border Radius**: 12px
- **Padding**: 8px vertical, 6px horizontal
- **Shadow**: 0 4px 20px rgba(0, 0, 0, 0.3)
- **Draggable**: Yes, via top/bottom handles

### Button Styling
- **Size**: 40px × 40px
- **Border Radius**: 8px
- **Icon Size**: 20px
- **Default State**: Transparent background, muted icon color
- **Hover State**: Light background tint, full icon color
- **Active State**: Accent color background, white icon
- **Has-Dropdown Indicator**: Small dot or chevron on bottom-right

### Section Dividers
- **Style**: 1px dashed line, 50% opacity
- **Margin**: 8px top/bottom
- **Purpose**: Visual grouping without hard borders

### Panel Styling
- **Position**: Anchored to right edge of clicked button
- **Background**: Same as toolbar (rgba(30, 30, 35, 0.98))
- **Border Radius**: 8px
- **Min Width**: 200px
- **Max Width**: 280px
- **Max Height**: 70vh (scrollable if needed)
- **Animation**: Fade in + slight slide (150ms ease-out)

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘K` / `Ctrl+K` | Open Hub command palette |
| `L` | Levels (last used) |
| `T` | Trend (last used) |
| `S` | Structure (last used) |
| `Z` | Zones (last used) |
| `F` | Overlays/Fib (last used) |
| `P` | Patterns (last used) |
| `R` | Plan/Risk (last used) |
| `M` | Measure (last used) |
| `A` | Annotate (last used) |
| `Escape` | Deselect tool / Close panel |
| `Delete` | Delete selected drawing |
| `⌘Z` / `Ctrl+Z` | Undo |

---

## State Management

### Global State
```typescript
interface ToolbarState {
  // Active tool (null = selection mode)
  activeTool: string | null;
  
  // Last used tool per button group
  lastUsed: {
    levels: string;
    trend: string;
    structure: string;
    zones: string;
    overlays: string;
    patterns: string;
    plan: string;
    measure: string;
    annotate: string;
  };
  
  // Control states
  snapEnabled: boolean;
  snapStrength: 'off' | 'weak' | 'strong';
  snapTarget: 'wick' | 'body' | 'close' | 'indicators';
  lockEnabled: boolean;
  drawingsVisible: boolean;
  indicatorsVisible: boolean;
  positionsVisible: boolean;
  stayInDrawingMode: boolean;
  
  // Favorites
  favorites: string[];
  recentTools: string[];
  
  // Cursor mode
  cursorMode: 'crosshair' | 'arrow' | 'dot' | 'demo';
}
```

### Persistence
- `lastUsed` → localStorage (key: `toolbar_lastUsed`)
- `favorites` → localStorage (key: `toolbar_favorites`)
- `recentTools` → localStorage (key: `toolbar_recent`)
- Control states → localStorage (key: `toolbar_controls`)

---

## Implementation Priority

### Phase 1: Core Structure
1. Toolbar container with drag handles
2. Section dividers
3. Basic button rendering
4. Click → activate default tool
5. Hover states

### Phase 2: Tool Panels
1. Hold → open panel
2. Panel positioning
3. Panel content rendering
4. Tool selection from panel
5. Panel close behavior

### Phase 3: Smart Features
1. Last-used memory
2. Keyboard shortcuts
3. Favorites system
4. Recent tools tracking
5. Hub search/command palette

### Phase 4: Control Dock
1. 2×2 control grid
2. Toggle behaviors
3. Hold menus for controls
4. More panel

### Phase 5: Polish
1. Animations
2. Tooltips
3. Right-click context menus
4. Accessibility (aria labels, focus management)
