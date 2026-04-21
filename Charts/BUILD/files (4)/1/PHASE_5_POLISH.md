# V6 Implementation Guide: Phase 5 - Polish Features

## Overview

Phase 5 adds polish features that elevate the charting experience:
1. **Analytic Spring Solver** - Stable physics for 120Hz displays
2. **Rubber-Band Overscroll** - iOS-like edge behavior
3. **Accessibility** - prefers-reduced-motion support

**Location:** `packages/chart-core/src/`

---

## Task 1: Analytic Spring Solver

The V5.2 Euler solver works fine at 60Hz but can be unstable at 120Hz+. The analytic solver uses closed-form solutions of the damped harmonic oscillator.

### File: `packages/chart-core/src/spring.ts`

```typescript
/**
 * Analytic Spring Animation
 * 
 * Uses closed-form solution of the damped harmonic oscillator:
 * m*x'' + c*x' + k*x = 0
 * 
 * Where:
 * - m = mass (normalized to 1)
 * - c = damping coefficient
 * - k = stiffness
 * 
 * Converted to more intuitive parameters:
 * - response: time to reach ~63% of target (seconds)
 * - dampingRatio (ζ): 
 *   - < 1: underdamped (oscillates)
 *   - = 1: critically damped (fastest without overshoot)
 *   - > 1: overdamped (slow approach)
 */

export interface SpringConfig {
  response: number;       // Time to ~63% of target (seconds)
  dampingRatio: number;   // ζ (zeta): damping ratio
}

export const SPRING_PRESETS: Record<string, SpringConfig> = {
  // Viewport panning/zooming - no overshoot
  viewport: { response: 0.4, dampingRatio: 1.0 },
  
  // Rubber-band snap-back - slight bounce
  rubberBand: { response: 0.5, dampingRatio: 0.8 },
  
  // UI elements - smooth and fast
  ui: { response: 0.3, dampingRatio: 0.85 },
  
  // Crosshair smoothing - fast, no overshoot
  crosshair: { response: 0.1, dampingRatio: 1.2 },
  
  // Reduced motion - instant
  reducedMotion: { response: 0.1, dampingRatio: 1.5 },
};

export class SpringAnimation {
  // Config
  private config: SpringConfig;
  
  // Derived parameters
  private omega0: number;  // Natural frequency
  private zeta: number;    // Damping ratio
  
  // State
  private x0: number;      // Initial displacement from target
  private v0: number;      // Initial velocity
  private target: number;  // Target value
  private startTime: number;
  
  // Current values (for external access)
  private currentPosition: number;
  private currentVelocity: number;
  
  constructor(initialValue: number, config: SpringConfig = SPRING_PRESETS.viewport) {
    this.config = config;
    this.omega0 = (2 * Math.PI) / config.response;
    this.zeta = config.dampingRatio;
    
    this.x0 = 0;
    this.v0 = 0;
    this.target = initialValue;
    this.startTime = 0;
    this.currentPosition = initialValue;
    this.currentVelocity = 0;
  }
  
  /**
   * Set new target with optional initial velocity.
   */
  setTarget(target: number, initialVelocity: number = 0): void {
    // Capture current state as new initial conditions
    this.x0 = this.currentPosition - target;
    this.v0 = initialVelocity !== 0 ? initialVelocity : this.currentVelocity;
    this.target = target;
    this.startTime = performance.now();
  }
  
  /**
   * Update and return current position.
   */
  update(currentTime: number): number {
    const t = Math.max(0, (currentTime - this.startTime) / 1000);
    const state = this.computeState(t);
    
    this.currentPosition = state.position;
    this.currentVelocity = state.velocity;
    
    return this.currentPosition;
  }
  
  /**
   * Compute position and velocity at time t using analytic solution.
   */
  private computeState(t: number): { position: number; velocity: number } {
    const { omega0, zeta, x0, v0, target } = this;
    
    // Handle near-zero displacement
    if (Math.abs(x0) < 1e-10 && Math.abs(v0) < 1e-10) {
      return { position: target, velocity: 0 };
    }
    
    // Critically damped (ζ ≈ 1)
    if (Math.abs(zeta - 1) < 0.001) {
      return this.computeCriticallyDamped(t);
    }
    
    // Overdamped (ζ > 1)
    if (zeta > 1) {
      return this.computeOverdamped(t);
    }
    
    // Underdamped (ζ < 1)
    return this.computeUnderdamped(t);
  }
  
  /**
   * Critically damped: x(t) = (A + Bt) * e^(-ω₀t) + target
   */
  private computeCriticallyDamped(t: number): { position: number; velocity: number } {
    const { omega0, x0, v0, target } = this;
    
    const A = x0;
    const B = v0 + omega0 * x0;
    const expTerm = Math.exp(-omega0 * t);
    
    const position = target + (A + B * t) * expTerm;
    const velocity = (B - omega0 * (A + B * t)) * expTerm;
    
    return { position, velocity };
  }
  
  /**
   * Overdamped: x(t) = A*e^(r1*t) + B*e^(r2*t) + target
   */
  private computeOverdamped(t: number): { position: number; velocity: number } {
    const { omega0, zeta, x0, v0, target } = this;
    
    const sqrtTerm = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega0 * (zeta - sqrtTerm);
    const r2 = -omega0 * (zeta + sqrtTerm);
    
    const A = (v0 - r2 * x0) / (r1 - r2);
    const B = x0 - A;
    
    const exp1 = Math.exp(r1 * t);
    const exp2 = Math.exp(r2 * t);
    
    const position = target + A * exp1 + B * exp2;
    const velocity = A * r1 * exp1 + B * r2 * exp2;
    
    return { position, velocity };
  }
  
  /**
   * Underdamped: x(t) = e^(-ζω₀t) * (A*cos(ωd*t) + B*sin(ωd*t)) + target
   */
  private computeUnderdamped(t: number): { position: number; velocity: number } {
    const { omega0, zeta, x0, v0, target } = this;
    
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);  // Damped frequency
    const expTerm = Math.exp(-omega0 * zeta * t);
    
    const A = x0;
    const B = (v0 + omega0 * zeta * x0) / omegaD;
    
    const cosWd = Math.cos(omegaD * t);
    const sinWd = Math.sin(omegaD * t);
    
    const position = target + expTerm * (A * cosWd + B * sinWd);
    const velocity = expTerm * (
      (B * omegaD - A * omega0 * zeta) * cosWd -
      (A * omegaD + B * omega0 * zeta) * sinWd
    );
    
    return { position, velocity };
  }
  
  /**
   * Check if animation has essentially stopped.
   */
  isAtRest(threshold: number = 0.01): boolean {
    const displacement = Math.abs(this.currentPosition - this.target);
    const velocity = Math.abs(this.currentVelocity);
    
    // Use relative threshold for large values
    const relativeThreshold = Math.max(threshold, Math.abs(this.target) * 0.0001);
    
    return displacement < relativeThreshold && velocity < threshold;
  }
  
  /**
   * Get current position.
   */
  getPosition(): number {
    return this.currentPosition;
  }
  
  /**
   * Get current velocity.
   */
  getVelocity(): number {
    return this.currentVelocity;
  }
  
  /**
   * Get target value.
   */
  getTarget(): number {
    return this.target;
  }
  
  /**
   * Snap to target immediately.
   */
  snapToTarget(): void {
    this.currentPosition = this.target;
    this.currentVelocity = 0;
    this.x0 = 0;
    this.v0 = 0;
  }
  
  /**
   * Update config (creates new animation from current state).
   */
  setConfig(config: SpringConfig): void {
    this.config = config;
    this.omega0 = (2 * Math.PI) / config.response;
    this.zeta = config.dampingRatio;
  }
}

/**
 * Create a spring that animates a 2D point.
 */
export class Spring2D {
  private springX: SpringAnimation;
  private springY: SpringAnimation;
  
  constructor(initialX: number, initialY: number, config: SpringConfig = SPRING_PRESETS.viewport) {
    this.springX = new SpringAnimation(initialX, config);
    this.springY = new SpringAnimation(initialY, config);
  }
  
  setTarget(x: number, y: number, vx: number = 0, vy: number = 0): void {
    this.springX.setTarget(x, vx);
    this.springY.setTarget(y, vy);
  }
  
  update(currentTime: number): { x: number; y: number } {
    return {
      x: this.springX.update(currentTime),
      y: this.springY.update(currentTime),
    };
  }
  
  isAtRest(): boolean {
    return this.springX.isAtRest() && this.springY.isAtRest();
  }
  
  getPosition(): { x: number; y: number } {
    return {
      x: this.springX.getPosition(),
      y: this.springY.getPosition(),
    };
  }
}
```

