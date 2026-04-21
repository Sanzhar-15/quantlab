import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@charts-plus/chart-core/presets': resolve(__dirname, 'packages/chart-core/src/presets.ts'),
      '@charts-plus/chart-core': resolve(__dirname, 'packages/chart-core/src/index.ts'),
      '@charts-plus/chart-render-canvas2d': resolve(
        __dirname,
        'packages/chart-render-canvas2d/src/index.ts',
      ),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts'],
  },
});
