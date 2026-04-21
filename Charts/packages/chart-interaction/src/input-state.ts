/**
 * Input state normalization and coalesced pointer event handling.
 * Provides unified input state from various event sources.
 */

/**
 * Normalized input state.
 * Captures all input information in a compact format.
 */
export type InputState = {
  pointerX: number;        // Pointer X position (physical pixels)
  pointerY: number;        // Pointer Y position (physical pixels)
  buttons: number;         // Button bitmask (0 = none, 1 = primary, 2 = secondary, 4 = auxiliary)
  modifiers: number;       // Modifier bitmask (1 = Shift, 2 = Ctrl, 4 = Alt, 8 = Meta)
  wheelDeltaX: number;     // Horizontal wheel delta
  wheelDeltaY: number;     // Vertical wheel delta
  pinchScale: number;      // Pinch scale (1.0 = no pinch)
  pinchCenterX: number;    // Pinch center X (physical pixels)
  pinchCenterY: number;    // Pinch center Y (physical pixels)
  timestamp: number;       // Event timestamp (performance.now())
  sequence: number;        // Sequence number (increments per event)
};

/**
 * Create initial input state.
 */
export function createInputState(): InputState {
  return {
    pointerX: 0,
    pointerY: 0,
    buttons: 0,
    modifiers: 0,
    wheelDeltaX: 0,
    wheelDeltaY: 0,
    pinchScale: 1.0,
    pinchCenterX: 0,
    pinchCenterY: 0,
    timestamp: performance.now(),
    sequence: 0,
  };
}

/**
 * Extract modifier flags from event.
 */
function getModifiers(event: MouseEvent | TouchEvent | WheelEvent): number {
  let modifiers = 0;
  if (event.shiftKey) modifiers |= 1;
  if (event.ctrlKey) modifiers |= 2;
  if (event.altKey) modifiers |= 4;
  if (event.metaKey) modifiers |= 8;
  return modifiers;
}

/**
 * Extract button bitmask from mouse event.
 */
function getButtons(event: MouseEvent): number {
  return event.buttons; // Already a bitmask
}

/**
 * Normalize mouse event to input state.
 */
export function normalizeMouseEvent(
  event: MouseEvent,
  rect: DOMRect,
  sequence: number,
): InputState {
  const dpr = window.devicePixelRatio || 1;
  return {
    pointerX: (event.clientX - rect.left) * dpr,
    pointerY: (event.clientY - rect.top) * dpr,
    buttons: getButtons(event),
    modifiers: getModifiers(event),
    wheelDeltaX: 0,
    wheelDeltaY: 0,
    pinchScale: 1.0,
    pinchCenterX: 0,
    pinchCenterY: 0,
    timestamp: performance.now(),
    sequence,
  };
}

/**
 * Normalize wheel event to input state.
 */
export function normalizeWheelEvent(
  event: WheelEvent,
  rect: DOMRect,
  sequence: number,
): InputState {
  const dpr = window.devicePixelRatio || 1;
  return {
    pointerX: (event.clientX - rect.left) * dpr,
    pointerY: (event.clientY - rect.top) * dpr,
    buttons: 0,
    modifiers: getModifiers(event),
    wheelDeltaX: event.deltaX,
    wheelDeltaY: event.deltaY,
    pinchScale: 1.0,
    pinchCenterX: 0,
    pinchCenterY: 0,
    timestamp: performance.now(),
    sequence,
  };
}

/**
 * Normalize touch event to input state.
 * Handles single touch, multi-touch, and pinch gestures.
 */
