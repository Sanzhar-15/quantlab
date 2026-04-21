/**
 * Rubber-band overscroll effect.
 * 
 * Provides iOS-like edge resistance when panning beyond chart bounds.
 * Uses asymptotic resistance approaching max overscroll distance.
 */

export interface RubberBandConfig {
  /**
   * Maximum overscroll distance in pixels.
   * Beyond this, resistance becomes very high.
   */
  maxOverscroll: number;

  /**
   * Resistance coefficient (0-1).
   * Higher values = more resistance.
   * Typical: 0.55 (iOS-like)
   */
  resistance: number;

  /**
   * Enable rubber-band effect.
   */
  enabled: boolean;
}

export const RubberBandPresets = {
  /**
   * iOS-like rubber-band.
   */
  ios: {
    maxOverscroll: 100,
    resistance: 0.55,
    enabled: true,
  } as RubberBandConfig,

  /**
   * Gentle rubber-band (more forgiving).
   */
  gentle: {
    maxOverscroll: 150,
    resistance: 0.4,
    enabled: true,
  } as RubberBandConfig,

  /**
   * Stiff rubber-band (less overscroll).
   */
  stiff: {
    maxOverscroll: 50,
    resistance: 0.7,
    enabled: true,
  } as RubberBandConfig,

  /**
   * Disabled (hard clamp at bounds).
   */
  disabled: {
    maxOverscroll: 0,
    resistance: 1,
    enabled: false,
  } as RubberBandConfig,
};

/**
 * Apply rubber-band resistance to a delta.
 * 
 * When the user drags beyond bounds, the delta is scaled down
 * based on how far beyond the bounds they are.
 * 
 * @param delta Input delta (e.g., pan distance)
 * @param currentOverscroll Current overscroll amount (positive = beyond bounds)
 * @param config Rubber-band configuration
 * @returns Scaled delta with rubber-band resistance applied
 */
export function applyRubberBandResistance(
  delta: number,
  currentOverscroll: number,
  config: RubberBandConfig
): number {
  if (!config.enabled || currentOverscroll <= 0) {
    return delta;
  }

  const { maxOverscroll, resistance } = config;

  // Asymptotic resistance function
  // As overscroll approaches maxOverscroll, resistance approaches 1 (no movement)
  const resistanceFactor = 1 - Math.pow(
    currentOverscroll / maxOverscroll,
    resistance
  );

  // Clamp resistance factor to [0, 1]
  const clampedResistance = Math.max(0, Math.min(1, resistanceFactor));

  return delta * clampedResistance;
}

/**
 * Calculate rubber-banded position.
 * 
 * Given a desired position and bounds, returns the actual position
 * with rubber-band effect applied.
 * 
 * @param position Desired position
 * @param min Minimum allowed position (lower bound)
 * @param max Maximum allowed position (upper bound)
 * @param config Rubber-band configuration
 * @returns Rubber-banded position
 */
export function rubberBandClamp(
  position: number,
  min: number,
  max: number,
  config: RubberBandConfig
): number {
  if (!config.enabled) {
    return Math.max(min, Math.min(max, position));
  }

  const { maxOverscroll, resistance } = config;

  if (position < min) {
    // Overscrolled below min
    const overscroll = min - position;
    const clampedOverscroll = Math.min(overscroll, maxOverscroll);

    // Asymptotic function: as overscroll increases, actual displacement decreases
    const actualOverscroll = maxOverscroll * (
      1 - Math.pow(1 - clampedOverscroll / maxOverscroll, 1 / resistance)
    );

    return min - actualOverscroll;
  } else if (position > max) {
    // Overscrolled above max
    const overscroll = position - max;
    const clampedOverscroll = Math.min(overscroll, maxOverscroll);

    const actualOverscroll = maxOverscroll * (
      1 - Math.pow(1 - clampedOverscroll / maxOverscroll, 1 / resistance)
    );

    return max + actualOverscroll;
  } else {
    // Within bounds
    return position;
  }
}

/**
 * Calculate current overscroll amount.
 * 
 * Returns 0 if within bounds, positive if beyond bounds.
 * 
 * @param position Current position
 * @param min Minimum allowed position
 * @param max Maximum allowed position
 * @returns Overscroll amount (0 if within bounds)
 */
export function getOverscrollAmount(
  position: number,
  min: number,
  max: number
): number {
  if (position < min) {
    return min - position;
  } else if (position > max) {
    return position - max;
  } else {
    return 0;
  }
}

/**
 * Check if position is beyond bounds.
 */
export function isOverscrolled(
  position: number,
  min: number,
  max: number
): boolean {
  return position < min || position > max;
}

/**
 * Calculate snap-back target when user releases during overscroll.
 * 
 * Returns the nearest bound (min or max).
 * 
 * @param position Current position
 * @param min Minimum allowed position
 * @param max Maximum allowed position
 * @returns Snap-back target
 */
