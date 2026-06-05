// FE-1-0/FE-1-1 latency shootout — the napi "engine floor" leg (BASELINE).
//
// Topology: the owning WorkbookSession lives in THIS Node process (the current
// shipped FE-2-0 grid topology). No Python, no transport — this is the absolute
// engine round-trip floor. If even this misses the gate, the <100ms Python<->grid
// moat is dead regardless of transport.
//
// Workload contract is identical to bench/latency_common.py (mirrored inline here
// since this is the only JS leg):
//   A: warmup 100, then 1000x { setValue(A1) -> recalcDirty -> snapshotDelta(v) }
//      with a dependent B1=A1+1 so recalc does real (tiny) work.
//   B: 50x { writeRange(100x10=1000 cells) -> recalcDirty -> snapshotDelta(v) }.
//
// Run (Mac host): cargo build -p ql-bindings-node --release
//   node crates/ql-bindings-node/tests/latency_napi.mjs
// Override the cdylib path with QL_NODE_CDYLIB=/abs/path/to/lib....{dylib,so}.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../.."); // crates/ql-bindings-node/tests -> root

// --- workload constants (keep in lockstep with latency_common.py) ------------
const WARMUP_A = 100;
const ITERS_A = 1000;
const BATCH_ROWS = 100;
const BATCH_COLS = 10;
const BATCH_CELLS = BATCH_ROWS * BATCH_COLS;
const WARMUP_B = 5;
const ITERS_B = 50;
const BATCH_BASE_ROW = 10;
const GATE_A_MS = 100.0;
const GATE_B_MS = 200.0;

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) {
    const p = process.env.QL_NODE_CDYLIB;
    if (!existsSync(p)) throw new Error(`QL_NODE_CDYLIB does not exist: ${p}`);
    return p;
  }
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const base = `libql_bindings_node.${ext}`;
  const candidates = [
    path.join(workspaceRoot, "target", "release", base),
    path.join(workspaceRoot, "target", "debug", base),
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(
      `built cdylib not found. Run \`cargo build -p ql-bindings-node --release\` first.\n` +
        `Looked in:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

function loadNative(cdylibPath) {
  const mod = { exports: {} };
  process.dlopen(mod, cdylibPath);
  return mod.exports;
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const pct = (p) => {
    const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
    return s[idx];
  };
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return {
    n,
    p50: r4(pct(50)),
    p95: r4(pct(95)),
    p99: r4(pct(99)),
    max: r4(s[n - 1]),
    min: r4(s[0]),
    mean: r4(s.reduce((a, b) => a + b, 0) / n),
  };
}

function median(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const m = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return Math.round(m * 1e4) / 1e4;
}

const ms = () => Number(process.hrtime.bigint()) / 1e6;

// --- main --------------------------------------------------------------------
const cdylibPath = resolveCdylib();
console.error(`[napi] loading cdylib: ${cdylibPath}`);
const { Session } = loadNative(cdylibPath);
if (!Session) throw new Error("native module must export the `Session` class");

const s = new Session();
const sheet = s.addSheet("Bench", 1000);
// dependent so recalc does real (tiny) work each single edit.
s.setFormula(sheet, 0, 1, "A1+1"); // B1 = A1+1
s.setValue(sheet, 0, 0, { kind: "number", number: 0 });
s.recalcDirty();
let version = s.snapshot().version; // seed the delta version token

// ---- Workload A: single-edit round-trip ----
const aTotals = [];
const aWrite = [];
const aRecalc = [];
const aDelta = [];
let aMinDeltaCells = Infinity; // correctness: every timed delta must carry >=1 changed cell
let lastA1 = 0;
for (let i = 0; i < WARMUP_A + ITERS_A; i++) {
  const timed = i >= WARMUP_A;
  lastA1 = i + 1;
  const t0 = ms();
  s.setValue(sheet, 0, 0, { kind: "number", number: lastA1 });
  const t1 = ms();
  s.recalcDirty();
  const t2 = ms();
  const delta = s.snapshotDelta(version);
  const t3 = ms();
  version = delta.version;
  if (timed) {
    aTotals.push(t3 - t0);
    aWrite.push(t1 - t0);
    aRecalc.push(t2 - t1);
    aDelta.push(t3 - t2);
    aMinDeltaCells = Math.min(aMinDeltaCells, delta.changedCells.length);
  }
}
// correctness guard: prove writes mutated AND recalc propagated (No-Fallbacks: fail loud).
if (aMinDeltaCells < 1) throw new Error(`[napi] invalid: a Workload-A delta carried 0 changed cells (measured a no-op)`);
const b1 = s.cell(sheet, 0, 1);
if (!b1 || !b1.value || b1.value.number !== lastA1 + 1) {
  throw new Error(`[napi] invalid: B1 (=A1+1) expected ${lastA1 + 1}, got ${JSON.stringify(b1?.value)} — round-trip did not recalc`);
}

// ---- Workload B: 1000-cell batch paste ----
const range = {
  sheet,
  startRow: BATCH_BASE_ROW,
  startCol: 0,
  endRow: BATCH_BASE_ROW + BATCH_ROWS - 1,
  endCol: BATCH_COLS - 1,
};
const bTotals = [];
const bWrite = [];
const bRecalc = [];
const bDelta = [];
let bMinDeltaCells = Infinity;
let lastBatchBase = 0;
for (let i = 0; i < WARMUP_B + ITERS_B; i++) {
  const timed = i >= WARMUP_B;
  // fresh values each iteration so the whole range is dirty.
  lastBatchBase = i * 1000;
  const values = [];
  for (let r = 0; r < BATCH_ROWS; r++) {
    const row = [];
    for (let c = 0; c < BATCH_COLS; c++) row.push({ kind: "number", number: lastBatchBase + r * BATCH_COLS + c });
    values.push(row);
  }
  const t0 = ms();
  s.writeRange(range, values);
  const t1 = ms();
  s.recalcDirty();
  const t2 = ms();
  const delta = s.snapshotDelta(version);
  const t3 = ms();
  version = delta.version;
  if (timed) {
    bTotals.push(t3 - t0);
    bWrite.push(t1 - t0);
    bRecalc.push(t2 - t1);
    bDelta.push(t3 - t2);
    bMinDeltaCells = Math.min(bMinDeltaCells, delta.changedCells.length);
  }
}
// correctness guard: every batch delta must carry the written cells; spot-check a corner.
if (bMinDeltaCells < 1) throw new Error(`[napi] invalid: a Workload-B delta carried 0 changed cells`);
const corner = s.cell(sheet, BATCH_BASE_ROW, 0);
if (!corner || !corner.value || corner.value.number !== lastBatchBase) {
  throw new Error(`[napi] invalid: batch corner expected ${lastBatchBase}, got ${JSON.stringify(corner?.value)}`);
}
s.close();

const A = summarize(aTotals);
const B = summarize(bTotals);
const report = {
  leg: "napi",
  topology: "engine-in-node",
  host: {
    platform: `${os.type()} ${os.release()}`,
    machine: os.machine?.() ?? process.arch,
    processor: os.cpus()?.[0]?.model ?? process.arch,
    python: null,
    node: process.version,
  },
  ts: new Date().toISOString(),
  workloadA: { ...A, iters: ITERS_A, stage_medians: { write: median(aWrite), recalc: median(aRecalc), delta: median(aDelta) } },
  workloadB: { ...B, iters: ITERS_B, cells: BATCH_CELLS, stage_medians: { write: median(bWrite), recalc: median(bRecalc), delta: median(bDelta) } },
  gates: { A_p50_lt_100ms: A.p50 < GATE_A_MS, B_p50_lt_200ms: B.p50 < GATE_B_MS },
};

const text = JSON.stringify(report, null, 2);
console.log(text);
const resultsDir = path.join(workspaceRoot, "bench", "results");
mkdirSync(resultsDir, { recursive: true });
writeFileSync(path.join(resultsDir, "napi.json"), text + "\n");
const verdict = report.gates.A_p50_lt_100ms && report.gates.B_p50_lt_200ms ? "PASS" : "MISS";
console.error(
  `[napi] ${verdict}  A.p50=${A.p50}ms (gate<${GATE_A_MS})  A.p99=${A.p99}ms  B.p50=${B.p50}ms (gate<${GATE_B_MS})`,
);
