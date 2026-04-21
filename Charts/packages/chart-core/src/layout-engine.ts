export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutOptions = {
  width: number;
  height: number;
  leftAxisWidth?: number;
  rightAxisWidth?: number;
  bottomAxisHeight?: number;
};

export type PaneLayout = {
  id: string;
  plotRect: Rect;
  leftAxisRect: Rect | null;
  rightAxisRect: Rect | null;
};

export type LayoutResult = {
  chartRect: Rect;
  plotRect: Rect;
  leftAxisRect: Rect | null;
  rightAxisRect: Rect | null;
  timeAxisRect: Rect | null;
  panes?: PaneLayout[];
};

export class LayoutEngine {
  public compute(options: LayoutOptions): LayoutResult {
    const width = Math.max(1, Math.round(options.width));
    const height = Math.max(1, Math.round(options.height));
    const leftWidth = Math.max(0, Math.round(options.leftAxisWidth ?? 0));
    const rightWidth = Math.max(0, Math.round(options.rightAxisWidth ?? 0));
    const bottomHeight = Math.max(0, Math.round(options.bottomAxisHeight ?? 0));

    const plotWidth = Math.max(1, width - leftWidth - rightWidth);
    const plotHeight = Math.max(1, height - bottomHeight);
    const chartRect: Rect = { x: 0, y: 0, width, height };
    const plotRect: Rect = { x: leftWidth, y: 0, width: plotWidth, height: plotHeight };
    const leftAxisRect = leftWidth > 0 ? { x: 0, y: 0, width: leftWidth, height: plotHeight } : null;
    const rightAxisRect =
      rightWidth > 0 ? { x: leftWidth + plotWidth, y: 0, width: rightWidth, height: plotHeight } : null;
    const timeAxisRect =
      bottomHeight > 0
        ? { x: leftWidth, y: plotHeight, width: plotWidth, height: bottomHeight }
        : null;

    return { chartRect, plotRect, leftAxisRect, rightAxisRect, timeAxisRect };
  }
}