---

## Task 2: Rubber-Band Overscroll

iOS-like edge resistance and snap-back.

### File: `packages/chart-core/src/rubber-band.ts`

```typescript
import { SpringAnimation, SPRING_PRESETS } from './spring';

export interface RubberBandConfig {
  resistance: number;      // Resistance factor (0-1), default: 0.4
  maxOverscroll: number;   // Max overscroll in pixels, default: 120
  springConfig?: {         // Spring config for snap-back
    response: number;
    dampingRatio: number;
  };
}

const DEFAULT_CONFIG: RubberBandConfig = {
  resistance: 0.4,
  maxOverscroll: 120,
  springConfig: SPRING_PRESETS.rubberBand,
};

export class RubberBandController {
  private config: RubberBandConfig;
  private overscroll: number = 0;
  private spring: SpringAnimation | null = null;
  private active: boolean = false;
  
  constructor(config: Partial<RubberBandConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Apply rubber-band resistance during drag past boundary.
   * Returns the resisted delta to apply.
   */
  applyResistance(delta: number, atBoundary: 'start' | 'end' | null): number {
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
    this.overscroll = clamp(
      this.overscroll + resistedDelta,
      -this.config.maxOverscroll,
      this.config.maxOverscroll
    );
    
    return resistedDelta;
  }
  
  /**
   * Start snap-back animation on release.
   */
  release(currentVelocity: number = 0): void {
    if (Math.abs(this.overscroll) < 0.5) {
      this.overscroll = 0;
      this.active = false;
      return;
    }
    
    this.spring = new SpringAnimation(
      this.overscroll,
      this.config.springConfig ?? SPRING_PRESETS.rubberBand
    );
    this.spring.setTarget(0, currentVelocity);
  }
  
  /**
   * Step the snap-back animation.
   * Returns current overscroll offset.
   */
  step(currentTime: number): number {
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
    return this.active || Math.abs(this.overscroll) > 0.1;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
```

