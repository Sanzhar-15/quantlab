// FE-1.5-1c-0 — the out-of-process reactive TRANSPORT proof: the Node HOST.
//
// FE-1.5-1.B proved `qb.publish` + the registry + the auto-republish hook + the v1 guards
// IN-PROCESS (embedded IPython + a pyo3 Session in one process, zero IPC). 1c-0 takes the
// SAME binding glue across a REAL process boundary, exactly the shipped grid topology:
//
//   Node host (THIS file, owns the napi WorkbookSession)
//        |  execute frames (kernel stdin)                 ^ republish frames (kernel fd 3)
//        v                                                |
//   Python kernel child (reactive_kernel_child.py = embedded IPython + the 1.B binding glue)
//
// The host is the SOLE engine writer (plan R8): it owns the napi Session AND the snapshotDelta
// cursor; the kernel only SIGNALS republish frames on a DEDICATED fd (3), never touching the
// engine. Two planes, never multiplexed (plan §11.4): fd 1 = the cell-output plane (a cell's
// print()), fd 3 = the control/republish plane (NDJSON the host applies). This is the FE-1.5-0
// `latency_node_host.mjs` host EXTENDED to also spawn + drive the kernel.
//
// Acceptance (command_exit_zero, headless): the 1a/1b reactive proof now across the process
// boundary — positives reactively recompute in snapshotDelta, negatives are engine-quiet
// (verified INDEPENDENTLY), the §13.3 DataFrame blank-fill null-matrix survives the wire, the
// stdout plane never corrupts fd 3, and every kernel/serialize/publish failure is FATAL (the
// `latency_node_host.mjs:86` catch->{error} swallow is gone). HIGH (1.B fold): every
// snapshotDelta asserts NOT fullRebuildRequired — a stale/epoch-mismatched cursor fails LOUD.
//
// Run (Mac host): see the run block in current_work.md — node + QL_NODE_CDYLIB (dylib) +
// QL_KERNEL_PYTHON ($HOME/.fe15-spike-venv/bin/python3.12, has IPython + pandas + numpy).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");
const CELL_TIMEOUT_MS = 15000;

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) return process.env.QL_NODE_CDYLIB;
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const base = `libql_bindings_node.${ext}`;
  for (const sub of ["release", "debug"]) {
    const p = path.join(workspaceRoot, "target", sub, base);
    if (existsSync(p)) return p;
  }
  throw new Error("built cdylib not found — run `cargo build -p ql-bindings-node --release`");
}

function resolveKernelPython() {
  if (process.env.QL_KERNEL_PYTHON) return process.env.QL_KERNEL_PYTHON;
  const venv = path.join(process.env.HOME || "", ".fe15-spike-venv", "bin", "python3.12");
  if (existsSync(venv)) return venv;
  return "python3.12";
}

const KERNEL_SCRIPT = path.join(
  workspaceRoot, "crates", "quantbook-py", "tests", "reactive_kernel_child.py"
);

