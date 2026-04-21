/**
 * Analytic Spring Solver for smooth transitions.
 * 
 * Implements a critically damped harmonic oscillator with closed-form solution.
 * Stable across all frame rates (60Hz to 144Hz+).
 * 
 * Used for non-interactive transitions (e.g., zoom to range, snap back).
 * NOT used during direct manipulation (pan/drag).
 */

export interface SpringConfig {
  /**
   * Natural frequency (rad/s).
   * Higher values = faster oscillation.
   * Typical range: 10-30 for UI animations.
   */
  frequency: number;

  /**
   * Damping ratio (dimensionless).
   * - 0: Undamped (oscillates forever)
   * - 0-1: Underdamped (overshoots and oscillates)
   * - 1: Critically damped (fastest without overshoot)
   * - >1: Overdamped (slow, no overshoot)
   * 
   * For UI, typically use 1.0 (critically damped) or 0.7-0.9 (slight overshoot).
   */
  dampingRatio: number;

  /**
   * Velocity threshold for considering the spring "at rest".
   * When |velocity| < threshold, the spring is considered settled.
   */
  restVelocityThreshold?: number;

  /**
   * Position threshold for considering the spring "at rest".
   * When |position - target| < threshold, the spring is considered settled.
   */
  restPositionThreshold?: number;
}

export interface SpringState {
  position: number;
  velocity: number;
  target: number;
  isAtRest: boolean;
}

/**
 * Default spring configurations for common UI scenarios.
 */
export const SpringPresets = {
  /**
   * Critically damped, medium speed.
   * Good for general UI transitions.
   */
  default: {
    frequency: 20,
    dampingRatio: 1.0,
    restVelocityThreshold: 0.01,
    restPositionThreshold: 0.01,
  } as SpringConfig,

  /**
   * Fast, critically damped.
   * Good for snappy interactions.
   */
  snappy: {
    frequency: 30,
    dampingRatio: 1.0,
    restVelocityThreshold: 0.01,
    restPositionThreshold: 0.01,
  } as SpringConfig,

  /**
   * Slow, smooth.
   * Good for gentle transitions.
   */
  gentle: {
    frequency: 10,
    dampingRatio: 1.0,
    restVelocityThreshold: 0.01,
    restPositionThreshold: 0.01,
  } as SpringConfig,

  /**
   * Slight overshoot (bouncy).
   * Good for playful interactions.
   */
  bouncy: {
    frequency: 20,
    dampingRatio: 0.7,
    restVelocityThreshold: 0.01,
    restPositionThreshold: 0.01,
  } as SpringConfig,

  /**
   * iOS-like spring.
   * Smooth, natural feel.
   */
  ios: {
    frequency: 15,
    dampingRatio: 0.86,
    restVelocityThreshold: 0.01,
    restPositionThreshold: 0.01,
  } as SpringConfig,
};

/**
 * Advance a spring by a time step using closed-form solution.
 * 
 * This implementation uses the analytical solution for a damped harmonic oscillator,
 * which is numerically stable and frame-rate independent.
 * 
 * @param state Current spring state
 * @param config Spring configuration
 * @param deltaTime Time step in seconds
 * @returns New spring state
 */
export function advanceSpring(
  state: SpringState,
  config: SpringConfig,
  deltaTime: number
): SpringState {
  if (state.isAtRest) {
    return state;
  }

  const { frequency, dampingRatio } = config;
  const restVelThreshold = config.restVelocityThreshold ?? 0.01;
  const restPosThreshold = config.restPositionThreshold ?? 0.01;

  // Angular frequency
  const omega = 2 * Math.PI * frequency;

  // Displacement from target
  const x0 = state.position - state.target;
  const v0 = state.velocity;

  let x: number;
  let v: number;

  if (dampingRatio === 1.0) {
    // Critically damped (most common for UI)
    const exp = Math.exp(-omega * deltaTime);
    x = (x0 + (v0 + omega * x0) * deltaTime) * exp;
    v = (v0 - omega * (v0 + omega * x0) * deltaTime) * exp;
  } else if (dampingRatio < 1.0) {
    // Underdamped (oscillatory)
    const zeta = dampingRatio;
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const exp = Math.exp(-zeta * omega * deltaTime);
    const cos = Math.cos(omegaD * deltaTime);
    const sin = Math.sin(omegaD * deltaTime);

    x = exp * (x0 * cos + ((v0 + zeta * omega * x0) / omegaD) * sin);
    v = exp * (v0 * cos - ((v0 * zeta * omega + omega * omega * x0) / omegaD) * sin);
  } else {
    // Overdamped (slow, no overshoot)
    const zeta = dampingRatio;
    const r1 = -omega * (zeta + Math.sqrt(zeta * zeta - 1));
    const r2 = -omega * (zeta - Math.sqrt(zeta * zeta - 1));

    const c1 = (v0 - r2 * x0) / (r1 - r2);
    const c2 = x0 - c1;

    const exp1 = Math.exp(r1 * deltaTime);
    const exp2 = Math.exp(r2 * deltaTime);

    x = c1 * exp1 + c2 * exp2;
    v = c1 * r1 * exp1 + c2 * r2 * exp2;
  }

  const newPosition = state.target + x;
  const newVelocity = v;

  // Check if at rest
  const isAtRest =
    Math.abs(newVelocity) < restVelThreshold &&
    Math.abs(newPosition - state.target) < restPosThreshold;

  return {
    position: isAtRest ? state.target : newPosition,
    velocity: isAtRest ? 0 : newVelocity,
    target: state.target,
    isAtRest,
  };
}

