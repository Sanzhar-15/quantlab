# LHS Drawing Toolbar - Implementation Guide

## Component Architecture

This document provides the technical implementation specifications for the LHS toolbar.

---

## File Structure

```
src/
├── components/
│   └── toolbar/
│       ├── LHSToolbar.tsx              # Main toolbar container
│       ├── ToolbarButton.tsx           # Individual button component
│       ├── ToolbarSection.tsx          # Section divider
│       ├── ToolbarDock.tsx             # Control dock (2x2 grid)
│       ├── DragHandle.tsx              # Top/bottom drag handles
│       │
│       ├── panels/
│       │   ├── BasePanel.tsx           # Shared panel wrapper
│       │   ├── HubPanel.tsx            # Hub panel with search
│       │   ├── LevelsPanel.tsx         # Levels tools panel
│       │   ├── TrendPanel.tsx          # Trend tools panel
│       │   ├── StructurePanel.tsx      # Structure panel (with quick access)
│       │   ├── ZonesPanel.tsx          # Zones tools panel
│       │   ├── OverlaysPanel.tsx       # Overlays panel (tabbed)
│       │   ├── PatternsPanel.tsx       # Patterns panel (with quick access)
│       │   ├── PlanPanel.tsx           # Plan tools panel
│       │   ├── MeasurePanel.tsx        # Measure tools panel
│       │   ├── AnnotatePanel.tsx       # Annotate tools panel
│       │   └── ControlPanels.tsx       # Snap/Lock/Vis/Del panels
│       │
│       └── hooks/
│           ├── useToolbarState.ts      # Toolbar state management
│           ├── useLastUsed.ts          # Last-used tool memory
│           ├── useFavorites.ts         # Favorites management
│           ├── useRecentTools.ts       # Recent tools tracking
│           └── usePanelPosition.ts     # Panel positioning logic
│
├── stores/
│   └── toolbarStore.ts                 # Zustand store for toolbar
│
├── constants/
│   └── toolDefinitions.ts              # All tool definitions
│
└── types/
    └── toolbar.ts                      # TypeScript types
```

---

## Core Types

```typescript
// types/toolbar.ts

export type ToolCategory = 
  | 'levels'
  | 'trend'
  | 'structure'
  | 'zones'
  | 'overlays'
  | 'patterns'
  | 'plan'
  | 'measure'
  | 'annotate';

export type CursorMode = 'crosshair' | 'arrow' | 'dot' | 'demo';

export type SnapStrength = 'off' | 'weak' | 'strong';

export type SnapTarget = 'wick' | 'body' | 'close' | 'indicators' | 'drawings';

export interface Tool {
  id: string;
  name: string;
  category: ToolCategory;
  subcategory?: string;
  icon: string | React.ComponentType;
  shortcut?: string;
  isNew?: boolean; // For ★ tools
  description?: string;
}

export interface ToolbarState {
  // Active tool
  activeTool: string | null;
  
  // Last used per category
  lastUsed: Record<ToolCategory, string>;
  
  // Open panel
  openPanel: ToolCategory | 'hub' | 'snap' | 'lock' | 'visibility' | 'delete' | 'more' | null;
  
  // Controls
  snapEnabled: boolean;
  snapStrength: SnapStrength;
  snapTargets: SnapTarget[];
  lockEnabled: boolean;
  eraserMode: boolean;
  stayInDrawingMode: boolean;
  
  // Visibility
  drawingsVisible: boolean;
  indicatorsVisible: boolean;
  positionsVisible: boolean;
  
  // Cursor
  cursorMode: CursorMode;
  
  // Favorites & Recent
  favorites: string[];
  recentTools: string[];
  
  // Actions
  setActiveTool: (toolId: string | null) => void;
  setLastUsed: (category: ToolCategory, toolId: string) => void;
  openPanel: (panel: string | null) => void;
  closePanel: () => void;
  toggleSnap: () => void;
  toggleLock: () => void;
  toggleEraser: () => void;
  toggleDrawingsVisible: () => void;
  addToFavorites: (toolId: string) => void;
  removeFromFavorites: (toolId: string) => void;
  addToRecent: (toolId: string) => void;
}
```

