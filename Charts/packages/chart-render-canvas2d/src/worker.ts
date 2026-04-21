import { registerWorkerFactories } from './worker-registry';

const LOD_WORKER_SOURCE = `
const resolveLevelCount = (length, maxLevels) => {
  if (length <= 1) return 0;
  const maxByLength = Math.floor(Math.log2(length));
  return Math.max(0, Math.min(maxLevels, maxByLength));
};

const buildLevel = (time, value, length, bucketSize) => {
  const bucketCount = Math.ceil(length / bucketSize);
  const outTime = [];
  const outValue = [];
  const offsets = new Int32Array(bucketCount + 1);

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    offsets[bucketIndex] = outTime.length;
    const start = bucketIndex * bucketSize;
    const end = Math.min(length, start + bucketSize);
    let hasFinite = false;
    let firstIndex = -1;
    let lastIndex = -1;
    let minIndex = -1;
    let maxIndex = -1;
    let minValue = 0;
    let maxValue = 0;
    let firstNaNIndex = -1;

    for (let i = start; i < end; i += 1) {
      const v = value[i];
      if (Number.isNaN(v)) {
        if (firstNaNIndex < 0) firstNaNIndex = i;
        continue;
      }
      if (!hasFinite) {
        hasFinite = true;
        firstIndex = i;
        lastIndex = i;
        minIndex = i;
        maxIndex = i;
        minValue = v;
        maxValue = v;
      } else {
        lastIndex = i;
        if (v < minValue) {
          minValue = v;
          minIndex = i;
        }
        if (v > maxValue) {
          maxValue = v;
          maxIndex = i;
        }
      }
    }

    if (!hasFinite) {
      if (firstNaNIndex >= 0) {
        outTime.push(time[firstNaNIndex]);
        outValue.push(NaN);
      }
      continue;
    }

    const indices = [firstIndex, minIndex, maxIndex, lastIndex];
    if (firstNaNIndex >= 0) indices.push(firstNaNIndex);
    indices.sort((a, b) => a - b);
    let previous = -1;
    for (let i = 0; i < indices.length; i += 1) {
      const idx = indices[i];
      if (idx === previous) continue;
      outTime.push(time[idx]);
      outValue.push(value[idx]);
      previous = idx;
    }
  }

  offsets[bucketCount] = outTime.length;

  return {
    bucketSize,
    time: Float64Array.from(outTime),
    value: Float64Array.from(outValue),
    length: outTime.length,
    offsets,
  };
};

const buildLevels = (time, value, length, maxLevels, minPoints, progressive, requestId) => {
  if (!length || length < minPoints) return [];
  const levelCount = resolveLevelCount(length, maxLevels);
  if (!levelCount) return [];

  const levels = new Array(levelCount);
  const start = progressive ? levelCount - 1 : 0;
  const end = progressive ? -1 : levelCount;
  const step = progressive ? -1 : 1;

  for (let levelIndex = start; levelIndex !== end; levelIndex += step) {
    const bucketSize = Math.pow(2, levelIndex + 1);
    const level = buildLevel(time, value, length, bucketSize);
    if (progressive) {
      const transfer = [level.time.buffer, level.value.buffer, level.offsets.buffer];
      self.postMessage({ requestId, length, levels: [level], done: false }, transfer);
    } else {
      levels[levelIndex] = level;
    }
  }

  return levels;
};

self.onmessage = (event) => {
  const data = event.data;
  if (!data) return;
  const { requestId, time, value, length, maxLevels, minPoints, progressive } = data;
  const levels = buildLevels(time, value, length, maxLevels, minPoints, !!progressive, requestId);
  if (progressive) {
    self.postMessage({ requestId, length, done: true });
    return;
  }
  const transfer = [];
  for (let i = 0; i < levels.length; i += 1) {
    transfer.push(levels[i].time.buffer, levels[i].value.buffer, levels[i].offsets.buffer);
  }
  self.postMessage({ requestId, length, levels, done: true }, transfer);
};
`;