---

## Task 3: Accessibility - Motion Preferences

### File: `packages/chart-core/src/accessibility.ts`

```typescript
import { SpringConfig, SPRING_PRESETS } from './spring';

export interface MotionPreferencesConfig {
  // Fallback if media query not supported
  defaultReducedMotion?: boolean;
}

/**
 * Manages motion preferences based on OS settings.
 * Respects prefers-reduced-motion media query.
 */
export class MotionPreferences {
  private prefersReducedMotion: boolean;
  private listeners: Set<(reduced: boolean) => void> = new Set();
  private mediaQuery: MediaQueryList | null = null;
  
  constructor(config: MotionPreferencesConfig = {}) {
    // Check if we're in a browser environment
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.prefersReducedMotion = this.mediaQuery.matches;
      
      // Listen for changes
      this.mediaQuery.addEventListener('change', this.handleChange);
    } else {
      // SSR or no support
      this.prefersReducedMotion = config.defaultReducedMotion ?? false;
    }
  }
  
  private handleChange = (e: MediaQueryListEvent): void => {
    this.prefersReducedMotion = e.matches;
    this.notifyListeners();
  };
  
  /**
   * Check if user prefers reduced motion.
   */
  shouldReduceMotion(): boolean {
    return this.prefersReducedMotion;
  }
  
  /**
   * Get appropriate momentum friction.
   * Higher friction = faster stop for reduced motion.
   */
  getMomentumFriction(): number {
    return this.prefersReducedMotion ? 0.8 : 0.95;
  }
  
  /**
   * Get minimum velocity threshold for momentum.
   */
  getMinVelocity(): number {
    return this.prefersReducedMotion ? 2.0 : 0.5;
  }
  
  /**
   * Get appropriate spring config.
   */
  getSpringConfig(preset: keyof typeof SPRING_PRESETS = 'viewport'): SpringConfig {
    if (this.prefersReducedMotion) {
      return SPRING_PRESETS.reducedMotion;
    }
    return SPRING_PRESETS[preset];
  }
  
  /**
   * Check if crosshair smoothing should be used.
   */
  shouldSmoothCrosshair(): boolean {
    return !this.prefersReducedMotion;
  }
  
  /**
   * Check if rubber-band effect should be used.
   */
  shouldUseRubberBand(): boolean {
    return !this.prefersReducedMotion;
  }
  
  /**
   * Get animation duration multiplier.
   * 0 = instant, 1 = normal
   */
  getAnimationMultiplier(): number {
    return this.prefersReducedMotion ? 0.2 : 1.0;
  }
  
  /**
   * Subscribe to preference changes.
   */
  onChange(callback: (reduced: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.prefersReducedMotion);
      } catch (e) {
        console.error('Motion preference listener error:', e);
      }
    }
  }
  
  /**
   * Clean up event listeners.
   */
  destroy(): void {
    if (this.mediaQuery) {
      this.mediaQuery.removeEventListener('change', this.handleChange);
    }
    this.listeners.clear();
  }
}

// Global singleton
let _instance: MotionPreferences | null = null;

export function getMotionPreferences(): MotionPreferences {
  if (!_instance) {
    _instance = new MotionPreferences();
  }
  return _instance;
}
```

