// Keyboard Shortcuts Registry for LHS Toolbar

import type { ToolCategory } from './types';

export interface ShortcutAction {
    key: string;
    mod?: 'cmd' | 'ctrl' | 'shift' | 'alt';
    action: 'openHub' | 'activateCategory' | 'closePanel' | 'toggleEraser';
    category?: ToolCategory;
    description: string;
}

export const TOOLBAR_SHORTCUTS: Record<string, ShortcutAction> = {
    // Hub
    hub: {
        key: 'k',
        mod: 'cmd', // ⌘K on Mac, Ctrl+K on Windows
        action: 'openHub',
        description: 'Open Hub',
    },

    // Categories (single key press)
    levels: {
        key: 'l',
        action: 'activateCategory',
        category: 'levels',
        description: 'Activate last-used Levels tool',
    },
    trend: {
        key: 't',
        action: 'activateCategory',
        category: 'trend',
        description: 'Activate last-used Trend tool',
    },
    structure: {
        key: 's',
        action: 'activateCategory',
        category: 'structure',
        description: 'Activate last-used Structure tool',
    },
    zones: {
        key: 'z',
        action: 'activateCategory',
        category: 'zones',
        description: 'Activate last-used Zones tool',
    },
    overlays: {
        key: 'f',
        action: 'activateCategory',
        category: 'overlays',
        description: 'Activate last-used Overlays tool',
    },
    patterns: {
        key: 'p',
        action: 'activateCategory',
        category: 'patterns',
        description: 'Activate last-used Patterns tool',
    },
    plan: {
        key: 'r',
        action: 'activateCategory',
        category: 'plan',
        description: 'Activate last-used Plan tool',
    },
    measure: {
        key: 'm',
        action: 'activateCategory',
        category: 'measure',
        description: 'Activate last-used Measure tool',
    },
    annotate: {
        key: 'a',
        action: 'activateCategory',
        category: 'annotate',
        description: 'Activate last-used Annotate tool',
    },

    // Global actions
    escape: {
        key: 'Escape',
        action: 'closePanel',
        description: 'Close open panel',
    },
    eraser: {
        key: 'e',
        action: 'toggleEraser',
        description: 'Toggle eraser mode',
    },
};

// Platform detection
export const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

// Check if modifier key is pressed
export function hasModifier(event: KeyboardEvent, mod?: 'cmd' | 'ctrl' | 'shift' | 'alt'): boolean {
    if (!mod) return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

    switch (mod) {
        case 'cmd':
            return isMac ? event.metaKey : event.ctrlKey;
        case 'ctrl':
            return event.ctrlKey;
        case 'shift':
            return event.shiftKey;
        case 'alt':
            return event.altKey;
        default:
            return false;
    }
}

// Check if element is an input/textarea (to avoid triggering shortcuts while typing)
export function isInputElement(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;

    const tagName = target.tagName.toLowerCase();
    const isEditable = target.isContentEditable;

    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || isEditable;
}