---

## Zustand Store

```typescript
// stores/toolbarStore.ts

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ToolbarState, ToolCategory, SnapStrength, SnapTarget, CursorMode } from '../types/toolbar';

// Default tools per category
const DEFAULT_TOOLS: Record<ToolCategory, string> = {
  levels: 'h_line',
  trend: 'trend_line',
  structure: 'parallel_channel',
  zones: 'rectangle',
  overlays: 'fib_retracement',
  patterns: 'triangle_pattern',
  plan: 'long_position',
  measure: 'quick_measure',
  annotate: 'text',
};

export const useToolbarStore = create<ToolbarState>()(
  persist(
    (set, get) => ({
      // Initial state
      activeTool: null,
      lastUsed: { ...DEFAULT_TOOLS },
      openPanel: null,
      
      // Controls
      snapEnabled: true,
      snapStrength: 'strong',
      snapTargets: ['wick', 'body'],
      lockEnabled: false,
      eraserMode: false,
      stayInDrawingMode: false,
      
      // Visibility
      drawingsVisible: true,
      indicatorsVisible: true,
      positionsVisible: true,
      
      // Cursor
      cursorMode: 'crosshair',
      
      // Favorites & Recent
      favorites: [],
      recentTools: [],
      
      // Actions
      setActiveTool: (toolId) => {
        set({ activeTool: toolId, eraserMode: false });
        if (toolId) {
          get().addToRecent(toolId);
        }
      },
      
      setLastUsed: (category, toolId) => {
        set((state) => ({
          lastUsed: { ...state.lastUsed, [category]: toolId },
        }));
      },
      
      openPanel: (panel) => set({ openPanel: panel }),
      closePanel: () => set({ openPanel: null }),
      
      toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
      toggleLock: () => set((state) => ({ lockEnabled: !state.lockEnabled })),
      toggleEraser: () => set((state) => ({ 
        eraserMode: !state.eraserMode,
        activeTool: state.eraserMode ? null : state.activeTool,
      })),
      toggleDrawingsVisible: () => set((state) => ({ 
        drawingsVisible: !state.drawingsVisible 
      })),
      
      addToFavorites: (toolId) => {
        set((state) => ({
          favorites: state.favorites.includes(toolId) 
            ? state.favorites 
            : [...state.favorites, toolId],
        }));
      },
      
      removeFromFavorites: (toolId) => {
        set((state) => ({
          favorites: state.favorites.filter((id) => id !== toolId),
        }));
      },
      
      addToRecent: (toolId) => {
        set((state) => {
          const filtered = state.recentTools.filter((id) => id !== toolId);
          return {
            recentTools: [toolId, ...filtered].slice(0, 4), // Max 4 recent
          };
        });
      },
    }),
    {
      name: 'toolbar-storage',
      partialize: (state) => ({
        lastUsed: state.lastUsed,
        snapEnabled: state.snapEnabled,
        snapStrength: state.snapStrength,
        snapTargets: state.snapTargets,
        stayInDrawingMode: state.stayInDrawingMode,
        cursorMode: state.cursorMode,
        favorites: state.favorites,
        recentTools: state.recentTools,
      }),
    }
  )
);
```

---

## Main Toolbar Component

