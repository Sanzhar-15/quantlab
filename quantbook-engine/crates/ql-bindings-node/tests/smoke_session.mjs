// Phase 6.1B inc.2d — engine-side cdylib smoke for the owning `WorkbookSession`
// over napi (the `Session` class). This is the RUNNABLE FFI proof that the
// product single-writer session drives an edit → recalc → snapshot loop across
// the napi boundary — not just that the crate compiles. The IDE-side mocha
// integration test (driving the same `Session` class through loader.ts) is the
// cross-repo follow-up; this script needs only plain Node + the built cdylib.
//
// Run (from the engine workspace root, via the Mac bridge):
//   cargo build -p ql-bindings-node
//   node crates/ql-bindings-node/tests/smoke_session.mjs
//
// Override the cdylib path with QL_NODE_CDYLIB=/abs/path/to/lib....{dylib,so}.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// crates/ql-bindings-node/tests → ../../.. = the cargo workspace root.
const workspaceRoot = path.resolve(here, "../../..");

// Resolve the built cdylib. On macOS the cdylib is `libql_bindings_node.dylib`;
// on Linux `.so`. Prefer an explicit override, then debug, then release.
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

// Load a napi-rs cdylib the same way Node loads a `.node` addon: hand a fresh
// module object to process.dlopen so the addon's napi_register_module populates
// `module.exports`. (No package.json / `.node` rename needed.)
function loadNative(cdylibPath) {
  const mod = { exports: {} };
  process.dlopen(mod, cdylibPath);
  return mod.exports;
}

const cdylibPath = resolveCdylib();
console.log(`[smoke] loading cdylib: ${cdylibPath}`);
const native = loadNative(cdylibPath);

assert.ok(native.Session, "the native module must export the `Session` class");
const { Session } = native;

// **6.3-1c (2026-05-30):** assert a thrown error reports the given engine `code`,
// accepting EITHER a native `.code` own-property (engine-taxonomy errors -- the
// structured reshape delivers code/class/details/retryable as data) OR a legacy
// `[code]`-prefix message (FFI bad_argument validation + collab errors, which
// stay prefix-encoded). Mirrors the IDE's parseQuantbookError dual-read, so the
// smoke is correct regardless of which channel an error took.
function throwsWithCode(fn, code, msg) {
  assert.throws(
    fn,
    (e) => {
      const native = typeof e?.code === "string" && e.code === code;
      const prefixed = e instanceof Error && e.message.startsWith(`[${code}]`);
      assert.ok(
        native || prefixed,
        `${msg} -- expected engine code '${code}' but got native .code='${e?.code}', message='${e?.message}'`,
      );
      return true;
    },
    msg,
  );
}

// --- M1 (6.3-1a) panic boundary: a Rust panic in a #[napi] method surfaces as a
// structured [panic] JS error and does NOT abort the Node host. `__forcePanicForTest`
// is a debug-only probe (absent from release cdylibs). After the caught panic the
// host is still alive (this assert.throws returning at all proves it) and the
// session — not faulted by a bare panic — remains usable.
{
  const probe = new Session();
  if (typeof probe.__forcePanicForTest === "function") {
    // 6.3-1c: a panic is an engine-taxonomy Internal error, so the structured
    // reshape routes it through throw_structured -> the thrown JS error carries
    // a NATIVE `.code === "panic"` (and `.class === "internal"`); its message no
    // longer carries the legacy `[panic]` prefix (code is data, not parsed).
    assert.throws(
      () => probe.__forcePanicForTest(),
      (e) => {
        assert.equal(e.code, "panic", "panic must surface native .code='panic'");
        assert.equal(e.class, "internal", "panic .class must be 'internal'");
        return true;
      },
      "a panic in a #[napi] method must surface a native [code=panic] error, not abort the host",
    );
    // Host survived (we reached here) and the session is still usable.
    const sid = probe.addSheet("AfterPanic", 1000);
    assert.equal(typeof sid, "number", "session remains usable after a caught panic");
    console.log("[smoke] M1 panic boundary: native code=panic surfaced, host alive, session usable");
  } else {
    console.log("[smoke] M1 panic boundary: __forcePanicForTest absent (release cdylib) — skipped");
  }
  probe.close();
}

// --- edit → recalc → snapshot loop through the owning WorkbookSession ---------
const s = new Session();

const sheetId = s.addSheet("Sheet1", 1000);
assert.equal(typeof sheetId, "number", "addSheet returns a numeric SheetId");
console.log(`[smoke] addSheet -> sheetId=${sheetId}`);