---

## Task 4: Integrate with Physics Controller

### File: `packages/chart-core/src/physics-controller.ts` (updates)

```typescript
import { SpringAnimation, SPRING_PRESETS } from './spring';
import { RubberBandController } from './rubber-band';
import { getMotionPreferences } from './accessibility';

export interface PhysicsControllerOptions {
  friction?: number;
  minVelocity?: number;
  enableRubberBand?: boolean;
  enableSpring?: boolean;
  onUpdate?: (dx: number, dy: number) => void;
  onComplete?: () => void;
  checkBounds?: () => { atStart: boolean; atEnd: boolean };
}

export class PhysicsController {
  private velocityX: number = 0;
  private velocityY: number = 0;
  private friction: number;
  private minVelocity: number;
  
  private running: boolean = false;
  private lastTime: number = 0;
  private rafId: number | null = null;
  
  private rubberBand: RubberBandController | null = null;
  private spring: SpringAnimation | null = null;
  
  private options: PhysicsControllerOptions;
  private motionPrefs = getMotionPreferences();
  
  constructor(options: PhysicsControllerOptions = {}) {
    this.options = options;
    
    // Use motion preferences for defaults
    this.friction = options.friction ?? this.motionPrefs.getMomentumFriction();
    this.minVelocity = options.minVelocity ?? this.motionPrefs.getMinVelocity();
    
    // Initialize rubber-band if enabled and motion allows
    if (options.enableRubberBand && this.motionPrefs.shouldUseRubberBand()) {
      this.rubberBand = new RubberBandController();
    }
    
    // Listen for motion preference changes
    this.motionPrefs.onChange((reduced) => {
      this.friction = reduced ? 0.8 : (options.friction ?? 0.95);
      this.minVelocity = reduced ? 2.0 : (options.minVelocity ?? 0.5);
      
      if (reduced && this.rubberBand) {
        this.rubberBand.cancel();
        this.rubberBand = null;
      } else if (!reduced && options.enableRubberBand && !this.rubberBand) {
        this.rubberBand = new RubberBandController();
      }
    });
  }
  
  /**
   * Start momentum with initial velocity.
   */
  start(vx: number, vy: number = 0): void {
    if (Math.abs(vx) < this.minVelocity && Math.abs(vy) < this.minVelocity) {
      return;
    }
    
    this.velocityX = vx;
    this.velocityY = vy;
    this.running = true;
    this.lastTime = performance.now();
    
    if (this.rubberBand) {
      this.rubberBand.interrupt();
    }
    
    this.scheduleFrame();
  }
  
  /**
   * Stop momentum.
   */
  stop(): void {
    this.running = false;
    this.velocityX = 0;
    this.velocityY = 0;
    
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    
    if (this.rubberBand) {
      this.rubberBand.release(this.velocityX);
    }
    
    this.options.onComplete?.();
  }
  
  /**
   * Handle drag with rubber-band at boundaries.
   */
  applyDrag(dx: number, dy: number): { dx: number; dy: number } {
    if (!this.rubberBand || !this.options.checkBounds) {
      return { dx, dy };
    }
    
    const bounds = this.options.checkBounds();
    
    let boundary: 'start' | 'end' | null = null;
    if (bounds.atStart && dx > 0) boundary = 'start';
    if (bounds.atEnd && dx < 0) boundary = 'end';
    
    const resistedDx = this.rubberBand.applyResistance(dx, boundary);
    
    return { dx: resistedDx, dy };
  }
  
  /**
   * Called when drag ends.
   */
  endDrag(vx: number, vy: number = 0): void {
    if (this.rubberBand?.isActive()) {
      this.rubberBand.release(vx);
      this.running = true;
      this.lastTime = performance.now();
      this.scheduleFrame();
    } else {
      this.start(vx, vy);
    }
  }
  
  /**
   * Get rubber-band overscroll offset.
   */
  getOverscroll(): number {
    return this.rubberBand?.getOverscroll() ?? 0;
  }
  
  private scheduleFrame(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.loop);
  }
  
  private loop = (now: number): void => {
    this.rafId = null;
    
    if (!this.running) return;
    
    const dt = Math.min(now - this.lastTime, 32); // Cap at 32ms
    this.lastTime = now;
    
    // Handle rubber-band snap-back
    if (this.rubberBand?.isActive()) {
      const overscroll = this.rubberBand.step(now);
      
      if (!this.rubberBand.isActive()) {
        // Snap-back complete
        this.stop();
        return;
      }
      
      // Continue animation
      this.scheduleFrame();
      return;
    }
    
    // Apply friction (frame-rate independent)
    const frictionPerFrame = Math.pow(this.friction, dt / 16.67);
    this.velocityX *= frictionPerFrame;
    this.velocityY *= frictionPerFrame;
    
    // Check if stopped
    const speed = Math.hypot(this.velocityX, this.velocityY);
    if (speed < this.minVelocity) {
      this.stop();
      return;
    }
    
    // Calculate displacement
    const dtSeconds = dt / 1000;
    let dx = this.velocityX * dtSeconds;
    let dy = this.velocityY * dtSeconds;
    
    // Check bounds and apply rubber-band
    if (this.rubberBand && this.options.checkBounds) {
      const bounds = this.options.checkBounds();
      
      let boundary: 'start' | 'end' | null = null;
      if (bounds.atStart && dx > 0) boundary = 'start';
      if (bounds.atEnd && dx < 0) boundary = 'end';
      
      if (boundary) {
        dx = this.rubberBand.applyResistance(dx, boundary);
        
        // If we hit boundary with velocity, trigger rubber-band release
        if (Math.abs(this.velocityX) > this.minVelocity * 2) {
          this.rubberBand.release(this.velocityX);
          this.velocityX = 0;
        }
      }
    }
    
    // Emit update
    this.options.onUpdate?.(dx, dy);
    
    // Continue
    this.scheduleFrame();
  };
  
  /**
   * Check if physics is running.
   */
  isRunning(): boolean {
    return this.running;
  }
  
  /**
   * Clean up.
   */
  destroy(): void {
    this.stop();
    this.rubberBand = null;
  }
}
```

