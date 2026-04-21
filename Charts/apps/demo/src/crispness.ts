import { CanvasSurface } from '@charts-plus/chart-render-canvas2d';

const dprs = [1, 1.25, 1.5, 2];
const grid = document.getElementById('grid');

if (grid) {
  dprs.forEach((dpr) => {
    const card = document.createElement('div');
    card.className = 'card';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `DPR ${dpr}`;

    const host = document.createElement('div');
    host.className = 'canvas-host';

    card.appendChild(label);
    card.appendChild(host);
    grid.appendChild(card);

    const surface = new CanvasSurface(host, {
      autoSize: false,
      width: host.clientWidth || 260,
      height: 160,
      dpr,
    });

    const ctx = surface.context;
    if (!ctx) return;

    const size = surface.getSize();
    ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, size.cssWidth, size.cssHeight);

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#b9f27b';

    const pad = 18;
    const left = surface.snapX(pad);
    const right = surface.snapX(size.cssWidth - pad);
    const top = surface.snapY(pad);
    const bottom = surface.snapY(size.cssHeight - pad);
    const midX = surface.snapX(size.cssWidth * 0.5);
    const midY = surface.snapY(size.cssHeight * 0.5);

    ctx.beginPath();
    // Horizontal line.
    ctx.moveTo(left, midY);
    ctx.lineTo(right, midY);
    // Vertical line.
    ctx.moveTo(midX, top);
    ctx.lineTo(midX, bottom);
    // Diagonal line.
    ctx.moveTo(left, bottom);
    ctx.lineTo(right, top);
    ctx.stroke();
  });
}
