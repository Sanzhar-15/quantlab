import { describe, expect, it } from 'vitest';

import { FrameScheduler } from './frame-scheduler';
import { InvalidationFlag } from './invalidation';

function createTestScheduler() {
  let rafCount = 0;
  let rafCb: ((time: number) => void) | null = null;
  const frames: Array<{ flags: InvalidationFlag; intent: unknown }> = [];

  const scheduler = new FrameScheduler(
    (payload) => {
      frames.push({ flags: payload.flags, intent: payload.intent });
    },
    {
      requestFrame: (cb) => {
        rafCount += 1;
        rafCb = cb;
        return rafCount;
      },
    },
  );

  const flush = (time = 0) => {
    const cb = rafCb;
    rafCb = null;
    cb?.(time);
  };

  return { scheduler, frames, flush, rafCount: () => rafCount };
}

describe('FrameScheduler', () => {
  it('merges invalidation flags', () => {
    const { scheduler, frames, flush } = createTestScheduler();
    scheduler.invalidate(InvalidationFlag.Layout);
    scheduler.invalidate(InvalidationFlag.Series);
    flush();
    expect(frames).toHaveLength(1);
    expect(frames[0].flags).toBe(InvalidationFlag.Layout | InvalidationFlag.Series);
  });

  it('coalesces multiple events into one frame', () => {
    const { scheduler, frames, flush, rafCount } = createTestScheduler();
    scheduler.queuePointerMove(10, 20);
    scheduler.queuePointerMove(12, 22);
    scheduler.queueWheel(1, 2, 12, 22);
    expect(rafCount()).toBe(1);
    flush();
    expect(frames).toHaveLength(1);
  });

  it('pointermove only invalidates overlay', () => {
    const { scheduler, frames, flush } = createTestScheduler();
    scheduler.queuePointerMove(10, 20);
    flush();
    expect(frames[0].flags).toBe(InvalidationFlag.Overlay);
  });

  it('coalesces wheel intent deltas', () => {
    const { scheduler, frames, flush } = createTestScheduler();
    scheduler.queueWheel(1, 2, 10, 10);
    scheduler.queueWheel(2, 3, 12, 12);
    flush();
    const intent = frames[0].intent as {
      wheel?: { deltaX: number; deltaY: number; x: number; y: number };
    };
    expect(intent.wheel?.deltaX).toBe(3);
    expect(intent.wheel?.deltaY).toBe(5);
    expect(intent.wheel?.x).toBe(12);
    expect(intent.wheel?.y).toBe(12);
  });
});
