// Phase 6.4-3d Step 5 — engine-side cdylib smoke for `pollEvents` + `setUdfWorker`.
//
// Proves over the REAL napi boundary (not just compilation):
//   1. `pollEvents(cursor)` surfaces `Event::CellDiagnostic` as a typed JS DTO —
//      a UDF cell with NO worker computes `#CALC!` AND emits a
//      `cell_diagnostic` event with code `udf_no_worker` (the 6.4-3d Step G
//      sink, the reason the IDE can render WHY a cell is `#CALC!`).
//   2. `setUdfWorker` fails loud with `[worker_spawn_failed]` on a bad
//      interpreter, and (when a `python3`/`python` with `pyarrow` is present)
//      succeeds so that `recalcAll` recomputes `=MYUDF(A1)` to the real value.
//
// Run (from the engine workspace root, via the Mac bridge):
//   cargo build -p ql-bindings-node --release --features test-fixtures
//   node crates/ql-bindings-node/tests/smoke_udf_pollevents.mjs
//
// Override the cdylib path with QL_NODE_CDYLIB=/abs/path/to/lib....{dylib,so}.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// crates/ql-bindings-node/tests → ../../.. = the cargo workspace root.
const workspaceRoot = path.resolve(here, "../../..");

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) {
    const p = process.env.QL_NODE_CDYLIB;
    if (!existsSync(p)) {
      throw new Error(`QL_NODE_CDYLIB does not exist: ${p}`);
    }
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

// Find `python3`/`python` that can `import pyarrow`, or null (loud skip).
function pythonWithPyarrow() {
  for (const py of ["python3", "python"]) {
    try {
      execFileSync(py, ["-c", "import pyarrow"], { stdio: "ignore" });
      return py;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const cdylibPath = resolveCdylib();
console.log(`[smoke] loading cdylib: ${cdylibPath}`);
const native = loadNative(cdylibPath);
assert.ok(native.Session, "the native module must export the `Session` class");
const { Session } = native;

// MYUDF: variadic / aggregate / volatile (mirrors udf_e2e.rs `udf_meta`).
const myUdfMeta = {
  canonicalName: "MYUDF",
  aliases: [],
  arity: { kind: "variadic" },
  volatility: "volatile",
  determinism: false,
  depShape: "value_deps",
  batchShape: "array_batch",
  argPolicy: "strict",
  cancellation: "worker_kill",
  argContext: "aggregate",
  provenanceTags: ["python"],
};

const s = new Session();
const sheetId = s.addSheet("S", 16384);

// Register MYUDF under handle 7 (`_smoke_udfs._double`).
s.registerFunction(myUdfMeta, 7n);

// A1 = 21, B1 = MYUDF(A1). With NO worker injected, B1 → #CALC! + diagnostic.
s.setValue(sheetId, 0, 0, { kind: "number", number: 21 });
s.setFormula(sheetId, 0, 1, "MYUDF(A1)");
s.recalcAll();

const b1NoWorker = s.cell(sheetId, 0, 1);
assert.ok(b1NoWorker && b1NoWorker.value, "B1 must exist after recalc");
assert.equal(b1NoWorker.value.kind, "error", "B1 with no worker is an error value");
console.log(`[smoke] no-worker B1 value = ${JSON.stringify(b1NoWorker.value)}`);

// --- pollEvents surfaces the CellDiagnostic --------------------------------
const page = s.pollEvents(0n);
assert.ok(Array.isArray(page.events), "pollEvents returns an events array");
assert.equal(typeof page.nextCursor, "bigint", "nextCursor is a BigInt");
assert.equal(page.dropped, false, "v1 unbounded ring never drops");
const diags = page.events.filter((e) => e.kind === "cell_diagnostic");
assert.ok(diags.length >= 1, "at least one cell_diagnostic event after a no-worker UDF recalc");
const d = diags.find((e) => e.diagnostic && e.diagnostic.code === "udf_no_worker");
assert.ok(d, `expected a udf_no_worker diagnostic; got ${JSON.stringify(diags)}`);
assert.equal(d.diagnostic.severity, "error", "diagnostic severity is 'error'");
assert.ok(d.diagnostic.addr, "diagnostic carries a cell addr");
assert.equal(d.diagnostic.addr.row, 0, "diagnostic addr.row");
assert.equal(d.diagnostic.addr.col, 1, "diagnostic addr.col (B1)");
assert.equal(typeof d.diagnostic.message, "string", "diagnostic message is a string");
console.log(`[smoke] pollEvents cell_diagnostic = ${JSON.stringify(d.diagnostic)}`);

// pollEvents from nextCursor returns no new events (ring did not advance).
const page2 = s.pollEvents(page.nextCursor);
assert.equal(page2.events.length, 0, "polling from nextCursor yields no new events");

// Negative / lossy cursor is rejected loud ([bad_argument]).
assert.throws(() => s.pollEvents(-1n), /\[bad_argument\]/, "negative cursor rejected");

// --- setUdfWorker: spawn-fail fails loud -----------------------------------
assert.throws(
  () => s.setUdfWorker({ python: "/nonexistent/definitely/not/a/python" }),
  /\[worker_spawn_failed\]/,
  "a bad interpreter surfaces [worker_spawn_failed]",
);
console.log("[smoke] setUdfWorker spawn-fail -> [worker_spawn_failed] OK");

// --- setUdfWorker: real-python success (loud-skip if no pyarrow) ------------
const py = pythonWithPyarrow();
if (!py) {
  console.warn("[smoke] SKIP real-python half: no python3/python with pyarrow on PATH");
} else {
  const pythonpath = path.join(workspaceRoot, "crates", "quantbook-py", "python");
  s.setUdfWorker({
    python: py,
    pythonpath: [pythonpath],
    udfModule: "quantbook._smoke_udfs",
    // Eager handshake spawns + imports pyarrow up-front; a cold import on the
    // system interpreter can exceed the 5s default. Give it generous headroom
    // (the Rust e2e spawns lazily under the 30s call deadline, never the 5s).
    handshakeTimeoutMs: 30000,
  });
  // Existing #CALC! cell needs a FULL recalc to pick up the worker (recalcDirty
  // would not — the cell is not dirty). Mirrors the engine docstring.
  s.recalcAll();
  const b1 = s.cell(sheetId, 0, 1);
  assert.ok(b1 && b1.value, "B1 must exist after worker recalc");
  assert.equal(b1.value.kind, "number", `B1 should compute a number, got ${JSON.stringify(b1.value)}`);
  assert.equal(b1.value.number, 42, "=MYUDF(A1) with A1=21 computes 42 via real python");
  console.log("[smoke] real-python =MYUDF(A1) -> 42 OK");
}

console.log("[smoke] ALL pollEvents + setUdfWorker assertions passed");