/**
 * Create a new spring state.
 */
export function createSpringState(
  position: number,
  velocity: number = 0,
  target: number = position
): SpringState {
  return {
    position,
    velocity,
    target,
    isAtRest: position === target && velocity === 0,
  };
}

/**
 * Update the target of a spring (e.g., user changed zoom level).
 */
export function setSpringTarget(state: SpringState, target: number): SpringState {
  return {
    ...state,
    target,
    isAtRest: false,
  };
}

/**
 * Instantly snap a spring to a position (no animation).
 */
export function snapSpring(state: SpringState, position: number): SpringState {
  return {
    position,
    velocity: 0,
    target: position,
    isAtRest: true,
  };
}

/**
 * SpringAnimation - Convenience class for stateful spring animations.
 * 
 * Wraps the functional spring API for easier state management in class-based code.
 * Useful for animations that persist across frames.
 */
export class SpringAnimation {
  private state: SpringState;
  private config: SpringConfig;
  private lastUpdateTime: number = 0;
  private firstUpdate: boolean = true;

  constructor(initialValue: number, config: SpringConfig = SpringPresets.default) {
    this.config = config;
    this.state = createSpringState(initialValue, 0, initialValue);
    // Don't set lastUpdateTime here - wait for first update() call
  }

  /**
   * Set new target with optional initial velocity.
   */
  setTarget(target: number, initialVelocity: number = 0): void {
    this.state = {
      ...this.state,
      target,
      velocity: initialVelocity !== 0 ? initialVelocity : this.state.velocity,
      isAtRest: false,
    };
    // Update lastUpdateTime when target changes to avoid large delta on next update()
    this.lastUpdateTime = performance.now();
    // Reset firstUpdate flag so next update() uses proper deltaTime calculation
    this.firstUpdate = false;
  }

  /**
   * Update and return current position.
   * Call this each frame with performance.now().
   * 
   * Caps deltaTime to prevent instability from large time gaps (e.g., tab switching, suspended app).
   * Uses 100ms cap to ensure smooth animations even after long pauses.
   */
  update(currentTime: number = performance.now()): number {
    // First frame: Initialize lastUpdateTime, use nominal 60fps frame time
    if (this.firstUpdate) {
      this.lastUpdateTime = currentTime;
      this.firstUpdate = false;
      // Use nominal 60fps frame time for first update (16.67ms)
      const deltaTime = 16.67 / 1000;
      if (deltaTime > 0) {
        this.state = advanceSpring(this.state, this.config, deltaTime);
      }
      return this.state.position;
    }
    
    // Cap deltaTime to 100ms (0.1s) to prevent instability from tab switches or app suspension
    const rawDeltaTime = (currentTime - this.lastUpdateTime) / 1000;
    const deltaTime = Math.max(0, Math.min(rawDeltaTime, 0.1));
    this.lastUpdateTime = currentTime;
    
    if (deltaTime > 0) {
      this.state = advanceSpring(this.state, this.config, deltaTime);
    }
    
    return this.state.position;
  }

  /**
   * Check if animation has essentially stopped.
   */
  isAtRest(): boolean {
    return this.state.isAtRest;
  }

  /**
   * Get current position.
   */
  getPosition(): number {
    return this.state.position;
  }

  /**
   * Get current velocity.
   */
  getVelocity(): number {
    return this.state.velocity;
  }

  /**
   * Get target value.
   */
  getTarget(): number {
    return this.state.target;
  }

  /**
   * Snap to target immediately.
   */
  snapToTarget(): void {
    this.state = snapSpring(this.state, this.state.target);
  }

  /**
   * Update config (creates new animation from current state).
   */
  setConfig(config: SpringConfig): void {
    this.config = config;
  }
}

/**
 * Spring2D - Convenience class for 2D spring animations.
 * 
 * Useful for viewport animations (zoom, pan) or crosshair smoothing.
 */
export class Spring2D {
  private springX: SpringAnimation;
  private springY: SpringAnimation;

  constructor(
    initialX: number,
    initialY: number,
    config: SpringConfig = SpringPresets.default
  ) {
    this.springX = new SpringAnimation(initialX, config);
    this.springY = new SpringAnimation(initialY, config);
  }

  /**
   * Set new target with optional initial velocity.
   */
  setTarget(x: number, y: number, vx: number = 0, vy: number = 0): void {
    this.springX.setTarget(x, vx);
    this.springY.setTarget(y, vy);
  }

  /**
   * Update and return current position.
   */
  update(currentTime: number = performance.now()): { x: number; y: number } {
    return {
      x: this.springX.update(currentTime),
      y: this.springY.update(currentTime),
    };
  }

  /**
   * Check if both springs are at rest.
   */
  isAtRest(): boolean {
    return this.springX.isAtRest() && this.springY.isAtRest();
  }

  /**
   * Get current position.
   */
  getPosition(): { x: number; y: number } {
    return {
      x: this.springX.getPosition(),
      y: this.springY.getPosition(),
    };
  }

  /**
   * Snap to target immediately.
   */
  snapToTarget(): void {
    this.springX.snapToTarget();
    this.springY.snapToTarget();
  }
}

