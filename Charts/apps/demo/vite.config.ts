import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: {
    jsxImportSource: 'react',
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@charts-plus/chart-core/presets': resolve(__dirname, '../../packages/chart-core/src/presets.ts'),
      '@charts-plus/chart-core': resolve(__dirname, '../../packages/chart-core/src/index.ts'),
      '@charts-plus/chart-render-canvas2d/worker': resolve(
        __dirname,
        '../../packages/chart-render-canvas2d/src/worker.ts',
      ),
      '@charts-plus/chart-render-canvas2d': resolve(
        __dirname,
        '../../packages/chart-render-canvas2d/src/index.ts',
      ),
      '@charts-plus/chart-transforms': resolve(
        __dirname,
        '../../packages/chart-transforms/src/index.ts',
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        crispness: resolve(__dirname, 'crispness.html'),
        scale: resolve(__dirname, 'scale.html'),
      },
    },
  },
});