```tsx
// components/toolbar/LHSToolbar.tsx

import React, { useState, useCallback } from 'react';
import { useToolbarStore } from '../../stores/toolbarStore';
import { DragHandle } from './DragHandle';
import { ToolbarButton } from './ToolbarButton';
import { ToolbarSection } from './ToolbarSection';
import { ToolbarDock } from './ToolbarDock';
import { 
  HubPanel, LevelsPanel, TrendPanel, StructurePanel, 
  ZonesPanel, OverlaysPanel, PatternsPanel, PlanPanel,
  MeasurePanel, AnnotatePanel 
} from './panels';

// Icons - replace with your actual icons
import { 
  SearchIcon, HorizontalLineIcon, TrendLineIcon, ChannelIcon,
  RectangleIcon, FibIcon, PatternIcon, TargetIcon, 
  RulerIcon, TextIcon 
} from '../icons';

interface LHSToolbarProps {
  className?: string;
}

export const LHSToolbar: React.FC<LHSToolbarProps> = ({ className }) => {
  const [position, setPosition] = useState({ y: 100 }); // Vertical position
  
  const {
    activeTool,
    lastUsed,
    openPanel,
    setActiveTool,
    setLastUsed,
    openPanel: setOpenPanel,
    closePanel,
  } = useToolbarStore();
  
  // Handle button click (activate last-used tool)
  const handleButtonClick = useCallback((category: ToolCategory) => {
    const toolId = lastUsed[category];
    setActiveTool(toolId);
    closePanel();
  }, [lastUsed, setActiveTool, closePanel]);
  
  // Handle button hold (open panel)
  const handleButtonHold = useCallback((category: ToolCategory | 'hub') => {
    setOpenPanel(category);
  }, [setOpenPanel]);
  
  // Handle tool selection from panel
  const handleToolSelect = useCallback((category: ToolCategory, toolId: string) => {
    setLastUsed(category, toolId);
    setActiveTool(toolId);
    closePanel();
  }, [setLastUsed, setActiveTool, closePanel]);
  
  // Handle drag
  const handleDrag = useCallback((deltaY: number) => {
    setPosition((prev) => ({
      y: Math.max(0, Math.min(window.innerHeight - 600, prev.y + deltaY)),
    }));
  }, []);
  
  return (
    <div 
      className={`lhs-toolbar ${className || ''}`}
      style={{ 
        position: 'fixed',
        left: 12,
        top: position.y,
        zIndex: 1000,
      }}
    >
      {/* Top Drag Handle */}
      <DragHandle position="top" onDrag={handleDrag} />
      
      <div className="toolbar-container">
        {/* ══ SECTION A: META ══ */}
        <ToolbarButton
          icon={<SearchIcon />}
          tooltip="Hub (⌘K)"
          isActive={openPanel === 'hub'}
          onClick={() => setOpenPanel('hub')}
          onHold={() => setOpenPanel('hub')}
        />
        {openPanel === 'hub' && (
          <HubPanel onClose={closePanel} onSelectTool={handleToolSelect} />
        )}
        
        <ToolbarSection />
        
        {/* ══ SECTION B: MARK ══ */}
        <ToolbarButton
          icon={<HorizontalLineIcon />}
          tooltip="Levels (L)"
          isActive={activeTool?.startsWith('h_') || activeTool?.startsWith('v_') || activeTool === 'cross_line' || activeTool === 'price_label'}
          hasDropdown
          onClick={() => handleButtonClick('levels')}
          onHold={() => handleButtonHold('levels')}
        />
        {openPanel === 'levels' && (
          <LevelsPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('levels', id)} 
          />
        )}
        
        <ToolbarButton
          icon={<TrendLineIcon />}
          tooltip="Trend (T)"
          isActive={activeTool?.includes('trend') || activeTool === 'ray' || activeTool?.includes('extended') || activeTool?.includes('info_line') || activeTool?.includes('angle') || activeTool?.includes('arrow_line')}
          hasDropdown
          onClick={() => handleButtonClick('trend')}
          onHold={() => handleButtonHold('trend')}
        />
        {openPanel === 'trend' && (
          <TrendPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('trend', id)} 
          />
        )}
        
        <ToolbarButton
          icon={<ChannelIcon />}
          tooltip="Structure (S)"
          isActive={activeTool?.includes('channel') || activeTool?.includes('pitchfork') || activeTool?.includes('swing') || activeTool?.includes('bos') || activeTool?.includes('choch')}
          hasDropdown
          onClick={() => handleButtonClick('structure')}
          onHold={() => handleButtonHold('structure')}
        />
        {openPanel === 'structure' && (
          <StructurePanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('structure', id)} 
          />
        )}
        
        <ToolbarButton
          icon={<RectangleIcon />}
          tooltip="Zones (Z)"
          isActive={activeTool?.includes('rectangle') || activeTool?.includes('zone') || activeTool?.includes('block') || activeTool?.includes('fvg') || activeTool?.includes('session')}
          hasDropdown
          onClick={() => handleButtonClick('zones')}
          onHold={() => handleButtonHold('zones')}
        />
        {openPanel === 'zones' && (
          <ZonesPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('zones', id)} 
          />
        )}
        
        <ToolbarSection />
        
        {/* ══ SECTION C: ANALYZE ══ */}
        <ToolbarButton
          icon={<FibIcon />}
          tooltip="Overlays (F)"
          isActive={activeTool?.includes('fib') || activeTool?.includes('gann') || activeTool?.includes('vwap') || activeTool?.includes('vp')}
          hasDropdown
          onClick={() => handleButtonClick('overlays')}
          onHold={() => handleButtonHold('overlays')}
        />
        {openPanel === 'overlays' && (
          <OverlaysPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('overlays', id)} 
          />
        )}
        
        <ToolbarButton
          icon={<PatternIcon />}
          tooltip="Patterns (P)"
          isActive={activeTool?.includes('pattern') || activeTool?.includes('elliott') || activeTool?.includes('harmonic') || activeTool?.includes('cyclic')}
          hasDropdown
          onClick={() => handleButtonClick('patterns')}
          onHold={() => handleButtonHold('patterns')}
        />
        {openPanel === 'patterns' && (
          <PatternsPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('patterns', id)} 
          />
        )}
        
        <ToolbarSection />
        
        {/* ══ SECTION D: EXECUTE ══ */}
        <ToolbarButton
          icon={<TargetIcon />}
          tooltip="Plan (R)"
          isActive={activeTool?.includes('position') || activeTool?.includes('forecast') || activeTool?.includes('projection') || activeTool?.includes('ghost')}
          hasDropdown
          onClick={() => handleButtonClick('plan')}
          onHold={() => handleButtonHold('plan')}
        />
        {openPanel === 'plan' && (
          <PlanPanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('plan', id)} 
          />
        )}
        
        <ToolbarButton
          icon={<RulerIcon />}
          tooltip="Measure (M)"
          isActive={activeTool?.includes('measure') || activeTool?.includes('range') || activeTool === 'box_zoom'}
          hasDropdown
          onClick={() => handleButtonClick('measure')}
          onHold={() => handleButtonHold('measure')}
        />
        {openPanel === 'measure' && (
          <MeasurePanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('measure', id)} 
          />
        )}
        
        <ToolbarSection />
        
        {/* ══ SECTION E: ANNOTATE ══ */}
        <ToolbarButton
          icon={<TextIcon />}
          tooltip="Annotate (A)"
          isActive={activeTool?.includes('text') || activeTool?.includes('note') || activeTool?.includes('callout') || activeTool?.includes('brush') || activeTool?.includes('emoji')}
          hasDropdown
          onClick={() => handleButtonClick('annotate')}
          onHold={() => handleButtonHold('annotate')}
        />
        {openPanel === 'annotate' && (
          <AnnotatePanel 
            onClose={closePanel} 
            onSelectTool={(id) => handleToolSelect('annotate', id)} 
          />
        )}
        
        <ToolbarSection variant="heavy" />
        
        {/* ══ SECTION F: CONTROL ══ */}
        <ToolbarDock />
      </div>
      
      {/* Bottom Drag Handle */}
      <DragHandle position="bottom" onDrag={handleDrag} />
    </div>
  );
};
```

