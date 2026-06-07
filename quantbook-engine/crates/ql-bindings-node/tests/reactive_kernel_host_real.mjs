// FE-1.5-1c-1/1c-2 — acid #1 end-to-end through a REAL ipykernel + the napi host (+ fullRebuild reseed).
//
// This is the 1c-0 Node host (`reactive_kernel_host.mjs`) EVOLVED for the real-kernel topology
// decided in 1c-0.5: instead of spawning the embedded-IPython child, it spawns the Python
// `jupyter_client` SUPERVISOR (`reactive_kernel_supervisor.py`), which drives a REAL ipykernel
// over ZMQ and relays the kernel's Comm republish frames back over the SAME fd-3 protocol. So the
// moat runs end-to-end through a real kernel:
//
//   THIS host (owns napi Session + cursor; sole engine writer, R8)
//        |  stdin: {execute|epoch_change|close}     ^ fd 3: {ready|republish|stale|executed|error|epoch_done|closed}
//        v                                          |  fd 1: forwarded cell stdout
//   supervisor (jupyter_client)  <-ZMQ->  REAL ipykernel running the SAME Quantbook glue (emit=Comm).
//
// Beyond 1c-0 this host FOLDS the two declared 1c-0 deferrals:
//   - G3 (formula-overwrite): the kernel can't preflight (no Session), so the HOST enforces it at
//     apply-time. The republish frame carries `overwrite`; if the target covers a user FORMULA and
//     `!overwrite`, the host REFUSES to apply and surfaces it on the cell result (loud + visible,
//     per No-Fallbacks) -- it does NOT clobber the formula and does NOT silently skip.
//   - R7 (undo/epoch force_check): the host owns undo, so after `s.undo()` it resyncs its cursor
//     and sends `{epoch_change}` to the kernel (a REVERSE control message). The kernel marks every
//     binding force_check; the NEXT touched published var republishes even with an unchanged
//     fingerprint -> healing the grid the undo reverted.
//
// FE-1.5-1c-2 retires the spike's LAST production-incompatible behavior: applyRepublish used to THROW
// on snapshotDelta().fullRebuildRequired. That signal is a DESIGNED engine event (an undo bumps the
// engine epoch, so a cursor token from before the undo epoch-mismatches -> the engine returns a full
// rebuild rather than a silently-incomplete delta, session.rs EpochMismatch), and the SHIPPED extension
// RESEEDS on it via acquireWorkbookSnapshotViaDelta (cellGridLogic.ts:1460-1465) — "an explicit
// designed signal, NOT a swallowed error." This host now does the same: on a legitimate fullRebuild it
// re-fetches a full snapshot and re-threads the cursor. To keep this a RECOVERY path and not a
// bug-masking fallback, every 1c-1 scenario asserts no reseed occurred (reseedTotal === 0) — an
// UNEXPECTED reseed in the incremental path is a cursor-threading bug and still fails loud. Only the
// dedicated RESEED scenario induces (and expects) exactly one.
//
// Acceptance (command_exit_zero, headless, the §12.2 bar): T1-positive (reassign -> dependent
// recomputes) + T5-negative (engine-quiet) run through a REAL ipykernel, plus fan-out, mutate,
// DataFrame blank-fill, channel separation, fail-loud, G1/G2/G3, and R7 -- all end-to-end.
//
// Run (Mac): QL_NODE_CDYLIB=<engine>/target/release/libql_bindings_node.dylib +
//            QL_KERNEL_PYTHON=$HOME/.fe15-spike-venv/bin/python3.12 (ipykernel/jupyter_client/pyzmq
//            + the `fe15` kernelspec); node crates/ql-bindings-node/tests/reactive_kernel_host_real.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");
const CELL_TIMEOUT_MS = 30000;   // a real kernel + ZMQ is slower than the embedded child
const READY_TIMEOUT_MS = 60000;  // kernel spawn + bootstrap injection
const CLOSE_TIMEOUT_MS = 10000;

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) return process.env.QL_NODE_CDYLIB;
  const ext = process.platform === "darwin" ? "dylib" : "so";
  for (const sub of ["release", "debug"]) {
    const p = path.join(workspaceRoot, "target", sub, `libql_bindings_node.${ext}`);
    if (existsSync(p)) return p;
  }
  throw new Error("built cdylib not found — run `cargo build -p ql-bindings-node --release`");
}
function resolveKernelPython() {
  if (process.env.QL_KERNEL_PYTHON) return process.env.QL_KERNEL_PYTHON;
  const venv = path.join(process.env.HOME || "", ".fe15-spike-venv", "bin", "python3.12");
  return existsSync(venv) ? venv : "python3.12";
}
const SUPERVISOR = path.join(workspaceRoot, "crates", "quantbook-py", "tests", "reactive_kernel_supervisor.py");

