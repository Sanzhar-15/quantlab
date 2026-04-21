/**
 * Main drawing manager orchestrating all components.
 */

import type { Drawing, DrawingType, AnchorPoint, Point } from './types';
import type { CoordinateTransform } from './coordinate-transform';
import { DrawingRegistry, createDefaultRegistry } from './registry';
import { InteractionStateMachine } from './interaction-state';
import { DrawingHitTesting } from './hit-testing';
import { DragHandler } from './drag-handler';
import { SnappingSystem } from './snapping';
import { CommandHistory, CreateDrawingCommand, DeleteDrawingCommand, UpdateDrawingCommand } from './undo-redo';
import { DrawingPersistence } from './persistence';
import { KeyboardShortcutHandler } from './keyboard-shortcuts';

/**
 * Drawing manager events.
 */
export type DrawingManagerEvent =
  | { type: 'drawingCreated'; drawing: Drawing }
  | { type: 'drawingUpdated'; drawing: Drawing }
  | { type: 'drawingDeleted'; drawingId: string }
  | { type: 'selectionChanged'; selectedIds: string[] };

/**
 * Drawing manager.
 */
export class DrawingManager {
  private registry: DrawingRegistry;
  private drawings = new Map<string, Drawing>();
  private stateMachine: InteractionStateMachine;
  private hitTesting: DrawingHitTesting;
  private dragHandler: DragHandler;
  private snapping: SnappingSystem;
  private commandHistory: CommandHistory;
  private persistence: DrawingPersistence;
  private keyboardShortcuts: KeyboardShortcutHandler;
  private transform: CoordinateTransform | null = null;
  private eventListeners: Array<(event: DrawingManagerEvent) => void> = [];

  public constructor(chartId: string = 'default') {
    this.registry = createDefaultRegistry();
    this.stateMachine = new InteractionStateMachine();
    this.hitTesting = new DrawingHitTesting();
    this.dragHandler = new DragHandler();
    this.snapping = new SnappingSystem();
    this.commandHistory = new CommandHistory();
    this.persistence = new DrawingPersistence(chartId);

    // Set up keyboard shortcuts
    this.keyboardShortcuts = KeyboardShortcutHandler.createDefault(
      (selected) => this.deleteDrawings(selected),
      () => this.stateMachine.toIdle(),
      () => this.commandHistory.undo(),
      () => this.commandHistory.redo(),
      () => this.getSelectedDrawings(),
    );

    // Load persisted drawings
    this.loadDrawings();
  }

  /**
   * Set coordinate transform.
   */
  public setTransform(transform: CoordinateTransform): void {
    this.transform = transform;
    this.hitTesting.setTransform(transform);
    this.dragHandler.setTransform(transform);
    this.dragHandler.setSnapping(this.snapping);
  }

  /**
   * Create a new drawing.
   */
  public createDrawing(type: DrawingType, anchors: AnchorPoint[], style?: Partial<DrawingStyle>): Drawing {
    const definition = this.registry.get(type);
    if (!definition) {
      throw new Error(`Drawing type ${type} not found`);
    }

    const drawing = definition.create(anchors, style);
    drawing.paneId = drawing.paneId || 'main'; // Default pane

    // Execute as command
    const command = new CreateDrawingCommand(drawing, this.drawings);
    this.commandHistory.execute(command);

    // Add to hit testing
    this.hitTesting.addDrawing(drawing);

    // Emit event
    this.emitEvent({ type: 'drawingCreated', drawing });

    // Auto-save
    this.saveDrawings();

    return drawing;
  }

  /**
   * Update a drawing.
   */
  public updateDrawing(drawing: Drawing): void {
    const oldDrawing = this.drawings.get(drawing.id);
    if (!oldDrawing) {
      throw new Error(`Drawing ${drawing.id} not found`);
    }

    drawing.modifiedAt = Date.now();
    drawing.revision++;

    // Execute as command
    const command = new UpdateDrawingCommand(oldDrawing, drawing, this.drawings);
    this.commandHistory.execute(command);

    // Update hit testing
    this.hitTesting.updateDrawing(drawing);

    // Emit event
    this.emitEvent({ type: 'drawingUpdated', drawing });

    // Auto-save
    this.saveDrawings();
  }

  /**
   * Delete a drawing.
   */
  public deleteDrawing(drawingId: string): void {
    const drawing = this.drawings.get(drawingId);
    if (!drawing) {
      return;
    }

    // Execute as command
    const command = new DeleteDrawingCommand(drawing, this.drawings);
    this.commandHistory.execute(command);

    // Remove from hit testing
    this.hitTesting.removeDrawing(drawingId);

    // Remove from selection
    this.stateMachine.removeFromSelection(drawingId);

    // Emit event
    this.emitEvent({ type: 'drawingDeleted', drawingId });

    // Auto-save
    this.saveDrawings();
  }

