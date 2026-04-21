// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';

const createStubContext = () => {
  const ctx = {
    canvas: document.createElement('canvas'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    stroke: (_path?: Path2D) => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    fill: () => {},
    fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 6 } as TextMetrics),
    setLineDash: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: () => {},
    transform: () => {},
    imageSmoothingEnabled: false,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
  return ctx as unknown as CanvasRenderingContext2D;
};

const stubCanvasContext = () => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
};

const createContainer = () => {
  const container = document.createElement('div');
  container.style.width = '400px';
  container.style.height = '240px';
  document.body.appendChild(container);
  return container;
};

describe('accessibility baseline', () => {
  it('applies focusable attributes and aria labeling', () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240 });
      const root = container;

      expect(root.classList.contains('charts-plus-root')).toBe(true);
      expect(root.tabIndex).toBe(0);
      expect(root.getAttribute('role')).toBe('region');
      const ariaLabel = root.getAttribute('aria-label');
      const labelledBy = root.getAttribute('aria-labelledby');
      expect(Boolean(ariaLabel || labelledBy)).toBe(true);

      const style = document.getElementById('charts-plus-focus-style');
      expect(style).toBeTruthy();

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});