// ---------------------------------------------------------------------------
// napi Session — owned HERE, the sole engine writer; the cursor lives HERE.
// ---------------------------------------------------------------------------
const mod = { exports: {} };
process.dlopen(mod, resolveCdylib());
const { Session } = mod.exports;
const s = new Session();
const sheetIds = new Map();
let version = null;
// 1c-2: count of republish frames the host handled via the RESEED path (a LEGITIMATE fullRebuild).
// Every 1c-1 scenario asserts this stays 0, so an UNEXPECTED reseed on the incremental path (a real
// cursor-threading bug) fails loud — the reseed is a recovery path, NOT a bug-masking fallback.
let reseedTotal = 0;

function colLetters(letters) {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}
function a1Cell(ref) {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
  if (!m) throw new Error(`malformed A1 cell: ${ref}`);
  const row = parseInt(m[2], 10);
  if (row < 1) throw new Error(`A1 row must be >= 1: ${ref}`);
  return { row: row - 1, col: colLetters(m[1]) };
}
function resolveTarget(a1) {
  const bang = a1.indexOf("!");
  if (bang < 0) throw new Error(`target must be sheet-qualified: ${a1}`);
  const name = a1.slice(0, bang);
  const ref = a1.slice(bang + 1);
  if (!sheetIds.has(name)) throw new Error(`unknown sheet in target: ${name}`);
  const sheet = sheetIds.get(name);
  let a, b;
  if (ref.includes(":")) { const [x, y] = ref.split(":", 2); a = a1Cell(x); b = a1Cell(y); }
  else { a = a1Cell(ref); b = a; }
  return { sheet, startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
}

// G3 (fold): a user FORMULA anywhere in the target envelope -> return it (the host must not clobber).
function formulaInRange(range) {
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const cell = s.cell(range.sheet, r, c);
      if (cell && cell.formula != null) return { row: r, col: c, formula: cell.formula };
    }
  }
  return null;
}

// Apply ONE republish frame: G3 preflight, then publishDataset + recalcDirty + snapshotDelta.
// Returns {delta} on the incremental path, {reseed} on a LEGITIMATE fullRebuild (1c-2 — re-fetch a
// full snapshot, mirroring the shipped reseed), or {g3refused} when the host refuses to overwrite a
// formula (surfaced, not silent). No-Fallbacks: a publish/serialize error still THROWS (FATAL).
function applyRepublish(frame) {
  const range = resolveTarget(frame.target);
  if (!frame.overwrite) {
    const f = formulaInRange(range);
    if (f) return { g3refused: { name: frame.name, detail: `(row=${f.row},col=${f.col}) formula ${JSON.stringify(f.formula)}` } };
  }
  s.publishDataset(frame.name, JSON.stringify({ values: frame.values }), range);
  s.recalcDirty();
  const d = s.snapshotDelta(version);
  if (d.fullRebuildRequired) {
    // 1c-2: a LEGITIMATE fullRebuild (the designed engine signal — e.g. an undo bumped the epoch so a
    // pre-undo cursor token epoch-mismatches). RESEED, mirroring the shipped
    // acquireWorkbookSnapshotViaDelta (cellGridLogic.ts:1460-1465): re-fetch a full snapshot and
    // re-thread the cursor to its version. NOT a swallowed error — `fullRebuildRequired` is an explicit
    // signal, and the no-stray-reseed invariant (reseedTotal asserted 0 across every incremental
    // scenario) means a cursor-threading BUG still surfaces as an unexpected reseed and fails loud.
    reseedTotal++;
    const full = s.snapshot();
    version = full.version;
    return { reseed: full };
  }
  version = d.version;
  return { delta: d };
}

function numAt(changedCells, row, col) {
  for (const cc of changedCells) {
    const c = cc.cell;
    if (c && c.row === row && c.col === col) return c.value ? c.value.number : null;
  }
  return null;
}
function groundNum(sheet, row, col) { const c = s.cell(sheet, row, col); return c && c.value ? c.value.number : null; }
function isBlank(sheet, row, col) { const c = s.cell(sheet, row, col); return !c || !c.value || c.value.kind === "blank"; }

