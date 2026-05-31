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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // **6.3-2 hardening (megaudit H1):** the `builtin` field is `f64`-typed +
  // validate_u32_index'd, so a malformed JS Number FAILS LOUD instead of being
  // silently ToUint32-coerced (NaN->0, 2.9->2, -1->u32::MAX) into a wrong-but-
  // valid-looking format id.
  throwsWithCode(
    () => s.setFormat(sheetId, 0, 0, { kind: "builtin", builtin: NaN }),
    "bad_argument",
    "setFormat builtin NaN is rejected (not coerced to 0)",
  );
  throwsWithCode(
    () => s.setFormat(sheetId, 0, 0, { kind: "builtin", builtin: 2.9 }),
    "bad_argument",
    "setFormat builtin 2.9 is rejected (not floored to 2)",
  );
  throwsWithCode(
    () => s.setFormat(sheetId, 0, 0, { kind: "builtin", builtin: -1 }),
    "bad_argument",
    "setFormat builtin -1 is rejected (not wrapped to u32::MAX)",
  );
  // **6.3-2 hardening (megaudit M2):** strict tagged union -- a 'builtin' kind
  // carrying a custom payload is a malformed DTO (rejected, not silently dropped).
  throwsWithCode(
    () => s.setFormat(sheetId, 0, 0, { kind: "builtin", builtin: 0, customPeer: 1n }),
    "bad_argument",
    "setFormat builtin kind carrying customPeer is rejected (strict union)",
  );
  // **6.3-2 hardening (megaudit M1):** CellValueJson is a strict tagged union --
  // an extraneous-for-kind field is a malformed DTO (rejected, not silently
  // dropped). Throws pre-mutation, so the target cell is untouched.
  throwsWithCode(
    () => s.setValue(sheetId, 50, 50, { kind: "blank", number: 123 }),
    "bad_argument",
    "setValue blank kind carrying a number is rejected (strict union)",
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

// **6.3-2 hardening (megaudit H2):** arity n/min/max are f64-typed +
// validate_u32_index'd, so a malformed JS Number FAILS LOUD instead of being
// silently ToUint32-coerced (2.9->2, NaN->0) into a wrong-but-valid arity.
// (These throw at arity_from_json before registration, so no name lands.)
throwsWithCode(
  () =>
    s.registerFunction(
      { ...myUdfMeta, canonicalName: "ARITYFRAC", arity: { kind: "fixed", n: 2.9 } },
      1n,
    ),
  "bad_argument",
  "registerFunction arity n=2.9 is rejected (not floored to 2)",
);
throwsWithCode(
  () =>
    s.registerFunction(
      { ...myUdfMeta, canonicalName: "ARITYNAN", arity: { kind: "fixed", n: NaN } },
      1n,
    ),
  "bad_argument",
  "registerFunction arity n=NaN is rejected (not coerced to 0)",
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

// === 6.3-2b (2026-05-30) — persistence over napi (.qbook open/save + import/export) ===
//
// Self-contained on FRESH sessions (order-independent of the shared `s`): a .qbook
// save/open round-trip + a csv export/import round-trip + the xlsx-export capability
// error (the default cdylib lacks the xlsx-write feature) + loud import negatives.
{
  const w = new Session();
  const dataSheet = w.addSheet("Data", 1000);
  w.setValue(dataSheet, 0, 0, { kind: "number", number: 123 });
  w.recalcDirty();

  // .qbook round-trip: save -> new Session().open() -> the value survives.
  const dir = mkdtempSync(path.join(tmpdir(), "ql-qbook-"));
  const qbookPath = path.join(dir, "smoke.qbook");
  w.save(qbookPath);
  const w2 = new Session();
  w2.open(qbookPath);
  assert.equal(w2.lifecycleState(), "ready", "opened .qbook session is 'ready'");
  const opened = w2.cell(dataSheet, 0, 0);
  assert.ok(
    opened && opened.value && opened.value.number === 123,
    ".qbook open round-trips the A1 value",
  );
  w2.close();

  // csv round-trip: export bytes -> fresh session import -> the value survives.
  // (Single live sheet, so csv export is unambiguous.)
  const csvBytes = w.export("csv");
  assert.ok(
    csvBytes instanceof Uint8Array && csvBytes.length > 0,
    "export('csv') returns a non-empty Uint8Array",
  );
  const w3 = new Session();
  w3.import(csvBytes, "csv");
  const imported = w3.cell(0, 0, 0); // csv import builds a fresh single sheet (id 0)
  assert.ok(
    imported && imported.value && imported.value.number === 123,
    "csv import round-trips the A1 value",
  );
  w3.close();

  // export('xlsx'): the default cdylib is built WITHOUT the `xlsx-write` feature,
  // so the writer is absent -> honest capability error (No-Fallbacks), not a silent
  // empty export.
  throwsWithCode(
    () => w.export("xlsx"),
    "not_implemented_in_v1_core",
    "export('xlsx') without the xlsx-write feature surfaces a loud not_implemented_in_v1_core",
  );

  // negatives: an unknown import format is a loud [bad_argument]; malformed xlsx
  // bytes fail loud as a Persistence-class error (the exact parse code — zip vs
  // calamine — is input-dependent, so assert the stable .class). Neither mutates `w`.
  throwsWithCode(
    () => w.import(new Uint8Array([1, 2, 3]), "json"),
    "bad_argument",
    "import with an unknown format surfaces a loud bad_argument",
  );
  assert.throws(
    () => w.import(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), "xlsx"),
    (e) => {
      assert.equal(e.class, "persistence", `malformed xlsx import must be persistence-class; got ${e?.class}`);
      return true;
    },
    "import of malformed xlsx bytes must fail loud (persistence)",
  );

  w.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    "[smoke] 6.3-2b persistence OK (.qbook open/save + csv round-trip + xlsx capability + loud negatives)",
  );
}

