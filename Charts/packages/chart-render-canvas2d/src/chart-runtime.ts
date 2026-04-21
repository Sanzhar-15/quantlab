type RuntimePriority = 0 | 1 | 2;

type RuntimeHandle = {
  requestFrame: (cb: (time: number) => void) => number;
  cancelFrame: (handle: number) => void;
  setPriority: (priority: RuntimePriority) => void;
  setVisible: (visible: boolean) => void;
  destroy: () => void;
};

type RuntimeHandleState = {
  id: number;
  element: Element | null;
  visible: boolean;
  priority: RuntimePriority;
};

const DEFAULT_FRAME_BUDGET_MS = 10;
const STARVATION_LIMIT_FRAMES = 8;
const PRIORITY_ORDER: RuntimePriority[] = [2, 1, 0];

const nowTime = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const requestFrame = (cb: (time: number) => void): number => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb);
  }
  if (typeof setTimeout === 'function') {
    return setTimeout(() => cb(Date.now()), 16) as unknown as number;
  }
  cb(Date.now());
  return 0;
};

const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  if (typeof clearTimeout === 'function') {
    clearTimeout(handle);
  }
};

class ChartRuntime {
  private readonly handles = new Map<number, RuntimeHandleState>();
  private readonly elementToHandle = new WeakMap<Element, number>();
  private readonly pendingVisible = new Map<number, (time: number) => void>();
  private readonly pendingHidden = new Map<number, (time: number) => void>();
  private readonly pendingNext = new Map<number, (time: number) => void>();
  private readonly frameBudgetMs = DEFAULT_FRAME_BUDGET_MS;
  private readonly roundRobinIndex: Record<RuntimePriority, number> = { 0: 0, 1: 0, 2: 0 };
  private readonly starvationFrames: Record<RuntimePriority, number> = { 0: 0, 1: 0, 2: 0 };
  private observer: IntersectionObserver | null = null;
  private scheduled = false;
  private inFrame = false;
  private nextId = 1;
  private rafHandle = 0;