const SERIES_WORKER_SOURCE = `
let canvas = null;
let ctx = null;
let dpr = 1;
let cssWidth = 0;
let cssHeight = 0;

const updateTransform = () => {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

const resizeCanvas = (pixelWidth, pixelHeight, nextDpr) => {
  const nextPixelWidth = Math.max(1, Math.round(pixelWidth));
  const nextPixelHeight = Math.max(1, Math.round(pixelHeight));
  dpr = Math.max(1, Number.isFinite(nextDpr) ? nextDpr : 1);
  cssWidth = nextPixelWidth / dpr;
  cssHeight = nextPixelHeight / dpr;
  if (canvas) {
    canvas.width = nextPixelWidth;
    canvas.height = nextPixelHeight;
  }
  updateTransform();
};

const alignLineWidth = (width) => {
  if (!Number.isFinite(width)) return 1;
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  return deviceWidth / dpr;
};

const snap = (value, strokeWidth) => {
  const aligned = Math.round(value * dpr) / dpr;
  const width = Number.isFinite(strokeWidth) ? strokeWidth : 1;
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  if (deviceWidth % 2 === 1) return aligned + 0.5 / dpr;
  return aligned;
};

const alignToDevicePixel = (value) => {
  if (!Number.isFinite(value)) return value;
  const scale = Math.max(1, dpr || 1);
  return Math.round(value * scale) / scale;
};

const resolveBarGeometry = (center, width) => {
  const safeDpr = Math.max(1, dpr || 1);
  const deviceWidth = Math.max(1, Math.round(width * safeDpr));
  const halfDevice = Math.floor(deviceWidth / 2);
  const centerDevice = Math.round(center * safeDpr);
  const leftDevice = centerDevice - halfDevice;
  return { left: leftDevice / safeDpr, width: deviceWidth / safeDpr };
};

const applyScaleMode = (value, mode, base) => {
  if (!Number.isFinite(value)) return NaN;
  if (mode === 'normal') return value;
  if (!Number.isFinite(base) || base === 0) return NaN;
  if (mode === 'percentage') return value / base - 1;
  if (mode === 'indexedTo100') return (value / base) * 100;
  return value;
};

const valueToY = (value, scale) => {
  if (!Number.isFinite(value)) return NaN;
  const height = scale.height;
  if (height <= 0) return NaN;
  if (scale.type === 'log') {
    if (value <= 0) return NaN;
    const logMin = Math.log10(scale.minPositive);
    const logMax = Math.log10(scale.max);
    if (logMax === logMin) return height * 0.5;
    const ratio = (Math.log10(value) - logMin) / (logMax - logMin);
    return (1 - ratio) * height;
  }
  if (scale.max === scale.min) return height * 0.5;
  const ratio = (value - scale.min) / (scale.max - scale.min);
  return (1 - ratio) * height;
};

const clear = () => {
  if (!ctx) return;
  ctx.clearRect(0, 0, cssWidth, cssHeight);
};

const renderSeries = (payload) => {
  if (!ctx) return;
  clear();
  const plotRect = payload.plotRect;
  if (plotRect.width <= 0 || plotRect.height <= 0) return;
  const span = payload.visibleRange.to - payload.visibleRange.from;
  if (span <= 0) return;
  if (!payload.series || payload.series.length === 0) return;
  const gapThresholdMs =
    typeof payload.gapThresholdMs === 'number' && Number.isFinite(payload.gapThresholdMs) && payload.gapThresholdMs > 0
      ? payload.gapThresholdMs
      : null;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
  ctx.clip();

  for (let s = 0; s < payload.series.length; s += 1) {
    const series = payload.series[s];
    if (!series) continue;
    const seriesType = series.seriesType || 'line';
    const time = series.time;
    if (!time) continue;

    const seriesRect = series.plotRect || plotRect;
    const scaleX = seriesRect.width / span;
    const offsetX = seriesRect.x - payload.visibleRange.from * scaleX;
    const width = Number.isFinite(series.width) ? series.width : 2;
    const alignedWidth = alignLineWidth(width);
    const opacity = Number.isFinite(series.opacity) ? series.opacity : 1;
    const scale = series.scale;
    const scaleMode = series.scaleMode || 'normal';
    const scaleBase = series.scaleBase;

    if (seriesType === 'candlestick' || seriesType === 'bar') {
      const open = series.open;
      const high = series.high;
      const low = series.low;
      const close = series.close;
      if (!open || !high || !low || !close) continue;
      const count = Math.min(time.length, open.length, high.length, low.length, close.length);
      if (!count) continue;
      const barWidth = Number.isFinite(series.barWidth) ? series.barWidth : alignedWidth;
      const upColor = series.upColor || series.color;
      const downColor = series.downColor || series.color;

      ctx.globalAlpha = opacity;
      ctx.setLineDash([]);
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';

      if (seriesType === 'candlestick') {
        const bodyWidth = Math.max(1 / dpr, barWidth);
        const minBodyHeight = 1 / dpr;
        const wickColor = typeof series.wickColor === 'string' ? series.wickColor : null;
        const borderVisible = series.borderVisible !== false;
        let lastWick = '';
        let lastBody = '';

        for (let i = 0; i < count; i += 1) {
          const o = open[i];
          const h = high[i];
          const l = low[i];
          const c = close[i];
          if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
            continue;
          }

          const scaledOpen = scaleMode === 'normal' ? o : applyScaleMode(o, scaleMode, scaleBase);
          const scaledHigh = scaleMode === 'normal' ? h : applyScaleMode(h, scaleMode, scaleBase);
          const scaledLow = scaleMode === 'normal' ? l : applyScaleMode(l, scaleMode, scaleBase);
          const scaledClose = scaleMode === 'normal' ? c : applyScaleMode(c, scaleMode, scaleBase);
          const yOpen = valueToY(scaledOpen, scale);
          const yHigh = valueToY(scaledHigh, scale);
          const yLow = valueToY(scaledLow, scale);
          const yClose = valueToY(scaledClose, scale);
          if (!Number.isFinite(yOpen) || !Number.isFinite(yHigh) || !Number.isFinite(yLow) || !Number.isFinite(yClose)) {
            continue;
          }

          const t = time[i];
          const center = offsetX + t * scaleX;
          const x = snap(center, alignedWidth);
          const yHighSnap = snap(seriesRect.y + yHigh, alignedWidth);
          const yLowSnap = snap(seriesRect.y + yLow, alignedWidth);

          let bodyTop = alignToDevicePixel(seriesRect.y + Math.min(yOpen, yClose));
          let bodyBottom = alignToDevicePixel(seriesRect.y + Math.max(yOpen, yClose));
          if (bodyBottom - bodyTop < minBodyHeight) {
            const mid = (bodyTop + bodyBottom) * 0.5;
            bodyTop = alignToDevicePixel(mid - minBodyHeight * 0.5);
            bodyBottom = alignToDevicePixel(mid + minBodyHeight * 0.5);
          }

          const body = resolveBarGeometry(center, bodyWidth);
          const isUp = c >= o;
          const bodyColor = isUp ? upColor : downColor;
          const wickStroke = wickColor || bodyColor;

          if (wickStroke !== lastWick) {
            ctx.strokeStyle = wickStroke;
            lastWick = wickStroke;
          }
          ctx.lineWidth = alignedWidth;
          ctx.beginPath();
          ctx.moveTo(x, yHighSnap);
          ctx.lineTo(x, yLowSnap);
          ctx.stroke();

          if (bodyColor !== lastBody) {
            ctx.fillStyle = bodyColor;
            lastBody = bodyColor;
          }
          ctx.fillRect(body.left, bodyTop, body.width, bodyBottom - bodyTop);

          if (borderVisible) {
            ctx.strokeStyle = bodyColor;
            ctx.lineWidth = alignedWidth;
            const inset = alignedWidth * 0.5;
            const strokeLeft = alignToDevicePixel(body.left + inset);
            const strokeTop = alignToDevicePixel(bodyTop + inset);
            const strokeWidth = Math.max(0, body.width - alignedWidth);
            const strokeHeight = Math.max(0, bodyBottom - bodyTop - alignedWidth);
            if (strokeWidth > 0 && strokeHeight > 0) {
              ctx.strokeRect(strokeLeft, strokeTop, strokeWidth, strokeHeight);
            }
          }
        }
      } else {
        const tickWidth = Math.max(alignedWidth, barWidth * 0.6);
        const halfTick = tickWidth * 0.5;
        let lastColor = '';

        ctx.lineWidth = alignedWidth;

        for (let i = 0; i < count; i += 1) {
          const o = open[i];
          const h = high[i];
          const l = low[i];
          const c = close[i];
          if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
            continue;
          }

          const scaledOpen = scaleMode === 'normal' ? o : applyScaleMode(o, scaleMode, scaleBase);
          const scaledHigh = scaleMode === 'normal' ? h : applyScaleMode(h, scaleMode, scaleBase);
          const scaledLow = scaleMode === 'normal' ? l : applyScaleMode(l, scaleMode, scaleBase);
          const scaledClose = scaleMode === 'normal' ? c : applyScaleMode(c, scaleMode, scaleBase);
          const yOpen = valueToY(scaledOpen, scale);
          const yHigh = valueToY(scaledHigh, scale);
          const yLow = valueToY(scaledLow, scale);
          const yClose = valueToY(scaledClose, scale);
          if (!Number.isFinite(yOpen) || !Number.isFinite(yHigh) || !Number.isFinite(yLow) || !Number.isFinite(yClose)) {
            continue;
          }

          const t = time[i];
          const center = offsetX + t * scaleX;
          const x = snap(center, alignedWidth);
          const yHighSnap = snap(seriesRect.y + yHigh, alignedWidth);
          const yLowSnap = snap(seriesRect.y + yLow, alignedWidth);
          const yOpenSnap = snap(seriesRect.y + yOpen, alignedWidth);
          const yCloseSnap = snap(seriesRect.y + yClose, alignedWidth);

          const isUp = c >= o;
          const stroke = isUp ? upColor : downColor;
          if (stroke !== lastColor) {
            ctx.strokeStyle = stroke;
            lastColor = stroke;
          }

          const leftTick = alignToDevicePixel(x - halfTick);
          const rightTick = alignToDevicePixel(x + halfTick);

          ctx.beginPath();
          ctx.moveTo(x, yHighSnap);
          ctx.lineTo(x, yLowSnap);
          ctx.moveTo(leftTick, yOpenSnap);
          ctx.lineTo(x, yOpenSnap);
          ctx.moveTo(x, yCloseSnap);
          ctx.lineTo(rightTick, yCloseSnap);
          ctx.stroke();
        }
      }
      continue;
    }

    const value = series.value;
    if (!value || value.length === 0) continue;
    const renderMode = series.renderMode === 'step' ? 'step' : 'linear';

    ctx.strokeStyle = series.color;
    ctx.lineWidth = alignedWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = opacity;
    if (series.dash && series.dash.length > 0) {
      ctx.setLineDash(series.dash);
    } else {
      ctx.setLineDash([]);
    }

    let started = false;
    let prevY = 0;
    let prevTime = NaN;
    ctx.beginPath();
    for (let i = 0; i < value.length; i += 1) {
      const v = value[i];
      if (!Number.isFinite(v)) {
        started = false;
        prevTime = NaN;
        continue;
      }
      const scaledValue = scaleMode === 'normal' ? v : applyScaleMode(v, scaleMode, scaleBase);
      const yValue = valueToY(scaledValue, scale);
      if (!Number.isFinite(yValue)) {
        started = false;
        prevTime = NaN;
        continue;
      }
      const t = time[i];
      if (started && gapThresholdMs !== null && Number.isFinite(prevTime) && t - prevTime > gapThresholdMs) {
        started = false;
      }
      const x = snap(offsetX + t * scaleX, alignedWidth);
      const y = snap(seriesRect.y + yValue, alignedWidth);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
        prevY = y;
        prevTime = t;
      } else {
        if (renderMode === 'step') {
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevY = y;
        prevTime = t;
      }
    }
    if (started) {
      ctx.stroke();
    }
  }

  ctx.restore();
  ctx.globalAlpha = 1;
};

self.onmessage = (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'init') {
    canvas = data.canvas;
    ctx = canvas.getContext('2d');
    resizeCanvas(data.pixelWidth, data.pixelHeight, data.dpr);
    return;
  }
  if (data.type === 'resize') {
    resizeCanvas(data.pixelWidth, data.pixelHeight, data.dpr);
    return;
  }
  if (data.type === 'render') {
    renderSeries(data);
  }
};
`;

const createLodWorker = (): Worker | null => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return null;
  }
  try {
    const blob = new Blob([LOD_WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  } catch {
    return null;
  }
};

const supportsSeriesWorker = (): boolean => {
  if (typeof Worker === 'undefined') return false;
  if (typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
  if (typeof OffscreenCanvas === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  return 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
};

const createSeriesWorker = (): Worker | null => {
  if (!supportsSeriesWorker()) return null;
  try {
    const blob = new Blob([SERIES_WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  } catch {
    return null;
  }
};

registerWorkerFactories({ lod: createLodWorker, series: createSeriesWorker });
