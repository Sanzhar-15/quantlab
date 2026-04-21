// React App Component
// Wraps the chart with LHSToolbar

import { useEffect } from 'react';
import { ToolbarProvider, LHSToolbar, useToolbarStore } from './components/toolbar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

// Control callbacks interface for main.tsx to wire to drawingApi
export interface ControlCallbacks {
    onVisibilityChange?: (visible: boolean) => void;
    onEraserModeChange?: (enabled: boolean) => void;
    onSnapChange?: (enabled: boolean) => void;
    onLockChange?: (enabled: boolean) => void;
    onDelete?: () => void;
    onClearAll?: () => void;
}

interface AppProps {
    onToolSelect: (toolId: string) => void;
    controlCallbacks?: ControlCallbacks;
}

// Bridge component that syncs toolbar state to control callbacks AND keyboard shortcuts
function ToolbarBridge({ callbacks, onToolSelect }: { callbacks?: ControlCallbacks; onToolSelect: (toolId: string) => void }) {
    const toolbarState = useToolbarStore();

    const {
        drawingsVisible,
        eraserMode,
        snapEnabled,
        lockEnabled,
        setActiveTool,
    } = toolbarState;

    // Expose setActiveTool to main.tsx via window global so it can reset toolbar when drawings complete
    useEffect(() => {
        (window as any).__reactToolbarActions = { setActiveTool };
        return () => {
            delete (window as any).__reactToolbarActions;
        };
    }, [setActiveTool]);

    // Enable global keyboard shortcuts
    useKeyboardShortcuts({ toolbarState, onToolSelect });

    // Sync visibility changes
    useEffect(() => {
        callbacks?.onVisibilityChange?.(drawingsVisible);
    }, [drawingsVisible, callbacks]);

    // Sync eraser mode changes
    useEffect(() => {
        callbacks?.onEraserModeChange?.(eraserMode);
    }, [eraserMode, callbacks]);

    // Sync snap changes
    useEffect(() => {
        callbacks?.onSnapChange?.(snapEnabled);
    }, [snapEnabled, callbacks]);

    // Sync lock changes
    useEffect(() => {
        callbacks?.onLockChange?.(lockEnabled);
    }, [lockEnabled, callbacks]);

    return null; // No UI - just syncs state
}

export function App({ onToolSelect, controlCallbacks }: AppProps) {
    console.log('[App] Rendering React LHSToolbar with keyboard shortcuts');
    return (
        <ToolbarProvider>
            <ToolbarBridge callbacks={controlCallbacks} onToolSelect={onToolSelect} />
            <LHSToolbar onToolSelect={onToolSelect} />
        </ToolbarProvider>
    );
}