// A1 = 10 (literal), B1 = A1+1 (formula). Formula text is the BODY without a
// leading "=" (engine/op-log convention; the IDE strips the "=" client-side,
// same as appendPutFormula).
s.setValue(sheetId, 0, 0, { kind: "number", number: 10 });
s.setFormula(sheetId, 0, 1, "A1+1");
s.recalcDirty();

// Single-cell read of the computed value.
const b1 = s.cell(sheetId, 0, 1);
assert.ok(b1, "B1 must exist after setFormula+recalc");
assert.ok(b1.value, "B1 must carry a computed value");
assert.equal(b1.value.kind, "number", "B1 value kind");
assert.equal(b1.value.number, 11, "B1 = A1 + 1 = 11");
// The engine canonicalizes formula text (e.g. "A1+1" -> "A1 + 1"); compare
// whitespace-insensitively. No leading "=" (engine/op-log convention).
assert.equal(
  b1.formula.replace(/\s+/g, ""),
  "A1+1",
  "B1 formula text round-trips (canonicalized, no leading '=')",
);
console.log(`[smoke] cell(B1) -> ${JSON.stringify(b1.value)} formula=${b1.formula}`);

// Full snapshot read: the version token must round-trip as opaque bytes, and the
// sheet/cell view must agree with the single-cell read.
const snap = s.snapshot();
assert.equal(snap.sheets.length, 1, "one sheet in snapshot");
assert.ok(Buffer.isBuffer(snap.version) || snap.version?.length > 0, "opaque version token present");
const sheet = snap.sheets[0];
assert.equal(sheet.id, sheetId, "snapshot sheet id matches");
const snapB1 = sheet.cells.find((c) => c.row === 0 && c.col === 1);
assert.ok(snapB1 && snapB1.value && snapB1.value.number === 11, "snapshot agrees: B1 == 11");

// listSheets sanity.
const sheets = s.listSheets();
assert.equal(sheets.length, 1, "one live sheet");
assert.equal(sheets[0].name, "Sheet1", "sheet name preserved");

// --- M2 (6.3-1b): start/await recalc + pre-start cancel window over napi -------
// Self-contained on fresh cells E1/F1 (col 4/5) so it does not disturb the A1/B1
// assertions above. Proves end-to-end that the windowed split works over napi:
// startRecalc* returns an op id without running, cancel(op) in the window makes
// awaitRecalc SKIP the recompute, and the session stays usable.
{
  s.setValue(sheetId, 0, 4, { kind: "number", number: 100 }); // E1 = 100
  s.setFormula(sheetId, 0, 5, "E1+1"); // F1 = E1 + 1
  // Happy path: startRecalcAll -> awaitRecalc completes and recomputes F1 = 101.
  const opAll = s.startRecalcAll();
  assert.equal(typeof opAll, "bigint", "startRecalcAll returns a BigInt op id");
  s.awaitRecalc(opAll);
  assert.equal(s.cell(sheetId, 0, 5).value.number, 101, "F1 = E1+1 = 101 after start/await");
  // 6.3-1c: operationStatus reports the completed outcome of the awaited op.
  assert.equal(
    s.operationStatus(opAll).state,
    "completed",
    "operationStatus(op) is 'completed' after a successful awaitRecalc",
  );
  // Pre-start cancel: dirty F1 (E1=200), start, cancel (true), await SKIPS recompute.
  s.setValue(sheetId, 0, 4, { kind: "number", number: 200 });
  const opDirty = s.startRecalcDirty();
  assert.equal(typeof opDirty, "bigint", "startRecalcDirty returns a BigInt op id");
  assert.equal(s.cancel(opDirty), true, "cancel of a Running op returns true");
  s.awaitRecalc(opDirty);
  assert.equal(
    s.cell(sheetId, 0, 5).value.number,
    101,
    "canceled recalc must NOT recompute F1 (stays stale 101, not 201)",
  );
  // 6.3-1c: operationStatus reports the canceled outcome (the pre-start cancel won).
  assert.equal(
    s.operationStatus(opDirty).state,
    "canceled",
    "operationStatus(op) is 'canceled' after a pre-start cancel won the window",
  );
  assert.equal(s.cancel(opDirty), false, "cancel of an already-terminal op is false");
  // Session still usable: a fresh recalc after the window recomputes F1 = 201.
  const opDirty2 = s.startRecalcDirty();
  s.awaitRecalc(opDirty2);
  assert.equal(s.cell(sheetId, 0, 5).value.number, 201, "fresh recalc after the window recomputes F1 = 201");
  console.log("[smoke] M2 start/await recalc + pre-start cancel window OK (cancel skipped recompute, session usable)");
}

