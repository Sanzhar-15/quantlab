/**
 * Volume Profile Plugin for rendering volume profile on charts.
 */

export interface VolumeProfileRenderInput {
  ctx: CanvasRenderingContext2D;
  plotRect: { x: number; y: number; width: number; height: number };
  profileData: Float32Array;
  minPrice: number;
  maxPrice: number;
  poc: number;
  vah: number;
  val: number;
  priceToY: (price: number) => number;
  options: VolumeProfileRenderOptions;
  dpr: number;
}

export interface VolumeProfileRenderOptions {
  color?: string;
  pocColor?: string;
  valueAreaColor?: string;
  opacity?: number;
  width?: number; // Width as percentage of plot area (0-100)
  position?: 'left' | 'right';
}

/**
 * Render volume profile histogram on the chart.
 */
export function renderVolumeProfile(input: VolumeProfileRenderInput): void {
  const {
    ctx,
    plotRect,
    profileData,
    minPrice,
    maxPrice,
    poc,
    vah,
    val,
    priceToY,
    options,
    dpr,
  } = input;

  const color = options.color ?? '#3b82f6';
  const pocColor = options.pocColor ?? '#ef4444';
  const valueAreaColor = options.valueAreaColor ?? 'rgba(59, 130, 246, 0.2)';
  const opacity = options.opacity ?? 0.6;
  const widthPercent = options.width ?? 20;
  const position = options.position ?? 'right';

  const numBins = profileData.length;
  const binHeight = (maxPrice - minPrice) / numBins;

  // Find max volume for scaling
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    const vol = profileData[i] ?? 0;
    if (vol > maxVolume) {
      maxVolume = vol;
    }
  }

  if (maxVolume === 0) return;

  // Calculate histogram width and position
  const histWidth = (plotRect.width * widthPercent) / 100;
  const histX = position === 'right' 
    ? plotRect.x + plotRect.width - histWidth 
    : plotRect.x;

  ctx.save();

  // Draw value area background
  const vahY = priceToY(vah);
  const valY = priceToY(val);
  ctx.fillStyle = valueAreaColor;
  ctx.fillRect(histX, vahY, histWidth, valY - vahY);

  // Draw volume bars
  for (let i = 0; i < numBins; i++) {
    const binPrice = minPrice + (i + 0.5) * binHeight;
    const binY = priceToY(binPrice + binHeight / 2);
    const binVolume = profileData[i] ?? 0;
    const barWidth = (binVolume / maxVolume) * histWidth;

    const barX = position === 'right' 
      ? plotRect.x + plotRect.width - barWidth 
      : plotRect.x;

    // Use POC color for the POC bin
    const binPriceTop = minPrice + (i + 1) * binHeight;
    const binPriceBottom = minPrice + i * binHeight;
    const isPOC = poc >= binPriceBottom && poc < binPriceTop;

    ctx.fillStyle = isPOC ? pocColor : color;
    ctx.globalAlpha = opacity;
    ctx.fillRect(barX, binY - (binHeight / 2), barWidth, binHeight);
  }

  // Draw POC line
  const pocY = priceToY(poc);
  ctx.strokeStyle = pocColor;
  ctx.lineWidth = 2 * dpr;
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(histX, pocY);
  ctx.lineTo(histX + histWidth, pocY);
  ctx.stroke();

  // Draw VAH/VAL lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([5 * dpr, 5 * dpr]);

  ctx.beginPath();
  ctx.moveTo(histX, vahY);
  ctx.lineTo(histX + histWidth, vahY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(histX, valY);
  ctx.lineTo(histX + histWidth, valY);
  ctx.stroke();

  ctx.restore();
}