---

## ToolbarButton Component

```tsx
// components/toolbar/ToolbarButton.tsx

import React, { useRef, useCallback } from 'react';

interface ToolbarButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  isActive?: boolean;
  hasDropdown?: boolean;
  onClick: () => void;
  onHold?: () => void;
}

const HOLD_DELAY = 300; // ms

export const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  icon,
  tooltip,
  isActive = false,
  hasDropdown = false,
  onClick,
  onHold,
}) => {
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const didHoldRef = useRef(false);
  
  const handleMouseDown = useCallback(() => {
    didHoldRef.current = false;
    
    if (onHold) {
      holdTimerRef.current = setTimeout(() => {
        didHoldRef.current = true;
        onHold();
      }, HOLD_DELAY);
    }
  }, [onHold]);
  
  const handleMouseUp = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    
    if (!didHoldRef.current) {
      onClick();
    }
  }, [onClick]);
  
  const handleMouseLeave = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);
  
  return (
    <button
      className={`toolbar-button ${isActive ? 'active' : ''}`}
      title={tooltip}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <span className="toolbar-button-icon">{icon}</span>
      {hasDropdown && <span className="toolbar-button-dropdown-indicator" />}
    </button>
  );
};
```

---

## Panel Base Component

```tsx
// components/toolbar/panels/BasePanel.tsx

import React, { useEffect, useRef } from 'react';

interface BasePanelProps {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}

export const BasePanel: React.FC<BasePanelProps> = ({ 
  children, 
  onClose,
  className = '',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  
  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    
    // Close on escape
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);
  
  return (
    <div 
      ref={panelRef}
      className={`toolbar-panel ${className}`}
    >
      {children}
    </div>
  );
};
```