// --- 6.3-1c M5: every snapshot DTO carries schemaVersion (contract section 4.1) -
{
  const snap = s.snapshot();
  assert.equal(snap.schemaVersion, 1, "snapshot carries schemaVersion === 1");
  console.log("[smoke] 6.3-1c M5: snapshot.schemaVersion === 1");
}

// --- 6.3-1c: structured engine error carries NATIVE .code/.class/.retryable ----
// A duplicate sheet name is an engine-taxonomy Conflict error, so the structured
// reshape delivers it as a JS Error with native own-properties (NOT a
// [code]-prefixed message). FFI bad_argument validation stays prefix-encoded.
{
  let caught;
  try {
    s.addSheet("Sheet1", 1000); // "Sheet1" already exists -> sheet_name_duplicate
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "duplicate addSheet must throw");
  assert.equal(caught.code, "sheet_name_duplicate", "native .code present as data");
  assert.equal(caught.class, "conflict", "native .class is the snake_case ErrorClass");
  assert.equal(typeof caught.retryable, "boolean", "native .retryable present");
  assert.ok(
    !caught.message.startsWith("["),
    "structured error message has NO [code] prefix (code is data, not a parsed token)",
  );
  // Session is unfaulted by a clean engine error -> still usable.
  assert.equal(typeof s.snapshot().schemaVersion, "number", "session usable after a structured error");
  console.log(
    `[smoke] 6.3-1c structured error OK (native code=${caught.code} class=${caught.class} retryable=${caught.retryable})`,
  );
}

