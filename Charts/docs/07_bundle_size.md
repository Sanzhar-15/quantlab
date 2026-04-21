# Bundle Size + Tree-Shaking

## Budgets

- core + canvas2d
  - soft: 61 KB gzip
  - hard: 64 KB gzip
- optional workers
  - soft: 8 KB gzip
  - hard: 10 KB gzip
- optional WebGL
  - soft: 8 KB gzip
  - hard: 10 KB gzip

## Size report

1) Build package outputs:

```bash
npm run build:packages
```

2) Run size report:

```bash
npm run size
```

`npm run size` enforces soft + hard caps. To run in warning-only mode:

```bash
node scripts/bundle-size.mjs
```

The report prints base totals plus optional module sizes. Optional modules that are not built yet will show as "missing".

## Optional backends

- Workers are off by default. To enable them, import the worker entrypoint before creating a chart:

```ts
import '@charts-plus/chart-render-canvas2d/worker';
import { createChart } from '@charts-plus/chart-render-canvas2d';

createChart('chart', { seriesRenderer: 'auto' });
```

- The WebGL backend is optional and only enabled when it exists. The size report tracks its budget separately.

## Verify tree-shaking

To confirm optional backends are not pulled into the base bundle, bundle two entry points and compare output sizes:

```ts
// /tmp/entry-core.ts
import { createChart } from '@charts-plus/chart-render-canvas2d';
void createChart;
```

```ts
// /tmp/entry-worker.ts
import '@charts-plus/chart-render-canvas2d/worker';
import { createChart } from '@charts-plus/chart-render-canvas2d';
void createChart;
```

```bash
npx esbuild /tmp/entry-core.ts --bundle --minify --format=esm --outfile=/tmp/core.js
npx esbuild /tmp/entry-worker.ts --bundle --minify --format=esm --outfile=/tmp/worker.js
wc -c /tmp/core.js /tmp/worker.js
```

The worker bundle should be larger and the core bundle should remain within the base budget.