// ---------------------------------------------------------------------------
// napi Session — owned HERE, the sole engine writer; the cursor lives HERE.
// ---------------------------------------------------------------------------
const mod = { exports: {} };
process.dlopen(mod, resolveCdylib());
const { Session } = mod.exports;
const s = new Session();
const sheetIds = new Map(); // name -> id
let version = null;

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
// "Bench!A5:C5" -> the napi CellRange (sheet RESOLVED to its id — the host owns the Session).
function resolveTarget(a1) {
  const bang = a1.indexOf("!");
  if (bang < 0) throw new Error(`target must be sheet-qualified: ${a1}`);
  const name = a1.slice(0, bang);
  const ref = a1.slice(bang + 1);
  if (!sheetIds.has(name)) throw new Error(`unknown sheet in target: ${name}`);
  const sheet = sheetIds.get(name);
  let a, b;
  if (ref.includes(":")) {
    const [x, y] = ref.split(":", 2);
    a = a1Cell(x); b = a1Cell(y);
  } else {
    a = a1Cell(ref); b = a;
  }
  return { sheet, startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
}

// Apply ONE republish frame from the kernel: publishDataset + recalcDirty + snapshotDelta.
// No-Fallbacks: a publish/serialize error propagates (no catch->{error}); a fullRebuild is FATAL.
function applyRepublish(frame) {
  const range = resolveTarget(frame.target);
  s.publishDataset(frame.name, JSON.stringify({ values: frame.values }), range);
  s.recalcDirty();
  const d = s.snapshotDelta(version);
  if (d.fullRebuildRequired) {
    // HIGH (1.B fold): a fullRebuild means the cursor went stale/epoch-mismatched -> a
    // delta that came from a full rebuild, not the republish, would SILENTLY mask a missing
    // reactive recompute. Fail LOUD. (1c forward-note: 1d adds a host-level recovery path for
    // LEGITIMATE epoch/stale-horizon rebuilds; this binding-local guard must not ship as-is.)
    throw new Error(
      `snapshotDelta required a FULL REBUILD (reason=${frame.name}/${d.fullRebuildReason}) — ` +
      `the incremental reactive delta cannot be trusted; cursor not threaded correctly`
    );
  }
  version = d.version;
  return d;
}

function numAt(changedCells, row, col) {
  for (const cc of changedCells) {
    const c = cc.cell;
    if (c && c.row === row && c.col === col) return c.value ? c.value.number : null;
  }
  return null;
}
function groundNum(sheet, row, col) {
  const c = s.cell(sheet, row, col);
  if (!c) return null;
  return c.value ? c.value.number : null;
}
function isBlank(sheet, row, col) {
  const c = s.cell(sheet, row, col);
  if (!c) return true;
  return !c.value || c.value.kind === "blank";
}

// ---------------------------------------------------------------------------
// Kernel child — spawned with a 4th fd (3) for the control/republish plane.
// ---------------------------------------------------------------------------
const READY_TIMEOUT_MS = 10000;
const CLOSE_TIMEOUT_MS = 3000;
const kernelStdout = []; // the cell-output plane (fd 1) — proves channel separation
let pending = null;      // the in-flight execute's collector
let readyDone = false;
let readyResolve, readyReject;
const ready = new Promise((res, rej) => {
  readyResolve = () => { readyDone = true; res(); };
  readyReject = (e) => { readyDone = true; rej(e); };
});
let closeResolve = null, closeReject = null, closing = false;
let sawClosed = false, sawCleanExit = false;
let fatal = null;

// LOW-1 (re-audit fold): a clean shutdown requires BOTH a `closed` frame AND a clean child exit
// (code 0, no signal). Resolve only when both have happened; a dirty/missing-close exit rejects.
function maybeFinishClose() {
  if (sawClosed && sawCleanExit && closeResolve) {
    const r = closeResolve; closeResolve = closeReject = null; r();
  }
}

// MED-1/MED-2 (1c-0 Codex fold): the SINGLE fatal path. No-Fallbacks: any protocol violation
// (a stray/duplicate/unexpected control frame, malformed JSON, an unexpected child exit, a
// spawn error) must reject EVERY waiter — the in-flight cell, the ready handshake, AND the
// close — never silently drop a frame (which could mask a leaked republish so a "quiet"
// negative falsely passes) and never hang a waiter that no future frame will ever resolve.
function failProtocol(err) {
  if (!fatal) fatal = err;
  if (!readyDone) readyReject(err);
  if (pending) { const p = pending; pending = null; p.reject(err); }
  if (closeReject) { const r = closeReject; closeReject = closeResolve = null; r(err); }
  try { child.kill("SIGKILL"); } catch { /* already dead */ }
}

// `-u` = unbuffered stdio: the cell's print() reaches fd 1 immediately (SEP check) and the
// child's stdin readline() doesn't read-ahead-buffer (request/response, no deadlock).
const child = spawn(resolveKernelPython(), ["-u", KERNEL_SCRIPT], {
  // [0] stdin: host->kernel execute   [1] stdout: cell print plane (host captures it)
  // [2] stderr: kernel diagnostics -> host stderr   [3] control/republish plane (host reads)
  stdio: ["pipe", "pipe", "inherit", "pipe"],
});

const readyTimer = setTimeout(() => {
  if (!readyDone) failProtocol(new Error(`kernel did not send 'ready' within ${READY_TIMEOUT_MS}ms`));
}, READY_TIMEOUT_MS);

child.on("error", (e) => failProtocol(new Error(`kernel spawn failed: ${e.message}`)));
child.on("exit", (code, sig) => {
  if (closing) {
    if (code === 0 && sig == null) { sawCleanExit = true; maybeFinishClose(); }
    else if (closeReject) { const r = closeReject; closeResolve = closeReject = null; r(new Error(`kernel exited dirty during close (code=${code}, signal=${sig})`)); }
    return;
  }
  // A kernel that dies before `close` (or mid-cell) is a FATAL host error, never a hang.
  failProtocol(new Error(`kernel exited unexpectedly (code=${code}, signal=${sig})`));
});

readline.createInterface({ input: child.stdout }).on("line", (l) => { if (l) kernelStdout.push(l); });

const ctrl = readline.createInterface({ input: child.stdio[3] });
ctrl.on("line", (line) => {
  if (fatal) return;
  // MED-1 (re-audit fold): an EMPTY control line is itself a protocol violation (the kernel
  // only ever writes json+newline) — fail loud, don't silently drop it.
  if (line === "") { failProtocol(new Error("empty control frame")); return; }
  let f;
  try { f = JSON.parse(line); } catch (e) { failProtocol(new Error(`malformed control frame: ${line}`)); return; }
  switch (f.type) {
    case "ready":
      if (readyDone) { failProtocol(new Error("duplicate 'ready' frame")); break; }
      readyResolve();
      break;
    case "republish": {
      if (!pending) { failProtocol(new Error(`stray 'republish' frame (no in-flight cell): ${f.name}`)); break; }
      try {
        pending.frames.push(f);                 // the RAW wire frame (proves what crossed fd 3)
        pending.deltas.push(applyRepublish(f));
        pending.republishCount++;
      } catch (e) { const p = pending; pending = null; p.reject(e); }
      break;
    }
    case "stale":
      if (!pending) { failProtocol(new Error(`stray 'stale' frame: ${f.name}`)); break; }
      pending.staleNames.push(f.name);
      break;
    case "executed": {
      if (!pending) { failProtocol(new Error("stray 'executed' frame (no in-flight cell)")); break; }
      const p = pending; pending = null;
      p.resolve({ deltas: p.deltas, frames: p.frames, republishCount: p.republishCount, staleNames: p.staleNames });
      break;
    }
    case "error": {
      // A cell/glue error is fatal to the in-flight cell; with no pending cell it's a protocol error.
      if (pending) { const p = pending; pending = null; p.reject(new Error(`KERNEL ERROR: ${f.error}`)); }
      else failProtocol(new Error(`KERNEL ERROR (no pending cell): ${f.error}`));
      break;
    }
    case "closed":
      if (!closing) { failProtocol(new Error("unexpected 'closed' frame")); break; }
      sawClosed = true; maybeFinishClose();  // resolves only once the clean exit ALSO arrives
      break;
    default:
      failProtocol(new Error(`unknown control frame type: ${f.type}`));
  }
});

function execute(code) {
  if (fatal) return Promise.reject(fatal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { if (pending) { pending = null; reject(new Error(`cell timed out (${CELL_TIMEOUT_MS}ms): ${code}`)); } },
      CELL_TIMEOUT_MS,
    );
    pending = {
      deltas: [], frames: [], republishCount: 0, staleNames: [],
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    child.stdin.write(JSON.stringify({ type: "execute", code }) + "\n");
  });
}

