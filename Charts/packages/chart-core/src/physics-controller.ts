/**
 * V5.2 Momentum Physics Controller
 * 
 * Implements iOS-like friction decay for natural-feeling momentum scrolling.
 * 
 * Key characteristics:
 * - Friction of 0.95 per frame at 60fps (~0.05 velocity loss per frame)
 * - Frame-rate independent via exponential decay: friction^(dt/16.67)
 * - Minimum velocity threshold of 0.5 px/frame to stop momentum
 * 
 * iOS scroll comparison:
 * - iOS uses ~0.998 decay per frame at 60fps (0.998^60 ≈ 0.89 remaining after 1s)
 * - We use slightly more friction (0.95) for faster, more responsive stopping
 * - This feels snappier while still being smooth
 */
export class PhysicsController {
  private _velocityX: number = 0;
  
  // V5.2: iOS-like friction - 0.95 decay per frame at 60fps
  // This is slightly more aggressive than iOS (0.998) for snappier response
  private _friction: number = 0.95;
  
  // V5.2: Stop threshold - momentum stops when velocity drops below this
  private _minVelocity: number = 0.5;
  
  private _lastTime: number = 0;
  private _active: boolean = false;
  private _onUpdate: (deltaX: number) => void;

  constructor(onUpdate: (deltaX: number) => void) {
    this._onUpdate = onUpdate;
  }

  public fling(velocity: number) {
    this._velocityX = velocity;
    this._active = true;
    this._lastTime = performance.now();
    this._loop();
  }

  public stop() {
    this._active = false;
    this._velocityX = 0;
  }

  public get isActive(): boolean {
    return this._active;
  }

  private _loop = () => {
    if (!this._active) return;

    const now = performance.now();
    const dt = Math.min(now - this._lastTime, 32); // Cap dt at 32ms to prevent jumps
    this._lastTime = now;

    // V5.2: Frame-rate independent friction decay
    // v = v0 * friction^(dt/16.67) where 16.67ms = 1 frame at 60fps
    const frictionPerFrame = Math.pow(this._friction, dt / 16.67);
    this._velocityX *= frictionPerFrame;

    if (Math.abs(this._velocityX) < this._minVelocity) {
      this.stop();
      return;
    }

    // Emit movement (delta pixels = velocity * time)
    const dtSeconds = dt / 1000;
    this._onUpdate(this._velocityX * dtSeconds);

    requestAnimationFrame(this._loop);
  };
}

