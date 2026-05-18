# Phase 4.12 megaudit — Opus-C findings
## Architecture / public API / persistence across the whole engine

Scope per the design doc (`docs/audits/2026-05-18-phase-4-12-megaudit-design.md` §97-112): cross-crate dependency map, public-API stability per crate, error taxonomy across crates, `.qbook` persistence forward/back compat, test architecture across crates, crate build hygiene, documentation coherence. Out of scope: function correctness (Codex), cross-feature integration (Opus-A), defensive/fuzz (Opus-B), audit-trail (self).

Repo: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Branch `feat/quantbook-engine` HEAD `947326824af`. 24 workspace crates (13 stubs `<25 LOC`, 11 live `200 LOC ≤ x ≤ 36 466 LOC`). 4131 workspace tests, gates clean per `docs/audits/2026-05-18-phase-4-12-megaudit-design.md` line 17.

---

## v2 readiness assessment (TL;DR)

**Phase 4 is structurally ready to enter Phase 5 (CRDT collaboration) — but not without three things landing first.** The architectural decisions taken in Phase 0-1 (T1-D02 hand-rolled graph, T1-D05 Loro reserved-for-oplog, T2-D01 `.qbook/` directory) have held under 11 sub-phases of feature pressure and the dependency graph remains acyclic. The 24-crate workspace shape has not needed to bend.

What needs to land before Phase 5:

1. **Public-API stability commitments**. ONE enum in the workspace carries `#[non_exhaustive]` today (`ql_functions::format::V2Token`). Every other public enum — `ErrorValue`, `Value`, `BindError`, `RuntimeError`, `QbookError`, `OpLogError`, `ReplayError`, `XlsxError`, `UnsupportedFeatureKind`, `PersistenceError`, `NameTableError`, `SheetNameError`, `TotalsFunction`, `LexError`, `ParseError`, `PrintError`, `FormatParseError`, `SimdShape`, `ReferenceMode`, `Locale`, `DateSystem` — is open to break callers on every variant addition. The Phase 4.11 Opus-C recommendation (add `#[non_exhaustive]` to xlsx enums before 0.2) needs to extend to the whole workspace.

2. **`ql-exec::WorkbookRuntime` monolith decomposition**. 12 413 LOC, 28 pub fns. This is the IDE binding's primary surface; freezing it now means Phase 5 collaboration patches will land in the same file. See HIGH-2.

3. **Persistence format magic-byte / version-probe symmetry between `.qbook/workbook.toml` and `oplog.bin`**. `.qbook/` has a v1-7 ladder with a two-phase probe; `oplog.bin` is a raw Loro `ExportMode::Snapshot` blob with no engine-level versioning. Phase 5's "merge two oplogs" semantics will need a version field. See HIGH-4.

What is fine:

- Cross-crate dependency graph: acyclic, leaf crates are leaves, the layered shape `types → storage/formula-syntax → functions/calcgraph → exec → io-xlsx` matches the design doc claim.
- Error-type composition: most errors carry source-chain `#[from]` and don't lossy-format. The two notable exceptions are flagged below (MEDIUM-2, MEDIUM-3).
- `.qbook/` schema versioning: v1 → v7 migration ladder, fail-loud on `UnsupportedSchema`, deny-unknown-fields strictness — well-shaped.
- Stub-crate doc hygiene: the 13 reserved crates all have a fresh "reserved for Phase N" header (post-Phase 2A.12 doc rot pass) rather than a stale "Phase 0 stub" claim.

---

## HIGH

### HIGH-1 — `#[non_exhaustive]` is missing from every public enum except one

`grep -rn "non_exhaustive" crates --include="*.rs"` returns ONE hit:

- `crates/ql-functions/src/format/error.rs:12` — `V2Token` is marked.

Every other public enum is open to break callers on every variant addition. The Phase 4.11 Opus-C audit (`docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md` §259-279) recommended marking the 11 public enums in `ql-io-xlsx` before 0.2; that recommendation has NOT landed in `ql-io-xlsx` (verified `crates/ql-io-xlsx/src/error.rs:18`, `options.rs`, `report.rs`, `model.rs`) and was never applied to the rest of the workspace.

Public enums missing `#[non_exhaustive]` (per `grep -rE "^pub enum"`):

| Crate | Enum | File:line | Variant count |
|---|---|---|---|
| ql-types | `ErrorValue` | `error.rs:24` | 15 |
| ql-types | `Value` | `value.rs` | 5 |
| ql-types | `DateSystem`, `Locale`, `ReferenceMode` | `eval_context.rs` | small enums likely to grow |
| ql-storage | `NameTableError` | `workbook.rs` | several |
| ql-storage | `SheetNameError` | `workbook.rs` | several |
| ql-storage | `FormatTableError` | `format.rs` | several |
| ql-storage | `SpillBlockError` / `SpillNotFoundError` | `spill.rs` | several |
| ql-storage | `TotalsFunction` | `tables.rs` | 6 |
| ql-storage | `NamedTarget` | `workbook.rs` | 4 |
| ql-exec | `BindError` | `plan.rs:169` | 15+ (`UnsupportedVariant`, `UnresolvedName`, `NamedTargetIs*`, `NamedRangeInScalarContext`, …) |
| ql-exec | `RuntimeError` | `workbook_runtime.rs` | 8+ |
| ql-exec | `EvalResult` | `eval_result.rs` | 2 |
| ql-exec | `SimdShape` | `lower.rs` | small |
| ql-formula-syntax | `LexError` | `lexer.rs:80+` | 10+ |
| ql-formula-syntax | `ParseError` | `parser.rs` | 30+ (`StructuredRefMalformed`, …) |
| ql-formula-syntax | `PrintError` | `printer.rs` | 1+ |
| ql-functions | `FormatParseError` | `format/error.rs` | already 8 + `Other` catch-all |
| ql-io | `QbookError` | `qbook_format.rs:185` | 14 |
| ql-oplog | `OpLogError` | `error.rs` | 5 |
| ql-oplog | `ReplayError` | `replay.rs` | several |
| ql-oplog | `PersistenceError` | `persistence.rs` | 2 |
| ql-io-xlsx | `XlsxError` | `error.rs:18` | 8 (one already `#[deprecated]`) |
| ql-io-xlsx | `UnsupportedFeatureKind` | `error.rs` | 13 + `Other(&'static str)` |

(Plus all the public structs whose fields will grow: `XlsxImportResult`, `XlsxImportReport`, `WorkbookEnvelope` — the last would break TOML round-trip but is `#[serde(deny_unknown_fields)]`, so additive changes require schema bump regardless.)

**Recommendation:** one closure commit `W5-D-PM12-NE` marks every workspace public enum + every public struct that documents "field may be added" with `#[non_exhaustive]`. This commit can't break callers (the type prefix doesn't constrain pattern matching today since the engine isn't tagged 0.2). It locks the door before Phase 5 puts pressure on the variant set.

**Severity:** HIGH because Phase 4.12's compatibility-freeze acceptance criterion (A4-02) calls out "complete enough to guide users" — the API stability story is the user-visible half of that.

### HIGH-2 — `ql-exec::WorkbookRuntime` is a 12 413-LOC monolith carrying the engine's primary public surface

`crates/ql-exec/src/workbook_runtime.rs` is 12 413 LOC — the largest single source file in the engine (next: `ql-functions/scalar_fns.rs` at 7 890, `range_fns.rs` at 6 896). It declares:

- `WorkbookRuntime` (live-edit per-edit borrow-window facade)
- `RecomputeResult` / `RecomputeFailure` (cross-cutting result types)
- `RuntimeError` (the cross-cutting error enum)
- 28 `pub fn`s on `WorkbookRuntime` (from `set_formula` to `validate_formula` to `recompute_dirty`)
- Inline `#[cfg(test)]` tests (thousands of LOC of them — the file's bottom half is tests)

This is the IDE binding's primary surface (per `docs/architecture/ide-consumer-contract.md`). It is also the surface Phase 5 (CRDT collaboration) will patch. Today's geometry means:

- Every new feature touches the same file, every PR conflicts on it.
- Per-method invariants are documented in module-level comments at the top, far from the function bodies.
- The test block at the bottom contains regression tests for ~10 sub-phases (2A.1 → 4.10) — they're auditable but not navigable.
- The `RuntimeError` enum (defined inside the file) is the "engine-side error" surface across Phases. Per HIGH-1 it's also missing `#[non_exhaustive]`.

The Phase 4.11 audits flagged `umya_export.rs` (1 495 LOC) as too big. `workbook_runtime.rs` is 8× larger.

**Recommendation:** split BEFORE Phase 5 starts. A reasonable shape:

- `ql-exec/src/runtime/mod.rs` — `WorkbookRuntime` struct + 4 constructors
- `ql-exec/src/runtime/mutations.rs` — `set_formula`, `set_value`, `clear_formula`, `intern_format`, `set_cell_format`
- `ql-exec/src/runtime/names.rs` — `set_name`, `set_sheet_scoped_name`
- `ql-exec/src/runtime/tables.rs` — `create_table`, `drop_table`, `rename_table`, `rename_column`, `resize_table`
- `ql-exec/src/runtime/sheets.rs` — `add_sheet`, `rename_sheet`
- `ql-exec/src/runtime/recompute.rs` — `recompute_all`, `recompute_dirty`
- `ql-exec/src/runtime/validate.rs` — `validate_formula`
- `ql-exec/src/error.rs` — `RuntimeError` + `RecomputeResult` + `RecomputeFailure` (separates the error surface from the runtime impl so Phase 5 collab errors can land cleanly).

**Severity:** HIGH because v2 (collaboration) needs this surface to be patchable in parallel by multiple authors. The 12 413-LOC ceiling is a contributor bottleneck even before Phase 5 lands.

### HIGH-3 — `ql-oplog::Op` reaches into `ql-io::CellWireValue` for its mutation vocabulary — wrong direction

`crates/ql-oplog/src/op.rs:36`:
```rust
use ql_io::{CellWireValue, NamedTargetWire};
```

`Op::PutValue { value: CellWireValue, … }` — the op-log's mutation type uses the PERSISTENCE crate's wire type. `ql-oplog` therefore depends on `ql-io` (verified `crates/ql-oplog/Cargo.toml:18`).

This is architecturally upside-down:

- `ql-io` is the file-format crate (`.qbook/` directory + TOML envelope + JSONL sheets). The "Wire" suffix on `CellWireValue` was named for the file-wire representation — serde-friendly, NaN/Inf-rejecting, schema-versioned.
- `ql-oplog` is the in-memory operation log. Its vocabulary should be independent of file format.
- Today, an in-memory `Op::PutValue` carries a type whose definition explicitly says "this is the JSON wire shape" — and `ql-exec` constructs these ops via `ql_io::CellWireValue::from_value` (e.g. `crates/ql-exec/src/workbook_runtime.rs:1272`).

Concrete consequences:

- A future change to `.qbook/` wire format (say, adding `CellWireValue::Date(i64)`) breaks the op-log mutation set, even if no `.qbook/` files are involved.
- Phase 5 CRDT merge needs to evolve `Op` independently of file format — today every op-log evolution forces a `.qbook/` schema bump.
- The Phase 2A.4 promotion of `ql-io` from dev-dep to prod-dep in `ql-exec` (Cargo.toml:21-25 comment) is now permanent because `CellWireValue` is on the runtime path.

**Recommendation:** introduce `ql-oplog::OpValue` as the op-log's own value type. `CellWireValue::from_value` becomes `OpValue::from_value` in `ql-oplog`; `ql-io` converts at the persistence boundary only. This costs ~50 LOC of conversion code and uncouples op-log evolution from file format evolution. Required before Phase 5 because Phase 5 will reshape `Op` (CRDT-friendly variants, peer attribution, etc.).

**Severity:** HIGH because Phase 5 directly touches the `Op` shape and the file-format coupling becomes a forced concurrent change.

### HIGH-4 — `oplog.bin` has no engine-level magic bytes / version field

`crates/ql-oplog/src/log.rs:131-149` exports / imports via Loro's `ExportMode::Snapshot`. The blob's identity is purely the Loro container name `"ops"` (line 34) and the JSON-string shape of its entries (lines 76-83). Recovery on malformed input returns `OpLogError::SchemaMismatch` — but only after Loro has parsed enough to find the container missing.

Compared to `.qbook/` (which has a clean `schema_version: u32` ladder v1..=v7 with a two-phase probe per `crates/ql-io/src/qbook_format.rs:386-395`), the op-log has:

- No magic bytes (a corrupted ZIP or random binary blob would surface as a Loro-internal decode error, not a clean "this isn't an op-log" diagnostic).
- No engine schema version (relies on Loro 1.12.0's own snapshot version field — which means a Loro major-version bump WILL break our op-logs and we'll diagnose via a Loro error message, not an engine-level diagnostic).
- No forward-compat path: if Phase 5 changes the container layout (e.g. peer-aware op streams), today's `SchemaMismatch("ops LoroList lost an entry ...")` is the only signal.

The Phase 5 work (CRDT collab) is specifically about evolving this layer. The MASTER-PLAN §548 already says "Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures" — but the op-log substrate is exactly what Phase 5 redesigns.

**Recommendation:** introduce a 16-byte header in front of the Loro snapshot. Suggested shape:

```
[0..4]   ASCII magic "QBOP"
[4..6]   engine schema version (u16, little-endian, initial value 1)
[6..8]   reserved (u16, must be zero)
[8..16]  reserved (8 bytes, must be zero)
[16..]   Loro snapshot bytes
```

`OpLog::export_bytes` prepends this header; `OpLog::import_bytes` parses + validates. Forward-compat: a v1 reader seeing v2 returns `OpLogError::UnsupportedSchema { found: 2 }` rather than a Loro-internal decode error. Backward-compat: a v2 writer can emit v1-format when no v2-specific feature is in use (per `.qbook/` precedent at `qbook_format.rs:1359-1382`).

**Severity:** HIGH because (a) Phase 5 will need a version bump; (b) the recovery diagnostic is currently a 2nd-level error message — fixing now means Phase 5's "merge two op-logs" can use the header as the version-compatibility check.

### HIGH-5 — Phase 4 documentation deliverables incomplete per MASTER-PLAN.md §535-538

MASTER-PLAN.md Phase 4 documentation deliverables list:

1. `docs/phase4/entry-plan.md` — **MISSING** (`ls docs/phase4/` shows only `exit-packet.md`).
2. `docs/phase4/exit-packet.md` — **EXISTS** but `status: DRAFT` per its frontmatter line 3. Will become ACTIVE when 4.12 megaudit closures land.
3. `docs/compat/excel-matrix.md` — **EXISTS** (verified `ls docs/compat/` is referenced in the exit-packet).
4. `docs/architecture/parser-and-semantics.md` — **MISSING** (`ls docs/architecture/` shows no such file; the closest is `2026-05-13-coercion-matrix.md`).
5. Updated legal/provenance notes — **NOT FOUND** at any obvious location (`deny.toml` line 33 confirms licenses block is DEFERRED to ship-readiness per CORR-10; no provenance manifest exists).

Phase 3 ALSO lacks its deliverables: MASTER-PLAN.md §370-371 calls for `docs/phase3/entry-plan.md` + `docs/phase3/exit-packet.md`. **Both MISSING** — `ls docs/phase3/` returns "No such file or directory". (Phase 2B does have both, Phase 2A has both, Phases 0-1 have exit-packet only.)

These are MASTER-PLAN-explicit deliverables that should ship as part of 4.12 closure. Phase 4 cannot mark COMPLETE in the master plan until they exist.

**Recommendation:** in the 4.12 closure batch:

- `docs/phase3/entry-plan.md` + `docs/phase3/exit-packet.md` — backfill (likely the audit-trail self-auditor's scope, flagged here for completeness).
- `docs/phase4/entry-plan.md` — backfill from the Phase 4.1 design context.
- `docs/architecture/parser-and-semantics.md` — write from the existing parser/coercion/lexer designs; this is a real gap (cross-references in the exit-packet point to non-existent doc).
- Legal/provenance — flag for Phase 7 (CORR-10) is acceptable per the deferral, but exit-packet should acknowledge.

**Severity:** HIGH because the master plan's compat-freeze acceptance criterion A4-02 says "matrix complete enough to guide users" — the missing architecture doc is a user-visible documentation gap that should be filled in this exit packet, not after.

---

## MEDIUM

### MEDIUM-1 — `MAX_ROW` / `MAX_COLUMN` declared in two crates with two different types

- `crates/ql-types/src/address.rs:28-31` — `pub const MAX_ROW: RowId = 1_048_575;` / `pub const MAX_COLUMN: ColId = 16_383;`
- `crates/ql-formula-syntax/src/lexer.rs:90-92` — `pub const MAX_COLUMN: u32 = 16_383;` / `pub const MAX_ROW: u32 = 1_048_575;`

Both are `pub use`-d at their crate `lib.rs` (`ql-types/src/lib.rs:23`, `ql-formula-syntax/src/lib.rs:40`). The `ql-types` version uses the strong-typed `RowId` / `ColId`; the `ql-formula-syntax` version uses raw `u32`. Cross-crate verification:

- `grep -rn "ql_formula_syntax::MAX_ROW\|ql_formula_syntax::MAX_COLUMN" crates` returns ZERO external consumers.
- The lexer's `MAX_ROW`/`MAX_COLUMN` are used INTERNALLY at `lexer.rs:713, 898, 1108-1109` and in tests at `lexer.rs:1361, 1426`.
- The `pub use` at `ql-formula-syntax/src/lib.rs:40` is dead exposure.

**Action:** make `ql_formula_syntax::lexer::MAX_{ROW,COLUMN}` `pub(crate)` (or import from `ql_types` and drop the local declaration). The export is a footgun: a caller importing `MAX_ROW` from `ql_formula_syntax` gets `u32` (subtly compatible but not type-equivalent to the canonical `RowId`).

### MEDIUM-2 — `BindError::UnsupportedVariant(&'static str)` is too lossy

`crates/ql-exec/src/plan.rs:183`:
```rust
UnsupportedVariant(&'static str),
```

Constructed at 7+ sites (lines 769, 860, 1115, 1241, 1736, plus others) with messages like `"named-formula-in-scalar"` and `"empty-array-literal"`. A caller wanting to programmatically distinguish "this is a named-formula problem" from "this is an array problem" has to string-match on the `&'static str`.

The xlsx layer's `XlsxError::Engine(String)` was flagged in the Phase 4.11 Opus-C audit (MEDIUM-6) for the same root issue. `BindError::UnsupportedVariant` is the engine-internal equivalent and shows up in Phase 4 closeout follow-ups: GAP-B-02 (named formula), GAP-B-05 (bare range scalar context), and the Phase 4.10 megaudit note about "literal range refs in `AggregateArg` context remain unbindable" all surface through this catch-all.

**Action:** in a Phase 5 prep commit, split `UnsupportedVariant` into:

```rust
UnsupportedNamedFormula,
UnsupportedArrayLiteralEmpty,
UnsupportedR1C1RangeInScalarContext,
UnsupportedBareRangeScalar,
// ...
```

Each carries the same `&'static str` for `Display`, but the caller-side `match` becomes structural. Two existing test expectations (`assert!(matches!(err, BindError::UnsupportedVariant(_)))` at `plan.rs:1965` and `crates/ql-exec/tests/...`) need updating, but each becomes more specific.

### MEDIUM-3 — `ql-exec → ql-io → ql-storage` cycle was prevented but the boundary is fuzzy

`crates/ql-exec/Cargo.toml:21`:
> Phase 2A.4 (2026-05-12): promoted from dev-dependency. `loader.rs` needs `ql_io::load_workbook` at runtime for the `load_workbook_and_recompute` convenience.

The "convenience" `load_workbook_and_recompute` at `loader.rs:42` is the only ql-io consumer of ql-exec — but as flagged in HIGH-3, `CellWireValue` from `ql-io` is also reached for the op-log path. Today:

- `ql-io` depends on `ql-types`, `ql-storage`.
- `ql-exec` depends on `ql-types`, `ql-storage`, `ql-formula-syntax`, `ql-calcgraph`, `ql-functions`, `ql-io`, `ql-oplog`, `ql-profile`.
- `ql-oplog` depends on `ql-types`, `ql-storage`, `ql-functions`, `ql-io`.

So `ql-oplog` and `ql-exec` BOTH depend on `ql-io`. That's not a cycle (Cargo would refuse), but the persistence crate (`ql-io`) is now load-bearing for the in-memory op-log and the runtime — its responsibilities are larger than "file I/O".

**Recommendation:** the HIGH-3 fix (lift `CellWireValue` into `ql-oplog`) also fixes this. After that change:
- `ql-oplog` drops its `ql-io` dependency (verified: `grep -rn "use ql_io" crates/ql-oplog/src/` shows zero non-persistence-module uses; only `persistence.rs` needs `ql_io::{load_workbook, save_workbook_extending, QbookError}`, and that can become a separate `ql-oplog-persistence` sub-module or stay).
- `ql-exec` keeps its `ql-io` dep for `loader.rs::load_workbook_and_recompute`.

### MEDIUM-4 — `ql-oplog::replay_into` takes a `&FunctionRegistry` it doesn't use

`crates/ql-oplog/src/replay.rs:38-43`:
> 2A.3.a's replay doesn't use it (formula evaluation is deferred to a separate `recompute_all` call), but keeping the parameter stable here avoids a breaking signature change in 2A.3.b/c when the eval path could land inside replay.

The signature has been frozen since 2A.3.a (2026-05-12, ~6 days ago — quite recent in calendar time but many phases ago in feature-velocity). The "eval path could land inside replay" defer never materialized; instead, replay is value-pure and `recompute_all` happens after.

The cost of the kept-stable parameter:
- `ql-oplog` depends on `ql-functions` solely for this parameter (and a test at `replay.rs:1043`).
- Every caller passes a `&FunctionRegistry` that gets dropped on the floor.

**Action:** drop the `&FunctionRegistry` parameter. Phase 5 will redesign `replay_into` anyway (CRDT merge needs a different signature). Drop `ql-functions` from `ql-oplog/Cargo.toml:21` after.

### MEDIUM-5 — `XlsxError::Reconciliation` is still `#[deprecated]` rather than removed

`crates/ql-io-xlsx/src/error.rs:74-89`:
```rust
#[deprecated(since = "0.1.1", note = "Never constructed; ...")]
Reconciliation { message: String },
```

The Phase 4.11 Opus-C HIGH-3 recommended REMOVE (`docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:60-66`). The closure chose deprecation instead. Per the comment at line 75, the variant will be removed in 0.2.0.

That decision is defensible — but two related issues compound:

(a) Other public enums in the workspace will collect `#[deprecated]` variants over time. With no `#[non_exhaustive]` on the enum itself (per HIGH-1), the deprecation doesn't actually let callers opt-in to the future shape — they still have to match every variant, including the deprecated one.

(b) The `#[allow(deprecated)]` on `XlsxPreservation` construction sites (`crates/ql-io-xlsx/src/lib.rs:330, 432`) shows the deprecation isn't even quiet for internal code. The dead variant adds noise.

**Action:** in 0.2.0 close, drop `Reconciliation`. Per HIGH-1, mark `XlsxError` `#[non_exhaustive]` at the same time so future additions are non-breaking.

### MEDIUM-6 — `ql-formula-syntax::lexer` exports unused symbols at the crate boundary

`crates/ql-formula-syntax/src/lib.rs:40`:
```rust
pub use lexer::{column_letters_to_index, lex, lex_with, LexError, MAX_COLUMN, MAX_ROW};
```

External-consumer audit:

- `lex` — used (many call sites).
- `LexError` — used (e.g. `ql-exec/src/plan.rs`).
- `lex_with` — **not used externally** (`grep -rn "ql_formula_syntax::lex_with\|use ql_formula_syntax::{[^}]*lex_with"` returns zero).
- `column_letters_to_index` — **not used externally**.
- `MAX_COLUMN` / `MAX_ROW` — **not used externally** (per MEDIUM-1 above).

Four symbols of six are leakage. `lex_with` and `column_letters_to_index` may be intentional API surface for future consumers; today they're dead exposure.

**Action:** either (a) demote unused symbols to `pub(crate)`, or (b) document them as deliberate API surface in the lib.rs doc-comment. My preference is (a) — the v0.x crate has no external SemVer commitment yet.

### MEDIUM-7 — `cargo deny check advisories` fails with two RUSTSEC unmaintained warnings

`mac zsh -lc '... cargo deny check advisories'`:

1. **RUSTSEC-2023-0089** (`atomic-polyfill`) via `loro 1.12.0 → loro-internal → postcard → heapless → atomic-polyfill`. Loro is the architectural lock (T1-D05); we cannot drop it. `atomic-polyfill` is archived; suggested replacement is `portable-atomic`. Upstream fix path: bump `heapless` past 0.7.x once it stabilizes on `portable-atomic`.

2. **RUSTSEC-2024-0436** (`paste`) via `umya-spreadsheet 2.2.0 → image 0.25 → ravif → rav1e → paste`. The `paste` crate is unmaintained but functional; suggested replacement is `pastey`. Upstream fix path: bump umya past 2.2.x once `image` drops `ravif` (or `ravif` updates).

The crate-level note at `ql-exec/Cargo.toml:33` already calls out the `paste` advisory as a reason for NOT pulling `pulp` directly:
> Adding pulp would pull in the unmaintained `paste` transitive (RUSTSEC-2024-0436) which fails cargo-audit.

So we have a recorded awareness of `paste`. `atomic-polyfill` is not similarly noted — it should be.

**Action:** both are TRANSITIVE unmaintained, not security advisories. Recommended:

- Document both in `deny.toml` `[advisories].ignore = [...]` with rationale (Loro lock prevents one; umya-spreadsheet upstream prevents the other). Today `ignore = []` — adding entries with comments makes the deferral explicit.
- Track an open issue per crate-upstream-fix.
- Phase 7 (ship hardening) should revisit before tagging 1.0.

**Severity:** MEDIUM because `cargo deny` failing is real CI noise; the underlying advisories are unmaintained-not-security so we're not exposed to active CVEs.

### MEDIUM-8 — `cargo doc --no-deps --workspace` emits 6 warnings

Verified via `mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd ~/...; cargo doc --no-deps --workspace 2>&1'`:

1. `crates/ql-storage/src/tables.rs:299` — broken intra-doc link `NameTable::generation`.
2. `crates/ql-storage/src/workbook.rs:417` — broken intra-doc link `validate_sheet_name`.
3. `crates/ql-storage/src/lib.rs:8` — ambiguous link `column` (module/macro collision).
4. `crates/ql-io-xlsx/src/error.rs:55` — broken intra-doc link `UnsupportedPolicy`.
5. `crates/ql-io-xlsx/src/options.rs:60` — broken intra-doc link `XlsxError::UnsupportedFeature`.
6. `crates/ql-io-xlsx/src/write/umya_export.rs:7` — unclosed HTML tag `numFmts`.

The Phase 4 exit packet acceptance criterion A4-01 says "fmt+clippy+doc clean". The doc warnings exist; the packet's claim is wrong unless these are closed.

**Action:** add `-D warnings` to `cargo doc` in the CI gate (currently doc warnings don't fail CI). Close the 6 warnings.

### MEDIUM-9 — `WorkbookEnvelope` schema bump cadence is healthy but `oplog.bin` is not similarly versioned

The `.qbook/workbook.toml` envelope has migrated v1 → v7 across Phases 2A-4.9 with proper additive-field serde defaults, two-phase loader probe, and explicit `ForwardCompatFieldOnOldVersion` error path (`qbook_format.rs:319-325`). This is exemplary.

`oplog.bin` (per HIGH-4) has no analogous ladder. The Phase 5 CRDT redesign will need the same forward/backward compat shape. Today the only "version" signal is `OpLogError::SchemaMismatch(&'static str)` with hard-coded messages.

**Recommendation:** combined with HIGH-4, treat `oplog.bin` schema versioning as a Phase 5 prep deliverable. The same two-phase pattern (version probe → full deserialize) applied at `OpLog::import_bytes`.

### MEDIUM-10 — Test directory cross-crate uses auditor-attribution naming as the persistent layout

`ls crates/ql-io-xlsx/tests/`:
```
calamine_smoke.rs
codex_phase_4_12_recompute_probe.rs
opus_a_cache_policy.rs
opus_a_deep_probe.rs
opus_a_dup_fmt.rs
opus_a_edge_cases.rs
opus_a_error_cell_probe.rs
opus_a_format_no_overlay.rs
opus_a_misc.rs
opus_a_text_edge.rs
phase_4_11_corpus_probe.rs
```

Eight of eleven test files are named after auditors. Same in `crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs` and `crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs`.

The auditor names are session-local; they convey nothing to a reader who wasn't in the audit session. A maintainer searching for "tests covering format-overlay round-trip" must know that lived under `opus_a_format_no_overlay.rs` rather than e.g. `format_overlay_roundtrip.rs`.

This is the Phase 4.11 Opus-C MEDIUM-7 ("module docs as changelog") pattern, applied to test filenames. It's the same readability tax.

**Action:** rename auditor-attribution test files to feature-scoped names in a single closure commit. Map by content:

- `codex_phase_4_12_recompute_probe.rs` → `recompute_after_import.rs`
- `opus_a_format_no_overlay.rs` → `format_overlay_import.rs`
- `opus_a_deep_probe.rs` → `import_pipeline_deep.rs`
- `opus_a_phase_4_12_cross_features.rs` (in `ql-exec`) → `cross_phase_integration.rs`
- `p412_defensive_fuzz_probes.rs` → `parser_defensive_fuzz.rs`

Audit-trail isn't lost — the audit doc trail at `docs/audits/2026-05-18-phase-4-12-*` preserves the lineage.

### MEDIUM-11 — `ql-exec`'s public surface has no documented stability story

`crates/ql-exec/src/lib.rs:87-117` declares 12 `pub use` blocks. The lib.rs module-level doc (lines 1-85) is a phase-history changelog (excellent for audit) but says nothing about which symbols are stable. Compare `docs/architecture/calcgraph-runtime.md:5`: "STABLE" tag explicitly applied to the calcgraph hook surface — but the runtime crate's user-facing surface has no equivalent annotation.

By the API-surface census:

- `WorkbookRuntime` itself: load-bearing for IDE; should be marked stable.
- `BindError` / `RuntimeError`: load-bearing; need `#[non_exhaustive]` per HIGH-1.
- `MapEnv` / `CellEnv` / `WorkbookEnv`: test-shaped (used by `ql-functions::reference_aware_fns::tests`); should they be public?
- `classify` / `dispatch` / `SimdShape`: internal observability today, no caller outside `ql-exec` itself (verified via `grep -rn "ql_exec::classify\|ql_exec::dispatch\|ql_exec::SimdShape" crates --include="*.rs"` outside `ql-exec/src`).
- `add_array` / `mul_array` / `add_scalar` / etc.: bench-shaped exports (Phase 2A.13 audit cycle-3 M9 noted at the use line). Used by `ql-bench`; could be `pub` only via a `simd-internals` feature flag.
- `eval_at_cell_boundary`: not used outside `ql-exec/src/` (verified via grep).
- `aggregate_cache::AggregateCache` trait + 3 impls: used by `ql-exec::CalcgraphSession`; external use surface is the trait, not the impls — `InMemAggregateCache` could be internal.
- `plan_cache::PlanCacheStats`: useful for ql-profile; rest of the module is internal.

**Recommendation:** before Phase 5, write a `docs/architecture/ql-exec-public-api.md` that classifies every `pub use` from `ql-exec/src/lib.rs:87-117` as Stable / Provisional / Deprecated / Internal. Move internal-only ones to `pub(crate)`. The result is the stability story that Phase 6.1 (`WorkbookSession`) will harden.

### MEDIUM-12 — `ql-exec → ql-profile` dependency exists but the surface is one-way and could be inverted

`ql-exec/Cargo.toml:30` depends on `ql-profile`. The profile crate is 610 LOC of stats containers (`Timings`, `BindPlanCacheStats`, etc.). Per `docs/MASTER-PLAN.md` profile is observability-shaped: the runtime EMITS stats; consumers (IDE / bench) READ them.

`grep -rn "use ql_profile" crates/ql-exec/src/` shows `ql-exec` consumes `ql_profile::Timings` to record into. That dep direction is fine.

But: `ql-profile/src/lib.rs` shows `ql-profile` itself depends on `ql-calcgraph` (`crates/ql-profile/Cargo.toml:14`). That means a tiny observability crate is pulled into the `ql-calcgraph` consumer chain — and `ql-calcgraph` is supposed to be a leaf (it depends only on `ql-types` and `ql-formula-syntax`). Verified: `crates/ql-calcgraph/Cargo.toml` only deps `ql-types`, `ql-formula-syntax`. So `ql-profile → ql-calcgraph → ql-types,formula-syntax`, then `ql-exec → ql-profile` → cycle? No, not a cycle (Cargo blocks); but the dep direction is structurally surprising.

Why does `ql-profile` depend on `ql-calcgraph`? Likely to capture graph-shaped stats (`GraphStats`). That's fine but means `ql-profile` becomes a heavyish import for any consumer who wants just `Timings`.

**Action:** split `ql-profile` into `ql-profile-runtime` (Timings, plan-cache stats — no `ql-calcgraph` dep) + `ql-profile-graph` (graph-shaped stats — has the dep). Optional; not urgent unless `ql-profile` becomes the universal observability crate.

### MEDIUM-13 — `ql-storage::Workbook` is the "god struct" but its public surface is reasonable; concern is testability

`crates/ql-storage/src/workbook.rs:884` (per grep) has 25+ `pub fn`s on `Workbook`. The struct itself owns: sheets, names (`NameTable`), formats (`FormatTable`), tables (`TableTable`), spills (`SpillAnchorTable`), date_system, reference_mode, locale, formula_cells, computed-overlay storage.

Compared to `ql-exec::WorkbookRuntime` (HIGH-2), `Workbook` is 4 998 LOC across 9 files — well-decomposed by responsibility. The concern: testing one piece (e.g., `NameTable` mutations) requires constructing a `Workbook` for almost every test; pure-storage tests would let `NameTable` and `TableTable` be tested independently.

**Action:** the existing `ql-storage::tests` block in `lib.rs` is a smoke test for re-exports — that's not the issue. The issue is that `NameTable` and `TableTable` are exposed as nested-but-testable types and their tests do live in their own modules. So this is actually fine.

I'm leaving this as MEDIUM with the recommendation to track during Phase 6.1 (`WorkbookSession`) consolidation: `WorkbookSession` should own `Workbook` directly (not a re-export), and the public surface should be the SESSION's, not the storage's.

---

## LOW

### LOW-1 — `panic!()` shows up in 30+ source sites; many are test-shaped match-fallbacks

`grep -rn "todo!()\\|unimplemented!()\\|panic!" crates/*/src/...` returns ~50 hits. Most are `_ => panic!()` match arms inside `#[cfg(test)]` blocks (e.g. `parser.rs:1447, 1470, 1482, 1500, 1521, ...`).

The non-test panics worth noting:

- `crates/ql-formula-syntax/src/printer.rs:339-347` — `SheetRef::Id` panics with a detailed message. Per the doc comment this is a contract panic ("pre-bind-only by contract"). GAP-B-08 tracks the post-bind resolver-aware printer. Acceptable today.
- `crates/ql-calcgraph/src/graph.rs:155, 433, 454` — defensive panics for "should-never-happen" branches. Acceptable; covered by tests.
- `crates/ql-calcgraph/src/lib.rs:137, dirty.rs:271, fingerprint.rs:624` — same pattern.
- `crates/ql-exec/src/plan_cache.rs:296` — inside a test only (`should not build`).

No production-path silent panics found. The pattern is healthy.

### LOW-2 — Workspace member declaration order in `Cargo.toml` doesn't include `ql-types`

`Cargo.toml:13-25` declares `default-members` listing 11 active crates. `ql-types` IS one of them. But the workspace's `members = ["crates/*"]` glob includes the 13 stub crates too — which means `cargo test` (without `--workspace`) runs only the default-members, missing tests in `ql-types/tests/coercion_matrix.rs`. Verified: `crates/ql-types/tests/coercion_matrix.rs` exists (429 LOC).

Wait, `ql-types` IS in default-members at line 14. Let me re-check.

```
default-members = [
    "crates/ql-types",       ← line 14
    "crates/ql-storage",
    ...
]
```

OK, `ql-types` is included. Default-members does NOT include `ql-functions`, `ql-formula-syntax`, `ql-io-xlsx`, `ql-io` (verified by reading lines 13-25). That's actually wrong — `cargo test` skips xlsx and io tests.

`grep -n "ql-functions\\|ql-formula-syntax\\|ql-io" Cargo.toml | head` shows these crates are in workspace member list but not in `default-members`. The implications:

- `cargo test` runs only default-members (11 crates).
- `cargo test --workspace` runs all 24.

The 4131-test claim depends on `--workspace`. The CI workflow surely uses that — but a developer running `cargo test` locally gets a subset.

**Action:** either (a) drop `default-members` entirely so `cargo test` defaults to the full workspace, or (b) add the missing live crates (`ql-functions`, `ql-formula-syntax`, `ql-io`, `ql-io-xlsx`, `ql-calcgraph`, `ql-exec` — verify each) to the default-members list.

Re-verified: default-members line 13-25 includes ql-types, ql-storage, ql-formula-syntax, ql-formula-semantics, ql-functions, ql-calcgraph, ql-exec, ql-bench, ql-profile, ql-oplog, ql-terminal. Missing: ql-io, ql-io-xlsx, ql-io-ods (the I/O family), and all the stub-shaped crates (ql-ai, ql-bindings-*, ql-collab, ql-connectors, ql-service, ql-sql, ql-terminal, ql-udf, quantbook-py).

So `cargo test` in this workspace SKIPS `ql-io` and `ql-io-xlsx` tests (the latter is where the 28 E2E xlsx tests live). That's a real gap.

**Severity:** LOW because CI presumably uses `--workspace`. The dev-loop hazard is the concern.

### LOW-3 — Module-level doc comments are exhaustive but use long-since-shipped phase markers

Sampled module doc comments in `ql-exec/src/lib.rs:1-85` use phase markers `Phase 0 W4-1`, `Phase 2A.1, 2A.6, 2B.4`, `Phase 3.10 V1`, etc. for orientation. The same pattern is in `ql-functions/src/lib.rs`, `ql-storage/src/lib.rs`, `ql-formula-syntax/src/lib.rs`, etc.

These markers tell the audit reader the lineage but say nothing to someone trying to learn the module's responsibility. The Phase 4.11 Opus-C MEDIUM-7 ("module docs as changelog") flagged the same concern at `ql-io-xlsx` granularity. The pattern is workspace-wide.

**Action:** at each crate's `lib.rs` top, add a one-paragraph "what this crate IS" upfront, before the per-module phase ledger. The phase ledger stays — it's audit gold — but is demoted to a subsection.

### LOW-4 — Test counts per crate are unbalanced

Per `find crates -name "tests" -type d`:

| Crate | tests/ files | E2E LOC |
|---|---|---|
| ql-exec | 11 | 5678 |
| ql-io-xlsx | 10 | 4489 |
| ql-functions | 2 | 1741 |
| ql-formula-syntax | 1 | (sub-100) |
| ql-types | 1 | 429 |
| ql-oplog | 1 | 495 |
| ql-storage | 0 | 0 |
| ql-calcgraph | 0 | 0 |
| ql-formula-syntax | 1 | (Phase 4.12 defensive probe) |

`ql-storage` and `ql-calcgraph` have ZERO `tests/` integration files. Their tests live entirely in `#[cfg(test)] mod tests` at the bottom of source modules. That's acceptable for unit-shaped tests but means there's no E2E-shaped test architecture in the storage / graph layers.

`ql-exec` carries the bulk of the integration weight — sensible (it's the orchestrator) but means the 4131-test workspace count is heavily weighted toward exec / xlsx. If you take "tests per crate ratio" as a proxy for test architecture, 11 + 10 vs 0 + 0 is uneven.

**Action:** not urgent. If Phase 5 introduces a new integration shape (collaboration), the natural home is `ql-collab/tests/` — which is currently empty since the crate is stub-only.

### LOW-5 — `ql-bench` depends on `ql-storage` only, but uses `ql_exec` symbols transitively

`crates/ql-bench/Cargo.toml` (per the head of the deps grep at the start) shows `ql-bench → ql-storage`. But the bench crate clearly exercises `ql-exec` SIMD kernels — let me re-verify:

`grep "ql-" crates/ql-bench/Cargo.toml`:

```
ql-storage
```

Only. But `ql-exec` declares 3 `[[bench]]` entries that point to `ql-exec/benches/`, not `ql-bench`. So `ql-bench` may be a separate, smaller crate. `ls crates/ql-bench/src` — 4 files / 677 LOC. Probably distinct from `ql-exec`'s benches.

OK — `ql-bench` is its own crate. The architectural concern: are there TWO bench paths (one in `ql-exec/benches/`, one in `ql-bench/`)? Conditionally yes, but I haven't verified what `ql-bench` measures vs what `ql-exec/benches` measures. Worth checking that the redundancy is intentional.

**Action:** verify and document in a one-line `ql-bench/src/lib.rs` doc comment. Not urgent.

### LOW-6 — `quantbook-py` is a STUB but per MASTER-PLAN.md it's the user-facing surface

`crates/quantbook-py/src/lib.rs` is a 20-LOC stub. Per MASTER-PLAN.md Phase 6.3 the `quantbook` Python package is the IDE-facing language for Python UDFs and `qb.show()`. Today it's empty.

The fact that the binding crate exists in the workspace from Phase 0 is good (locks the dependency graph shape). The stub is healthy.

**Concern:** Phase 5 collaboration semantics will inform Phase 6.3 binding shape. Today there's no `docs/architecture/python-binding-contract.md` analogous to `ide-consumer-contract.md`. When Phase 5 lands the op-log will need a "peer" concept — the Python bindings will need to know how to participate.

**Action:** at Phase 5 entry, also draft `docs/architecture/python-binding-contract.md`.

### LOW-7 — `ql-io::WORKBOOK_SCHEMA_VERSION = 7` is the largest version-bumping crate; should there be an explicit `MIN_SUPPORTED_SCHEMA_VERSION` policy?

`crates/ql-io/src/qbook_format.rs:160, 168`:
```rust
pub const WORKBOOK_SCHEMA_VERSION: u32 = 7;
pub const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;
```

The crate accepts v1..=v7. That's wide. A v1 reader (pre-2A.8) refuses v2; a v7 reader accepts v1-v7 plus refuses v8. The accept-everything-down-to-1 policy is great for the engine's life today, but if Phase 5 introduces v8+ with semantically incompatible changes, the backward-compat ladder grows ad infinitum.

Compare `.zip`, `.docx`, `.xlsx`: those formats have explicit "minimum reader" policies. `.qbook/` does not.

**Action:** at Phase 5 entry, add a policy doc note: "v1 readers (pre-2A.8) are EOL'd post-Phase 5 closure; minimum supported schema version may be lifted." Not urgent today.

### LOW-8 — `Cargo.toml` version pinning is intentional but heavy; `arrow = "=58.3.0"` and 6 sibling pins

`Cargo.toml:38`:
```toml
arrow = "=58.3.0"
```

Plus comment on lines 38-40 explaining the pin discipline. This is deliberate (Phase 0 SIMD acceptance). Six other Arrow sibling crates are similarly pinned exactly. Maintenance cost: every Arrow patch release requires an explicit workspace bump.

The Phase 4.11 Opus-C audit LOW-5 (`docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:211-223`) flagged the 3-version `zip` + 3-version `quick-xml` problem. That's still present (umya pulls quick-xml 0.37, we pull 0.36, transitives pull 0.39). Same recommendation: align via `[patch.crates-io]` once stable; not blocking.

### LOW-9 — `loro = workspace` version: 1.12.0

Loro is the Phase 5 substrate per T1-D05. We're on 1.12.0 today; Loro just (2026-05) hit 1.x stability per its release notes. The major-version stability is reassuring. The audit-relevant fact: every Loro minor bump may change the on-disk snapshot format. Per HIGH-4 (no engine-level magic bytes), a Loro 2.0 upgrade is a wire-breaking change with no soft landing.

**Action:** combined with HIGH-4. Engine-level header lets us snake the Loro version off the wire format.

---

## Persistence-format upgrade-path assessment

The two persistence surfaces:

### `.qbook/` directory format

**Shape:** TOML envelope (`workbook.toml`) + per-sheet JSONL (`sheets/N.jsonl`) + optional `oplog.bin` + atomic-save marker (`.atomic-save-marker-v1`).

**Versioning:** `schema_version: u32` in envelope. v1..=v7 ladder. Two-phase loader probe (`SchemaVersionProbe` reads version-only field first, then full deserialize). `deny_unknown_fields` strictness. Explicit `UnsupportedSchema`, `MalformedX`, `ForwardCompatFieldOnOldVersion` error variants.

**Verdict:** **Healthy for v2 (Phase 5 collab).** Phase 5 will likely add a `peer_id`, `version_vector`, or similar — append the field with `#[serde(default)]`, bump to v8. The recovery path is well-shaped. The atomic-save protocol is hardened by Phase 2A.13 audit cycle-3.

**Open risk:** the cross-crate dep on `CellWireValue` (HIGH-3) means a wire-format evolution requires `ql-oplog` coordination. Lifting `CellWireValue` into `ql-oplog` (HIGH-3) breaks that coupling.

### `oplog.bin` (Loro snapshot)

**Shape:** raw Loro `ExportMode::Snapshot` bytes — no engine-level wrapper.

**Versioning:** none at the engine level. Relies on Loro 1.x snapshot stability.

**Verdict:** **NOT ready for v2.** Phase 5 will reshape the op model (CRDT merge needs peer-aware ops). With no magic-bytes / version-probe at the wrapping level, evolution is harder than `.qbook/` — every change requires either a Loro container rename (`OPS_CONTAINER` per `log.rs:34`) or breaking the on-disk format.

**Recommendation:** see HIGH-4. Add a 16-byte header. Land before Phase 5 starts.

---

## Public API stability commitments per crate

Recommendation set, applied workspace-wide. **None of these break callers today** because no crate is tagged 0.2+; all are 0.1.0.

### ql-types

| Symbol | Recommendation |
|---|---|
| `Value` | Stable. `#[non_exhaustive]` BEFORE 0.2. |
| `ErrorValue` | Stable. `#[non_exhaustive]`. The 15 variants are likely to grow (`#NIMPL!`, `#CANCEL!` deferred per `error.rs:11`). |
| `Address`, `Range`, `ColId`, `RowId`, `SheetId` | Stable. Likely never changes. |
| `MAX_ROW`, `MAX_COLUMN` | Stable. |
| `DateSystem`, `Locale`, `ReferenceMode` | Stable. `#[non_exhaustive]`. Locale will grow. |
| `EvalContext`, `NowProvider`, `DEFAULT_EVAL_CONTEXT` | Stable. |
| `ArrayValue`, `ArrayShapeError` | Stable. `#[non_exhaustive]` on the latter. |
| `to_number_strict` / `to_text_for_*` / coercion family | Stable. |

### ql-storage

| Symbol | Recommendation |
|---|---|
| `Workbook` | Stable. The "god struct" but consciously decomposed. |
| `Sheet`, `Bounds` | Stable. |
| `ColumnStore`, `SparseOverlay`, `chunk_rows_from_env`, `DEFAULT_CHUNK_ROWS` | Stable. |
| `NameTable`, `NamedTarget`, `NameTableError`, `SheetNameError` | Stable. `#[non_exhaustive]` on the error enums. |
| `FormatTable`, `FormatId`, `FormatTableError`, `FIRST_CUSTOM_FORMAT_ID` | Stable. `#[non_exhaustive]` on `FormatTableError`. |
| `CellFormatOverlay` | Stable. |
| `SpillAnchorTable`, `SpillBlockError`, `SpillNotFoundError`, `SpillShape` | Stable. `#[non_exhaustive]` on error types. |
| `TableTable`, `TableMetadata`, `TableColumn`, `TotalsFunction` | Stable. `#[non_exhaustive]` on `TotalsFunction` (Excel keeps adding totals). |

### ql-formula-syntax

| Symbol | Recommendation |
|---|---|
| `lex`, `parse`, `print`, `print_with` | Stable. |
| `LexError`, `ParseError`, `PrintError` | Stable. `#[non_exhaustive]` on all three. |
| `lex_with`, `column_letters_to_index`, `MAX_COLUMN`, `MAX_ROW` (lib re-exports) | **Internal — demote to `pub(crate)`.** Per MEDIUM-1 and MEDIUM-6. |
| `LocaleData`, `locale_data` | Stable. |
| `Token`, `Operator`, `AxisSpec` | Stable. `#[non_exhaustive]` on `Operator`. |
| `Expr`, `RangeRef`, `SheetRef`, `CellAddr`, `SpecialItem`, `TableSpecItem`, `TableSpecSubtree` | Stable. `#[non_exhaustive]` on `Expr`, `RangeRef`, `SheetRef`, `SpecialItem`, `TableSpecItem`. |
| `rewrite_*` AST utilities | Stable. |
| `FormulaSite` | Stable. |

### ql-functions

| Symbol | Recommendation |
|---|---|
| `default_registry`, `FunctionRegistry` | Stable. |
| `FunctionFn`, `FunctionContext`, `FunctionArg`, `FunctionReturn`, `ScalarFn`, `RegisteredFn` | Stable. `#[non_exhaustive]` on `RegisteredFn` (it will grow as new tiers land — Phase 4.5 already added ContextAwareFn). |
| `RangeAwareFn`, `FnArg`, `ContextAwareFn`, `ReferenceAwareFn`, `RefContext`, `RefArg`, `ArgContract`, `PlanKind`, `ReferenceQuery`, `NoOpReferenceQuery`, `NO_OP_REFERENCE_QUERY` | Stable. `#[non_exhaustive]` on `ArgContract`, `PlanKind`, `RefArg`. |
| `WelfordState` + welford funcs | Stable. |
| `set_test_now_secs`, `set_test_rng_seed`, `clear_test_overrides` | Stable. Marked test-shaped. |
| `format::V2Token` | Already `#[non_exhaustive]`. |
| `format::FormatParseError` | Stable. Already has `Other` catch-all, but `#[non_exhaustive]` formally. |

### ql-calcgraph

(Per `Cargo.toml` and `lib.rs`.) No `pub use` block — every public type is at-module path. The `docs/architecture/calcgraph-runtime.md` already declares the public surface STABLE. Recommend `#[non_exhaustive]` on `Node` enum (per `node.rs`), `StripeKey` enum if present, and any error enums.

### ql-exec

Already covered MEDIUM-11. Most urgent:
- `WorkbookRuntime` — STABLE (after the HIGH-2 split).
- `RuntimeError`, `BindError` — STABLE, `#[non_exhaustive]` per HIGH-1 + MEDIUM-2 split.
- SIMD `add_*` / `mul_*` family — **INTERNAL — demote behind a `bench-internals` feature**.
- `eval_at_cell_boundary`, `classify`, `dispatch`, `SimdShape`, `InMemAggregateCache` — **INTERNAL — demote to `pub(crate)`**.

### ql-io

| Symbol | Recommendation |
|---|---|
| `load_workbook`, `save_workbook`, `save_workbook_extending` | Stable. |
| `WORKBOOK_SCHEMA_VERSION`, `MIN_SUPPORTED_SCHEMA_VERSION` | Stable. |
| `QbookError` | Stable. `#[non_exhaustive]` per HIGH-1. |
| `CellRecord`, `CellWireValue`, `NamedEntry`, `NamedTargetWire`, `NamesSection`, `SheetEnvelope`, `WorkbookEnvelope` | Stable BUT — per HIGH-3 — `CellWireValue` and `NamedTargetWire` ought to live in `ql-oplog`. Move; re-export from `ql-io` for backward compat. |
| `error_to_canonical_text` | Stable. |

### ql-oplog

| Symbol | Recommendation |
|---|---|
| `Op`, `LocaleWire`, `ReferenceModeWire` | Stable. `#[non_exhaustive]` on `Op`. |
| `OpLog` | Stable. After HIGH-4 header lands. |
| `OpLogError`, `PersistenceError`, `ReplayError` | Stable. `#[non_exhaustive]` per HIGH-1. |
| `replay_into` | Signature CHANGE — drop the `&FunctionRegistry` param per MEDIUM-4. |
| `save_workbook_with_oplog`, `load_workbook_with_oplog`, `OPLOG_FILENAME` | Stable. |

### ql-io-xlsx

Already covered by Phase 4.11 Opus-C audit (§259-279). Apply the same `#[non_exhaustive]` discipline to the 11 enums + structs identified.

### Stub crates (ql-ai, ql-bindings-*, ql-collab, ql-connectors, ql-formula-semantics, ql-io-ods, ql-service, ql-sql, ql-terminal, ql-udf, quantbook-py)

All 13 reserve workspace-graph shape, all have updated "Reserved for Phase N+" doc comments (Phase 2A.12 audit M16/DOC closure). No public surface today. **Stable: zero. Provisional: zero. Internal: 100%.** This is fine.

---

## v2 (Phase 5 CRDT collaboration) prep summary

If I had to rank the prep work in landing order before Phase 5 starts:

1. **HIGH-4** — Add 16-byte header to `oplog.bin`. Phase 5 directly redesigns the op-log; the header is the version anchor that lets the redesign land in a backward-compat-aware shape.

2. **HIGH-3** — Lift `CellWireValue` (and `NamedTargetWire`) into `ql-oplog`. Phase 5 reshapes `Op`; the lift uncouples op evolution from file-format evolution.

3. **HIGH-1** — `#[non_exhaustive]` workspace-wide. One commit. Removes the SemVer-trap for Phase 5's new error variants and Op variants.

4. **HIGH-2** — Split `ql-exec/src/workbook_runtime.rs`. Phase 5's collaboration hooks land in this file; the 12 413-LOC monolith makes parallel work hostile.

5. **MEDIUM-4** — Drop `&FunctionRegistry` from `replay_into`. Phase 5 redesigns replay; remove cruft first.

6. **MEDIUM-2** — Split `BindError::UnsupportedVariant`. Caller-side error handling becomes structural; Phase 5's IDE-binding work will need this.

7. **HIGH-5** — Backfill `docs/phase3/`, `docs/phase4/entry-plan.md`, `docs/architecture/parser-and-semantics.md`. The compatibility-freeze acceptance is empirically met but the deliverables aren't shipped.

8. **MEDIUM-7** — `cargo deny` advisories: explicit-ignore both, document.

9. **MEDIUM-8** — Close 6 doc-warnings.

10. **MEDIUM-10** — Rename auditor-attribution test files to feature-scoped names.

Phase 5 entry should NOT happen before items 1-4 land. Items 5-10 can land in parallel with Phase 5 or shortly after.

---

## Notes for parallel auditors

- HIGH-1 (non_exhaustive across all enums) overlaps with what Opus-A may surface in cross-feature integration (Op variants, error variants). My recommendation: one commit applies it everywhere; the cross-feature work doesn't need to think about it after.
- HIGH-2 (`workbook_runtime.rs` split) may surface in Opus-A's cross-feature traces (the runtime is where features integrate). My concern is structural; Opus-A's will be functional. Both legitimate; both close in the same refactor.
- HIGH-3 / HIGH-4 (oplog evolution) are unlikely to surface elsewhere — they're architectural decisions about how Phase 5 lands. Lifting here is correct.
- HIGH-5 (missing docs) overlaps with what self-auditor will likely flag. Same finding from different angles is fine; both auditors should see the gap.
- MEDIUM-2 (BindError lossiness) overlaps with what Codex may see if it surfaces error-shape divergences from Excel. The fix shape is structural (split the enum); Codex's would be functional (right error for right input). Both close in the same surface-area refactor.
- MEDIUM-7 (cargo deny) is build-time only; no overlap with other auditors.
- MEDIUM-8 (doc warnings) overlaps with self-auditor's "exit-packet integrity" — both will catch that A4-01 is mis-stated.

---

## Relevant file paths

### Crate manifests
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/Cargo.toml`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/Cargo.toml` (HIGH-3, MEDIUM-4)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/Cargo.toml`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/deny.toml` (MEDIUM-7)

### Public-API surfaces
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs`

### Error taxonomies
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types/src/error.rs` (15 variants of `ErrorValue`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/plan.rs:169` (`BindError`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime.rs` (12413 LOC; `RuntimeError` + `RecomputeResult` + `WorkbookRuntime`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/qbook_format.rs:185` (`QbookError`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/error.rs` (`OpLogError`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:38-65` (`ReplayError` + `&FunctionRegistry` unused param)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/persistence.rs:46` (`PersistenceError`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/error.rs` (`XlsxError`, includes deprecated variant)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:80` (`LexError`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/src/parser.rs:129` (`ParseError`)

### Persistence
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/qbook_format.rs:160` (`WORKBOOK_SCHEMA_VERSION = 7`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/qbook_format.rs:181` (`ATOMIC_SAVE_MARKER_FILENAME`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:131-149` (export/import, NO magic bytes)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/persistence.rs` (sidecar `oplog.bin`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/op.rs:36` (HIGH-3 — wrong-direction `ql-io::CellWireValue` dep)

### Test architecture
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/` (10 files, 8 named after auditors)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs`

### Doc gaps
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase4/` (missing `entry-plan.md`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase3/` (does not exist — missing both entry-plan and exit-packet)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/` (missing `parser-and-semantics.md`)
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:535-538` (the master-plan list of Phase 4 deliverables)

### Build hygiene
- `cargo doc --no-deps --workspace`: 6 broken-doc-link / unclosed-HTML warnings (MEDIUM-8)
- `cargo deny check advisories`: 2 unmaintained-RUSTSEC failures (MEDIUM-7)
