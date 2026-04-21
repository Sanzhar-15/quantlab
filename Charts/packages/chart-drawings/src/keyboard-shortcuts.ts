/**
 * Keyboard shortcut handling for drawing tools.
 */

import type { Drawing } from './types';

/**
 * Keyboard shortcut handler.
 */
export class KeyboardShortcutHandler {
  private handlers = new Map<string, () => void>();

  /**
   * Register a keyboard shortcut.
   */
  public register(key: string, handler: () => void): void {
    this.handlers.set(key, handler);
  }

  /**
   * Handle keyboard event.
   */
  public handleKeyDown(event: KeyboardEvent): boolean {
    const key = this.getKeyString(event);
    const handler = this.handlers.get(key);
    if (handler) {
      event.preventDefault();
      handler();
      return true;
    }
    return false;
  }

  /**
   * Get key string from keyboard event.
   */
  private getKeyString(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');
    parts.push(event.key);
    return parts.join('+');
  }

  /**
   * Create default keyboard shortcuts.
   */
  public static createDefault(
    onDelete: (selectedDrawings: Drawing[]) => void,
    onEscape: () => void,
    onUndo: () => void,
    onRedo: () => void,
    getSelectedDrawings: () => Drawing[],
  ): KeyboardShortcutHandler {
    const handler = new KeyboardShortcutHandler();

    // Delete key
    handler.register('Delete', () => {
      const selected = getSelectedDrawings();
      if (selected.length > 0) {
        onDelete(selected);
      }
    });

    // Escape key
    handler.register('Escape', () => {
      onEscape();
    });

    // Undo (Ctrl+Z or Cmd+Z)
    handler.register('Ctrl+Z', () => {
      onUndo();
    });
    handler.register('Meta+Z', () => {
      onUndo();
    });

    // Redo (Ctrl+Shift+Z or Cmd+Shift+Z)
    handler.register('Ctrl+Shift+Z', () => {
      onRedo();
    });
    handler.register('Meta+Shift+Z', () => {
      onRedo();
    });

    return handler;
  }
}

