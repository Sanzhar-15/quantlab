/**
 * Delta Charting Engine: Grid Cross-Fade Transitions
 * 
 * Manages smooth transitions when grid step changes during zoom.
 * Old grid fades out while new grid fades in over ~120ms.
 */

import type { Tick, Rect } from '@charts-plus/chart-core';
import { renderGridFromTicks } from './grid-renderer';

interface GridTransition {
  oldTicks: Tick[] | null;
  oldStartTime: number;
  duration: number; // ms
}

interface GridStyle {
  majorColor: string;
  minorColor: string;
  majorAlpha: number;
  minorAlpha: number;
  dpr: number;
  fadeMinors: boolean;
}

/**
 * Manages cross-fade transitions for grid lines.
 * 
 * When the major step changes (e.g., 100 → 200), this creates
 * a smooth visual transition by:
 * 1. Keeping the old grid visible, fading out
 * 2. Fading in the new grid simultaneously
 * 3. Completing the transition over ~120ms
 */
export class GridTransitionManager {
  private yTransition: GridTransition = { 
    oldTicks: null, 
    oldStartTime: 0, 
    duration: 120 
  };
  
  private xTransition: GridTransition = { 
    oldTicks: null, 
    oldStartTime: 0, 
    duration: 120 
  };
  
  private _lastYMajorStep: number | null = null;
  private _lastXMajorStep: number | null = null;

  /**
   * Sets the transition duration in milliseconds.
   */
  public setDuration(ms: number): void {
    this.yTransition.duration = ms;
    this.xTransition.duration = ms;
  }

  /**
   * Called when Y ticks are regenerated.
   * If step changed, initiates a transition.
   */
  public onYTicksChanged(prevTicks: Tick[], newTicks: Tick[], newMajorStep: number): void {
    const stepChanged = this._lastYMajorStep !== null && 
                        this._lastYMajorStep !== newMajorStep &&
                        prevTicks.length > 0;
    
    if (stepChanged) {
      this.yTransition.oldTicks = [...prevTicks];
      this.yTransition.oldStartTime = performance.now();
    }
    
    this._lastYMajorStep = newMajorStep;
  }

  /**
   * Called when X ticks are regenerated.
   * If step changed, initiates a transition.
   */
  public onXTicksChanged(prevTicks: Tick[], newTicks: Tick[], newMajorStep: number): void {
    const stepChanged = this._lastXMajorStep !== null && 
                        this._lastXMajorStep !== newMajorStep &&
                        prevTicks.length > 0;
    
    if (stepChanged) {
      this.xTransition.oldTicks = [...prevTicks];
      this.xTransition.oldStartTime = performance.now();
    }
    
    this._lastXMajorStep = newMajorStep;
  }

  /**
   * Gets the current Y transition progress (0 = start, 1 = complete).
   */
  public getYTransitionProgress(): number {
    if (!this.yTransition.oldTicks) return 1;
    
    const elapsed = performance.now() - this.yTransition.oldStartTime;
    const progress = Math.min(1, elapsed / this.yTransition.duration);
    
    if (progress >= 1) {
      this.yTransition.oldTicks = null;
    }
    
    return progress;
  }

  /**
   * Gets the current X transition progress (0 = start, 1 = complete).
   */
  public getXTransitionProgress(): number {
    if (!this.xTransition.oldTicks) return 1;
    
    const elapsed = performance.now() - this.xTransition.oldStartTime;
    const progress = Math.min(1, elapsed / this.xTransition.duration);
    
    if (progress >= 1) {
      this.xTransition.oldTicks = null;
    }
    
    return progress;
  }

  /**
   * Checks if any transition is currently active.
   */
  public isTransitioning(): boolean {
    return this.yTransition.oldTicks !== null || this.xTransition.oldTicks !== null;
  }

  /**
   * Renders grid with cross-fade if transition is active.
   * 
   * If no transition is active, renders normally.
   * If transition is active, renders both old (fading out) and new (fading in) grids.
   */
  public renderWithTransition(
    ctx: CanvasRenderingContext2D,
    plotRect: Rect,
    currentYTicks: Tick[],
    currentXTicks: Tick[],
    style: GridStyle,
  ): boolean {
    const yProgress = this.getYTransitionProgress();
    const xProgress = this.getXTransitionProgress();
    
    const yTransitioning = yProgress < 1 && this.yTransition.oldTicks;
    const xTransitioning = xProgress < 1 && this.xTransition.oldTicks;
    
    if (!yTransitioning && !xTransitioning) {
      // No transition active - normal render
      return false;
    }
    
    if (yTransitioning && xTransitioning) {
      // Both axes transitioning - complex case
      // Render old grid fading out
      const fadeOutMajor = style.majorAlpha * (1 - Math.max(yProgress, xProgress));
      const fadeOutMinor = style.minorAlpha * (1 - Math.max(yProgress, xProgress));
      
      renderGridFromTicks(
        ctx,
        plotRect,
        this.yTransition.oldTicks!,
        this.xTransition.oldTicks!,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeOutMajor,
          minorAlpha: fadeOutMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
      
      // Render new grid fading in
      const fadeInMajor = style.majorAlpha * Math.max(yProgress, xProgress);
      const fadeInMinor = style.minorAlpha * Math.max(yProgress, xProgress);
      
      renderGridFromTicks(
        ctx,
        plotRect,
        currentYTicks,
        currentXTicks,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeInMajor,
          minorAlpha: fadeInMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
    } else if (yTransitioning) {
      // Only Y axis transitioning
      // Render old Y with current X, fading out
      const fadeOutMajor = style.majorAlpha * (1 - yProgress);
      const fadeOutMinor = style.minorAlpha * (1 - yProgress);
      
      renderGridFromTicks(
        ctx,
        plotRect,
        this.yTransition.oldTicks!,
        currentXTicks,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeOutMajor,
          minorAlpha: fadeOutMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
      
      // Render new Y with current X, fading in
      const fadeInMajor = style.majorAlpha * yProgress;
      const fadeInMinor = style.minorAlpha * yProgress;
      
      renderGridFromTicks(
        ctx,
        plotRect,
        currentYTicks,
        currentXTicks,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeInMajor,
          minorAlpha: fadeInMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
    } else if (xTransitioning) {
      // Only X axis transitioning
      // Render current Y with old X, fading out
      const fadeOutMajor = style.majorAlpha * (1 - xProgress);
      const fadeOutMinor = style.minorAlpha * (1 - xProgress);
      
      renderGridFromTicks(
        ctx,
        plotRect,
        currentYTicks,
        this.xTransition.oldTicks!,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeOutMajor,
          minorAlpha: fadeOutMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
      
      // Render current Y with new X, fading in
      const fadeInMajor = style.majorAlpha * xProgress;
      const fadeInMinor = style.minorAlpha * xProgress;
      
      renderGridFromTicks(
        ctx,
        plotRect,
        currentYTicks,
        currentXTicks,
        style.majorColor,
        style.minorColor,
        {
          majorAlpha: fadeInMajor,
          minorAlpha: fadeInMinor,
          dpr: style.dpr,
          fadeMinors: style.fadeMinors,
        },
      );
    }
    
    // Request next frame if transition is still active
    if (this.isTransitioning()) {
      return true; // Indicates animation is active
    }
    
    return true;
  }

  /**
   * Resets all transitions.
   */
  public reset(): void {
    this.yTransition.oldTicks = null;
    this.xTransition.oldTicks = null;
    this._lastYMajorStep = null;
    this._lastXMajorStep = null;
  }
}

