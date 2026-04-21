# Cursor Instructions - LHS Toolbar Implementation

## How to Use These Documents

This folder contains the complete specification for implementing an optimal LHS drawing toolbar for a trading charting platform.

### Document Index

| Document | Purpose | When to Reference |
|----------|---------|-------------------|
| `LHS_BAR_ARCHITECTURE.md` | High-level structure, sections, design principles | Starting a new component, understanding overall system |
| `LHS_BAR_TOOLS.md` | Complete tool definitions, properties, panel layouts | Implementing specific tools or panels |
| `LHS_BAR_IMPLEMENTATION.md` | Code examples, components, state management | Writing actual code |
| `LHS_BAR_QUICKREF.md` | Quick reference, shortcuts, specs | Quick lookups during development |

---

## Key Implementation Notes for Cursor

### 1. Button Behavior Pattern

Every main button (except Hub) follows this pattern:

```typescript
// Click = activate last-used tool in this category
const handleClick = () => {
  const toolId = lastUsed[category];
  setActiveTool(toolId);
};

// Hold (300ms) = open panel
const handleHold = () => {
  setOpenPanel(category);
};

// Tool selection from panel = update last-used + activate
const handleToolSelect = (toolId: string) => {
  setLastUsed(category, toolId);
  setActiveTool(toolId);
  closePanel();
};
```

### 2. Panel Positioning

Panels always appear to the RIGHT of the toolbar, never overlapping chart center:

```typescript
const panelStyle = {
  position: 'absolute',
  left: 'calc(100% + 8px)', // 8px gap from toolbar
  top: 0, // Align with button that opened it
};
```

### 3. State Persistence

These items persist to localStorage:
- `lastUsed` - Last used tool per category
- `favorites` - User's favorited tools
- `recentTools` - Recently used tools (max 4)
- `snapEnabled`, `snapStrength`, `snapTargets`
- `stayInDrawingMode`
- `cursorMode`

### 4. Tool ID Convention

Tool IDs follow snake_case naming:
- `h_line`, `h_ray`, `v_line`
- `trend_line`, `trend_angle`
- `fib_retracement`, `fib_extension`
- `parallel_channel`, `pitchfork`
- `bos_marker`, `choch_marker`

### 5. New Tools (★)

New tools are marked with `isNew: true` in tool definitions. Display a ★ badge next to these.

---

## Recommended Implementation Order

### Phase 1: Core Structure
```
□ LHSToolbar container component
□ DragHandle component (top + bottom)
□ ToolbarButton component
□ ToolbarSection divider component
□ Basic button rendering (10 main buttons)
□ Click → activate default tool
□ Hover states
□ Active states
```

### Phase 2: Panel System
```
□ BasePanel wrapper component
□ Panel positioning logic
□ Click outside to close
□ Escape to close
□ LevelsPanel (simplest, good template)
□ TrendPanel
□ StructurePanel (with Quick Access row)
□ ZonesPanel
□ OverlaysPanel (tabbed)
□ PatternsPanel (with Quick Access row)
□ PlanPanel
□ MeasurePanel
□ AnnotatePanel
```

### Phase 3: State Management
```
□ Zustand store setup
□ Last-used memory
□ localStorage persistence
□ Tool selection updates last-used
□ Click uses last-used
```

### Phase 4: Control Dock
```
□ ToolbarDock component
□ 2×2 grid layout
□ Snap toggle + panel
□ Lock toggle + panel
□ Visibility toggle + panel
□ Delete/Eraser toggle + panel
□ More button + panel
```

### Phase 5: Hub & Polish
```
□ HubPanel component
□ Search field (always visible)
□ Search filtering logic
□ Recents section
□ Favorites section
□ Cursor mode selection
□ Keyboard shortcuts hook
□ Animations
□ Tooltips
```

---

## Code Templates

### Tool Definition Template
```typescript
{
  id: 'tool_id',
  name: 'Tool Name',
  category: 'category_name',
  subcategory: 'optional_subcategory',
  icon: 'icon_string_or_component',
  shortcut: 'optional_key',
  isNew: false, // true for ★ tools
  description: 'Optional description',
}
```