// === 6.3-2c (2026-05-30) — structure / sheets over napi ===
//
// Self-contained on a FRESH session: rename / move (incl. no-op) / delete+restore
// round-trips observed through listSheets() (which reflects display order) + a
// defined-name binding + loud structured negatives. Sheet ids are captured from
// addSheet (no assumption about a default sheet's id).
{
  const w = new Session();
  const a = w.addSheet("Alpha", 1000);
  const b = w.addSheet("Beta", 1000);

  // rename: the new name appears in listSheets under the same id.
  w.renameSheet(a, "AlphaRenamed");
  assert.ok(
    w.listSheets().some((s) => s.id === a && s.name === "AlphaRenamed"),
    "renameSheet reflected in listSheets",
  );

  // move: place b at display index 0; listSheets order reflects it.
  w.moveSheet(b, 0);
  assert.equal(
    w.listSheets()[0].id,
    b,
    "moveSheet placed sheet b at display index 0",
  );
  // no-op: moving b to its current index must not throw.
  w.moveSheet(b, 0);

  // setName: bind a workbook name to a range on a live sheet. A defined name is
  // delta-invisible, so prove it is OBSERVABLE by resolving it inside a formula
  // (not merely "did not throw" -- a no-op would pass that).
  w.setValue(b, 0, 0, { kind: "number", number: 10 }); // b!A1
  w.setValue(b, 1, 0, { kind: "number", number: 20 }); // b!A2
  w.setValue(b, 2, 0, { kind: "number", number: 30 }); // b!A3
  w.setName("Nums", { sheet: b, startRow: 0, startCol: 0, endRow: 2, endCol: 0 }); // A1:A3
  w.setFormula(b, 0, 1, "SUM(Nums)"); // b!B1 = SUM(Nums)
  w.recalcDirty();
  assert.equal(
    w.cell(b, 0, 1).value.number,
    60,
    "setName is observable: SUM(Nums) over the defined range resolves to 10+20+30",
  );
  // Range orientation is a documented contract: an INVERTED target normalizes to
  // the same rectangle (start <= end per axis), so SUM over it is identical.
  w.setName("NumsInv", { sheet: b, startRow: 2, startCol: 0, endRow: 0, endCol: 0 }); // A3:A1 inverted
  w.setFormula(b, 1, 1, "SUM(NumsInv)"); // b!B2 = SUM(NumsInv)
  w.recalcDirty();
  assert.equal(
    w.cell(b, 1, 1).value.number,
    60,
    "setName normalizes an inverted range to the same rectangle (A3:A1 == A1:A3)",
  );

  // delete + restore: the sheet drops from / returns to listSheets.
  w.deleteSheet(a);
  assert.ok(
    !w.listSheets().some((s) => s.id === a),
    "deleteSheet drops the sheet from listSheets",
  );
  w.restoreSheet(a);
  assert.ok(
    w.listSheets().some((s) => s.id === a && s.name === "AlphaRenamed"),
    "restoreSheet returns the sheet (with its name) to listSheets",
  );

  // negatives (loud, structured): unknown id -> sheet_not_found on every mutator;
  // duplicate name -> sheet_name_duplicate; out-of-range move index -> bad_argument;
  // restoring a live (not-tombstoned) sheet -> sheet_not_deleted.
  const unknownId = 60000;
  throwsWithCode(() => w.deleteSheet(unknownId), "sheet_not_found", "deleteSheet on unknown id");
  throwsWithCode(() => w.renameSheet(unknownId, "X"), "sheet_not_found", "renameSheet on unknown id");
  throwsWithCode(() => w.restoreSheet(unknownId), "sheet_not_found", "restoreSheet on unknown id");
  throwsWithCode(() => w.moveSheet(unknownId, 0), "sheet_not_found", "moveSheet on unknown id");
  throwsWithCode(
    () => w.renameSheet(b, "AlphaRenamed"),
    "sheet_name_duplicate",
    "renameSheet to an existing live name",
  );
  const count = w.listSheets().length;
  throwsWithCode(
    () => w.moveSheet(b, count + 5),
    "bad_argument",
    "moveSheet to an out-of-range index",
  );
  throwsWithCode(
    () => w.restoreSheet(b),
    "sheet_not_deleted",
    "restoreSheet on a live (not-tombstoned) sheet",
  );

  w.close();
  console.log(
    "[smoke] 6.3-2c structure/sheets OK (rename/move/delete/restore round-trips + setName + loud negatives)",
  );
}