  public constructor() {
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(this.handleIntersect, { threshold: 0.01 });
    }
  }

  public createHandle(element?: Element | null): RuntimeHandle {
    const id = this.nextId++;
    const state: RuntimeHandleState = {
      id,
      element: element ?? null,
      visible: true,
      priority: 1,
    };
    this.handles.set(id, state);
    if (element && this.observer) {
      this.elementToHandle.set(element, id);
      this.observer.observe(element);
    }

    return {
      requestFrame: (cb) => this.requestFrame(id, cb),
      cancelFrame: (handle) => this.cancelFrame(id, handle),
      setPriority: (priority) => this.setPriority(id, priority),
      setVisible: (visible) => this.setVisible(id, visible),
      destroy: () => this.destroyHandle(id),
    };
  }

  private setPendingVisible(id: number, cb: (time: number) => void): void {
    this.pendingHidden.delete(id);
    this.pendingVisible.set(id, cb);
  }

  private setPendingHidden(id: number, cb: (time: number) => void): void {
    this.pendingVisible.delete(id);
    this.pendingHidden.set(id, cb);
  }

  private requestFrame(id: number, cb: (time: number) => void): number {
    const state = this.handles.get(id);
    if (!state) return 0;
    if (this.inFrame) {
      this.pendingNext.set(id, cb);
    } else if (state.visible) {
      this.setPendingVisible(id, cb);
    } else {
      this.setPendingHidden(id, cb);
    }
    this.ensureScheduled();
    return id;
  }

  private cancelFrame(id: number, handle: number): void {
    if (id !== handle) return;
    this.pendingVisible.delete(id);
    this.pendingHidden.delete(id);
    this.pendingNext.delete(id);
  }

  private setPriority(id: number, priority: RuntimePriority): void {
    const state = this.handles.get(id);
    if (!state) return;
    state.priority = priority;
  }

  private setVisible(id: number, visible: boolean): void {
    const state = this.handles.get(id);
    if (!state) return;
    state.visible = visible;

    if (visible) {
      const pending = this.pendingHidden.get(id);
      if (pending) {
        this.pendingHidden.delete(id);
        if (this.inFrame) {
          this.pendingNext.set(id, pending);
        } else {
          this.setPendingVisible(id, pending);
        }
      }
      this.ensureScheduled();
      return;
    }

    const pendingVisible = this.pendingVisible.get(id);
    if (pendingVisible) {
      this.setPendingHidden(id, pendingVisible);
    }
    const pendingNext = this.pendingNext.get(id);
    if (pendingNext) {
      this.pendingNext.delete(id);
      this.setPendingHidden(id, pendingNext);
    }
  }

  private destroyHandle(id: number): void {
    const state = this.handles.get(id);
    if (!state) return;
    this.handles.delete(id);
    this.pendingVisible.delete(id);
    this.pendingHidden.delete(id);
    this.pendingNext.delete(id);
    if (state.element && this.observer) {
      this.observer.unobserve(state.element);
      this.elementToHandle.delete(state.element);
    }
  }

  private handleIntersect = (entries: IntersectionObserverEntry[]) => {
    entries.forEach((entry) => {
      const id = this.elementToHandle.get(entry.target);
      if (!id) return;
      this.setVisible(id, entry.isIntersecting && entry.intersectionRatio > 0);
    });
  };

  private ensureScheduled(): void {
    if (this.scheduled) return;
    if (this.pendingVisible.size === 0) return;
    this.scheduled = true;
    this.rafHandle = requestFrame(this.onFrame);
  }

  private onFrame = (time: number): void => {
    this.scheduled = false;
    this.inFrame = true;

    const entries = Array.from(this.pendingVisible.entries());
    this.pendingVisible.clear();

    const buckets: Record<RuntimePriority, Array<[number, (time: number) => void]>> = {
      0: [],
      1: [],
      2: [],
    };
    for (const entry of entries) {
      const state = this.handles.get(entry[0]);
      const priority = state?.priority ?? 0;
      buckets[priority].push(entry);
    }

    for (const priority of PRIORITY_ORDER) {
      buckets[priority].sort((a, b) => a[0] - b[0]);
    }

    const frameStart = nowTime();
    const budgetMs = this.frameBudgetMs;
    let budgetExceeded = false;
    const carryOver = new Map<number, (time: number) => void>();

    const processBucket = (priority: RuntimePriority, forceOne = false): number => {
      const bucket = buckets[priority];
      if (bucket.length === 0) return 0;
      const count = bucket.length;
      const startIndex = this.roundRobinIndex[priority] % count;
      let processed = 0;

      for (let i = 0; i < count; i += 1) {
        const index = (startIndex + i) % count;
        const [id, cb] = bucket[index]!;
        if (budgetExceeded && !(forceOne && processed === 0)) {
          carryOver.set(id, cb);
          continue;
        }
        const state = this.handles.get(id);
        if (!state) {
          processed += 1;
          continue;
        }
        if (!state.visible) {
          this.setPendingHidden(id, cb);
          processed += 1;
          continue;
        }
        cb(time);
        processed += 1;
        if (budgetMs > 0 && nowTime() - frameStart >= budgetMs) {
          budgetExceeded = true;
        }
      }

      if (processed > 0) {
        this.roundRobinIndex[priority] = (startIndex + processed) % count;
      }
      return processed;
    };

    for (const priority of PRIORITY_ORDER) {
      const forceOne =
        budgetExceeded &&
        buckets[priority].length > 0 &&
        this.starvationFrames[priority] >= STARVATION_LIMIT_FRAMES;
      const processed = processBucket(priority, forceOne);
      if (buckets[priority].length === 0) {
        this.starvationFrames[priority] = 0;
      } else if (processed > 0) {
        this.starvationFrames[priority] = 0;
      } else {
        this.starvationFrames[priority] += 1;
      }
    }

    this.inFrame = false;

    if (carryOver.size > 0) {
      carryOver.forEach((cb, id) => {
        const state = this.handles.get(id);
        if (!state) return;
        if (state.visible) {
          this.setPendingVisible(id, cb);
        } else {
          this.setPendingHidden(id, cb);
        }
      });
    }

    if (this.pendingNext.size > 0) {
      this.pendingNext.forEach((cb, id) => {
        const state = this.handles.get(id);
        if (!state) return;
        if (state.visible) {
          this.setPendingVisible(id, cb);
        } else {
          this.setPendingHidden(id, cb);
        }
      });
      this.pendingNext.clear();
    }

    this.ensureScheduled();
  };
}

let defaultRuntime: ChartRuntime | null = null;

export const getChartRuntime = (): ChartRuntime => {
  if (!defaultRuntime) {
    defaultRuntime = new ChartRuntime();
  }
  return defaultRuntime;
};

export type { RuntimeHandle, RuntimePriority };
