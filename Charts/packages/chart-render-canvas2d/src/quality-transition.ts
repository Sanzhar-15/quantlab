/**
 * Quality transition manager for gradual quality level changes.
 * 
 * Prevents visible quality jumps when transitioning between quality levels
 * by gradually interpolating over a short duration.
 * 
 * Quality levels:
 * - 0: High quality (idle state, full detail)
 * - 1: Medium quality (light degradation, some optimizations)
 * - 2: Low quality (heavy degradation, maximum performance)
 * 
 * Transition behavior:
 * - Increasing degradation (0→1→2): Immediate (performance critical - don't delay)
 * - Decreasing degradation (2→1→0): Gradual (smooth visual experience - avoid visible jumps)
 */

export class QualityTransitionManager {
  private currentLevel: number = 0;
  private targetLevel: number = 0;
  private transitionFrames = 0;
  private readonly TRANSITION_DURATION = 3; // frames (3 frames ≈ 50ms at 60fps)

  /**
   * Update quality level to target level with gradual transition.
   * 
   * @param targetLevel - Target quality level (0, 1, or 2)
   * @returns Current quality level (may be interpolated during transition)
   */
  update(targetLevel: number): number {
    // Clamp target to valid range
    const clampedTarget = Math.max(0, Math.min(2, Math.round(targetLevel)));
    this.targetLevel = clampedTarget;

    // If already at target, no transition needed
    if (this.currentLevel === this.targetLevel) {
      this.transitionFrames = 0;
      return this.currentLevel;
    }

    // Performance optimization: immediate transition when increasing degradation level
    // (0→1→2 means degrading quality for performance - don't delay this)
    if (this.targetLevel > this.currentLevel) {
      this.currentLevel = this.targetLevel;
      this.transitionFrames = 0;
      return this.currentLevel;
    }

    // Smooth transition when decreasing degradation level (returning to high quality)
    // Start or continue transition
    this.transitionFrames++;
    
    if (this.transitionFrames >= this.TRANSITION_DURATION) {
      // Transition complete
      this.currentLevel = this.targetLevel;
      this.transitionFrames = 0;
      return this.currentLevel;
    }

    // Interpolate between current and target
    const progress = this.transitionFrames / this.TRANSITION_DURATION;
    const interpolated = this.currentLevel * (1 - progress) + this.targetLevel * progress;
    
    // Round to nearest integer for discrete quality levels
    return Math.round(interpolated);
  }

  /**
   * Get current quality level without updating.
   */
  getCurrentLevel(): number {
    return this.currentLevel;
  }

  /**
   * Get target quality level.
   */
  getTargetLevel(): number {
    return this.targetLevel;
  }

  /**
   * Check if currently transitioning.
   */
  isTransitioning(): boolean {
    return this.currentLevel !== this.targetLevel;
  }

  /**
   * Force immediate transition to target level (skip interpolation).
   */
  forceTransition(target: number): void {
    this.currentLevel = target;
    this.targetLevel = target;
    this.transitionFrames = 0;
  }
}