---

## Example Panel: Structure Panel (with Quick Access)

```tsx
// components/toolbar/panels/StructurePanel.tsx

import React from 'react';
import { BasePanel } from './BasePanel';
import { useToolbarStore } from '../../../stores/toolbarStore';

interface StructurePanelProps {
  onClose: () => void;
  onSelectTool: (toolId: string) => void;
}

export const StructurePanel: React.FC<StructurePanelProps> = ({ 
  onClose, 
  onSelectTool 
}) => {
  const { activeTool } = useToolbarStore();
  
  const handleSelect = (toolId: string) => {
    onSelectTool(toolId);
  };
  
  return (
    <BasePanel onClose={onClose} className="structure-panel">
      {/* Quick Access Row */}
      <div className="panel-section">
        <div className="panel-section-title">Quick Access</div>
        <div className="quick-access-row">
          <button 
            className={`tool-item ${activeTool === 'parallel_channel' ? 'active' : ''}`}
            onClick={() => handleSelect('parallel_channel')}
          >
            <span className="tool-icon">⫽</span>
            <span className="tool-name">Parallel</span>
          </button>
          <button 
            className={`tool-item ${activeTool === 'pitchfork' ? 'active' : ''}`}
            onClick={() => handleSelect('pitchfork')}
          >
            <span className="tool-icon">⋔</span>
            <span className="tool-name">Pitchfork</span>
          </button>
          <button 
            className={`tool-item ${activeTool === 'swing_label' ? 'active' : ''}`}
            onClick={() => handleSelect('swing_label')}
          >
            <span className="tool-icon">⟰</span>
            <span className="tool-name">Swing</span>
          </button>
        </div>
      </div>
      
      {/* Channels Section */}
      <div className="panel-section">
        <div className="panel-section-title">Channels</div>
        <div className="tool-list">
          <ToolItem id="parallel_channel" name="Parallel Channel" icon="⫽" active={activeTool === 'parallel_channel'} onSelect={handleSelect} />
          <ToolItem id="regression_trend" name="Regression Trend" icon="📈" active={activeTool === 'regression_trend'} onSelect={handleSelect} />
          <ToolItem id="flat_top_bottom" name="Flat Top/Bottom" icon="⌐" active={activeTool === 'flat_top_bottom'} onSelect={handleSelect} />
          <ToolItem id="disjoint_channel" name="Disjoint Channel" icon="⫽" active={activeTool === 'disjoint_channel'} onSelect={handleSelect} />
          <ToolItem id="std_dev_channel" name="Std Deviation Channel" icon="σ" active={activeTool === 'std_dev_channel'} onSelect={handleSelect} isNew />
        </div>
      </div>
      
      {/* Pitchforks Section */}
      <div className="panel-section">
        <div className="panel-section-title">Pitchforks</div>
        <div className="tool-list">
          <ToolItem id="pitchfork" name="Andrews' Pitchfork" icon="⋔" active={activeTool === 'pitchfork'} onSelect={handleSelect} />
          <ToolItem id="schiff_pitchfork" name="Schiff Pitchfork" icon="⋔" active={activeTool === 'schiff_pitchfork'} onSelect={handleSelect} />
          <ToolItem id="modified_schiff" name="Modified Schiff" icon="⋔" active={activeTool === 'modified_schiff'} onSelect={handleSelect} />
          <ToolItem id="inside_pitchfork" name="Inside Pitchfork" icon="⋔" active={activeTool === 'inside_pitchfork'} onSelect={handleSelect} />
          <ToolItem id="pitchfan" name="Pitchfan" icon="⋔" active={activeTool === 'pitchfan'} onSelect={handleSelect} />
        </div>
      </div>
      
      {/* Market Structure Section */}
      <div className="panel-section">
        <div className="panel-section-title">Market Structure</div>
        <div className="tool-list">
          <ToolItem id="swing_label" name="Swing High/Low Label" icon="⟰" active={activeTool === 'swing_label'} onSelect={handleSelect} isNew />
          <ToolItem id="bos_marker" name="BOS Marker" icon="⚡" active={activeTool === 'bos_marker'} onSelect={handleSelect} isNew />
          <ToolItem id="choch_marker" name="CHoCH Marker" icon="↻" active={activeTool === 'choch_marker'} onSelect={handleSelect} isNew />
          <ToolItem id="invalidation_zone" name="Invalidation Zone" icon="▢" active={activeTool === 'invalidation_zone'} onSelect={handleSelect} isNew />
          <ToolItem id="liquidity_sweep" name="Liquidity Sweep" icon="💧" active={activeTool === 'liquidity_sweep'} onSelect={handleSelect} isNew />
        </div>
      </div>
    </BasePanel>
  );
};

// Tool Item Component
interface ToolItemProps {
  id: string;
  name: string;
  icon: string;
  active: boolean;
  isNew?: boolean;
  onSelect: (id: string) => void;
}

const ToolItem: React.FC<ToolItemProps> = ({ id, name, icon, active, isNew, onSelect }) => (
  <button 
    className={`tool-item ${active ? 'active' : ''}`}
    onClick={() => onSelect(id)}
  >
    <span className="tool-icon">{icon}</span>
    <span className="tool-name">{name}</span>
    {isNew && <span className="tool-badge">★</span>}
  </button>
);
```

