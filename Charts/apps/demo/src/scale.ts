import { CanvasSurface } from '@charts-plus/chart-render-canvas2d';
import { PriceScale } from '@charts-plus/chart-core';

const host = document.getElementById('chart');
const toggle = document.getElementById('toggle') as HTMLButtonElement | null;

if (host) {
  const surface = new CanvasSurface(host, { autoSize: true });
  const scale = new PriceScale({ type: 'linear', tickCount: 6, format: 'decimal' });

  const count = 180;
  const values = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    values[i] = Math.exp(i / 28);
  }

  const render = () => {
    const ctx = surface.context;
    if (!ctx) return;
    const size = surface.getSize();
    const padding = { top: 16, right: 16, bottom: 24, left: 64 };
    const plotWidth = Math.max(1, size.cssWidth - padding.left - padding.right);
    const plotHeight = Math.max(1, size.cssHeight - padding.top - padding.bottom);

    scale.setHeight(plotHeight);
    scale.autoScale(values, 0, values.length);
    const ticks = scale.getTicks();

    ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, size.cssWidth, size.cssHeight);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ticks.forEach((tick) => {
      const y = padding.top + scale.valueToY(tick);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotWidth, y);
      ctx.stroke();
    });

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px "IBM Plex Sans", "Space Grotesk", sans-serif';
    ctx.textBaseline = 'middle';
    ticks.forEach((tick) => {
      const y = padding.top + scale.valueToY(tick);
      ctx.fillText(scale.format(tick), 12, y);
    });

    ctx.strokeStyle = '#7bc8ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < values.length; i += 1) {
      const x = padding.left + (i / (values.length - 1)) * plotWidth;
      const y = padding.top + scale.valueToY(values[i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  surface.setOnResize(render);
  render();

  if (toggle) {
    toggle.addEventListener('click', () => {
      const nextType = scale.getEffectiveType() === 'linear' ? 'log' : 'linear';
      scale.setOptions({ type: nextType });
      toggle.textContent = nextType === 'linear' ? 'Switch to Log' : 'Switch to Linear';
      render();
    });
  }
}
