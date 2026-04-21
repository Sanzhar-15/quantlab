import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const budgetsPath = path.join(repoRoot, 'config', 'bundle-budgets.json');
const budgets = JSON.parse(await fs.readFile(budgetsPath, 'utf8'));
const strictSoft =
  process.argv.includes('--strict') || process.env.BUNDLE_BUDGET_STRICT === '1';

const bundlePaths = {
  core: path.join(repoRoot, 'packages', 'chart-core', 'dist', 'index.js'),
  canvas2d: path.join(repoRoot, 'packages', 'chart-render-canvas2d', 'dist', 'index.js'),
  worker: path.join(repoRoot, 'packages', 'chart-render-canvas2d', 'dist', 'worker.js'),
  webgl: path.join(repoRoot, 'packages', 'chart-render-webgl', 'dist', 'index.js'),
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

const readBundleSize = async (filePath, options = {}) => {
  try {
    const raw = await fs.readFile(filePath);
    const gz = zlib.gzipSync(raw, { level: 9 });
    return { raw: raw.byteLength, gzip: gz.byteLength, path: filePath };
  } catch (error) {
    if (error && error.code === 'ENOENT' && !options.required) {
      return null;
    }
    throw error;
  }
};

const reportBundle = (label, size) => {
  if (!size) {
    // eslint-disable-next-line no-console
    console.log(`${label}: missing (not built)`);
    return;
  }
  const rel = path.relative(repoRoot, size.path);
  // eslint-disable-next-line no-console
  console.log(`${label}: ${rel} gzip ${formatBytes(size.gzip)} (raw ${formatBytes(size.raw)})`);
};

const checkBudget = (label, gzipBytes, budget) => {
  if (!budget) return;
  const soft = budget.softGzipBytes;
  const hard = budget.hardGzipBytes;
  // eslint-disable-next-line no-console
  console.log(
    `${label}: gzip ${formatBytes(gzipBytes)} (soft ${formatBytes(soft)}, hard ${formatBytes(hard)})`,
  );

  if (gzipBytes > hard) {
    // eslint-disable-next-line no-console
    console.error(`${label} hard cap exceeded by ${formatBytes(gzipBytes - hard)}.`);
    process.exitCode = 1;
    return;
  }

  if (gzipBytes > soft) {
    const message = `${label} soft cap exceeded by ${formatBytes(gzipBytes - soft)}.`;
    if (strictSoft) {
      // eslint-disable-next-line no-console
      console.error(message);
      process.exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.warn(message);
    }
  }
};

const coreSize = await readBundleSize(bundlePaths.core, { required: true });
const canvasSize = await readBundleSize(bundlePaths.canvas2d, { required: true });

reportBundle('core', coreSize);
reportBundle('canvas2d', canvasSize);

const totalRaw = coreSize.raw + canvasSize.raw;
const totalGzip = coreSize.gzip + canvasSize.gzip;
checkBudget('core+canvas2d', totalGzip, budgets.corePlusCanvas2d);
// eslint-disable-next-line no-console
console.log(`Total raw: ${formatBytes(totalRaw)}`);

const workerSize = await readBundleSize(bundlePaths.worker);
reportBundle('optional-workers', workerSize);
if (workerSize) {
  checkBudget('optional-workers', workerSize.gzip, budgets.optionalWorkers);
}

const webglSize = await readBundleSize(bundlePaths.webgl);
reportBundle('optional-webgl', webglSize);
if (webglSize) {
  checkBudget('optional-webgl', webglSize.gzip, budgets.optionalWebgl);
}
