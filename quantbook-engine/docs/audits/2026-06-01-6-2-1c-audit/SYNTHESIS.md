# 6.2-1c audit synthesis (2026-06-01)

**Increment:** Phase 6.2-1c -- bind the remaining 18 `EngineSession` methods over the
`ql-service` hyper HTTP service (cluster E atomic/transactions + the 5 reserved sec-3.5
bulk Capability stubs + undo/redo + `snapshotDelta` + functions). Pure transport;
COMPLETES 6.2-1.

**Method:** parallel 2-lane review per repo discipline -- Codex (default model,
`-c model_reasoning_effort=high`, `-s read-only`, Linux VM) + a fresh Opus lane
(general-purpose agent). Both reviewed only the 6.2-1c changes
(`crates/ql-service/src/{wire.rs,router.rs,lib.rs}` + `tests/cluster_e_http.rs`) against
the frozen napi source-of-truth (`crates/ql-bindings-node/src/lib.rs`) + the engine DTO/
trait/error types (`crates/ql-session/src/{dto.rs,session.rs,function_meta.rs}`).

## Verdicts

- **Codex: SHIP-WITH-FIXES** -- 1 HIGH, 0 MED, 0 LOW.
- **Opus: SHIP** -- 0 findings at any severity.

## The HIGH (Codex cross-lane catch; Opus missed it) -- FOLDED

**`PublishDatasetBody.data` / `MaterializeQueryBody.data` modeled as
`serde_json::Value`, but the frozen napi source takes `data: String` and parses it via
`parse_reserved_json_payload` before forwarding.** (`wire.rs`, the two reserved bodies.)

- napi crosses opaque JSON as TEXT because its `serde-json` feature is off -- the same
  project-wide "opaque-JSON-as-string" convention as the 6.3-1c `details` field. The
  service's bespoke wire layer exists precisely to MIRROR the napi shapes across binding
  rows; the plan's explicit charter was "thin loud forwarders ... mirroring napi 6.3-2e
  EXACTLY."
- Unlike the 6.2-1a `import`/`export` octet-stream divergence (genuine binary -- no JSON
  form exists), there is NO transport reason to deviate here: `data` is JSON either way.
- Observable-contract angle: with `String` + parse, malformed JSON text fails loud as
  `[bad_argument]` BEFORE the engine call, matching napi exactly, rather than letting
  non-JSON text ride through to the `not_implemented_in_v1_core` 501.

**Disposition: FOLDED into the feat.** `data` changed to `String` on both reserved
bodies; added `wire::parse_reserved_json_payload` (mirror of the napi helper); the two
handlers parse before forwarding. The `cluster_e_reserved_bulk_all_501` test now sends
`data` as JSON text (double-encoded) and a NEW negative pins malformed text ->
`400 bad_argument` (the No-Fallbacks parse path is now observable).

(No-Fallbacks note: the `Value` version did NOT strictly swallow anything -- any JSON body
is valid -- but the String+parse mirror is the consistency-correct choice for a reserved
endpoint whose real contract lands in 6.4/6.5, and matching napi now minimizes drift.)

## What both lanes verified clean

- **Wire parity:** every cluster-E DTO field name/type/optionality/encoding matches its
  napi `FooJson` counterpart -- u64 ids/handles/revision as quoted decimal strings
  (`TransactionId`/`implHandle`); `SessionVersion` as lowercase hex; `Arity` n/min/max +
  `FormatId` builtin as INTEGER `u32` (no `6.0` serde divergence -- the napi f64-then-
  validate dance is unneeded because serde has no `ToUint32` coercion hole);
  `WorkbookSnapshotDeltaWire` field order matches napi (`schemaVersion` last) +
  `fullRebuildReason` snake_case + `skip_serializing_if None`; `FunctionMetadataWire`
  enum strings + required `aliases`/`provenanceTags` (loud on omission).
- **Converters:** `session_op_from_wire` / `arity_from_wire` / `function_metadata_from_wire`
  reproduce the napi strict-union rejections (extraneous-for-kind, missing payload,
  u8-range, inverted range, unknown enum) byte-for-byte.
- **Reserved-5:** always surface `not_implemented_in_v1_core` (Capability -> 501); the
  `.map(|_| ())` on the unreachable Ok arm is correct.
- **snapshotDelta:** `hex_decode` runs BEFORE the engine lock (malformed token ->
  `invalid_version_token`/400, no panic, no lock acquired); empty -> `no_prior_version`;
  pre-undo token -> `epoch_mismatch`; the designed full-rebuild reasons pass through.
- **Test observability:** every `cluster_e_http.rs` assert pins behavior that a no-op/
  broken binding would fail (cross-cell batch all-or-nothing; txn handle consumed on BOTH
  commit and rollback; undo/redo observable round-trip with recalc between; snapshotDelta
  incremental carries the changed VALUE; functions metadata round-trip + register-over-
  builtin `function_exists` + unregister-unknown `function_not_found`). No wrong-reason
  asserts.
- **Pure-transport invariant:** ql-exec/ql-session/ql-bindings-node untouched.

## Post-fold verification

- ql-service: 20 wire serde unit tests + 11 integration tests (golden 1 + cluster_a_b 2 +
  cluster_c_d 2 + cluster_e 5 + error_paths 1) -- all pass.
- clippy `-p ql-service --all-targets`: 0 warnings (the ql-storage/ql-oplog/ql-exec
  warnings are pre-existing in those dependency crates).
- build debug + release: 0/0.
- **ql-exec `--lib` 802/0 (default + `--features xlsx-write`) UNCHANGED** -- pure transport.
- `cargo check --workspace`: clean.

**Final verdict: SHIP (Codex HIGH folded; both lanes' clean findings confirmed at source).**