---

## Control Dock Component

```tsx
// components/toolbar/ToolbarDock.tsx

import React from 'react';
import { useToolbarStore } from '../../stores/toolbarStore';
import { SnapPanel, LockPanel, VisibilityPanel, DeletePanel, MorePanel } from './panels/ControlPanels';

export const ToolbarDock: React.FC = () => {
  const {
    snapEnabled,
    lockEnabled,
    drawingsVisible,
    eraserMode,
    openPanel,
    toggleSnap,
    toggleLock,
    toggleDrawingsVisible,
    toggleEraser,
    openPanel: setOpenPanel,
    closePanel,
  } = useToolbarStore();
  
  return (
    <div className="toolbar-dock">
      {/* 2x2 Grid */}
      <div className="dock-grid">
        {/* Snap Button */}
        <button
          className={`dock-button ${snapEnabled ? 'active' : ''}`}
          onClick={toggleSnap}
          onContextMenu={(e) => { e.preventDefault(); setOpenPanel('snap'); }}
          title="Snap (click toggle, right-click options)"
        >
          🧲
        </button>
        {openPanel === 'snap' && <SnapPanel onClose={closePanel} />}
        
        {/* Lock Button */}
        <button
          className={`dock-button ${lockEnabled ? 'active' : ''}`}
          onClick={toggleLock}
          onContextMenu={(e) => { e.preventDefault(); setOpenPanel('lock'); }}
          title="Lock (click toggle, right-click options)"
        >
          🔒
        </button>
        {openPanel === 'lock' && <LockPanel onClose={closePanel} />}
        
        {/* Visibility Button */}
        <button
          className={`dock-button ${!drawingsVisible ? 'inactive' : ''}`}
          onClick={toggleDrawingsVisible}
          onContextMenu={(e) => { e.preventDefault(); setOpenPanel('visibility'); }}
          title="Visibility (click toggle, right-click options)"
        >
          👁
        </button>
        {openPanel === 'visibility' && <VisibilityPanel onClose={closePanel} />}
        
        {/* Delete Button */}
        <button
          className={`dock-button ${eraserMode ? 'active' : ''}`}
          onClick={toggleEraser}
          onContextMenu={(e) => { e.preventDefault(); setOpenPanel('delete'); }}
          title="Delete (click eraser mode, right-click options)"
        >
          🗑
        </button>
        {openPanel === 'delete' && <DeletePanel onClose={closePanel} />}
      </div>
      
      {/* More Button */}
      <button
        className="dock-more-button"
        onClick={() => setOpenPanel('more')}
        title="More options"
      >
        ···
      </button>
      {openPanel === 'more' && <MorePanel onClose={closePanel} />}
    </div>
  );
};
```

