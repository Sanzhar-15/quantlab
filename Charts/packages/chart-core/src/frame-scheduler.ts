import { InvalidationFlag } from './invalidation';

export type PointerIntent = {
  x: number;
  y: number;
  type: 'move' | 'down' | 'up';
};

export type WheelIntent = {
  deltaX: number;
  deltaY: number;
  x: number;
  y: number;
  ctrlKey?: boolean;  // V7: Ctrl key state for right-edge zoom (Ctrl = cursor anchor)
};

export type TouchIntent = {
  kind: 'pan' | 'pinch';
  deltaX: number;
  deltaY: number;
  scale: number;
  centerX: number;
  centerY: number;
};

export type InputIntent = {
  pointer?: PointerIntent;
  wheel?: WheelIntent;
  touch?: TouchIntent;
};

export type FramePayload = {
  time: number;
  flags: InvalidationFlag;
  intent: InputIntent;
};

export type FrameSchedulerOptions = {
  requestFrame?: (cb: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
};

type TimingGlobals = {
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: (cb: () => void, ms?: number) => number;
  clearTimeout?: (handle: number) => void;
};

function defaultRequestFrame(cb: (time: number) => void): number {
  const timing = globalThis as TimingGlobals;
  if (typeof timing.requestAnimationFrame === 'function') {
    return timing.requestAnimationFrame(cb);
  }
  if (typeof timing.setTimeout === 'function') {
    return timing.setTimeout(() => cb(Date.now()), 16);
  }
  cb(Date.now());
  return 0;
}

function defaultCancelFrame(handle: number): void {
  const timing = globalThis as TimingGlobals;
  if (typeof timing.cancelAnimationFrame === 'function') {
    timing.cancelAnimationFrame(handle);
    return;
  }
  if (typeof timing.clearTimeout === 'function') {
    timing.clearTimeout(handle);
  }
}

export class FrameScheduler {
  private readonly _onFrame: (payload: FramePayload) => void;
  private readonly _requestFrame: (cb: (time: number) => void) => number;
  private readonly _cancelFrame: (handle: number) => void;
  private _scheduled = false;
  private _handle = 0;
  private _pendingFlags: InvalidationFlag = InvalidationFlag.None;
  private _intent: InputIntent = {};

  public constructor(
    onFrame: (payload: FramePayload) => void,
    options: FrameSchedulerOptions = {},
  ) {
    this._onFrame = onFrame;
    this._requestFrame = options.requestFrame ?? defaultRequestFrame;
    this._cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  }

  public invalidate(flags: InvalidationFlag): void {
    if (flags === InvalidationFlag.None) return;
    this._pendingFlags = (this._pendingFlags | flags) as InvalidationFlag;
    this._schedule();
  }

  public queuePointerMove(x: number, y: number): void {
    const pointer = this._intent.pointer ?? { x, y, type: 'move' as const };
    pointer.x = x;
    pointer.y = y;
    pointer.type = 'move';
    this._intent.pointer = pointer;
    this.invalidate(InvalidationFlag.Overlay);
  }

  public queuePointerDown(x: number, y: number): void {
    const pointer = this._intent.pointer ?? { x, y, type: 'down' as const };
    pointer.x = x;
    pointer.y = y;
    pointer.type = 'down';
    this._intent.pointer = pointer;
    this.invalidate(InvalidationFlag.Overlay);
  }

  public queuePointerUp(x: number, y: number): void {
    const pointer = this._intent.pointer ?? { x, y, type: 'up' as const };
    pointer.x = x;
    pointer.y = y;
    pointer.type = 'up';
    this._intent.pointer = pointer;
    this.invalidate(InvalidationFlag.Overlay);
  }

  // V7: Right-edge zoom - Ctrl key state determines anchor mode
  public queueWheel(deltaX: number, deltaY: number, x: number, y: number, ctrlKey?: boolean): void {
    const wheel = this._intent.wheel ?? { deltaX: 0, deltaY: 0, x, y };
    wheel.deltaX += deltaX;
    wheel.deltaY += deltaY;
    wheel.x = x;
    wheel.y = y;
    // V7: Preserve Ctrl key state (last value wins if multiple wheel events coalesced)
    if (ctrlKey !== undefined) {
      wheel.ctrlKey = ctrlKey;
    }
    this._intent.wheel = wheel;
    this.invalidate((InvalidationFlag.Series | InvalidationFlag.Overlay) as InvalidationFlag);
  }

  public queueTouch(intent: TouchIntent): void {
    const existing = this._intent.touch;
    if (existing && existing.kind === intent.kind) {
      existing.deltaX += intent.deltaX;
      existing.deltaY += intent.deltaY;
      existing.scale *= intent.scale;
      existing.centerX = intent.centerX;
      existing.centerY = intent.centerY;
    } else {
      this._intent.touch = { ...intent };
    }
    this.invalidate((InvalidationFlag.Series | InvalidationFlag.Overlay) as InvalidationFlag);
  }

  public destroy(): void {
    if (this._scheduled) {
      this._cancelFrame(this._handle);
      this._scheduled = false;
    }
    this._pendingFlags = InvalidationFlag.None;
    this._intent = {};
  }

  private _schedule(): void {
    if (this._scheduled) return;
    this._scheduled = true;
    this._handle = this._requestFrame(this._onAnimationFrame);
  }

  private _onAnimationFrame = (time: number): void => {
    this._scheduled = false;
    const flags = this._pendingFlags;
    const intent = this._intent;
    this._pendingFlags = InvalidationFlag.None;
    this._intent = {};
    this._onFrame({ time, flags, intent });
  };
}
