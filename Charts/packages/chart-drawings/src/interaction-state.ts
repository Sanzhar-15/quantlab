/**
 * Interaction state machine for drawing tools.
 */

import type { Drawing, Point } from './types';

/**
 * Interaction state.
 */
export type InteractionState =
  | 'idle'
  | 'hovering'           // Hovering over drawing
  | 'creating'           // Creating new drawing
  | 'selected'           // Drawing selected
  | 'dragging'           // Dragging handle/anchor
  | 'multi-selecting';   // Box selection active

/**
 * Interaction context.
 */
export interface InteractionContext {
  state: InteractionState;
  activeDrawing: Drawing | null;
  activeHandleIndex: number | null;
  selectedDrawings: Set<string>;
  creatingDrawing: Drawing | null;
  creatingAnchorIndex: number;
  boxSelectionStart: Point | null;
  boxSelectionEnd: Point | null;
}

/**
 * Interaction state machine.
 */
export class InteractionStateMachine {
  private context: InteractionContext = {
    state: 'idle',
    activeDrawing: null,
    activeHandleIndex: null,
    selectedDrawings: new Set(),
    creatingDrawing: null,
    creatingAnchorIndex: 0,
    boxSelectionStart: null,
    boxSelectionEnd: null,
  };

  /**
   * Get current state.
   */
  public getState(): InteractionState {
    return this.context.state;
  }

  /**
   * Get interaction context.
   */
  public getContext(): InteractionContext {
    return { ...this.context };
  }

  /**
   * Transition to idle state.
   */
  public toIdle(): void {
    this.context.state = 'idle';
    this.context.activeDrawing = null;
    this.context.activeHandleIndex = null;
    this.context.creatingDrawing = null;
    this.context.creatingAnchorIndex = 0;
    this.context.boxSelectionStart = null;
    this.context.boxSelectionEnd = null;
  }

  /**
   * Transition to hovering state.
   */
  public toHovering(drawing: Drawing): void {
    if (this.context.state === 'idle' || this.context.state === 'hovering') {
      this.context.state = 'hovering';
      this.context.activeDrawing = drawing;
    }
  }

  /**
   * Transition to creating state.
   */
  public toCreating(drawing: Drawing): void {
    this.context.state = 'creating';
    this.context.creatingDrawing = drawing;
    this.context.creatingAnchorIndex = 0;
  }

  /**
   * Add anchor to creating drawing.
   */
  public addCreatingAnchor(anchor: AnchorPoint): void {
    if (this.context.state === 'creating' && this.context.creatingDrawing) {
      this.context.creatingDrawing.anchors.push(anchor);
      this.context.creatingAnchorIndex++;
    }
  }

  /**
   * Finish creating drawing.
   */
  public finishCreating(): Drawing | null {
    if (this.context.state === 'creating' && this.context.creatingDrawing) {
      const drawing = this.context.creatingDrawing;
      this.context.state = 'idle';
      this.context.creatingDrawing = null;
      this.context.creatingAnchorIndex = 0;
      return drawing;
    }
    return null;
  }

  /**
   * Transition to selected state.
   */
  public toSelected(drawing: Drawing): void {
    this.context.state = 'selected';
    this.context.activeDrawing = drawing;
    this.context.selectedDrawings.clear();
    this.context.selectedDrawings.add(drawing.id);
  }

  /**
   * Add to selection.
   */
  public addToSelection(drawing: Drawing): void {
    this.context.selectedDrawings.add(drawing.id);
    if (this.context.selectedDrawings.size === 1) {
      this.context.activeDrawing = drawing;
      this.context.state = 'selected';
    } else {
      this.context.state = 'multi-selecting';
    }
  }

  /**
   * Remove from selection.
   */
  public removeFromSelection(drawingId: string): void {
    this.context.selectedDrawings.delete(drawingId);
    if (this.context.selectedDrawings.size === 0) {
      this.context.state = 'idle';
      this.context.activeDrawing = null;
    } else if (this.context.selectedDrawings.size === 1) {
      this.context.state = 'selected';
      // Set active drawing to remaining one
      const remainingId = Array.from(this.context.selectedDrawings)[0]!;
      // Would need drawing lookup here
    }
  }

  /**
   * Clear selection.
   */
  public clearSelection(): void {
    this.context.selectedDrawings.clear();
    this.context.activeDrawing = null;
    this.context.state = 'idle';
  }

  /**
   * Transition to dragging state.
   */
  public toDragging(drawing: Drawing, handleIndex: number): void {
    if (this.context.state === 'selected' || this.context.state === 'hovering') {
      this.context.state = 'dragging';
      this.context.activeDrawing = drawing;
      this.context.activeHandleIndex = handleIndex;
    }
  }

  /**
   * Update dragging anchor.
   */
  public updateDraggingAnchor(anchor: AnchorPoint): void {
    if (
      this.context.state === 'dragging' &&
      this.context.activeDrawing &&
      this.context.activeHandleIndex !== null
    ) {
      const index = this.context.activeHandleIndex;
      if (index >= 0 && index < this.context.activeDrawing.anchors.length) {
        this.context.activeDrawing.anchors[index] = anchor;
        this.context.activeDrawing.modifiedAt = Date.now();
        this.context.activeDrawing.revision++;
      }
    }
  }

  /**
   * Finish dragging.
   */
  public finishDragging(): void {
    if (this.context.state === 'dragging') {
      this.context.state = 'selected';
      this.context.activeHandleIndex = null;
    }
  }

  /**
   * Transition to multi-selecting state.
   */
  public toMultiSelecting(startPoint: Point): void {
    this.context.state = 'multi-selecting';
    this.context.boxSelectionStart = startPoint;
    this.context.boxSelectionEnd = startPoint;
  }

  /**
   * Update box selection.
   */
  public updateBoxSelection(endPoint: Point): void {
    if (this.context.state === 'multi-selecting') {
      this.context.boxSelectionEnd = endPoint;
    }
  }

  /**
   * Finish box selection.
   */
  public finishBoxSelection(selectedDrawingIds: string[]): void {
    if (this.context.state === 'multi-selecting') {
      this.context.selectedDrawings = new Set(selectedDrawingIds);
      this.context.boxSelectionStart = null;
      this.context.boxSelectionEnd = null;

      if (selectedDrawingIds.length === 0) {
        this.context.state = 'idle';
        this.context.activeDrawing = null;
      } else if (selectedDrawingIds.length === 1) {
        this.context.state = 'selected';
        // Would need drawing lookup here
      } else {
        this.context.state = 'multi-selecting';
      }
    }
  }
}

// Import AnchorPoint type
import type { AnchorPoint } from './types';

