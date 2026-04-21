/**
 * Gesture engine with state machine.
 * Handles panning, zooming, selecting, and editing gestures.
 */

import type { InputState } from './input-state';
import type { InertialPanState, InertialPanOptions } from './physics';
import {
  createInertialPanState,
  updateInertialPan,
  addInertialVelocity,
  startInertialPan,
  stopInertialPan,
  clampInertialPan,
} from './physics';

/**
 * Gesture state.
 */
export type GestureState = 'idle' | 'panning' | 'zooming' | 'selecting' | 'editing';

/**
 * Gesture result from processing input.
 */
export type GestureResult = {
  type: 'pan' | 'zoom' | 'select' | 'none';
  deltaX?: number;
  deltaY?: number;
  scale?: number;
  centerX?: number;
  centerY?: number;
  selectionStart?: { x: number; y: number };
  selectionEnd?: { x: number; y: number };
};

/**
 * Gesture engine options.
 */
export type GestureEngineOptions = {
  inertialPan?: InertialPanOptions;
  enableInertia?: boolean;
  enablePinch?: boolean;
  panThreshold?: number;      // Minimum movement to start pan (pixels)
  zoomSensitivity?: number;   // Wheel zoom sensitivity
};

/**
 * V5.2 Default Gesture Options
 * 
 * Tuned for iOS-like momentum feel with direct manipulation during drag.
 */
const DEFAULT_OPTIONS: Required<GestureEngineOptions> = {
  inertialPan: {
    friction: 0.95,      // V5.2: iOS-like 5% velocity loss per frame
    minVelocity: 0.5,    // V5.2: Clean stop threshold
    maxVelocity: 50,
  },
  enableInertia: true,
  enablePinch: true,
  panThreshold: 2,       // Minimum pixels to confirm drag intent
  zoomSensitivity: 0.001,
};

/**
 * Gesture engine.
 * Processes input events and produces gesture results.
 */
export class GestureEngine {
  private state: GestureState = 'idle';
  private inertialPan: InertialPanState = createInertialPanState();
  private lastInput: InputState | null = null;
  private panStart: { x: number; y: number } | null = null;
  private pinchStart: { distance: number; centerX: number; centerY: number } | null = null;
  private selectionStart: { x: number; y: number } | null = null;
  private options: Required<GestureEngineOptions>;
  private frameTime: number = 0;

