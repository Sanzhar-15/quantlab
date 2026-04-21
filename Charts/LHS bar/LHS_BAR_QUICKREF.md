# LHS Toolbar - Quick Reference

## Structure at a Glance

```
┌───────────────────────────────────────────────────────────────────┐
│                           ⋮⋮ HANDLE                              │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  🔍 HUB ──────────── Search, Recents, Favorites, Cursor          │
│                                                                   │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─       │
│                                                                   │
│  ─  LEVELS ─────────── H-Line, H-Ray, V-Line, Cross, Price Label │
│  ╱  TREND ──────────── Trend, Ray, Extended, Info, Angle, Arrow  │
│  ⫽  STRUCTURE ──────── Channels, Pitchforks, Market Structure    │
│  ▭  ZONES ──────────── Rectangle, Smart Zones, Session Boxes    │
│                                                                   │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─       │
│                                                                   │
│  ϕ  OVERLAYS ───────── [Fib/Gann Tab] [Volume Tab]               │
│  ◇  PATTERNS ───────── Harmonic, Chart, Elliott, Cycles         │
│                                                                   │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─       │
│                                                                   │
│  ◎  PLAN ───────────── Long/Short, Multi-Target, Forecast       │
│  📏 MEASURE ─────────── Quick Measure, Ranges, Zoom              │
│                                                                   │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─       │
│                                                                   │
│  T  ANNOTATE ───────── Text, Labels, Shapes, Markers, Embed     │
│                                                                   │
│  ═══════════════════════════════════════════════════════════     │
│                                                                   │
│  ┌─────────┬─────────┐                                           │
│  │ 🧲 SNAP │ 🔒 LOCK │                                           │
│  ├─────────┼─────────┤                                           │
│  │ 👁 VIS  │ 🗑 DEL  │                                           │
│  └─────────┴─────────┘                                           │
│  ┌─────────────────────┐                                         │
│  │      ··· MORE       │                                         │
│  └─────────────────────┘                                         │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│                           ⋮⋮ HANDLE                              │
└───────────────────────────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘K` | Open Hub/Search |
| `L` | Levels tool |
| `T` | Trend tool |
| `S` | Structure tool |
| `Z` | Zones tool |
| `F` | Overlays (Fib) tool |
| `P` | Patterns tool |
| `R` | Plan (Risk) tool |
| `M` | Measure tool |
| `A` | Annotate tool |
| `Esc` | Deselect / Close panel |
| `Del` | Delete selected |

---

## Default Tools per Button

| Button | Default Tool | ID |
|--------|--------------|-----|
| Levels | Horizontal Line | `h_line` |
| Trend | Trend Line | `trend_line` |
| Structure | Parallel Channel | `parallel_channel` |
| Zones | Rectangle | `rectangle` |
| Overlays | Fib Retracement | `fib_retracement` |
| Patterns | Triangle | `triangle_pattern` |
| Plan | Long Position | `long_position` |
| Measure | Quick Measure | `quick_measure` |
| Annotate | Text | `text` |

---

## Interaction Rules

### Click Behavior
- **Single click** → Activate last-used tool in that group
- First use → Activate default tool

### Hold Behavior (300ms+)
- **Long press** → Open tool panel
- Panel appears to the RIGHT of toolbar

### Panel Close
- Click outside panel
- Select a tool
- Press Escape

---

## New Tools (★)

### Market Structure
- Swing High/Low Label
- BOS Marker  
- CHoCH Marker
- Invalidation Zone
- Liquidity Sweep

### Smart Zones
- Supply/Demand Zone
- Order Block
- Fair Value Gap
- Breaker Block
- Session Box
- Opening Range

### Overlays
- Auto-Fib
- OTE Zone (62-79%)
- VWAP Bands
- Session VWAP
- POC Projection
- Value Area Highlight

### Other
- Std Deviation Channel
- Wedge Template
- Double Top/Bottom
- Multi-Target Position
- Scaled Entry Position
- Trade Journal Entry

---

## Control Dock

| Button | Click | Hold/Right-Click |
|--------|-------|------------------|
| 🧲 Snap | Toggle on/off | Snap settings |
| 🔒 Lock | Lock/unlock all | Lock options |
| 👁 Vis | Toggle drawings | Visibility options |
| 🗑 Del | Eraser mode | Delete options |

### More Menu Contains
- Stay in Drawing Mode toggle
- Sync settings (Layout/Global)
- Object Tree
- Toolbar Settings

---

## Panel Layouts

### Panels with Quick Access Row
- **Structure**: [Parallel] [Pitchfork] [Swing]
- **Patterns**: [Triangle] [XABCD] [Impulse]

### Tabbed Panels
- **Overlays**: [Fib/Gann] [Volume]

### Hub Panel (Special)
```
Search field ← Always visible at top
─────────────
Recents (4 items, pinnable)
─────────────
Favorites (user-curated)
─────────────
Cursor modes
```

---

## Visual Specs

### Toolbar Container
- Background: `rgba(30, 30, 35, 0.95)`
- Border radius: `12px`
- Padding: `8px 6px`
- Shadow: `0 4px 20px rgba(0, 0, 0, 0.3)`

### Buttons
- Size: `40px × 40px`
- Border radius: `8px`
- Icon size: `20px`
- Active color: `#3b82f6`

### Panels
- Min width: `200px`
- Max width: `280px`
- Max height: `70vh`
- Animation: fade + slide (150ms)

---

## File Structure

```
components/toolbar/
├── LHSToolbar.tsx
├── ToolbarButton.tsx
├── ToolbarSection.tsx
├── ToolbarDock.tsx
├── DragHandle.tsx
├── panels/
│   ├── BasePanel.tsx
│   ├── HubPanel.tsx
│   ├── LevelsPanel.tsx
│   ├── TrendPanel.tsx
│   ├── StructurePanel.tsx
│   ├── ZonesPanel.tsx
│   ├── OverlaysPanel.tsx
│   ├── PatternsPanel.tsx
│   ├── PlanPanel.tsx
│   ├── MeasurePanel.tsx
│   ├── AnnotatePanel.tsx
│   └── ControlPanels.tsx
└── hooks/
    ├── useToolbarState.ts
    ├── useLastUsed.ts
    └── useKeyboardShortcuts.ts

stores/
└── toolbarStore.ts

constants/
└── toolDefinitions.ts
```

---

## Implementation Priority

1. **Phase 1**: Core structure, buttons, click behavior
2. **Phase 2**: Panels, hold behavior, tool selection
3. **Phase 3**: Last-used memory, keyboard shortcuts
4. **Phase 4**: Control dock, toggles
5. **Phase 5**: Hub search, favorites, animations