// === 6.3-2d (2026-05-30) — tables over napi ===
//
// Self-contained on a FRESH session. Tables have NO read surface (snapshot() does
// NOT surface tables), so observe via a STRUCTURED-REFERENCE formula: SUM(T[Col])
// resolves over the table's data column. It SURVIVES renameColumn / renameTable
// (the engine rewrites the stored formula text), TRACKS a resize that extends the
// data range, and re-binds to an error (#NAME!) once the table is dropped. Exercises
// the new TableSpecJson DTO + loud structured negatives.
{
  const w = new Session();
  const sh = w.addSheet("Data", 1000);

  // Header at row 0; data at rows 1-2 of col 0 = 10, 20.
  w.setValue(sh, 1, 0, { kind: "number", number: 10 });
  w.setValue(sh, 2, 0, { kind: "number", number: 20 });

  // create: a 3x1 table (header + 2 data rows) anchored at (0,0), one column "Qty".
  w.createTable({
    name: "Sales",
    sheet: sh,
    topRow: 0,
    topCol: 0,
    rows: 3,
    cols: 1,
    hasHeader: true,
    hasTotals: false,
    columnNames: ["Qty"],
  });

  // OBSERVABLE: a structured-reference formula resolves over the data column.
  // (A no-op createTable would leave this #NAME!, so this pins REAL creation.)
  w.setFormula(sh, 0, 2, "SUM(Sales[Qty])"); // C1
  w.recalcDirty();
  assert.equal(w.cell(sh, 0, 2).value.number, 30, "SUM(Sales[Qty]) resolves to 10+20");

  // renameColumn: the engine rewrites the stored formula text -> still resolves.
  w.renameColumn("Sales", "Qty", "Quantity");
  w.recalcDirty();
  assert.equal(
    w.cell(sh, 0, 2).value.number,
    30,
    "renameColumn rewrites the structured ref (Qty -> Quantity) -> still 30",
  );
  // PIN that the rename REALLY took effect (a silent no-op would leave the old
  // column name still bound, so "still 30" alone is not enough): a FRESH formula
  // using the NEW column name binds + resolves (only possible if the column was
  // actually renamed), AND a fresh formula using the OLD name fails to bind
  // (setFormula rejects an unbindable structured ref eagerly -> [formula_bind];
  // a bind error does NOT fault the session, so it stays usable afterward).
  w.setFormula(sh, 0, 5, "SUM(Sales[Quantity])"); // F1 (new name binds)
  w.recalcDirty();
  assert.equal(w.cell(sh, 0, 5).value.number, 30, "the NEW column name binds after renameColumn");
  throwsWithCode(
    () => w.setFormula(sh, 1, 5, "SUM(Sales[Qty])"),
    "formula_bind",
    "the OLD column name no longer binds after renameColumn",
  );

  // renameTable: likewise rewrites the table reference -> still resolves.
  w.renameTable("Sales", "Revenue");
  w.recalcDirty();
  assert.equal(
    w.cell(sh, 0, 2).value.number,
    30,
    "renameTable rewrites the structured ref (Sales -> Revenue) -> still 30",
  );
  // PIN the table rename the same way: the NEW table name binds, the OLD fails.
  w.setFormula(sh, 2, 5, "SUM(Revenue[Quantity])"); // F3 (new table name binds)
  w.recalcDirty();
  assert.equal(w.cell(sh, 2, 5).value.number, 30, "the NEW table name binds after renameTable");
  throwsWithCode(
    () => w.setFormula(sh, 3, 5, "SUM(Sales[Quantity])"),
    "formula_bind",
    "the OLD table name no longer binds after renameTable",
  );

  // resize: add a data row BELOW the footprint, grow rows 3 -> 4 (header + 3 data),
  // and watch the SUM range extend to include it (OBSERVABLE, not just no-throw).
  w.setValue(sh, 3, 0, { kind: "number", number: 40 });
  w.resizeTable("Revenue", 4, 1, [], []);
  w.recalcDirty();
  assert.equal(
    w.cell(sh, 0, 2).value.number,
    70,
    "resizeTable extends the data range -> SUM now 10+20+40",
  );

  // drop: metadata removed -> the structured ref re-binds to a #NAME? error on
  // recompute (the cell read 70 immediately above, so this error IS the drop's
  // rebind, not a pre-existing one). Pin the error VALUE, not just kind==="error".
  w.dropTable("Revenue");
  w.recalcDirty();
  const dropped = w.cell(sh, 0, 2).value;
  assert.equal(dropped.kind, "error", "dropTable -> SUM over the dropped table re-binds to an error");
  assert.ok(
    typeof dropped.error === "string" && dropped.error.includes("NAME"),
    `dropTable rebind is a #NAME? error (UnknownTable), got ${JSON.stringify(dropped.error)}`,
  );

  // negatives (loud, structured). Seed a live table to drive the collision paths.
  w.createTable({
    name: "T2",
    sheet: sh,
    topRow: 6,
    topCol: 0,
    rows: 2,
    cols: 1,
    hasHeader: true,
    hasTotals: false,
    columnNames: ["X"],
  });
  throwsWithCode(
    () =>
      w.createTable({
        name: "T2",
        sheet: sh,
        topRow: 10,
        topCol: 0,
        rows: 2,
        cols: 1,
        hasHeader: true,
        hasTotals: false,
        columnNames: ["Y"],
      }),
    "table_create_rejected",
    "createTable with a duplicate name",
  );
  throwsWithCode(
    () =>
      w.createTable({
        name: "ZeroRows",
        sheet: sh,
        topRow: 20,
        topCol: 0,
        rows: 0,
        cols: 1,
        hasHeader: false,
        hasTotals: false,
        columnNames: ["Q"],
      }),
    "table_create_rejected",
    "createTable with rows=0 (validator permits 0; engine enforces > 0)",
  );
  throwsWithCode(
    () =>
      w.createTable({
        name: "BadSheet",
        sheet: 60000,
        topRow: 0,
        topCol: 0,
        rows: 2,
        cols: 1,
        hasHeader: false,
        hasTotals: false,
        columnNames: ["Q"],
      }),
    "sheet_not_found",
    "createTable on a non-live sheet",
  );
  throwsWithCode(() => w.renameTable("NoSuch", "X"), "table_not_found", "renameTable on unknown table");
  throwsWithCode(() => w.dropTable("NoSuch"), "table_not_found", "dropTable on unknown table");
  throwsWithCode(() => w.resizeTable("NoSuch", 2, 1, [], []), "table_not_found", "resizeTable on unknown table");
  throwsWithCode(() => w.renameColumn("NoSuch", "X", "Y"), "table_not_found", "renameColumn on unknown table");
  throwsWithCode(
    () => w.renameColumn("T2", "NoCol", "Y"),
    "table_column_not_found",
    "renameColumn on unknown column",
  );
  // The remaining two table error classes: a rejected column rename target
  // (empty new name) and a rejected resize (zero dims -- the u32 validator
  // permits 0, so the engine is the one that rejects).
  throwsWithCode(
    () => w.renameColumn("T2", "X", ""),
    "table_column_rejected",
    "renameColumn to an empty column name",
  );
  throwsWithCode(
    () => w.resizeTable("T2", 0, 1, [], []),
    "table_resize_rejected",
    "resizeTable to zero rows",
  );

  w.close();
  console.log(
    "[smoke] 6.3-2d tables OK (create/rename-col/rename-table/resize/drop via SUM(T[Col]) + loud negatives)",
  );
}

