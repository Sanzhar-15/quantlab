export class LabelMeasureCache {
  private readonly _cache = new Map<string, number>();
  private readonly _maxEntries: number;

  public constructor(maxEntries = 2048) {
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  public measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
    const key = `${font}::${text}`;
    const cached = this._cache.get(key);
    if (cached !== undefined) {
      this._cache.delete(key);
      this._cache.set(key, cached);
      return cached;
    }
    const previous = ctx.font;
    ctx.font = font;
    const width = ctx.measureText(text).width;
    ctx.font = previous;
    this._cache.set(key, width);
    if (this._cache.size > this._maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }
    return width;
  }

  public clear(): void {
    this._cache.clear();
  }
}