---

## CSS Styles

```css
/* styles/toolbar.css */

.lhs-toolbar {
  position: fixed;
  left: 12px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.toolbar-container {
  background: rgba(30, 30, 35, 0.95);
  border-radius: 12px;
  padding: 8px 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Drag Handle */
.drag-handle {
  width: 40px;
  height: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: ns-resize;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.drag-handle:hover {
  opacity: 1;
}

.drag-handle-dots {
  width: 20px;
  height: 4px;
  background: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.3),
    rgba(255, 255, 255, 0.3) 3px,
    transparent 3px,
    transparent 6px
  );
}

/* Toolbar Button */
.toolbar-button {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: all 0.15s ease;
  color: rgba(255, 255, 255, 0.6);
}

.toolbar-button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
}

.toolbar-button.active {
  background: #3b82f6;
  color: white;
}

.toolbar-button-icon {
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.toolbar-button-dropdown-indicator {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
}

/* Section Divider */
.toolbar-section {
  width: 24px;
  height: 1px;
  background: rgba(255, 255, 255, 0.2);
  margin: 8px auto;
}

.toolbar-section.heavy {
  height: 2px;
  background: rgba(255, 255, 255, 0.3);
}

/* Panel */
.toolbar-panel {
  position: absolute;
  left: calc(100% + 8px);
  top: 0;
  min-width: 200px;
  max-width: 280px;
  max-height: 70vh;
  overflow-y: auto;
  background: rgba(30, 30, 35, 0.98);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  padding: 8px;
  animation: panel-appear 0.15s ease-out;
}

@keyframes panel-appear {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* Panel Section */
.panel-section {
  margin-bottom: 12px;
}

.panel-section:last-child {
  margin-bottom: 0;
}

.panel-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.5);
  padding: 4px 8px;
  margin-bottom: 4px;
}

/* Quick Access Row */
.quick-access-row {
  display: flex;
  gap: 4px;
  padding: 0 4px;
  margin-bottom: 8px;
}

.quick-access-row .tool-item {
  flex: 1;
  flex-direction: column;
  padding: 8px 4px;
}

/* Tool List */
.tool-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Tool Item */
.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: all 0.1s;
}

.tool-item:hover {
  background: rgba(255, 255, 255, 0.1);
}

.tool-item.active {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}

.tool-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.tool-name {
  font-size: 13px;
  flex: 1;
}

.tool-badge {
  font-size: 10px;
  color: #fbbf24;
}

/* Control Dock */
.toolbar-dock {
  margin-top: 4px;
}

.dock-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.dock-button {
  width: 40px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s;
}

.dock-button:hover {
  background: rgba(255, 255, 255, 0.1);
}

.dock-button.active {
  background: rgba(59, 130, 246, 0.3);
}

.dock-button.inactive {
  opacity: 0.5;
}

.dock-more-button {
  width: 100%;
  height: 24px;
  margin-top: 4px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  font-size: 14px;
  letter-spacing: 2px;
  transition: all 0.15s;
}

.dock-more-button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}

/* Tab Bar (for Overlays panel) */
.panel-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 4px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}

.panel-tab {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s;
}

.panel-tab:hover {
  color: rgba(255, 255, 255, 0.9);
}

.panel-tab.active {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

/* Search Field (for Hub) */
.hub-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  margin-bottom: 12px;
}

.hub-search-icon {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
}

.hub-search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: white;
  font-size: 13px;
  outline: none;
}

.hub-search-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}
```

