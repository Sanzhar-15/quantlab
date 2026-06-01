// Phase 6.3-4 — the Node (napi) row of the golden parity matrix.
//
// Runs the canonical golden flow (entry-plan 6.3 §6) through the napi `Session`
// and emits a CANONICAL JSON transcript (an ordered list of step records) to
// stdout, in the SAME shape as `crates/quantbook-py/tests/golden_flow.py`. The
// comparator `parity_matrix.py` runs both rows and asserts the transcripts match
// (masking engine-internal opaque ids / version tokens). This is the FOCUSED
// cross-binding emitter; `smoke_session.mjs` remains the Node-only deep smoke.
//
// Run (from the engine workspace root, via the Mac bridge):
//   cargo build -p ql-bindings-node
//   node crates/ql-bindings-node/tests/golden_flow.mjs
//
// Override the cdylib path with QL_NODE_CDYLIB=/abs/path/to/lib....{dylib,so}.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) {
    const p = process.env.QL_NODE_CDYLIB;
    if (!existsSync(p)) throw new Error(`QL_NODE_CDYLIB does not exist: ${p}`);
    return p;
  }
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const base = `libql_bindings_node.${ext}`;
  const candidates = [
    path.join(workspaceRoot, "target", "debug", base),
    path.join(workspaceRoot, "target", "release", base),
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(
      `built cdylib not found. Run \`cargo build -p ql-bindings-node\` first.\n` +
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

// Recover the engine code from a thrown napi error. Two channels exist:
//   - Engine-taxonomy errors (`throw_structured`) carry a real native `.code`
//     (e.g. "sheet_name_duplicate") and a message with NO `[code]` prefix.
//   - FFI arg-validation (`bad_argument_error`) throws a plain napi `Error` whose
//     `.code` is napi's default Status ("GenericFailure") and whose real engine
//     code lives in the `[bad_argument] ...` MESSAGE PREFIX.
// **LOW-1 (6.3-5):** prefer the NATIVE `.code` FIRST, then fall back to the
// `[code]`-message-prefix regex — matching the Python row's `_err_code` (which
// reads the native `.code` first). The native `.code` is only meaningful for the
// structured-throw path (a generic napi Status like "GenericFailure" is NOT a
// stable engine code, so it is skipped and the prefix is used instead).
function errCode(e) {
  if (e && typeof e.code === "string" && e.code !== "GenericFailure") return e.code;
  if (e instanceof Error && e.message.startsWith("[")) {
    const end = e.message.indexOf("]");
    if (end > 0) return e.message.slice(1, end);
  }
  if (e && typeof e.code === "string") return e.code;
  return "<no-code>";
}

function run(native) {
  const { Session } = native;
  const out = [];
  const rec = (step, extra) => out.push({ step, ...extra });
  const expectErr = (step, fn) => {
    try {
      fn();
      out.push({ step, error: "<did-not-throw>" });
    } catch (e) {
      out.push({ step, error: { code: errCode(e) } });
    }
  };

  const s = new Session();
  rec("lifecycle_initial", { value: s.lifecycleState() });

  // --- new sheet + edits ---
  const sh = s.addSheet("Sheet1", 1000);
  rec("add_sheet", { value: sh });
  s.setValue(sh, 0, 0, { kind: "number", number: 10 }); // A1 = 10
  s.setFormula(sh, 0, 1, "A1+1"); // B1 = A1+1
  // HIGH-A step 4 (6.3-5): the FIRST recalc op id is deterministically `1`
  // (engine `next_op_id` starts at 1) across both fresh sessions, so it is a
  // DETERMINISTIC, UNMASKED u64 witness. Post-fix BOTH bindings emit the decimal
  // STRING "1" (napi BigInt → quoted decimal in stableStringify; pyo3 now returns
  // a decimal string too); PRE-fix Python emitted the JSON number `1` → a
  // divergence. The masked-`<opid>` form below keeps the original presence signal.
  const firstRecalcOp = s.recalcDirty();
  rec("recalc_op_id", { value: firstRecalcOp });
  rec("recalc", { value: firstRecalcOp != null ? "<opid>" : null });
  rec("b1_value", { value: s.cell(sh, 0, 1).value });

  // --- snapshot ---
  const snap = s.snapshot();
  rec("snapshot", { sheets: snap.sheets.length, schemaVersion: snap.schemaVersion });

  // --- snapshot_delta: incremental (setValue does NOT bump the epoch) ---
  const vBefore = s.snapshot().version;
  s.setValue(sh, 5, 5, { kind: "number", number: 77 }); // F6 = 77
  s.recalcDirty();
  const delta = s.snapshotDelta(vBefore);
  const hit = delta.changedCells.find(
    (c) => c.sheet === sh && c.cell.row === 5 && c.cell.col === 5,
  );
  // Audit MED-1: pin schemaVersion + the changed-cell coordinate (not just the
  // value) so the delta-surface DTO is cross-checked, not only its presence.
  rec("delta_after_edit", {
    fullRebuildRequired: delta.fullRebuildRequired,
    schemaVersion: delta.schemaVersion,
    hitCoord: hit ? [hit.cell.row, hit.cell.col] : null,
    changedHit: hit ? hit.cell.value : null,
  });

  // --- snapshot_delta: empty token -> full rebuild (not an error) ---
  const fr = s.snapshotDelta(Buffer.alloc(0));
  rec("delta_empty_token", {
    fullRebuildRequired: fr.fullRebuildRequired,
    reason: fr.fullRebuildReason ?? null,
  });

  // --- table (observed via a structured-reference formula) ---
  const ts = s.addSheet("TblSheet", 1000);
  s.setValue(ts, 0, 0, { kind: "text", text: "Qty" }); // header A1
  s.setValue(ts, 1, 0, { kind: "number", number: 10 }); // A2
  s.setValue(ts, 2, 0, { kind: "number", number: 20 }); // A3
  s.createTable({
    name: "Sales",
    sheet: ts,
    topRow: 0,
    topCol: 0,
    rows: 3,
    cols: 1,
    hasHeader: true,
    hasTotals: false,
    columnNames: ["Qty"],
  });
  s.setFormula(ts, 0, 2, "SUM(Sales[Qty])"); // C1 on TblSheet
  s.recalcDirty();
  rec("table_sum", { value: s.cell(ts, 0, 2).value });

  // --- batch (atomic, observable) ---
  const res = s.batch(
    [
      { kind: "setValue", sheet: sh, row: 0, col: 2, value: { kind: "number", number: 5 } }, // C1=5
      { kind: "setFormula", sheet: sh, row: 0, col: 3, text: "C1*2" }, // D1=C1*2
      // setFormat op (builtin 0 = General) -- exercises the format_id input
      // converter cross-binding; applied becomes 3.
      { kind: "setFormat", sheet: sh, row: 0, col: 4, format: { kind: "builtin", builtin: 0 } },
    ],
    {},
  );
  s.recalcDirty();
  rec("batch_applied", { value: res.applied });
  rec("batch_d1", { value: s.cell(sh, 0, 3).value });

  // --- undo / redo (observable) ---
  rec("can_undo_before", { value: s.canUndo() });
  const u = s.undo();
  s.recalcDirty();
  rec("undo", { consumed: u.consumed, c1: s.cell(sh, 0, 2) }); // C1 reverted -> null
  const r = s.redo();
  s.recalcDirty();
  const c1 = s.cell(sh, 0, 2);
  rec("redo", { consumed: r.consumed, c1: c1 ? c1.value : null });

  // --- persistence: save -> open in a fresh session -> value survives ---
  const saveDir = mkdtempSync(path.join(tmpdir(), "qbnode_golden_save_"));
  const savePath = path.join(saveDir, "golden.qbook");
  s.save(savePath);
  const s2 = new Session();
  s2.open(savePath);
  s2.recalcDirty();
  rec("persist_a1", { value: s2.cell(sh, 0, 0).value }); // A1 == 10 survives

  // --- function registration ---
  const meta = {
    canonicalName: "MYUDF",
    aliases: [],
    arity: { kind: "variadic" },
    volatility: "pure",
    determinism: true,
    depShape: "value_deps",
    batchShape: "array_batch",
    argPolicy: "strict",
    cancellation: "cooperative",
    argContext: "scalar",
    provenanceTags: [],
  };
  s.registerFunction(meta, 1n);
  const fns = s.listFunctions();
  // MED-4 (6.3-5): record the FULL metadata DTO of the registered "MYUDF" entry
  // (every field listFunctions returns) so the parity comparator field-checks the
  // whole FunctionMetadata cross-binding, not just presence + count. Keys are
  // sorted by the comparator's canonical stringify.
  const myudf = fns.find((f) => f.canonicalName === "MYUDF") ?? null;
  rec("register_udf", {
    present: myudf != null,
    total: fns.length,
    metadata: myudf,
  });

  // --- events: poll from cursor 0 (>=1 event after the recalcs) ---
  // Audit MED-2: pin the SORTED-UNIQUE event kinds (order-independent) so the
  // event tagged-union DTO mapping is cross-checked, not only the count.
  const page = s.pollEvents(0n);
  rec("poll_events", {
    count: page.events.length,
    dropped: page.dropped,
    kinds: [...new Set(page.events.map((e) => e.kind))].sort(),
  });

  // --- writeRange (§3.5; 6.5-0 substrate): bulk-write a 1x2 range ---
  const wr = s.writeRange(
    { sheet: sh, startRow: 20, startCol: 0, endRow: 20, endCol: 1 },
    [[{ kind: "number", number: 10 }, { kind: "number", number: 20 }]],
  );
  rec("write_range", { written: wr.written });

  // --- materializeQuery (§3.5; 6.5-1 substrate): SELECT 1 -> cell (sh, 20, 2) ---
  const mq = s.materializeQuery(
    "q1",
    { sheet: sh, startRow: 20, startCol: 2, endRow: 20, endCol: 2 },
    '{"sql":"SELECT 1 AS a"}',
  );
  rec("materialize_query", { id: mq.id });

  // --- refreshSource (§3.5): re-run q1 at revision 1; no formula dependents -> dirtied=0 ---
  const rs = s.refreshSource("q1", 1n);
  rec("refresh_source", { dirtied: rs.dirtied });

  // --- deliberate panic on a SEPARATE session: surfaces, does NOT abort ---
  const p = new Session();
  if (typeof p.__forcePanicForTest === "function") {
    try {
      p.__forcePanicForTest();
      rec("panic", { error: "<did-not-throw>" });
    } catch (e) {
      rec("panic", { error: { code: errCode(e) } });
    }
    rec("after_panic_lifecycle", { value: p.lifecycleState() });
  } else {
    rec("panic", { error: { code: "panic" }, note: "probe-absent-release" });
    rec("after_panic_lifecycle", { value: p.lifecycleState() });
  }

  // --- error-path rows (stable codes) ---
  expectErr("err_dup_sheet", () => s.addSheet("Sheet1", 1000));
  expectErr("err_bad_kind", () => s.setValue(sh, 9, 9, { kind: "bogus" }));
  expectErr("err_register_builtin", () => s.registerFunction({ ...meta, canonicalName: "SUM" }, 2n));

  // post-close: a command on a Closed session -> invalid_state (do this LAST)
  s.close();
  expectErr("err_post_close", () => s.cell(sh, 0, 0));

  return out;
}

const native = loadNative(resolveCdylib());
const transcript = run(native);
// Canonical, key-sorted, compact JSON (matches the Python emitter's dump opts).
process.stdout.write(stableStringify(transcript) + "\n");

// JSON.stringify does NOT sort object keys; emit a key-sorted canonical form so
// the byte-for-byte comparison in parity_matrix.py is order-independent.
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  // A napi BigInt (e.g. a future custom-format `customPeer`, or an op id) is not
  // JSON-serializable by default -- render it as its decimal string so the Node
  // emitter never throws, and the Python row (which emits a plain int) compares
  // after json.dumps coerces its int the same way. (Audit 6.3-4 MED-1.)
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