  /**
   * Delete multiple drawings.
   */
  public deleteDrawings(drawings: Drawing[]): void {
    for (const drawing of drawings) {
      this.deleteDrawing(drawing.id);
    }
  }

  /**
   * Get all drawings.
   */
  public getAllDrawings(): Drawing[] {
    return Array.from(this.drawings.values());
  }

  /**
   * Get drawing by ID.
   */
  public getDrawing(id: string): Drawing | undefined {
    return this.drawings.get(id);
  }

  /**
   * Get selected drawings.
   */
  public getSelectedDrawings(): Drawing[] {
    const context = this.stateMachine.getContext();
    const selected: Drawing[] = [];
    for (const id of context.selectedDrawings) {
      const drawing = this.drawings.get(id);
      if (drawing) {
        selected.push(drawing);
      }
    }
    return selected;
  }

  /**
   * Handle pointer down.
   */
  public handlePointerDown(point: Point, button: number): void {
    // Hit test
    const hit = this.hitTesting.hitTest(point);
    if (hit) {
      if (hit.result.type === 'handle') {
        // Start dragging handle
        this.stateMachine.toDragging(hit.drawing, hit.result.handleIndex!);
      } else {
        // Select drawing
        this.stateMachine.toSelected(hit.drawing);
      }
    } else {
      // Start box selection or create new drawing
      this.stateMachine.toMultiSelecting(point);
    }
  }

  /**
   * Handle pointer move.
   */
  public handlePointerMove(point: Point): void {
    const context = this.stateMachine.getContext();

    if (context.state === 'dragging' && context.activeDrawing && context.activeHandleIndex !== null) {
      // Update dragging
      const anchor = this.dragHandler.updateDrag(
        context.activeDrawing,
        context.activeHandleIndex,
        point,
        this.getAllDrawings(),
      );
      this.stateMachine.updateDraggingAnchor(anchor);
      this.updateDrawing(context.activeDrawing);
    } else if (context.state === 'multi-selecting') {
      // Update box selection
      this.stateMachine.updateBoxSelection(point);
    } else {
      // Hit test for hover
      const hit = this.hitTesting.hitTest(point);
      if (hit) {
        this.stateMachine.toHovering(hit.drawing);
      } else {
        this.stateMachine.toIdle();
      }
    }
  }

  /**
   * Handle pointer up.
   */
  public handlePointerUp(point: Point): void {
    const context = this.stateMachine.getContext();

    if (context.state === 'dragging') {
      this.stateMachine.finishDragging();
    } else if (context.state === 'multi-selecting') {
      // Finish box selection
      const selectedIds: string[] = []; // TODO: Calculate from box
      this.stateMachine.finishBoxSelection(selectedIds);
    }
  }

  /**
   * Handle keyboard event.
   */
  public handleKeyDown(event: KeyboardEvent): boolean {
    return this.keyboardShortcuts.handleKeyDown(event);
  }

  /**
   * Undo last operation.
   */
  public undo(): boolean {
    return this.commandHistory.undo();
  }

  /**
   * Redo last undone operation.
   */
  public redo(): boolean {
    return this.commandHistory.redo();
  }

  /**
   * Save drawings to persistence.
   */
  public saveDrawings(): void {
    this.persistence.save(this.getAllDrawings());
  }

  /**
   * Load drawings from persistence.
   */
  public loadDrawings(): void {
    const drawings = this.persistence.load();
    for (const drawing of drawings) {
      this.drawings.set(drawing.id, drawing);
      this.hitTesting.addDrawing(drawing);
    }
  }

  /**
   * Add event listener.
   */
  public addEventListener(listener: (event: DrawingManagerEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove event listener.
   */
  public removeEventListener(listener: (event: DrawingManagerEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index >= 0) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * Emit event.
   */
  private emitEvent(event: DrawingManagerEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Get registry.
   */
  public getRegistry(): DrawingRegistry {
    return this.registry;
  }


  /**
   * Get state machine.
   */
  public getStateMachine(): InteractionStateMachine {
    return this.stateMachine;
  }

  /**
   * Get hit testing.
   */
  public getHitTesting(): DrawingHitTesting {
    return this.hitTesting;
  }
}

// Import DrawingStyle type
import type { DrawingStyle } from './types';

