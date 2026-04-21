// Toolbar State Store (React Context + localStorage)
// Dependency-free alternative to Zustand

import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import type {
    ToolbarState,
    ToolCategory,
    SnapStrength,
    SnapTarget,
    CursorMode,
    PanelId
} from './types';
import { DEFAULT_TOOLS } from './toolDefinitions';

// Initial state
const INITIAL_STATE: Omit<ToolbarState,
    'setActiveTool' | 'setLastUsed' | 'setOpenPanel' | 'closePanel' |
    'toggleSnap' | 'setSnapStrength' | 'toggleSnapTarget' | 'toggleLock' |
    'toggleEraser' | 'toggleDrawingsVisible' | 'toggleIndicatorsVisible' |
    'togglePositionsVisible' | 'setCursorMode' | 'setStayInDrawingMode' |
    'addToFavorites' | 'removeFromFavorites' | 'addToRecent'
> = {
    activeTool: null,
    lastUsed: { ...DEFAULT_TOOLS },
    openPanel: null,
    snapEnabled: true,
    snapStrength: 'strong',
    snapTargets: ['wick', 'body'],
    lockEnabled: false,
    eraserMode: false,
    stayInDrawingMode: false,
    drawingsVisible: true,
    indicatorsVisible: true,
    positionsVisible: true,
    cursorMode: 'crosshair',
    favorites: [],
    recentTools: [],
};

const STORAGE_KEY = 'lhs-toolbar-storage';

// Load from localStorage
function loadPersistedState(): Partial<typeof INITIAL_STATE> {
    if (typeof window === 'undefined') return {};
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return JSON.parse(stored);
    } catch (e) {
        console.warn('Failed to load toolbar state:', e);
    }
    return {};
}

// Save to localStorage
function persistState(state: typeof INITIAL_STATE) {
    if (typeof window === 'undefined') return;
    try {
        const toPersist = {
            lastUsed: state.lastUsed,
            snapEnabled: state.snapEnabled,
            snapStrength: state.snapStrength,
            snapTargets: state.snapTargets,
            stayInDrawingMode: state.stayInDrawingMode,
            cursorMode: state.cursorMode,
            favorites: state.favorites,
            recentTools: state.recentTools,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
    } catch (e) {
        console.warn('Failed to persist toolbar state:', e);
    }
}

// Context
const ToolbarContext = createContext<ToolbarState | null>(null);

// Provider
export function ToolbarProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState(() => ({
        ...INITIAL_STATE,
        ...loadPersistedState(),
    }));

    // Persist on change
    useEffect(() => {
        persistState(state);
    }, [state]);

    // Actions
    const setActiveTool = useCallback((toolId: string | null) => {
        setState(s => {
            const newState = { ...s, activeTool: toolId, eraserMode: false };
            if (toolId) {
                // Add to recent
                const filtered = s.recentTools.filter(id => id !== toolId);
                newState.recentTools = [toolId, ...filtered].slice(0, 4);
            }
            return newState;
        });
    }, []);

    const setLastUsed = useCallback((category: ToolCategory, toolId: string) => {
        setState(s => ({
            ...s,
            lastUsed: { ...s.lastUsed, [category]: toolId },
        }));
    }, []);

    const setOpenPanel = useCallback((panel: PanelId | null) => {
        setState(s => ({ ...s, openPanel: panel }));
    }, []);

    const closePanel = useCallback(() => {
        setState(s => ({ ...s, openPanel: null }));
    }, []);

    const toggleSnap = useCallback(() => {
        setState(s => ({ ...s, snapEnabled: !s.snapEnabled }));
    }, []);

    const setSnapStrength = useCallback((strength: SnapStrength) => {
        setState(s => ({ ...s, snapStrength: strength }));
    }, []);

    const toggleSnapTarget = useCallback((target: SnapTarget) => {
        setState(s => ({
            ...s,
            snapTargets: s.snapTargets.includes(target)
                ? s.snapTargets.filter(t => t !== target)
                : [...s.snapTargets, target],
        }));
    }, []);

    const toggleLock = useCallback(() => {
        setState(s => ({ ...s, lockEnabled: !s.lockEnabled }));
    }, []);

    const toggleEraser = useCallback(() => {
        setState(s => ({
            ...s,
            eraserMode: !s.eraserMode,
            activeTool: s.eraserMode ? s.activeTool : null,
        }));
    }, []);

    const toggleDrawingsVisible = useCallback(() => {
        setState(s => ({ ...s, drawingsVisible: !s.drawingsVisible }));
    }, []);

    const toggleIndicatorsVisible = useCallback(() => {
        setState(s => ({ ...s, indicatorsVisible: !s.indicatorsVisible }));
    }, []);

    const togglePositionsVisible = useCallback(() => {
        setState(s => ({ ...s, positionsVisible: !s.positionsVisible }));
    }, []);

    const setCursorMode = useCallback((mode: CursorMode) => {
        setState(s => ({ ...s, cursorMode: mode }));
    }, []);

    const setStayInDrawingMode = useCallback((stay: boolean) => {
        setState(s => ({ ...s, stayInDrawingMode: stay }));
    }, []);

    const addToFavorites = useCallback((toolId: string) => {
        setState(s => ({
            ...s,
            favorites: s.favorites.includes(toolId) ? s.favorites : [...s.favorites, toolId],
        }));
    }, []);

    const removeFromFavorites = useCallback((toolId: string) => {
        setState(s => ({
            ...s,
            favorites: s.favorites.filter(id => id !== toolId),
        }));
    }, []);

    const addToRecent = useCallback((toolId: string) => {
        setState(s => {
            const filtered = s.recentTools.filter(id => id !== toolId);
            return {
                ...s,
                recentTools: [toolId, ...filtered].slice(0, 4),
            };
        });
    }, []);

    // Memoize context value to prevent unnecessary re-renders
    const value: ToolbarState = useMemo(() => ({
        ...state,
        setActiveTool,
        setLastUsed,
        setOpenPanel,
        closePanel,
        toggleSnap,
        setSnapStrength,
        toggleSnapTarget,
        toggleLock,
        toggleEraser,
        toggleDrawingsVisible,
        toggleIndicatorsVisible,
        togglePositionsVisible,
        setCursorMode,
        setStayInDrawingMode,
        addToFavorites,
        removeFromFavorites,
        addToRecent,
    }), [state, setActiveTool, setLastUsed, setOpenPanel, closePanel, toggleSnap,
        setSnapStrength, toggleSnapTarget, toggleLock, toggleEraser,
        toggleDrawingsVisible, toggleIndicatorsVisible, togglePositionsVisible,
        setCursorMode, setStayInDrawingMode, addToFavorites, removeFromFavorites, addToRecent]);

    return (
        <ToolbarContext.Provider value={value}>
            {children}
        </ToolbarContext.Provider>
    );
}

// Hook
export function useToolbarStore(): ToolbarState;
export function useToolbarStore<T>(selector: (state: ToolbarState) => T): T;
export function useToolbarStore<T>(selector?: (state: ToolbarState) => T) {
    const context = useContext(ToolbarContext);
    if (!context) {
        throw new Error('useToolbarStore must be used within a ToolbarProvider');
    }
    return selector ? selector(context) : context;
}
