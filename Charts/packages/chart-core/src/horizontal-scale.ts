export type VisibleRange = {
  from: number;
  to: number;
};

export type HorizontalScaleOptions = Record<string, unknown>;

export type HorizontalScale<Options = HorizontalScaleOptions> = {
  setPlotWidth: (width: number) => void;
  setVisibleRange: (range: VisibleRange) => void;
  getVisibleRange: () => VisibleRange;
  setElasticActive: (active: boolean) => void;
  setOptions: (options: Partial<Options>) => void;
  getClampedRange: (range?: VisibleRange) => VisibleRange;
  getTicksForRange: (range: VisibleRange, desiredCount?: number) => number[];
  getTicks: (desiredCount?: number) => number[];
  timeToX: (time: number) => number;
  xToTime: (x: number) => number;
  getVisibleIndices: () => { from: number; to: number };
  panByPixels: (deltaX: number) => void;
  zoomByWheel: (deltaY: number, anchorX: number, anchorToRightEdge?: boolean) => void;
  zoomByScale: (scale: number, anchorX: number) => void;
};