// === 6.3-2e (2026-05-30) — atomic groups + reserved stubs over napi ===
//
// Self-contained on a FRESH session. batch + the transaction handle are OBSERVABLE
// (the staged ops really apply + resolve through a formula); the all-or-nothing
// contract is pinned (a rejected batch leaves the grid intact); rollback discards;
// the 5 reserved stubs surface not_implemented_in_v1_core; and the SessionOpJson
// converter rejects malformed ops loudly. Exercises the new SessionOpJson /
// BatchOptionsJson / BatchResultJson DTOs.
{
  const w = new Session();
  const sh = w.addSheet("Ops", 1000);

  // batch: atomic apply, OBSERVABLE (a no-op batch would leave B1 #NAME!/blank).
  const r = w.batch(
    [
      { kind: "setValue", sheet: sh, row: 0, col: 0, value: { kind: "number", number: 5 } }, // A1=5
      { kind: "setFormula", sheet: sh, row: 0, col: 1, text: "A1*2" }, // B1=A1*2
    ],
    {},
  );
  assert.equal(r.applied, 2, "batch reports applied=2");
  assert.ok(
    r.version instanceof Uint8Array && r.version.length > 0,
    "batch returns a non-empty version token",
  );
  w.recalcDirty();
  assert.equal(w.cell(sh, 0, 0).value.number, 5, "batch setValue applied (A1=5)");
  assert.equal(w.cell(sh, 0, 1).value.number, 10, "batch setFormula applied + resolves (B1=A1*2=10)");

  // batch all-or-nothing: a same-cell conflict rejects the WHOLE batch with NO
  // partial mutation (the conflict is detected pre-mutation). A sentinel set before
  // the failing batch must survive intact, AND a *valid* op on a DIFFERENT cell in
  // the same rejected batch must NOT land (cross-cell atomicity, not just the
  // conflicting cell).
  w.setValue(sh, 9, 9, { kind: "number", number: 99 }); // sentinel J10=99
  throwsWithCode(
    () =>
      w.batch(
        [
          { kind: "setValue", sheet: sh, row: 10, col: 10, value: { kind: "number", number: 7 } }, // valid, different cell
          { kind: "setValue", sheet: sh, row: 9, col: 9, value: { kind: "number", number: 1 } },
          { kind: "setValue", sheet: sh, row: 9, col: 9, value: { kind: "number", number: 2 } }, // same cell -> conflict
        ],
        {},
      ),
    "conflicting_batch_ops",
    "a same-cell-twice batch is rejected as a conflict",
  );
  assert.equal(
    w.cell(sh, 9, 9).value.number,
    99,
    "the rejected batch left the sentinel cell unchanged (all-or-nothing)",
  );
  assert.equal(
    w.cell(sh, 10, 10),
    null,
    "the valid op on a different cell in the rejected batch also did NOT land (cross-cell atomicity)",
  );

  // transaction: begin / add / commit, OBSERVABLE.
  const t = w.beginTransaction();
  assert.equal(typeof t, "bigint", "beginTransaction returns a BigInt id");
  w.txnAdd(t, { kind: "setValue", sheet: sh, row: 1, col: 2, value: { kind: "number", number: 7 } }); // C2=7
  w.txnAdd(t, { kind: "setFormula", sheet: sh, row: 1, col: 3, text: "C2+1" }); // D2=C2+1
  const rc = w.commitTransaction(t);
  assert.equal(rc.applied, 2, "commitTransaction applied 2 staged ops");
  w.recalcDirty();
  assert.equal(w.cell(sh, 1, 3).value.number, 8, "committed txn resolves (D2=C2+1=8)");

  // transaction rollback: the staged op is discarded (the cell stays empty -> null).
  const t2 = w.beginTransaction();
  assert.notEqual(t2, t, "beginTransaction returns distinct ids");
  w.txnAdd(t2, { kind: "setValue", sheet: sh, row: 5, col: 5, value: { kind: "number", number: 42 } }); // F6 staged
  w.rollbackTransaction(t2);
  w.recalcDirty();
  assert.equal(w.cell(sh, 5, 5), null, "a rolled-back txn did NOT apply its staged op (F6 still empty)");
  // rollback REALLY consumed the handle (not a silent no-op): a follow-up op on it fails.
  throwsWithCode(
    () => w.txnAdd(t2, { kind: "setValue", sheet: sh, row: 5, col: 5, value: { kind: "number", number: 1 } }),
    "transaction_not_found",
    "rollback consumed the handle (txnAdd on a rolled-back txn is transaction_not_found)",
  );

  // reserved stubs: all 5 surface not_implemented_in_v1_core (loud Capability).
  const r0 = { sheet: sh, startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  throwsWithCode(() => w.writeRange(r0, [[{ kind: "number", number: 1 }]]), "not_implemented_in_v1_core", "writeRange reserved");
  throwsWithCode(() => w.publishDataset("ds", "{}", r0), "not_implemented_in_v1_core", "publishDataset reserved");
  throwsWithCode(() => w.bindRange("b1", r0), "not_implemented_in_v1_core", "bindRange reserved");
  throwsWithCode(() => w.refreshSource("s1", 1n), "not_implemented_in_v1_core", "refreshSource reserved");
  throwsWithCode(() => w.materializeQuery("q1", r0, "{}"), "not_implemented_in_v1_core", "materializeQuery reserved");

  // arg validation (loud): unknown op kind / missing-for-kind payload / malformed JSON.
  throwsWithCode(
    () => w.batch([{ kind: "frobnicate", sheet: sh, row: 0, col: 0 }], {}),
    "bad_argument",
    "unknown SessionOp kind",
  );
  throwsWithCode(
    () => w.batch([{ kind: "setValue", sheet: sh, row: 0, col: 0 }], {}),
    "bad_argument",
    "setValue op missing its 'value' payload",
  );
  throwsWithCode(
    () => w.batch([{ kind: "clear", sheet: sh, row: 0, col: 0, value: { kind: "number", number: 1 } }], {}),
    "bad_argument",
    "clear op carrying an extraneous 'value' payload (strict tagged union)",
  );
  throwsWithCode(
    () => w.publishDataset("ds", "{not valid json", r0),
    "bad_argument",
    "publishDataset with malformed JSON data",
  );

  w.close();
  console.log(
    "[smoke] 6.3-2e atomic groups + reserved stubs OK (batch atomic+observable, txn commit/rollback, reserved Capability, arg validation)",
  );
}

// === 6.3-2 hardening coverage (2026-05-30, megaudit Opus-3) ===
//
// Closes the smoke-coverage gaps the megaudit flagged: recalcAll (the
// never-exercised recompute wrapper), pollEvents (bound but never called -- real
// cursor-decode + EventPageJson builder unexercised at the JS boundary), and
// setUdfWorker arg-validation (the handshakeTimeoutMs guard, which needs no
// Python spawn -- it fires BEFORE the eager spawn).
{
  const w = new Session();
  const sh = w.addSheet("Cover", 1000);

  // recalcAll: OBSERVABLE recompute. setFormula eagerly computes at set time, so
  // to PIN that recalcAll actually recomputes (not merely returns an op id),
  // mutate the input AFTER the formula is set: B1 is then STALE (12) and only a
  // real recalcAll that picks up the dirtied dependency recomputes it to 14. A
  // broken no-op recalcAll would leave B1 at 12 and fail this assert.
  w.setValue(sh, 0, 0, { kind: "number", number: 6 }); // A1
  w.setFormula(sh, 0, 1, "A1*2"); // B1 eagerly = 12
  w.setValue(sh, 0, 0, { kind: "number", number: 7 }); // A1=7 -> B1 dirty, still reads 12 until recalc
  const opId = w.recalcAll();
  assert.equal(typeof opId, "bigint", "recalcAll returns an operation id (BigInt)");
  assert.equal(
    w.cell(sh, 0, 1).value.number,
    14,
    "recalcAll recomputes the dirtied B1=A1*2=14 (pins real recompute, not a stale 12)",
  );

  // pollEvents: decode a real EventPageJson from the ring. The recalcAll above
  // wrote at least an operation_completed event; poll from cursor 0n and assert
  // the page shape + that the cursor-decode/builder produced a usable page.
  const page = w.pollEvents(0n);
  assert.ok(Array.isArray(page.events), "pollEvents page.events is an array");
  assert.equal(typeof page.nextCursor, "bigint", "pollEvents page.nextCursor is a BigInt");
  assert.equal(page.dropped, false, "pollEvents page.dropped is false (unbounded ring in v1)");
  assert.ok(page.events.length >= 1, "pollEvents surfaces >=1 event after a recompute");
  // negative cursor -> loud bad_argument (the BigInt sign-bit guard), not a
  // silently-truncated ring position.
  throwsWithCode(() => w.pollEvents(-1n), "bad_argument", "pollEvents(-1n) is rejected (sign-bit guard)");

  // setUdfWorker handshakeTimeoutMs arg-validation: these throw BEFORE the eager
  // Python spawn, so no fixture is needed. (The spawn path itself is deferred.)
  throwsWithCode(
    () => w.setUdfWorker({ python: "python3", handshakeTimeoutMs: -5 }),
    "bad_argument",
    "setUdfWorker handshakeTimeoutMs -5 is rejected",
  );
  throwsWithCode(
    () => w.setUdfWorker({ python: "python3", handshakeTimeoutMs: NaN }),
    "bad_argument",
    "setUdfWorker handshakeTimeoutMs NaN is rejected",
  );
  throwsWithCode(
    () => w.setUdfWorker({ python: "python3", handshakeTimeoutMs: 700000 }),
    "bad_argument",
    "setUdfWorker handshakeTimeoutMs over the 600000ms cap is rejected",
  );

  w.close();
  console.log("[smoke] 6.3-2 hardening coverage OK (recalcAll observable, pollEvents page + negative cursor, setUdfWorker arg-validation)");
}

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