// ---------------------------------------------------------------------------
// Supervisor child — spawned with a 4th fd (3) for the control/republish plane.
// ---------------------------------------------------------------------------
const kernelStdout = [];
let pending = null;
let readyDone = false;
let readyResolve, readyReject;
const ready = new Promise((res, rej) => {
  readyResolve = () => { readyDone = true; res(); };
  readyReject = (e) => { readyDone = true; rej(e); };
});
let closeResolve = null, closeReject = null, closing = false, sawClosed = false, sawCleanExit = false;
let fatal = null;

function failProtocol(err) {
  if (!fatal) fatal = err;
  if (!readyDone) readyReject(err);
  if (pending) { const p = pending; pending = null; p.reject(err); }
  if (closeReject) { const r = closeReject; closeResolve = closeReject = null; r(err); }
  // The rejection propagates to main().catch -> gracefulKill() (SIGTERM, then SIGKILL after a
  // grace window) so the supervisor runs its shutdown and the real ipykernel is NOT orphaned.
}

// HIGH (1c-1 Codex fold): SIGKILL on the supervisor bypasses its `finally`/signal shutdown and
// ORPHANS the KernelManager-spawned ipykernel. Send SIGTERM first (the supervisor's handler tears
// the kernel down + exits), and only hard-kill after a grace timeout.
let killed = false;
function gracefulKill() {
  if (killed) return Promise.resolve();
  killed = true;
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* dead */ } resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
  });
}
function maybeFinishClose() {
  if (sawClosed && sawCleanExit && closeResolve) { const r = closeResolve; closeResolve = closeReject = null; r(); }
}

const child = spawn(resolveKernelPython(), ["-u", SUPERVISOR], {
  stdio: ["pipe", "pipe", "inherit", "pipe"],
});

const readyTimer = setTimeout(() => {
  if (!readyDone) failProtocol(new Error(`supervisor did not send 'ready' within ${READY_TIMEOUT_MS}ms`));
}, READY_TIMEOUT_MS);

child.on("error", (e) => failProtocol(new Error(`supervisor spawn failed: ${e.message}`)));
child.on("exit", (code, sig) => {
  if (closing) {
    if (code === 0 && sig == null) { sawCleanExit = true; maybeFinishClose(); }
    else if (closeReject) { const r = closeReject; closeResolve = closeReject = null; r(new Error(`supervisor exited dirty during close (code=${code}, signal=${sig})`)); }
    return;
  }
  failProtocol(new Error(`supervisor exited unexpectedly (code=${code}, signal=${sig})`));
});

readline.createInterface({ input: child.stdout }).on("line", (l) => { if (l) kernelStdout.push(l); });

const ctrl = readline.createInterface({ input: child.stdio[3] });
ctrl.on("line", (line) => {
  if (fatal) return;
  if (line === "") { failProtocol(new Error("empty control frame")); return; }
  let f;
  try { f = JSON.parse(line); } catch { failProtocol(new Error(`malformed control frame: ${line}`)); return; }
  switch (f.type) {
    case "ready":
      if (readyDone) { failProtocol(new Error("duplicate 'ready' frame")); break; }
      readyResolve();
      break;
    case "republish": {
      if (!pending) { failProtocol(new Error(`stray 'republish' frame: ${f.name}`)); break; }
      try {
        const res = applyRepublish(f);
        if (res.g3refused) { pending.g3refused.push(res.g3refused); }
        else {
          pending.frames.push(f);
          pending.republishCount++;
          // a frame applied via the RESEED path carries no incremental delta (full re-fetch);
          // a frame applied via the normal path carries one. Track them separately so a scenario
          // can assert WHICH path applied it (the no-stray-reseed invariant).
          if (res.reseed) { pending.reseeds.push(res.reseed); pending.reseedCount++; }
          else { pending.deltas.push(res.delta); }
        }
      } catch (e) { const p = pending; pending = null; p.reject(e); }
      break;
    }
    case "stale":
      if (!pending) { failProtocol(new Error(`stray 'stale' frame: ${f.name}`)); break; }
      pending.staleNames.push(f.name);
      break;
    case "executed":
    case "epoch_done":
    case "unpublished": {
      if (!pending) { failProtocol(new Error(`stray '${f.type}' frame`)); break; }
      const p = pending; pending = null;
      p.resolve({ deltas: p.deltas, frames: p.frames, republishCount: p.republishCount, staleNames: p.staleNames, g3refused: p.g3refused, reseeds: p.reseeds, reseedCount: p.reseedCount });
      break;
    }
    case "error": {
      if (pending) {
        const p = pending; pending = null;
        // carry any g3refusals recorded before the error so execute() still rolls back the ghost.
        p.reject(Object.assign(new Error(`KERNEL ERROR: ${f.error}`), { g3refused: p.g3refused }));
      } else failProtocol(new Error(`KERNEL ERROR (no pending cell): ${f.error}`));
      break;
    }
    case "closed":
      if (!closing) { failProtocol(new Error("unexpected 'closed' frame")); break; }
      sawClosed = true; maybeFinishClose();
      break;
    default:
      failProtocol(new Error(`unknown control frame type: ${f.type}`));
  }
});