export function getSnapBackTarget(
  position: number,
  min: number,
  max: number
): number {
  if (position < min) {
    return min;
  } else if (position > max) {
    return max;
  } else {
    return position;
  }
}

/**
 * RubberBandController - Convenience class for rubber-band overscroll with spring-based snap-back.
 * 
 * Provides iOS-like edge resistance during drag and smooth spring-based snap-back on release.
 * Uses SpringAnimation for natural, frame-rate independent snap-back animation.
 */
import { SpringAnimation, SpringPresets, type SpringConfig } from './spring';

export interface RubberBandControllerConfig extends Partial<RubberBandConfig> {
  /**
   * Spring config for snap-back animation.
   * Default: SpringPresets.ios (slight bounce for natural feel)
   */
  springConfig?: SpringConfig;
}

export class RubberBandController {
  private config: RubberBandConfig;
  private springConfig: SpringConfig;
  private overscroll: number = 0;
  private spring: SpringAnimation | null = null;
  private active: boolean = false;

  constructor(config: RubberBandControllerConfig = {}) {
    this.config = {
      maxOverscroll: config.maxOverscroll ?? RubberBandPresets.ios.maxOverscroll,
      resistance: config.resistance ?? RubberBandPresets.ios.resistance,
      enabled: config.enabled ?? RubberBandPresets.ios.enabled,
    };
    this.springConfig = config.springConfig ?? SpringPresets.ios;
  }

  /**
   * Apply rubber-band resistance during drag past boundary.
   * Returns the resisted delta to apply.
   */
  applyResistance(delta: number, atBoundary: 'start' | 'end' | null): number {
    if (!this.config.enabled) {
      return delta;
    }

    // Not at boundary - no resistance
    if (!atBoundary) {
      // If we have overscroll, we're returning from overscroll
      if (this.overscroll !== 0) {
        const returning = Math.sign(this.overscroll) !== Math.sign(delta);
        if (returning) {
          // Allow full delta when returning
          this.overscroll += delta;
          if (Math.sign(this.overscroll) !== Math.sign(this.overscroll - delta)) {
            // Crossed zero - snap to zero
            const remaining = -this.overscroll + delta;
            this.overscroll = 0;
            this.spring = null;
            this.active = false;
            return remaining;
          }
          return 0; // Consumed by overscroll reduction
        }
      }
      return delta;
    }

    this.active = true;

    // Calculate asymptotic resistance
    // As overscroll approaches max, resistance approaches 0
    const overscrollRatio = Math.abs(this.overscroll) / this.config.maxOverscroll;
    const resistance = this.config.resistance * (1 - overscrollRatio);
    const effectiveResistance = Math.max(0.05, resistance); // Minimum 5%

    // Apply resistance
    const resistedDelta = delta * effectiveResistance;

    // Update overscroll (clamped)
    this.overscroll = Math.max(
      -this.config.maxOverscroll,
      Math.min(this.config.maxOverscroll, this.overscroll + resistedDelta)
    );

    // Cancel spring if user starts dragging again
    if (this.spring) {
      this.spring = null;
    }

    return resistedDelta;
  }

  /**
   * Start snap-back animation on release.
   * Uses spring animation for natural, frame-rate independent snap-back.
   */
  release(currentVelocity: number = 0): void {
    if (Math.abs(this.overscroll) < 0.5) {
      this.overscroll = 0;
      this.active = false;
      this.spring = null;
      return;
    }

    // Create spring animation from current overscroll to zero
    this.spring = new SpringAnimation(this.overscroll, this.springConfig);
    this.spring.setTarget(0, currentVelocity);
    this.active = true;
  }

  /**
   * Step the snap-back animation.
   * Returns current overscroll offset.
   * Call this each frame with performance.now().
   */
  step(currentTime: number = performance.now()): number {
    if (!this.spring) {
      return this.overscroll;
    }

    this.overscroll = this.spring.update(currentTime);

    if (this.spring.isAtRest()) {
      this.overscroll = 0;
      this.spring = null;
      this.active = false;
    }

    return this.overscroll;
  }

  /**
   * Get current overscroll offset.
   */
  getOverscroll(): number {
    return this.overscroll;
  }

  /**
   * Check if rubber-band is active (overscroll or animating).
   */
  isActive(): boolean {
    return this.active || (this.spring !== null && !this.spring.isAtRest());
  }

  /**
   * Cancel and reset.
   */
  cancel(): void {
    this.overscroll = 0;
    this.spring = null;
    this.active = false;
  }

  /**
   * Interrupt animation (e.g., user starts dragging again).
   */
  interrupt(): void {
    this.spring = null;
  }
}