  public constructor(options: GestureEngineOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Process input state and return gesture result.
   */
  public processInput(input: InputState): GestureResult | null {
    this.frameTime = input.timestamp;

    // Handle wheel zoom
    if (input.wheelDeltaY !== 0 || input.wheelDeltaX !== 0) {
      return this.handleWheelZoom(input);
    }

    // Handle pinch zoom
    if (this.options.enablePinch && input.pinchScale !== 1.0) {
      return this.handlePinchZoom(input);
    }

    // Handle pointer movement
    if (input.buttons !== 0) {
      return this.handlePointerDown(input);
    } else {
      return this.handlePointerUp(input);
    }
  }

  /**
   * Update gesture engine (process inertia).
   * Call this every frame.
   */
  public update(frameTime: number): GestureResult | null {
    if (!this.options.enableInertia) {
      return null;
    }

    if (this.state === 'panning' && this.inertialPan.active) {
      const frameDelta = frameTime - this.frameTime;
      if (frameDelta > 0) {
        this.inertialPan = updateInertialPan(this.inertialPan, this.options.inertialPan);

        if (this.inertialPan.active) {
          return {
            type: 'pan',
            deltaX: this.inertialPan.velocityX,
            deltaY: this.inertialPan.velocityY,
          };
        } else {
          // Inertia stopped
          this.state = 'idle';
        }
      }
    }

    this.frameTime = frameTime;
    return null;
  }

  /**
   * Handle wheel zoom.
   */
  private handleWheelZoom(input: InputState): GestureResult {
    const scale = 1.0 + input.wheelDeltaY * this.options.zoomSensitivity;
    return {
      type: 'zoom',
      scale,
      centerX: input.pointerX,
      centerY: input.pointerY,
    };
  }

  /**
   * Handle pinch zoom.
   */
  private handlePinchZoom(input: InputState): GestureResult {
    if (this.state !== 'zooming' && this.pinchStart === null) {
      // Start pinch
      this.state = 'zooming';
      this.pinchStart = {
        distance: this.calculatePinchDistance(input),
        centerX: input.pinchCenterX,
        centerY: input.pinchCenterY,
      };
      return { type: 'none' };
    }

    if (this.pinchStart) {
      const currentDistance = this.calculatePinchDistance(input);
      const scale = currentDistance / this.pinchStart.distance;

      return {
        type: 'zoom',
        scale,
        centerX: input.pinchCenterX,
        centerY: input.pinchCenterY,
      };
    }

    return { type: 'none' };
  }

  /**
   * Calculate pinch distance from input state.
   */
  private calculatePinchDistance(input: InputState): number {
    // For now, use a heuristic based on pinchScale
    // In a full implementation, this would track actual touch distances
    return input.pinchScale * 100; // Reference distance
  }

  /**
   * Handle pointer down.
   */
  private handlePointerDown(input: InputState): GestureResult | null {
    if (this.state === 'idle') {
      // Start potential pan
      this.panStart = { x: input.pointerX, y: input.pointerY };
      this.inertialPan = startInertialPan(this.inertialPan, input.pointerX, input.pointerY);
      this.lastInput = input;
      return null;
    }

    if (this.state === 'panning' && this.lastInput) {
      // Continue pan
      const deltaX = input.pointerX - this.lastInput.pointerX;
      const deltaY = input.pointerY - this.lastInput.pointerY;

      // Check if movement exceeds threshold
      if (this.panStart) {
        const totalDeltaX = input.pointerX - this.panStart.x;
        const totalDeltaY = input.pointerY - this.panStart.y;
        const distance = Math.sqrt(totalDeltaX * totalDeltaX + totalDeltaY * totalDeltaY);

        if (distance < this.options.panThreshold) {
          // Not enough movement yet
          this.lastInput = input;
          return null;
        }
      }

      // Update inertial pan velocity
      const frameDelta = (input.timestamp - this.lastInput.timestamp) / 16.67; // Normalize to frame time
      if (frameDelta > 0) {
        this.inertialPan = addInertialVelocity(this.inertialPan, deltaX, deltaY, frameDelta);
      }

      this.state = 'panning';
      this.lastInput = input;

      return {
        type: 'pan',
        deltaX,
        deltaY,
      };
    }

    this.lastInput = input;
    return null;
  }

  /**
   * Handle pointer up.
   */
  private handlePointerUp(input: InputState): GestureResult | null {
    if (this.state === 'panning') {
      // Stop pan, start inertia
      this.inertialPan = stopInertialPan(this.inertialPan);
      this.lastInput = null;
      this.panStart = null;
      // State remains 'panning' until inertia stops
      return null;
    }

    if (this.state === 'zooming') {
      // Stop zoom
      this.state = 'idle';
      this.pinchStart = null;
      return null;
    }

    // Reset to idle
    this.state = 'idle';
    this.panStart = null;
    this.pinchStart = null;
    this.lastInput = null;
    this.inertialPan = createInertialPanState();

    return null;
  }

  /**
   * Get current gesture state.
   */
  public getState(): GestureState {
    return this.state;
  }

  /**
   * Reset gesture engine to idle.
   */
  public reset(): void {
    this.state = 'idle';
    this.inertialPan = createInertialPanState();
    this.lastInput = null;
    this.panStart = null;
    this.pinchStart = null;
    this.selectionStart = null;
  }

  /**
   * Clamp inertial pan to valid range.
   */
  public clampPan(minX: number, maxX: number, minY: number, maxY: number): void {
    this.inertialPan = clampInertialPan(this.inertialPan, minX, maxX, minY, maxY);
  }
}

