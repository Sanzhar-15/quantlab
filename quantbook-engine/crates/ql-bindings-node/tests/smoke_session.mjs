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
assert.throws(
  () => s.setValue(sheetId, 0, 2, { kind: "bogus" }),
  /\[bad_argument\]/,
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
assert.throws(
  () => s.registerFunction(myUdfMeta, 0xBEEFn),
  /\[function_exists\]/,
  "duplicate registerFunction surfaces structured [function_exists]",
);

// Register-against-builtin → also [function_exists] (registry's metadata
// already exists for SUM at boot via register_builtin_metadata).
assert.throws(
  () => s.registerFunction({ ...myUdfMeta, canonicalName: "SUM" }, 1n),
  /\[function_exists\]/,
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
assert.throws(
  () => s.unregisterFunction("DOES_NOT_EXIST"),
  /\[function_not_found\]/,
  "unregisterFunction on unknown name surfaces structured [function_not_found]",
);

// Unregister built-in → [function_exists] (builtin-guard re-uses the Conflict
// variant per the 6.4-0 audit-fix Codex A LOW closure).
assert.throws(
  () => s.unregisterFunction("SUM"),
  /\[function_exists\]/,
  "unregisterFunction on a built-in name surfaces [function_exists] (builtin-guard)",
);

// Fail-loud: unknown enum string at the napi boundary.
assert.throws(
  () =>
    s.registerFunction(
      { ...myUdfMeta, canonicalName: "BOGUS_VOLATILITY", volatility: "extremely_volatile" },
      1n,
    ),
  /\[bad_argument\]/,
  "unknown volatility string surfaces structured [bad_argument]",
);

console.log("[smoke] 6.4-2 function registration PASS");

// **6.1C audit-fix M8 — Session.close() deterministic lifecycle release.**
// Post-close any command call returns a structured [invalid_state] error, not
// a panic / silent failure. Closes the lifecycle hole flagged by the megaudit
// (engine has `close()`; without the napi wrapper JS could only GC-free the
// underlying workbook). The double-close is a no-op (idempotent terminal).
s.close();
assert.throws(
  () => s.cell(sheetId, 0, 0),
  /\[invalid_state\]/,
  "post-close cell() must fail loud with [invalid_state]",
);
assert.throws(
  () => s.setValue(sheetId, 0, 0, { kind: "number", number: 42 }),
  /\[invalid_state\]/,
  "post-close setValue() must fail loud with [invalid_state]",
);
// 6.4-2 post-close lifecycle: all three new methods rejected by ensure_ready
// (registerFunction, unregisterFunction) or ensure_readable (listFunctions).
assert.throws(
  () => s.registerFunction(myUdfMeta, 1n),
  /\[invalid_state\]/,
  "post-close registerFunction must fail loud with [invalid_state]",
);
assert.throws(
  () => s.unregisterFunction("MYUDF"),
  /\[invalid_state\]/,
  "post-close unregisterFunction must fail loud with [invalid_state]",
);
assert.throws(
  () => s.listFunctions(),
  /\[invalid_state\]/,
  "post-close listFunctions must fail loud with [invalid_state]",
);
// Idempotent: re-closing a Closed session is a no-op (state stays Closed).
s.close();

console.log("[smoke] PASS — edit/recalc/snapshot/close + 6.4-2 function registration through WorkbookSession over napi");
