/**
 * V5.2 Inertial Panning Physics
 * 
 * Implements iOS-like exponential decay for smooth, natural-feeling panning.
 * 
 * Key characteristics:
 * - Friction of 0.95 per frame at 60fps (matches iOS scroll feel)
 * - Minimum velocity threshold of 0.5 px/frame for clean stopping
 * - Frame-rate independent design
 * 
 * Design decisions per V5.2:
 * - NO spring physics during drag (direct 1:1 manipulation)
 * - NO rubber-band effect at boundaries (stop at edges, add in V2 if requested)
 * - Friction-based momentum on release only
 */

/**
 * Inertial pan state.
 */
export type InertialPanState = {
  velocityX: number;      // Pixels per frame
  velocityY: number;
  positionX: number;      // Current position
  positionY: number;
  active: boolean;        // True if inertia is active
};

/**
 * Inertial pan options.
 */
export type InertialPanOptions = {
  friction: number;       // Friction coefficient (0-1, higher = less friction/longer coast)
  minVelocity: number;    // Minimum velocity to continue (pixels per frame)
  maxVelocity: number;    // Maximum velocity cap (pixels per frame)
};

/**
 * V5.2 Default Options - iOS-like momentum feel
 * 
 * friction: 0.95 = 5% velocity loss per frame at 60fps
 * - iOS uses ~0.998 (very long coast)
 * - 0.95 is snappier but still smooth
 * 
 * minVelocity: 0.5 = stop when barely moving
 * - Prevents infinite tiny movements
 * - Creates clean stop without jitter
 */
const DEFAULT_OPTIONS: InertialPanOptions = {
  friction: 0.95,        // V5.2: iOS-like 5% velocity loss per frame
  minVelocity: 0.5,      // V5.2: Stop when velocity < 0.5 px/frame
  maxVelocity: 50,       // Cap at 50 px/frame for reasonable max speed
};

/**
 * Create initial inertial pan state.
 */
export function createInertialPanState(): InertialPanState {
  return {
    velocityX: 0,
    velocityY: 0,
    positionX: 0,
    positionY: 0,
    active: false,
  };
}

/**
 * Update inertial pan state.
 * Applies friction and updates position.
 */
export function updateInertialPan(
  state: InertialPanState,
  options: InertialPanOptions = DEFAULT_OPTIONS,
): InertialPanState {
  if (!state.active) {
    return state;
  }

  // Apply friction
  let velocityX = state.velocityX * options.friction;
  let velocityY = state.velocityY * options.friction;

  // Cap velocity
  const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
  if (speed > options.maxVelocity) {
    const scale = options.maxVelocity / speed;
    velocityX *= scale;
    velocityY *= scale;
  }

  // Check if we should stop
  const minSpeed = options.minVelocity;
  if (Math.abs(velocityX) < minSpeed && Math.abs(velocityY) < minSpeed) {
    return {
      ...state,
      velocityX: 0,
      velocityY: 0,
      active: false,
    };
  }

  // Update position
  return {
    velocityX,
    velocityY,
    positionX: state.positionX + velocityX,
    positionY: state.positionY + velocityY,
    active: true,
  };
}

/**
 * Add velocity to inertial pan state.
 * Called during active panning to accumulate velocity.
 */
export function addInertialVelocity(
  state: InertialPanState,
  deltaX: number,
  deltaY: number,
  frameDelta: number,
): InertialPanState {
  // Calculate velocity from delta (pixels per frame)
  const velocityX = deltaX / frameDelta;
  const velocityY = deltaY / frameDelta;

  // Apply exponential moving average for smooth velocity
  const alpha = 0.3; // Smoothing factor
  const smoothedVX = state.velocityX * (1 - alpha) + velocityX * alpha;
  const smoothedVY = state.velocityY * (1 - alpha) + velocityY * alpha;

  return {
    ...state,
    velocityX: smoothedVX,
    velocityY: smoothedVY,
    positionX: state.positionX + deltaX,
    positionY: state.positionY + deltaY,
    active: true,
  };
}

/**
 * Start inertial pan (on pointer down).
 */
export function startInertialPan(
  state: InertialPanState,
  x: number,
  y: number,
): InertialPanState {
  return {
    ...state,
    positionX: x,
    positionY: y,
    velocityX: 0,
    velocityY: 0,
    active: false, // Not active until release
  };
}

/**
 * Stop inertial pan (on pointer up).
 * Keeps current velocity for inertia.
 */
export function stopInertialPan(state: InertialPanState): InertialPanState {
  // Keep velocity for inertia, but mark as ready for decay
  return {
    ...state,
    active: state.velocityX !== 0 || state.velocityY !== 0,
  };
}

/**
 * Clamp position to valid range.
 */
export function clampInertialPan(
  state: InertialPanState,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): InertialPanState {
  const clampedX = Math.max(minX, Math.min(maxX, state.positionX));
  const clampedY = Math.max(minY, Math.min(maxY, state.positionY));

  // If clamped, reduce velocity in that direction
  let velocityX = state.velocityX;
  let velocityY = state.velocityY;

  if (clampedX !== state.positionX) {
    velocityX *= 0.5; // Dampen X velocity
  }
  if (clampedY !== state.positionY) {
    velocityY *= 0.5; // Dampen Y velocity
  }

  return {
    ...state,
    positionX: clampedX,
    positionY: clampedY,
    velocityX,
    velocityY,
  };
}

