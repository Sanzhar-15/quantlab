/**
 * Accessibility utilities for respecting user preferences.
 * 
 * Respects `prefers-reduced-motion` and adjusts animation/physics behavior accordingly.
 */

import type { SpringConfig } from './spring';
import type { RubberBandConfig } from './rubber-band';

export interface AccessibilityConfig {
  /**
   * Respect `prefers-reduced-motion` media query.
   */
  respectReducedMotion: boolean;

  /**
   * Custom reduced motion detection (for testing/override).
   */
  forceReducedMotion?: boolean;
}

export const AccessibilityDefaults: AccessibilityConfig = {
  respectReducedMotion: true,
};

/**
 * Global accessibility manager (singleton).
 */
class AccessibilityManager {
  private config: AccessibilityConfig = AccessibilityDefaults;
  private mediaQuery: MediaQueryList | null = null;
  private listeners: Set<() => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      
      // Listen for changes
      const listener = () => this.notifyListeners();
      if (this.mediaQuery.addEventListener) {
        this.mediaQuery.addEventListener('change', listener);
      } else {
        // Fallback for older browsers
        this.mediaQuery.addListener(listener);
      }
    }
  }

  /**
   * Check if reduced motion is preferred.
   */
  public prefersReducedMotion(): boolean {
    if (this.config.forceReducedMotion !== undefined) {
      return this.config.forceReducedMotion;
    }

    if (!this.config.respectReducedMotion) {
      return false;
    }

    return this.mediaQuery?.matches ?? false;
  }

  /**
   * Update configuration.
   */
  public setConfig(config: Partial<AccessibilityConfig>): void {
    this.config = { ...this.config, ...config };
    this.notifyListeners();
  }

  /**
   * Get current configuration.
   */
  public getConfig(): AccessibilityConfig {
    return { ...this.config };
  }

  /**
   * Add a listener for preference changes.
   */
  public addListener(listener: () => void): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener.
   */
  public removeListener(listener: () => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of a change.
   */
  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Adjust spring config for reduced motion.
   */
  public adjustSpringConfig(config: SpringConfig): SpringConfig {
    if (!this.prefersReducedMotion()) {
      return config;
    }

    // For reduced motion: instant transitions (very high frequency, critically damped)
    return {
      ...config,
      frequency: 100, // Very fast
      dampingRatio: 1.0, // Critically damped (no overshoot)
    };
  }

  /**
   * Adjust rubber-band config for reduced motion.
   */
  public adjustRubberBandConfig(config: RubberBandConfig): RubberBandConfig {
    if (!this.prefersReducedMotion()) {
      return config;
    }

    // For reduced motion: disable rubber-band (hard clamp)
    return {
      ...config,
      enabled: false,
    };
  }

  /**
   * Adjust friction for reduced motion.
   */
  public adjustFriction(friction: number): number {
    if (!this.prefersReducedMotion()) {
      return friction;
    }

    // For reduced motion: higher friction (faster deceleration)
    return Math.max(friction, 0.98);
  }

  /**
   * Adjust animation duration for reduced motion.
   */
  public adjustDuration(durationMs: number): number {
    if (!this.prefersReducedMotion()) {
      return durationMs;
    }

    // For reduced motion: instant or very short duration
    return Math.min(durationMs, 50);
  }

  /**
   * Check if animations should be disabled entirely.
   */
  public shouldDisableAnimations(): boolean {
    return this.prefersReducedMotion();
  }
}

/**
 * Global singleton instance.
 */
let globalAccessibilityManager: AccessibilityManager | null = null;

/**
 * Get the global accessibility manager.
 */
export function getAccessibilityManager(): AccessibilityManager {
  if (!globalAccessibilityManager) {
    globalAccessibilityManager = new AccessibilityManager();
  }
  return globalAccessibilityManager;
}

/**
 * Convenience function: check if reduced motion is preferred.
 */
export function prefersReducedMotion(): boolean {
  return getAccessibilityManager().prefersReducedMotion();
}

/**
 * Convenience function: adjust spring config for accessibility.
 */
export function adjustSpringForAccessibility(config: SpringConfig): SpringConfig {
  return getAccessibilityManager().adjustSpringConfig(config);
}

/**
 * Convenience function: adjust rubber-band config for accessibility.
 */
export function adjustRubberBandForAccessibility(config: RubberBandConfig): RubberBandConfig {
  return getAccessibilityManager().adjustRubberBandConfig(config);
}

/**
 * Convenience function: adjust friction for accessibility.
 */
export function adjustFrictionForAccessibility(friction: number): number {
  return getAccessibilityManager().adjustFriction(friction);
}

/**
 * Convenience function: adjust duration for accessibility.
 */
export function adjustDurationForAccessibility(durationMs: number): number {
  return getAccessibilityManager().adjustDuration(durationMs);
}

/**
 * Get appropriate momentum friction for reduced motion.
 * Higher friction = faster stop for reduced motion.
 */
export function getMomentumFriction(): number {
  const manager = getAccessibilityManager();
  return manager.adjustFriction(0.95);
}

/**
 * Get minimum velocity threshold for momentum.
 * Higher threshold = less momentum for reduced motion.
 */
export function getMinVelocity(): number {
  const manager = getAccessibilityManager();
  if (manager.prefersReducedMotion()) {
    return 2.0;
  }
  return 0.5;
}

/**
 * Check if crosshair smoothing should be used.
 */
export function shouldSmoothCrosshair(): boolean {
  return !getAccessibilityManager().prefersReducedMotion();
}

/**
 * Check if rubber-band effect should be used.
 */
export function shouldUseRubberBand(): boolean {
  return !getAccessibilityManager().prefersReducedMotion();
}

/**
 * Get animation duration multiplier.
 * 0 = instant, 1 = normal
 */
export function getAnimationMultiplier(): number {
  const manager = getAccessibilityManager();
  return manager.prefersReducedMotion() ? 0.2 : 1.0;
}

