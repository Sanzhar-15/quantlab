// LHS Toolbar Types
// Based on LHS_BAR_IMPLEMENTATION.md specification

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

export type PanelId =
    | ToolCategory
    | 'hub'
    | 'snap'
    | 'lock'
    | 'visibility'
    | 'delete'
    | 'more';

export interface Tool {
    id: string;
    name: string;
    category: ToolCategory;
    subcategory?: string;
    icon: string; // Unicode symbol
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
    openPanel: PanelId | null;

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
    setOpenPanel: (panel: PanelId | null) => void;
    closePanel: () => void;
    toggleSnap: () => void;
    setSnapStrength: (strength: SnapStrength) => void;
    toggleSnapTarget: (target: SnapTarget) => void;
    toggleLock: () => void;
    toggleEraser: () => void;
    toggleDrawingsVisible: () => void;
    toggleIndicatorsVisible: () => void;
    togglePositionsVisible: () => void;
    setCursorMode: (mode: CursorMode) => void;
    setStayInDrawingMode: (stay: boolean) => void;
    addToFavorites: (toolId: string) => void;
    removeFromFavorites: (toolId: string) => void;
    addToRecent: (toolId: string) => void;
}