### Panel Section Template
```tsx
<div className="panel-section">
  <div className="panel-section-title">Section Name</div>
  <div className="tool-list">
    <ToolItem id="tool_id" name="Tool Name" icon="⊕" />
    <ToolItem id="tool_id_2" name="Tool Name 2" icon="⊕" isNew />
  </div>
</div>
```

### Quick Access Row Template
```tsx
<div className="panel-section">
  <div className="panel-section-title">Quick Access</div>
  <div className="quick-access-row">
    <QuickAccessButton id="tool_1" name="Short Name" icon="⊕" />
    <QuickAccessButton id="tool_2" name="Short Name" icon="⊕" />
    <QuickAccessButton id="tool_3" name="Short Name" icon="⊕" />
  </div>
</div>
```

### Tabbed Panel Template
```tsx
const [activeTab, setActiveTab] = useState<'tab1' | 'tab2'>('tab1');

return (
  <BasePanel>
    <div className="panel-tabs">
      <button 
        className={`panel-tab ${activeTab === 'tab1' ? 'active' : ''}`}
        onClick={() => setActiveTab('tab1')}
      >
        Tab 1
      </button>
      <button 
        className={`panel-tab ${activeTab === 'tab2' ? 'active' : ''}`}
        onClick={() => setActiveTab('tab2')}
      >
        Tab 2
      </button>
    </div>
    
    {activeTab === 'tab1' && <Tab1Content />}
    {activeTab === 'tab2' && <Tab2Content />}
  </BasePanel>
);
```

---

## Common Patterns

### Check if Tool is Active
```typescript
const isToolInCategory = (toolId: string, category: ToolCategory) => {
  const categoryTools = TOOLS.filter(t => t.category === category);
  return categoryTools.some(t => t.id === toolId);
};

const isActive = activeTool && isToolInCategory(activeTool, 'levels');
```

### Hold Detection
```typescript
const HOLD_DELAY = 300;
let holdTimer: NodeJS.Timeout;
let didHold = false;

const onMouseDown = () => {
  didHold = false;
  holdTimer = setTimeout(() => {
    didHold = true;
    onHold();
  }, HOLD_DELAY);
};

const onMouseUp = () => {
  clearTimeout(holdTimer);
  if (!didHold) onClick();
};
```

### Panel Close on Outside Click
```typescript
useEffect(() => {
  const handleClickOutside = (e: MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };
  document.addEventListener('mousedown', handleClickOutside);
  return () => document.removeEventListener('mousedown', handleClickOutside);
}, [onClose]);
```

---

## Questions to Ask When Implementing

1. **Which category does this tool belong to?** → Check LHS_BAR_TOOLS.md
2. **What's the panel layout for this button?** → Check LHS_BAR_TOOLS.md panel layouts
3. **Does this panel need Quick Access?** → Only Structure and Patterns
4. **Does this panel need tabs?** → Only Overlays
5. **What are the tool properties?** → Check TypeScript interfaces in LHS_BAR_TOOLS.md
6. **What's the keyboard shortcut?** → Check LHS_BAR_QUICKREF.md
7. **Is this a new tool (★)?** → Check the "New Tools Summary" section

---

## Testing Checklist

For each button:
- [ ] Click activates last-used tool
- [ ] Hold opens panel
- [ ] Panel appears to right
- [ ] Panel closes on outside click
- [ ] Panel closes on Escape
- [ ] Panel closes on tool selection
- [ ] Tool selection updates last-used
- [ ] Active state shows correctly
- [ ] Keyboard shortcut works

For control dock:
- [ ] Click toggles state
- [ ] Right-click opens options
- [ ] Visual state matches actual state
- [ ] Persistence works

For Hub:
- [ ] Search filters tools
- [ ] Recents show last 4 used
- [ ] Favorites can be added/removed
- [ ] Cursor mode changes work
