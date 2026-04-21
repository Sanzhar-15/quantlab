// Global Keyboard Shortcuts Hook

import { useEffect } from 'react';
import { TOOLBAR_SHORTCUTS, hasModifier, isInputElement } from '../components/toolbar/shortcuts';
import type { ToolbarState } from '../components/toolbar/types';

interface UseKeyboardShortcutsProps {
    toolbarState: ToolbarState;
    onToolSelect?: (toolId: string) => void;
}

export function useKeyboardShortcuts({ toolbarState, onToolSelect }: UseKeyboardShortcutsProps) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            // Don't trigger shortcuts when typing in inputs
            if (isInputElement(event.target)) {
                return;
            }

            // Find matching shortcut
            for (const shortcut of Object.values(TOOLBAR_SHORTCUTS)) {
                const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
                const modMatch = hasModifier(event, shortcut.mod);

                if (!keyMatch || !modMatch) continue;

                // Prevent default browser behavior
                event.preventDefault();
                event.stopPropagation();

                // Execute action
                switch (shortcut.action) {
                    case 'openHub':
                        toolbarState.setOpenPanel('hub');
                        break;

                    case 'activateCategory':
                        if (shortcut.category) {
                            const toolId = toolbarState.lastUsed[shortcut.category];
                            if (toolId) {
                                toolbarState.setActiveTool(toolId);
                                toolbarState.setLastUsed(shortcut.category, toolId);
                                toolbarState.closePanel();
                                onToolSelect?.(toolId);
                            }
                        }
                        break;

                    case 'closePanel':
                        toolbarState.closePanel();
                        break;

                    case 'toggleEraser':
                        toolbarState.toggleEraser();
                        break;
                }

                // Only handle first matching shortcut
                break;
            }
        };

        // Add global listener
        window.addEventListener('keydown', handleKeyDown, true); // Use capture phase

        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [toolbarState, onToolSelect]);
}
