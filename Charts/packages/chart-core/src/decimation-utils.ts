export const CONFLATION_POINTS_PER_PX = 12;
export const CONFLATION_MIN_RATIO = 0.4;

export const resolveConflationPlotWidth = (
  plotWidth: number,
  visibleCount: number,
  pointsPerPx = CONFLATION_POINTS_PER_PX,
): number => {
  const width = Math.max(0, Math.round(plotWidth));
  if (width <= 0) return width;
  const count = Math.max(0, Math.floor(visibleCount));
  if (count <= 0) return width;
  const density = count / width;
  if (!Number.isFinite(density) || density <= pointsPerPx) return width;
  const ratio = Math.max(CONFLATION_MIN_RATIO, Math.min(1, pointsPerPx / density));
  return Math.max(1, Math.round(width * ratio));
};