// --- 6.3-2a: read / lifecycle / format / validate cluster ----------------------
// Grid state here: A1 (0,0) = 10 (literal), B1 (0,1) = A1+1 = 11 (computed).
{
  // lifecycleState: a live, drained session is "ready".
  assert.equal(s.lifecycleState(), "ready", "lifecycleState() is 'ready' on a live session");

  // queryRange: columnar read of A1:B1. Layout is column-major:
  // columns has length n_cols; each column.values has length n_rows.
  const rr = s.queryRange(
    { sheet: sheetId, startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    { includeFormulas: false, includeFormats: false, includeRendered: false },
  );
  assert.equal(rr.schemaVersion, 1, "RangeResult carries schemaVersion === 1");
  assert.equal(rr.nRows, 1, "queryRange A1:B1 has 1 row");
  assert.equal(rr.nCols, 2, "queryRange A1:B1 has 2 cols");
  assert.equal(rr.columns.length, 2, "columnar: 2 columns");
  assert.equal(rr.columns[0].values[0].number, 10, "col 0 row 0 = A1 = 10");
  assert.equal(rr.columns[1].values[0].number, 11, "col 1 row 0 = B1 = 11");

  // include_* options are not implemented in v1 -> fail loud (honest capability).
  throwsWithCode(
    () =>
      s.queryRange(
        { sheet: sheetId, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { includeFormulas: true, includeFormats: false, includeRendered: false },
      ),
    "not_implemented_in_v1_core",
    "queryRange with include_formulas surfaces a loud not_implemented_in_v1_core",
  );

  // registerFormat -> a FormatId (the engine dedups a well-known string like
  // "0.00" to a BUILTIN index; a novel string would be custom). setFormat
  // round-trips it (no throw) -- exercises both converters' happy path.
  const fmt = s.registerFormat("0.00");
  assert.ok(fmt.kind === "builtin" || fmt.kind === "custom", "registerFormat returns a FormatId");
  s.setFormat(sheetId, 0, 0, fmt);

  // setFormat reverse-converter fail-loud: a negative customPeer BigInt is
  // rejected (No-Fallbacks; exercises the custom-path sign-bit guard).
  throwsWithCode(
    () => s.setFormat(sheetId, 0, 0, { kind: "custom", customPeer: -1n, customCounter: 0 }),
    "bad_argument",
    "setFormat with a negative customPeer BigInt surfaces a loud bad_argument",
  );

  // validateFormula returns diagnostics as DATA (never throws on a bad formula).
  const okDiags = s.validateFormula(sheetId, 0, 0, "1 + 2 * 3");
  assert.ok(Array.isArray(okDiags) && okDiags.length === 0, "valid formula -> empty diagnostics");
  const badDiags = s.validateFormula(sheetId, 0, 0, "1 +* 2");
  assert.ok(Array.isArray(badDiags) && badDiags.length >= 1, "malformed formula -> >=1 diagnostic");
  assert.equal(badDiags[0].severity, "error", "diagnostic severity is 'error'");
  assert.equal(typeof badDiags[0].code, "string", "diagnostic carries a string code");

  // markVolatilesDirty: no-throw (no volatiles here, so B1 stays 11 for the
  // clear() assertion below; no recalc between).
  s.markVolatilesDirty();

  console.log(
    "[smoke] 6.3-2a read/lifecycle/format/validate OK (queryRange schemaVersion=1, diagnostics-as-data)",
  );
}

// clear() == clear_formula() == "convert to literal": it removes the FORMULA
// but PRESERVES the last computed value (inc.2c-6 contract). So B1 keeps
// value==11 and loses its formula. (To also clear the value, setValue(blank).)
s.clear(sheetId, 0, 1);
const cleared = s.cell(sheetId, 0, 1);
assert.ok(cleared, "B1 still present (value preserved)");
assert.ok(cleared.value && cleared.value.number === 11, "clear preserves the computed value");
assert.ok(!cleared.formula, "clear removes the formula (convert-to-literal)");

// setValue(blank) then re-read: value gone too.
s.setValue(sheetId, 0, 1, { kind: "blank" });
const blanked = s.cell(sheetId, 0, 1);
assert.ok(!blanked || !blanked.value, "setValue(blank) clears the value");

// fail-loud: unknown value kind is rejected (No-Fallbacks), not silently dropped.
throwsWithCode(
  () => s.setValue(sheetId, 0, 2, { kind: "bogus" }),
  "bad_argument",
  "unknown value kind surfaces a structured [bad_argument] error",
);

// === 6.4-2 (2026-05-28) — function-registration surface over napi ===
//
// Wires the substrate (6.4-0 metadata + hooks; 6.4-1 ArgContext binder + H3
// fn_gen invalidation + M3 sorted_metadata + M5 mapper + I1 LazyShape) to
// the JS surface. Asserts the round-trip + the two new Appendix A codes
// (function_exists / function_not_found) the IDE allowlist now accepts.

const initialFunctions = s.listFunctions();
assert.ok(
  Array.isArray(initialFunctions) && initialFunctions.length > 200,
  `listFunctions on a fresh session returns the ~260 built-ins; got ${initialFunctions.length}`,
);
const initialCount = initialFunctions.length;
// Built-in present + sorted (ascending canonical_name).
assert.ok(
  initialFunctions.some((m) => m.canonicalName === "SUM"),
  "SUM (built-in) must appear in listFunctions",
);
for (let i = 1; i < initialFunctions.length; i++) {
  assert.ok(
    initialFunctions[i - 1].canonicalName < initialFunctions[i].canonicalName,
    `listFunctions MUST be sorted ascending: violated at ${initialFunctions[i - 1].canonicalName} -> ${initialFunctions[i].canonicalName}`,
  );
}

// UDF stub matching the Phase-6.4-3 wedge shape (Volatile + Aggregate +
// ArrayBatch — the Python-UDF default).
//
// Note: napi-rs `Option<T>` fields require the field to be ABSENT (undefined)
// rather than `null` — passing `null` triggers a `NumberExpected` (or
// equivalent) at the boundary. So we omit `n`/`min`/`max` from the arity here
// rather than setting them to `null`.
const myUdfMeta = {
  canonicalName: "MYUDF",
  displayName: "My UDF",
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

// Happy path: register → list (includes) → unregister → list (excludes).
s.registerFunction(myUdfMeta, 0xABCDn);
const afterRegister = s.listFunctions();
assert.strictEqual(afterRegister.length, initialCount + 1, "MYUDF lifts count by 1");
const reg = afterRegister.find((m) => m.canonicalName === "MYUDF");
assert.ok(reg, "MYUDF appears post-register");
assert.strictEqual(reg.volatility, "volatile", "metadata enum round-trips: volatility");
assert.strictEqual(reg.batchShape, "array_batch", "metadata enum round-trips: batchShape");
assert.strictEqual(reg.argContext, "aggregate", "metadata enum round-trips: argContext");
assert.deepStrictEqual(reg.provenanceTags, ["python"], "metadata Vec<String> round-trips");
assert.strictEqual(reg.arity.kind, "variadic", "Arity tagged-union round-trips");

// Duplicate register → [function_exists] (Appendix A 6.4-2 new row).
throwsWithCode(
  () => s.registerFunction(myUdfMeta, 0xBEEFn),
  "function_exists",
  "duplicate registerFunction surfaces structured [function_exists]",
);

// Register-against-builtin → also [function_exists] (registry's metadata
// already exists for SUM at boot via register_builtin_metadata).
throwsWithCode(
  () => s.registerFunction({ ...myUdfMeta, canonicalName: "SUM" }, 1n),
  "function_exists",
  "registering against a built-in's name surfaces [function_exists]",
);

// Unregister round-trip.
s.unregisterFunction("MYUDF");
const afterUnregister = s.listFunctions();
assert.strictEqual(afterUnregister.length, initialCount, "MYUDF cleanly removed");
assert.ok(
  !afterUnregister.some((m) => m.canonicalName === "MYUDF"),
  "MYUDF gone from list post-unregister",
);

// Unregister unknown → [function_not_found] (Appendix A 6.4-2 new row).
throwsWithCode(
  () => s.unregisterFunction("DOES_NOT_EXIST"),
  "function_not_found",
  "unregisterFunction on unknown name surfaces structured [function_not_found]",
);

// Unregister built-in → [function_exists] (builtin-guard re-uses the Conflict
// variant per the 6.4-0 audit-fix Codex A LOW closure).
throwsWithCode(
  () => s.unregisterFunction("SUM"),
  "function_exists",
  "unregisterFunction on a built-in name surfaces [function_exists] (builtin-guard)",
);

// Fail-loud: unknown enum string at the napi boundary.
throwsWithCode(
  () =>
    s.registerFunction(
      { ...myUdfMeta, canonicalName: "BOGUS_VOLATILITY", volatility: "extremely_volatile" },
      1n,
    ),
  "bad_argument",
  "unknown volatility string surfaces structured [bad_argument]",
);

// 6.4-2 cycle-2 audit-fix (H1/F1): a lowercase or empty canonicalName must
// surface a structured [bad_argument] — NOT panic across the napi boundary
// (which pre-fix would have aborted the host AND sealed the session Faulted).
throwsWithCode(
  () => s.registerFunction({ ...myUdfMeta, canonicalName: "mylowerudf" }, 1n),
  "bad_argument",
  "lowercase canonicalName surfaces structured [bad_argument] (no FFI panic)",
);
throwsWithCode(
  () => s.registerFunction({ ...myUdfMeta, canonicalName: "" }, 1n),
  "bad_argument",
  "empty canonicalName surfaces structured [bad_argument] (no FFI panic)",
);
// The rejected bad-name calls must NOT have sealed the session: a valid
// registration still succeeds afterwards.
s.registerFunction({ ...myUdfMeta, canonicalName: "MYUDF2" }, 7n);
assert.ok(
  s.listFunctions().some((m) => m.canonicalName === "MYUDF2"),
  "session stays usable after rejected bad-name registrations (not sealed)",
);
s.unregisterFunction("MYUDF2");

// 6.4-2 cycle-2 audit-fix (F3): a strict ArityJson tagged union rejects
// extraneous payload fields rather than silently ignoring them.
throwsWithCode(
  () =>
    s.registerFunction(
      { ...myUdfMeta, canonicalName: "MYUDF3", arity: { kind: "variadic", n: 7 } },
      1n,
    ),
  "bad_argument",
  "variadic arity carrying 'n' surfaces structured [bad_argument] (strict tagged union)",
);

console.log("[smoke] 6.4-2 function registration PASS");

// **6.1C audit-fix M8 — Session.close() deterministic lifecycle release.**
// Post-close any command call returns a structured [invalid_state] error, not
// a panic / silent failure. Closes the lifecycle hole flagged by the megaudit
// (engine has `close()`; without the napi wrapper JS could only GC-free the
// underlying workbook). The double-close is a no-op (idempotent terminal).
s.close();
throwsWithCode(
  () => s.cell(sheetId, 0, 0),
  "invalid_state",
  "post-close cell() must fail loud with [invalid_state]",
);
throwsWithCode(
  () => s.setValue(sheetId, 0, 0, { kind: "number", number: 42 }),
  "invalid_state",
  "post-close setValue() must fail loud with [invalid_state]",
);
// 6.4-2 post-close lifecycle: all three new methods rejected by ensure_ready
// (registerFunction, unregisterFunction) or ensure_readable (listFunctions).
throwsWithCode(
  () => s.registerFunction(myUdfMeta, 1n),
  "invalid_state",
  "post-close registerFunction must fail loud with [invalid_state]",
);
throwsWithCode(
  () => s.unregisterFunction("MYUDF"),
  "invalid_state",
  "post-close unregisterFunction must fail loud with [invalid_state]",
);
throwsWithCode(
  () => s.listFunctions(),
  "invalid_state",
  "post-close listFunctions must fail loud with [invalid_state]",
);
// Idempotent: re-closing a Closed session is a no-op (state stays Closed).
s.close();

console.log("[smoke] PASS — edit/recalc/snapshot/close + 6.4-2 function registration through WorkbookSession over napi");
