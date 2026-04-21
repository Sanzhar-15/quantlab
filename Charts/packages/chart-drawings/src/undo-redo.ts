/**
 * Undo/redo system with command pattern.
 */

import type { Drawing } from './types';

/**
 * Command interface.
 */
export interface Command {
  execute(): void;
  undo(): void;
  merge?(other: Command): boolean;
}

/**
 * Command history.
 */
export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory = 100;

  /**
   * Execute a command and add to history.
   */
  public execute(command: Command): void {
    command.execute();

    // Try to merge with last command
    if (this.undoStack.length > 0) {
      const lastCommand = this.undoStack[this.undoStack.length - 1]!;
      if (lastCommand.merge && lastCommand.merge(command)) {
        // Command merged, don't add new entry
        return;
      }
    }

    // Add to undo stack
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }

    // Clear redo stack
    this.redoStack = [];
  }

  /**
   * Undo last command.
   */
  public undo(): boolean {
    if (this.undoStack.length === 0) {
      return false;
    }

    const command = this.undoStack.pop()!;
    command.undo();
    this.redoStack.push(command);
    return true;
  }

  /**
   * Redo last undone command.
   */
  public redo(): boolean {
    if (this.redoStack.length === 0) {
      return false;
    }

    const command = this.redoStack.pop()!;
    command.execute();
    this.undoStack.push(command);
    return true;
  }

  /**
   * Check if undo is available.
   */
  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available.
   */
  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Clear history.
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * Create drawing command.
 */
export class CreateDrawingCommand implements Command {
  private drawing: Drawing;
  private drawings: Map<string, Drawing>;

  public constructor(drawing: Drawing, drawings: Map<string, Drawing>) {
    this.drawing = drawing;
    this.drawings = drawings;
  }

  public execute(): void {
    this.drawings.set(this.drawing.id, this.drawing);
  }

  public undo(): void {
    this.drawings.delete(this.drawing.id);
  }
}

/**
 * Delete drawing command.
 */
export class DeleteDrawingCommand implements Command {
  private drawing: Drawing;
  private drawings: Map<string, Drawing>;

  public constructor(drawing: Drawing, drawings: Map<string, Drawing>) {
    this.drawing = drawing;
    this.drawings = drawings;
  }

  public execute(): void {
    this.drawings.delete(this.drawing.id);
  }

  public undo(): void {
    this.drawings.set(this.drawing.id, this.drawing);
  }
}

/**
 * Update drawing command.
 */
export class UpdateDrawingCommand implements Command {
  private drawingId: string;
  private oldDrawing: Drawing;
  private newDrawing: Drawing;
  private drawings: Map<string, Drawing>;

  public constructor(
    oldDrawing: Drawing,
    newDrawing: Drawing,
    drawings: Map<string, Drawing>,
  ) {
    this.drawingId = oldDrawing.id;
    this.oldDrawing = oldDrawing;
    this.newDrawing = newDrawing;
    this.drawings = drawings;
  }

  public execute(): void {
    this.drawings.set(this.drawingId, this.newDrawing);
  }

  public undo(): void {
    this.drawings.set(this.drawingId, this.oldDrawing);
  }

  /**
   * Merge consecutive drag operations.
   */
  public merge(other: Command): boolean {
    if (other instanceof UpdateDrawingCommand && other.drawingId === this.drawingId) {
      // Merge: keep old state, update new state
      this.newDrawing = other.newDrawing;
      return true;
    }
    return false;
  }
}