---

## Task 5: Usage Examples

### Using Spring Animation

```typescript
import { SpringAnimation, SPRING_PRESETS } from '@charts-plus/chart-core';

// Create spring for viewport zoom
const zoomSpring = new SpringAnimation(1.0, SPRING_PRESETS.viewport);

// Animate to new zoom level
zoomSpring.setTarget(2.0);

// In render loop
function animate(time: number) {
  const zoom = zoomSpring.update(time);
  chart.setZoom(zoom);
  
  if (!zoomSpring.isAtRest()) {
    requestAnimationFrame(animate);
  }
}
```

### Using Rubber-Band

```typescript
import { RubberBandController } from '@charts-plus/chart-core';

const rubberBand = new RubberBandController({
  resistance: 0.4,
  maxOverscroll: 100,
});

// During drag
function onDrag(delta: number, atBoundary: boolean) {
  const resistedDelta = rubberBand.applyResistance(
    delta, 
    atBoundary ? 'start' : null
  );
  viewport.pan(resistedDelta);
}

// On release
function onRelease(velocity: number) {
  rubberBand.release(velocity);
}

// In animation loop
function animate(time: number) {
  const overscroll = rubberBand.step(time);
  viewport.setOverscroll(overscroll);
  
  if (rubberBand.isActive()) {
    requestAnimationFrame(animate);
  }
}
```

