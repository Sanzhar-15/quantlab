import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@charts-plus/chart-render-canvas2d/worker',
        replacement: resolve(__dirname, '../../packages/chart-render-canvas2d/src/worker.ts'),
      },
      {
        find: '@charts-plus/chart-render-canvas2d',
        replacement: resolve(__dirname, '../../packages/chart-render-canvas2d/src/index.ts'),
      },
      {
        find: '@charts-plus/chart-core/presets',
        replacement: resolve(__dirname, '../../packages/chart-core/src/presets.ts'),
      },
      {
        find: '@charts-plus/chart-core',
        replacement: resolve(__dirname, '../../packages/chart-core/src/index.ts'),
      },
    ],
  },
  server: { port: 5176, strictPort: true },
});