export function normalizeTouchEvent(
  event: TouchEvent,
  rect: DOMRect,
  sequence: number,
): InputState {
  const dpr = window.devicePixelRatio || 1;
  const touches = event.touches;
  
  if (touches.length === 0) {
    // Touch end
    return {
      pointerX: 0,
      pointerY: 0,
      buttons: 0,
      modifiers: 0,
      wheelDeltaX: 0,
      wheelDeltaY: 0,
      pinchScale: 1.0,
      pinchCenterX: 0,
      pinchCenterY: 0,
      timestamp: performance.now(),
      sequence,
    };
  }

  if (touches.length === 1) {
    // Single touch
    const touch = touches[0]!;
    return {
      pointerX: (touch.clientX - rect.left) * dpr,
      pointerY: (touch.clientY - rect.top) * dpr,
      buttons: 1, // Primary button
      modifiers: 0,
      wheelDeltaX: 0,
      wheelDeltaY: 0,
      pinchScale: 1.0,
      pinchCenterX: 0,
      pinchCenterY: 0,
      timestamp: performance.now(),
      sequence,
    };
  }

  // Multi-touch (pinch)
  const touch1 = touches[0]!;
  const touch2 = touches[1]!;
  
  const x1 = (touch1.clientX - rect.left) * dpr;
  const y1 = (touch1.clientY - rect.top) * dpr;
  const x2 = (touch2.clientX - rect.left) * dpr;
  const y2 = (touch2.clientY - rect.top) * dpr;
  
  const centerX = (x1 + x2) * 0.5;
  const centerY = (y1 + y2) * 0.5;
  const distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  
  // Calculate scale (normalize to initial distance, stored separately)
  // For now, use a simple heuristic: scale based on distance
  const baseDistance = 100; // Reference distance
  const scale = distance / baseDistance;
  
  return {
    pointerX: centerX,
    pointerY: centerY,
    buttons: 1,
    modifiers: 0,
    wheelDeltaX: 0,
    wheelDeltaY: 0,
    pinchScale: scale,
    pinchCenterX: centerX,
    pinchCenterY: centerY,
    timestamp: performance.now(),
    sequence,
  };
}

/**
 * Get coalesced pointer events if available.
 * Prevents "staircase" movement on high-DPI displays.
 */
export function getCoalescedEvents(event: PointerEvent): Array<{ x: number; y: number; time: number }> {
  if ('getCoalescedEvents' in event && typeof event.getCoalescedEvents === 'function') {
    const coalesced = event.getCoalescedEvents();
    return Array.from(coalesced).map((e) => ({
      x: e.clientX,
      y: e.clientY,
      time: e.timeStamp,
    }));
  }
  
  // Fallback: single event
  return [
    {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    },
  ];
}

/**
 * Normalize pointer event with coalesced events.
 */
export function normalizePointerEvent(
  event: PointerEvent,
  rect: DOMRect,
  sequence: number,
): InputState[] {
  const dpr = window.devicePixelRatio || 1;
  const coalesced = getCoalescedEvents(event);
  
  return coalesced.map((e, index) => ({
    pointerX: (e.x - rect.left) * dpr,
    pointerY: (e.y - rect.top) * dpr,
    buttons: event.buttons,
    modifiers: getModifiers(event),
    wheelDeltaX: 0,
    wheelDeltaY: 0,
    pinchScale: 1.0,
    pinchCenterX: 0,
    pinchCenterY: 0,
    timestamp: e.time,
    sequence: sequence + index,
  }));
}

/**
 * Merge multiple input states (for coalesced events).
 * Takes the last state and accumulates deltas.
 */
export function mergeInputStates(states: InputState[]): InputState {
  if (states.length === 0) {
    return createInputState();
  }
  
  if (states.length === 1) {
    return states[0]!;
  }
  
  // Use the last state as base
  const last = states[states.length - 1]!;
  
  // Accumulate wheel deltas
  let wheelDeltaX = 0;
  let wheelDeltaY = 0;
  for (const state of states) {
    wheelDeltaX += state.wheelDeltaX;
    wheelDeltaY += state.wheelDeltaY;
  }
  
  return {
    ...last,
    wheelDeltaX,
    wheelDeltaY,
  };
}