### Using Motion Preferences

```typescript
import { getMotionPreferences } from '@charts-plus/chart-core';

const motionPrefs = getMotionPreferences();

// Check preferences
if (motionPrefs.shouldReduceMotion()) {
  // Use instant transitions
} else {
  // Use animations
}

// Get appropriate config
const springConfig = motionPrefs.getSpringConfig('viewport');
const friction = motionPrefs.getMomentumFriction();

// Listen for changes
motionPrefs.onChange((reduced) => {
  if (reduced) {
    // Switch to instant mode
    chart.disableAnimations();
  } else {
    // Enable animations
    chart.enableAnimations();
  }
});
```

---

## Task 6: Tests

### File: `packages/chart-core/src/__tests__/spring.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { SpringAnimation, SPRING_PRESETS } from '../spring';

describe('SpringAnimation', () => {
  it('should converge to target (critically damped)', () => {
    const spring = new SpringAnimation(0, SPRING_PRESETS.viewport);
    spring.setTarget(100);
    
    // Simulate 2 seconds
    const endTime = 2000;
    spring.update(endTime);
    
    expect(spring.isAtRest()).toBe(true);
    expect(spring.getPosition()).toBeCloseTo(100, 1);
  });
  
  it('should overshoot (underdamped)', () => {
    const spring = new SpringAnimation(0, { response: 0.5, dampingRatio: 0.5 });
    spring.setTarget(100);
    
    // At some point during animation, position should exceed target
    let maxPosition = 0;
    for (let t = 0; t < 2000; t += 16) {
      spring.update(t);
      maxPosition = Math.max(maxPosition, spring.getPosition());
    }
    
    expect(maxPosition).toBeGreaterThan(100);
  });
  
  it('should not overshoot (overdamped)', () => {
    const spring = new SpringAnimation(0, { response: 0.5, dampingRatio: 1.5 });
    spring.setTarget(100);
    
    let maxPosition = 0;
    for (let t = 0; t < 2000; t += 16) {
      spring.update(t);
      maxPosition = Math.max(maxPosition, spring.getPosition());
    }
    
    expect(maxPosition).toBeLessThanOrEqual(100.1);
  });
  
  it('should handle initial velocity', () => {
    const spring = new SpringAnimation(0, SPRING_PRESETS.viewport);
    spring.setTarget(100, 500); // High initial velocity
    
    spring.update(16);
    
    // Should move significantly in first frame
    expect(spring.getPosition()).toBeGreaterThan(5);
  });
});
```

---

## Verification Checklist

### Spring Solver
- [ ] Critically damped reaches target without overshoot
- [ ] Underdamped oscillates then settles
- [ ] Overdamped slowly approaches target
- [ ] Stable at 60Hz, 90Hz, 120Hz, 144Hz
- [ ] Handles initial velocity correctly
- [ ] isAtRest() returns true when settled

### Rubber-Band
- [ ] Resistance increases as overscroll increases
- [ ] Maximum overscroll is respected
- [ ] Snap-back animation is smooth
- [ ] Interrupt works (user starts dragging again)
- [ ] Works with momentum

### Accessibility
- [ ] Detects prefers-reduced-motion
- [ ] Responds to preference changes
- [ ] Provides appropriate friction values
- [ ] Provides appropriate spring configs
- [ ] Can disable rubber-band for reduced motion

---

## Next Steps

After completing Phase 5:
1. Integration testing with full chart
2. Profile performance (spring solver overhead)
3. User testing for "feel"
4. Documentation updates
