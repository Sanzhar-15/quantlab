import { describe, expect, it } from 'vitest';

import { LayoutEngine } from './layout-engine';

describe('LayoutEngine', () => {
  it('keeps axis rects separated', () => {
    const engine = new LayoutEngine();
    const result = engine.compute({
      width: 800,
      height: 400,
      leftAxisWidth: 60,
      rightAxisWidth: 80,
    });

    expect(result.plotRect.x).toBe(60);
    expect(result.plotRect.width).toBe(800 - 60 - 80);
    expect(result.leftAxisRect?.width).toBe(60);
    expect(result.rightAxisRect?.x).toBe(result.plotRect.x + result.plotRect.width);
  });
});