function sendOp(frame) {
  if (fatal) return Promise.reject(fatal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { if (pending) { pending = null; reject(new Error(`op timed out (${CELL_TIMEOUT_MS}ms): ${JSON.stringify(frame)}`)); } },
      CELL_TIMEOUT_MS,
    );
    pending = {
      deltas: [], frames: [], republishCount: 0, staleNames: [], g3refused: [], reseeds: [], reseedCount: 0,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    child.stdin.write(JSON.stringify(frame) + "\n");
  });
}
// execute a cell; then reconcile any host G3 REFUSAL by rolling back the ghost binding in the
// kernel registry (MED Codex fold) so a later publish can't trip G1/G2 against a refused target.
// Reconcile happens whether the cell SUCCEEDED or ERRORED (a refused-publish-then-error cell must
// still roll the ghost back), then the original error is re-thrown.
async function execute(code) {
  let res, thrown = null;
  try { res = await sendOp({ type: "execute", code }); }
  catch (e) { thrown = e; res = { g3refused: (e && e.g3refused) || [] }; }
  for (const ref of res.g3refused) await sendOp({ type: "unpublish", name: ref.name });
  if (thrown) throw thrown;
  return res;
}
const epochChange = () => sendOp({ type: "epoch_change" });

function probeQuiet() {
  const d = s.snapshotDelta(version);
  if (d.fullRebuildRequired) throw new Error("probeQuiet hit a full rebuild (stale cursor)");
  version = d.version;
  return d.changedCells.length;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const sheet = s.addSheet("Bench", 1000);
  sheetIds.set("Bench", sheet);
  s.setFormula(sheet, 0, 2, "B1*2");      // C1 = B1*2
  s.setFormula(sheet, 0, 3, "B1+100");    // D1 = B1+100
  s.setFormula(sheet, 2, 3, "A3+B3+C3");  // D3
  s.setFormula(sheet, 4, 3, "A5+B5+C5");  // D5
  s.setFormula(sheet, 4, 5, "1+1");       // F5 — a user FORMULA (the G3 target)
  s.recalcDirty();
  version = s.snapshot().version;

  await ready;
  clearTimeout(readyTimer);
  if (fatal) throw fatal;

  // ===== B — first publish; same-cell hook QUIET (no double-fire) — through the REAL kernel =====
  let r = await execute('x = 0\nqb.publish("x", x, "Bench!B1", owner_cell_id="cellX")');
  assert(r.republishCount === 1, `B: expected 1 republish, got ${r.republishCount}`);
  assert(groundNum(sheet, 0, 1) === 0 && groundNum(sheet, 0, 2) === 0 && groundNum(sheet, 0, 3) === 100,
    `B: B1/C1/D1 expected 0/0/100`);

  // ===== C — reassign -> hook fires in the REAL kernel -> C1 AND D1 recompute (FAN-OUT) =====
  r = await execute("x = 7");
  assert(r.republishCount === 1, `C: expected 1 republish, got ${r.republishCount}`);
  assert(numAt(r.deltas[0].changedCells, 0, 2) === 14 && numAt(r.deltas[0].changedCells, 0, 3) === 107,
    `C: C1=14 AND D1=107 expected in delta (fan-out)`);
  assert(groundNum(sheet, 0, 1) === 7 && groundNum(sheet, 0, 2) === 14 && groundNum(sheet, 0, 3) === 107, `C: ground 7/14/107`);

  // ===== negatives — engine-quiet, verified INDEPENDENTLY, across the real kernel =====
  r = await execute("z = x + 1");
  assert(r.republishCount === 0 && probeQuiet() === 0, "neg-readonly: must be quiet");
  r = await execute("w = 99");
  assert(r.republishCount === 0 && probeQuiet() === 0, "neg-unrelated: must be quiet");
  r = await execute("x = 7");
  assert(r.republishCount === 0 && probeQuiet() === 0, "neg-samevalue: must be quiet");

  // ===== G — mutate-in-place (the 1b detector) across the real kernel =====
  r = await execute('vec = [10, 20, 30]\nqb.publish("vec", vec, "Bench!A3:C3", owner_cell_id="cellV")');
  assert(r.republishCount === 1 && groundNum(sheet, 2, 3) === 60, `G-publish: D3=60`);
  r = await execute("vec[1] = 99");
  assert(r.republishCount === 1 && numAt(r.deltas[0].changedCells, 2, 3) === 139 && groundNum(sheet, 2, 3) === 139, `G-mutate: D3=139`);

  // ===== H — DataFrame SHRINK blank-fill: the null-matrix survives kernel -> Comm -> host =====
  await execute("import pandas as pd");
  r = await execute('df = pd.DataFrame([[10.0, 20.0, 30.0]])\nqb.publish("df", df, "Bench!A5:C5", owner_cell_id="cellDF")');
  assert(groundNum(sheet, 4, 3) === 60, `H-publish: D5=60`);
  r = await execute("df = pd.DataFrame([[1.0, 2.0]])");
  assert(r.republishCount === 1 && r.frames[0].values[0][2] === null, `H-shrink: wire frame must carry null in vacated slot, got ${JSON.stringify(r.frames[0].values)}`);
  assert(numAt(r.deltas[0].changedCells, 4, 3) === 3 && groundNum(sheet, 4, 3) === 3 && isBlank(sheet, 4, 2), `H-shrink: D5=3 + C5 BLANK`);

  // ===== SEP — cell print() lands on fd1; the Comm republish stays on the control plane =====
  const beforeOut = kernelStdout.length;
  r = await execute('print("CELLOUT-MARKER-1C1")\nx = 11');
  assert(r.republishCount === 1 && numAt(r.deltas[0].changedCells, 0, 2) === 22, `SEP: C1=22`);
  await new Promise((res) => setTimeout(res, 50));
  const sepOut = kernelStdout.slice(beforeOut);
  assert(sepOut.some((l) => l.includes("CELLOUT-MARKER-1C1")), `SEP: print must reach fd1; got ${JSON.stringify(sepOut)}`);
  const CTRL = new Set(["ready", "republish", "stale", "executed", "epoch_done", "error", "closed"]);
  for (const l of sepOut) {
    let p = null; try { p = JSON.parse(l); } catch { /* plain output */ }
    assert(!(p && typeof p === "object" && CTRL.has(p.type)), `SEP: control frame leaked onto fd1: ${l}`);
  }

  // ===== FAIL — a raising cell is FATAL (surfaced), kernel survives =====
  let raised = null;
  try { await execute('raise RuntimeError("boom-1c1")'); } catch (e) { raised = e; }
  assert(raised && /boom-1c1/.test(raised.message), `FAIL: raising cell must surface as host error, got ${raised && raised.message}`);
  r = await execute("x = 12");
  assert(numAt(r.deltas[0].changedCells, 0, 2) === 24, `FAIL-recover: kernel survives; C1=24`);

  // ===== G1/G2 — kernel-side guard rejects propagate over the wire as FATAL =====
  await execute('qb.publish("dup", 5, "Bench!E1", owner_cell_id="cellDup")');
  let g1 = null;
  try { await execute('qb.publish("dup", 9, "Bench!E1", owner_cell_id="other")'); } catch (e) { g1 = e; }
  assert(g1 && /already published/.test(g1.message), `G1: duplicate reject must reach host, got ${g1 && g1.message}`);
  let g2 = null;
  try { await execute('qb.publish("rangeB", [9, 9], "Bench!A3:B3", owner_cell_id="cellB")'); } catch (e) { g2 = e; }
  assert(g2 && /overlaps/.test(g2.message), `G2: overlap reject must reach host, got ${g2 && g2.message}`);

  // ===== G3 (FOLD) — host refuses to overwrite a user FORMULA (F5) unless overwrite=True =====
  r = await execute('qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF")');
  assert(r.republishCount === 0 && r.g3refused.length === 1, `G3: host must REFUSE to clobber F5's formula, got refused=${JSON.stringify(r.g3refused)} republished=${r.republishCount}`);
  assert(s.cell(sheet, 4, 5).formula != null, `G3: F5 must still be a formula after the refusal`);
  // same name + owner + overwrite=True: G1 allows the same-owner re-run, G2 skips self, and the host
  // now applies (overwrite threaded) -> F5's formula is replaced with the value.
  r = await execute('qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF", overwrite=True)');
  assert(r.republishCount === 1 && r.g3refused.length === 0 && groundNum(sheet, 4, 5) === 0 && s.cell(sheet, 4, 5).formula == null,
    `G3: overwrite=True must replace F5's formula with 0, got republished=${r.republishCount} refused=${JSON.stringify(r.g3refused)} F5=${groundNum(sheet, 4, 5)}`);

  // ===== R7 (FOLD) — undo reverts the grid; force_check heals on the NEXT touch =====
  r = await execute("x = 8");
  assert(groundNum(sheet, 0, 1) === 8 && groundNum(sheet, 0, 2) === 16, `R7 setup: B1/C1=8/16`);
  // the host owns undo: revert the x=8 publish, recalc, resync the cursor past the epoch, then
  // signal the kernel (reverse control message) so it marks force_check. MED (Codex fold): only
  // drive the epoch path when the undo was actually CONSUMED -- a no-op undo (empty stack) must
  // not force a needless republish.
  const undoRes = s.undo();
  assert(undoRes.consumed === true, `R7: undo must be consumed (the x=8 publish was pending), got ${JSON.stringify(undoRes)}`);
  s.recalcDirty();
  version = s.snapshot().version;       // resync past the undo epoch (avoid a full-rebuild cursor)
  await epochChange();
  assert(groundNum(sheet, 0, 1) !== 8, `R7: undo must revert B1 away from the live var (got ${groundNum(sheet, 0, 1)})`);
  // an UNRELATED cell must NOT consume the force_check (it's "next TOUCHED var", not "next cell")
  r = await execute("u = 1");
  assert(r.republishCount === 0, `R7: an unrelated cell must not republish (force_check is next-touched), got ${r.republishCount}`);
  assert(groundNum(sheet, 0, 1) !== 8, `R7: an unrelated cell must not heal the grid`);
  // touching x heals: fingerprint unchanged (still 8) BUT force_check -> republish -> incremental delta
  r = await execute("y = x");
  assert(r.republishCount === 1, `R7: y=x must force a republish despite an unchanged fingerprint, got ${r.republishCount}`);
  assert(numAt(r.deltas[0].changedCells, 0, 2) === 16, `R7: heal must carry C1=16 in the INCREMENTAL delta`);
  assert(groundNum(sheet, 0, 1) === 8 && groundNum(sheet, 0, 2) === 16, `R7: force_check healed B1/C1 to 8/16`);
  r = await execute("z2 = x");   // force_check cleared -> a same-value touch is QUIET again
  assert(r.republishCount === 0, `R7: force_check must clear after the heal (a later same-value touch is quiet)`);

  // ===== 1c-2 RESEED (FOLD) — a kernel republish that LEGITIMATELY trips fullRebuild heals via reseed =====
  // No-stray-reseed invariant: every scenario so far rode the INCREMENTAL delta path. Prove it — a
  // reseed in any of them would be a cursor-threading bug the reseed could otherwise mask.
  assert(reseedTotal === 0, `RESEED: all 1c-1 scenarios must stay on the incremental path, got reseedTotal=${reseedTotal}`);
  // Make x live again on the incremental path (B1=5, C1=10).
  r = await execute("x = 5");
  assert(r.republishCount === 1 && r.reseedCount === 0 && groundNum(sheet, 0, 1) === 5 && groundNum(sheet, 0, 2) === 10,
    `RESEED setup: x=5 -> B1=5/C1=10 on the incremental path, got reseedCount=${r.reseedCount} B1=${groundNum(sheet, 0, 1)} C1=${groundNum(sheet, 0, 2)}`);
  // The host undoes that publish but — unlike R7 — deliberately does NOT resync its cursor. The undo
  // bumps the engine epoch, so the NEXT snapshotDelta on the now-stale (pre-undo) cursor token
  // epoch-mismatches and legitimately returns fullRebuildRequired: the signal the host must RESEED on.
  const undoReseed = s.undo();
  assert(undoReseed.consumed === true, `RESEED: undo of x=5 must be consumed, got ${JSON.stringify(undoReseed)}`);
  s.recalcDirty();
  // (intentionally NO `version = s.snapshot().version` here — that resync is exactly what R7 does to
  //  AVOID a full rebuild; omitting it is what makes the next delta legitimately full-rebuild.)
  await epochChange();                       // force_check every binding; the next touched var republishes
  assert(reseedTotal === 0, `RESEED: still no reseed before the trigger, got ${reseedTotal}`);
  // Touching x republishes (force_check) even though x's fingerprint is unchanged; applyRepublish then
  // hits the stale cursor -> fullRebuild -> RESEED (re-fetch full snapshot, re-thread the cursor).
  r = await execute("y2 = x");
  assert(r.republishCount === 1 && r.reseedCount === 1,
    `RESEED: the force_check republish must reseed on the legitimate fullRebuild, got republished=${r.republishCount} reseeded=${r.reseedCount}`);
  assert(reseedTotal === 1, `RESEED: exactly one reseed total, got ${reseedTotal}`);
  // The grid HEALED to x's current kernel value (5) even though the delta full-rebuilt.
  assert(groundNum(sheet, 0, 1) === 5 && groundNum(sheet, 0, 2) === 10,
    `RESEED: the grid must heal to x=5/C1=10 after the reseed, got B1=${groundNum(sheet, 0, 1)} C1=${groundNum(sheet, 0, 2)}`);
  // The cursor RECOVERED: the reseed re-threaded `version`, so a later quiet cell rides the incremental
  // delta again (the engine is NOT stuck full-rebuilding forever).
  r = await execute("q9 = 1");
  assert(r.republishCount === 0 && r.reseedCount === 0 && probeQuiet() === 0,
    `RESEED: cursor must recover -> incremental deltas work again after the reseed`);

  // ---- clean shutdown ----
  closing = true;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { closeResolve = closeReject = null; reject(new Error(`close timed out (sawClosed=${sawClosed}, sawCleanExit=${sawCleanExit})`)); }, CLOSE_TIMEOUT_MS);
    closeResolve = () => { clearTimeout(t); resolve(); };
    closeReject = (e) => { clearTimeout(t); reject(e); };
    child.stdin.write(JSON.stringify({ type: "close" }) + "\n");
  });

  console.log("[reactive-kernel-host-real 1c-2] PASS — acid #1 end-to-end through a REAL ipykernel (+ fullRebuild reseed)");
  console.log("  B/C   publish + reassign -> hook fires in the REAL kernel -> C1=14 AND D1=107 (fan-out)");
  console.log("  neg   z=x+1 / w=99 / x=7 -> 0 frames + independent snapshotDelta empty (engine-quiet ×3)");
  console.log("  G     vec[1]=99          -> mutate-in-place across the real kernel -> D3=139");
  console.log("  H     df 1x3->1x2 SHRINK -> blank-fill null-matrix survives kernel->Comm->host -> D5=3/C5 BLANK");
  console.log("  SEP   print + x=11       -> cell stdout on fd1, Comm republish on fd3 (separation, both ways)");
  console.log("  FAIL  raise              -> FATAL host error; kernel survives -> next cell republishes");
  console.log("  G1/G2 dup / overlap      -> kernel-side guard rejects propagate over the wire");
  console.log("  G3    publish over F5     -> host REFUSES (no clobber); overwrite=True replaces it (FOLD)");
  console.log("  R7    x=8; undo; u=1; y=x -> epoch force_check: u=1 no overfire; y=x heals C1=16 incrementally (FOLD)");
  console.log("  RES   x=5; undo (no resync); y2=x -> LEGITIMATE fullRebuild -> host RESEEDS -> grid heals; cursor recovers (1c-2 FOLD)");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(`[reactive-kernel-host-real 1c-2] FAIL: ${e && e.stack ? e.stack : e}`);
  await gracefulKill();  // tear the kernel down via the supervisor; never orphan the ipykernel
  process.exit(1);
});