// snapshotDelta with NOTHING applied — the INDEPENDENT engine-quiet probe (1a/1b discipline:
// prove quiet independently, not just "no frame arrived"). Returns the changedCells count.
function probeQuiet() {
  const d = s.snapshotDelta(version);
  if (d.fullRebuildRequired) throw new Error("probeQuiet hit a full rebuild (stale cursor)");
  version = d.version;
  return d.changedCells.length;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  // ---- setup: the FE-1.5-0 dependent-formula shape ----
  const sheet = s.addSheet("Bench", 1000);
  sheetIds.set("Bench", sheet);
  s.setFormula(sheet, 0, 2, "B1*2");      // C1 = B1*2    (scalar fan-out dep)
  s.setFormula(sheet, 0, 3, "B1+100");    // D1 = B1+100  (2nd fan-out dep)
  s.setFormula(sheet, 2, 3, "A3+B3+C3");  // D3 = A3+B3+C3 (vector / mutate-in-place dep)
  s.setFormula(sheet, 4, 3, "A5+B5+C5");  // D5 = A5+B5+C5 (DataFrame blank-fill dep)
  s.recalcDirty();
  version = s.snapshot().version; // seed the cursor AFTER setup recalc (host-side)

  await ready; // loud handshake — a kernel that can't import IPython fails here, not by hanging
  clearTimeout(readyTimer);
  if (fatal) throw fatal;

  // ===== B — first publish writes the cell; the SAME-cell hook is QUIET (no double-fire) =====
  let r = await execute('x = 0\nqb.publish("x", x, "Bench!B1", owner_cell_id="cellX")');
  assert(r.republishCount === 1,
    `B: expected exactly 1 republish frame (explicit publish; hook quiet), got ${r.republishCount}`);
  assert(groundNum(sheet, 0, 1) === 0, `B: B1 expected 0, got ${groundNum(sheet, 0, 1)}`);
  assert(groundNum(sheet, 0, 2) === 0 && groundNum(sheet, 0, 3) === 100,
    `B: C1/D1 expected 0/100, got ${groundNum(sheet, 0, 2)}/${groundNum(sheet, 0, 3)}`);

  // ===== C — reassign x -> hook auto-republishes -> C1 AND D1 reactively recompute (FAN-OUT) =====
  r = await execute("x = 7");
  assert(r.republishCount === 1, `C: expected 1 republish frame, got ${r.republishCount}`);
  const cDelta = r.deltas[0].changedCells;
  assert(numAt(cDelta, 0, 2) === 14, `C: C1=14 expected in delta, got ${numAt(cDelta, 0, 2)}`);
  assert(numAt(cDelta, 0, 3) === 107, `C: D1=107 expected in delta (fan-out), got ${numAt(cDelta, 0, 3)}`);
  assert(groundNum(sheet, 0, 1) === 7 && groundNum(sheet, 0, 2) === 14 && groundNum(sheet, 0, 3) === 107,
    `C: ground B1/C1/D1 expected 7/14/107`);

  // ===== negatives — engine-quiet across the boundary, verified INDEPENDENTLY =====
  r = await execute("z = x + 1");        // read-only ref: fingerprint unchanged -> no frame
  assert(r.republishCount === 0, `neg-readonly: expected 0 frames, got ${r.republishCount}`);
  assert(probeQuiet() === 0, "neg-readonly: independent snapshotDelta must be empty (engine-quiet)");
  r = await execute("w = 99");           // unrelated var: not a registered name -> no frame
  assert(r.republishCount === 0, `neg-unrelated: expected 0 frames, got ${r.republishCount}`);
  assert(probeQuiet() === 0, "neg-unrelated: independent snapshotDelta must be empty");
  r = await execute("x = 7");            // same value: fingerprint unchanged -> no frame
  assert(r.republishCount === 0, `neg-samevalue: expected 0 frames, got ${r.republishCount}`);
  assert(probeQuiet() === 0, "neg-samevalue: independent snapshotDelta must be empty");

  // ===== G — vector publish + mutate-in-place (the 1b detector across the boundary) =====
  r = await execute('vec = [10, 20, 30]\nqb.publish("vec", vec, "Bench!A3:C3", owner_cell_id="cellV")');
  assert(r.republishCount === 1, `G-publish: expected 1 frame, got ${r.republishCount}`);
  assert(groundNum(sheet, 2, 3) === 60, `G-publish: D3 expected 60, got ${groundNum(sheet, 2, 3)}`);
  r = await execute("vec[1] = 99");      // mutate-in-place: defs empty, vec a ref, fingerprint changed
  assert(r.republishCount === 1, `G-mutate: expected 1 frame, got ${r.republishCount}`);
  assert(numAt(r.deltas[0].changedCells, 2, 3) === 139 && groundNum(sheet, 2, 3) === 139,
    `G-mutate: D3 expected 139 (10+99+30), got delta=${numAt(r.deltas[0].changedCells, 2, 3)} ground=${groundNum(sheet, 2, 3)}`);

  // ===== H — DataFrame SHRINK blank-fill: the null-matrix must survive the WIRE =====
  await execute("import pandas as pd");
  r = await execute('df = pd.DataFrame([[10.0, 20.0, 30.0]])\nqb.publish("df", df, "Bench!A5:C5", owner_cell_id="cellDF")');
  assert(groundNum(sheet, 4, 3) === 60, `H-publish: D5 expected 60, got ${groundNum(sheet, 4, 3)}`);
  r = await execute("df = pd.DataFrame([[1.0, 2.0]])");  // SHRINKS 1x3 -> 1x2
  assert(r.republishCount === 1, `H-shrink: expected 1 frame, got ${r.republishCount}`);
  // ADVERSARIAL (1.B framing): the RAW frame that crossed fd 3 must literally carry `null` in the
  // vacated [0][2] slot — that null is what makes C5 Blank and D5=3 instead of the STALE 33 a
  // naive publish (writing only A5,B5, leaving C5=30) would yield. So D5===3 (not 33) proves the
  // blank-fill is load-bearing AND survived JSON serialization over the wire.
  assert(r.frames[0].values[0][2] === null,
    `H-shrink: the wire frame must carry null in the vacated slot (blank-fill over fd 3), got ${JSON.stringify(r.frames[0].values)}`);
  assert(numAt(r.deltas[0].changedCells, 4, 3) === 3 && groundNum(sheet, 4, 3) === 3,
    `H-shrink (blank-fill): D5 expected 3 (1+2+blank), got delta=${numAt(r.deltas[0].changedCells, 4, 3)} ground=${groundNum(sheet, 4, 3)}`);
  assert(isBlank(sheet, 4, 2), `H-shrink: C5 expected a BLANK cell after shrink, got ${JSON.stringify(s.cell(sheet, 4, 2))}`);

  // ===== SEP — the stdout plane (fd 1) must NOT corrupt the republish plane (fd 3) =====
  const beforeOut = kernelStdout.length;
  r = await execute('print("STDOUT-MARKER-7C0")\nx = 11');  // prints AND triggers a republish
  assert(r.republishCount === 1, `SEP: expected 1 clean republish frame despite stdout print, got ${r.republishCount}`);
  assert(numAt(r.deltas[0].changedCells, 0, 2) === 22, `SEP: C1=22 expected (x=11), got ${numAt(r.deltas[0].changedCells, 0, 2)}`);
  // give the stdout readline a tick to flush the captured line, then assert it landed on fd 1.
  await new Promise((res) => setTimeout(res, 50));
  const sepOut = kernelStdout.slice(beforeOut);
  assert(sepOut.some((l) => l.includes("STDOUT-MARKER-7C0")),
    `SEP: the cell's print must land on the stdout plane (fd 1); captured: ${JSON.stringify(sepOut)}`);
  // LOW-2 (1c-0 Codex fold): also prove the converse — NO control frame leaked onto stdout (a
  // broken impl that duplicated control JSON onto both planes would otherwise pass the line above).
  const CTRL_TYPES = new Set(["ready", "republish", "stale", "executed", "error", "closed"]);
  for (const l of sepOut) {
    let parsed = null;
    try { parsed = JSON.parse(l); } catch { /* plain cell output, not a frame */ }
    assert(!(parsed && typeof parsed === "object" && CTRL_TYPES.has(parsed.type)),
      `SEP: a control frame leaked onto the stdout plane (planes multiplexed): ${l}`);
  }

  // ===== FAIL — No-Fallbacks transport: a kernel error is FATAL, never a silent skip =====
  let raised = null;
  try { await execute('raise RuntimeError("boom-7c0")'); } catch (e) { raised = e; }
  assert(raised && /boom-7c0/.test(raised.message),
    `FAIL: a raising cell must surface as a FATAL host error (not swallowed), got ${raised && raised.message}`);
  // the kernel survives a cell error (it's the CELL that failed, not the kernel) — prove it still runs.
  r = await execute("x = 12");
  assert(numAt(r.deltas[0].changedCells, 0, 2) === 24, `FAIL-recover: kernel must survive a cell error; C1=24 expected`);

  // ===== G1/G2 — a kernel-side guard rejection propagates over the wire as FATAL =====
  await execute('qb.publish("dup", 5, "Bench!E1", owner_cell_id="cellDup")');
  let g1 = null;
  try { await execute('qb.publish("dup", 9, "Bench!E1", owner_cell_id="other")'); } catch (e) { g1 = e; }
  assert(g1 && /already published/.test(g1.message), `G1: duplicate-name reject must reach the host, got ${g1 && g1.message}`);
  let g2 = null;
  try { await execute('qb.publish("rangeB", [9, 9], "Bench!A3:B3", owner_cell_id="cellB")'); } catch (e) { g2 = e; }
  assert(g2 && /overlaps/.test(g2.message), `G2: overlap reject must reach the host, got ${g2 && g2.message}`);

  // ---- clean shutdown ----
  // LOW-1 (1c-0 Codex fold): require an explicit `closed` frame (+ a clean child exit). A
  // timeout REJECTS (fail-loud) rather than resolving — a close-protocol failure must not be
  // hidden behind a "teardown passed" timer.
  closing = true;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      closeResolve = closeReject = null;
      reject(new Error(`close timed out within ${CLOSE_TIMEOUT_MS}ms (sawClosed=${sawClosed}, sawCleanExit=${sawCleanExit})`));
    }, CLOSE_TIMEOUT_MS);
    closeResolve = () => { clearTimeout(t); resolve(); };
    closeReject = (e) => { clearTimeout(t); reject(e); };
    child.stdin.write(JSON.stringify({ type: "close" }) + "\n");
  });

  console.log("[reactive-kernel-host 1c-0] PASS — out-of-process reactive transport across a real process boundary");
  console.log("  B   publish x=0        -> 1 frame; same-cell hook QUIET (no double-fire over the wire)");
  console.log("  C   x=7                -> auto-republish frame -> C1=14 AND D1=107 (fan-out) in the delta");
  console.log("  neg z=x+1 / w=99 / x=7 -> 0 frames; independent snapshotDelta empty (engine-quiet, 3 ways)");
  console.log("  G   vec / vec[1]=99    -> mutate-in-place frame across the boundary -> D3=139");
  console.log("  H   df 1x3->1x2 SHRINK -> blank-fill null-matrix survives the WIRE -> D5=3 + C5 BLANK");
  console.log("  SEP print + x=11       -> stdout plane (fd1) does NOT corrupt the republish plane (fd3)");
  console.log("  FAIL raise             -> FATAL host error (no catch->{error} swallow); kernel survives");
  console.log("  G1/G2 dup / overlap    -> kernel-side guard rejection propagates over the wire as FATAL");
  console.log("  HIGH every snapshotDelta asserts NOT fullRebuildRequired (stale cursor fails loud)");
  process.exit(0);
}

main().catch((e) => {
  console.error(`[reactive-kernel-host 1c-0] FAIL: ${e && e.stack ? e.stack : e}`);
  try { child.kill("SIGKILL"); } catch { /* already dead */ }
  process.exit(1);
});