---

## Keyboard Shortcuts Implementation

```typescript
// hooks/useKeyboardShortcuts.ts

import { useEffect, useCallback } from 'react';
import { useToolbarStore } from '../stores/toolbarStore';

export const useKeyboardShortcuts = () => {
  const { 
    setActiveTool, 
    lastUsed, 
    openPanel,
    closePanel 
  } = useToolbarStore();
  
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Ignore if typing in input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    
    // Command palette
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault();
      openPanel('hub');
      return;
    }
    
    // Escape
    if (event.key === 'Escape') {
      closePanel();
      setActiveTool(null);
      return;
    }
    
    // Tool shortcuts (only without modifiers)
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      switch (event.key.toLowerCase()) {
        case 'l':
          setActiveTool(lastUsed.levels);
          break;
        case 't':
          setActiveTool(lastUsed.trend);
          break;
        case 's':
          setActiveTool(lastUsed.structure);
          break;
        case 'z':
          setActiveTool(lastUsed.zones);
          break;
        case 'f':
          setActiveTool(lastUsed.overlays);
          break;
        case 'p':
          setActiveTool(lastUsed.patterns);
          break;
        case 'r':
          setActiveTool(lastUsed.plan);
          break;
        case 'm':
          setActiveTool(lastUsed.measure);
          break;
        case 'a':
          setActiveTool(lastUsed.annotate);
          break;
      }
    }
  }, [lastUsed, setActiveTool, openPanel, closePanel]);
  
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
};
```

---

## Migration from Current Implementation

Based on your current screenshot, here's the mapping:

| Current Button | New Location |
|----------------|--------------|
| Arrow (cursor) | Hub → Cursor section |
| Diagonal line | TREND button (default) |
| Three lines | LEVELS button |
| Brush/draw | ANNOTATE → Shapes → Brush |
| "Tr" text | ANNOTATE button (default) |
| Rectangle | ZONES button (default) |
| Search/zoom | MEASURE → Box Zoom |
| Settings | Control Dock → More → Settings |
| Chart icon | Keep separate (not toolbar) |

### Migration Steps

1. **Keep existing tool implementations** - They work, just reorganize
2. **Create new toolbar container** - Replace current vertical bar
3. **Add panel system** - Hold-to-open with sections
4. **Add state management** - Last-used, favorites
5. **Add control dock** - Snap/lock/vis/del grid
6. **Add keyboard shortcuts**
7. **Style refinements**
