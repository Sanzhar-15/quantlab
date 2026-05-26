Phase 5 Megaudit 5.8 - Lane A (Codex)

Scope: adversarial empirical + CRDT convergence audit of Phase 5 collaboration surface.
Mode: audit-only; no source fixes applied.

Source HEAD check:
`git log --oneline -1` returned `dfa3d113c90 docs(quantbook): point Phase 6 entry-plan at the now-ready 5.8 megaudit package`, not the requested `1465b1db4c4`.
`git show --stat --oneline -1` showed a docs-only delta in `docs/phase6/entry-plan.md`.

Empirical probe summary:
- Temporary Rust probes were run under `crates/ql-collab/tests/megaudit_lane_a_tmp.rs` and then removed.
- Probe run: `CARGO_TARGET_DIR=/private/tmp/quantbook-megaudit-lane-a-target /Users/sanzhar/.cargo/bin/cargo test -p ql-collab --test megaudit_lane_a_tmp -- --nocapture`
- Result: five-test convergence/wire/parity suite passed at the harness level, with the table and format collision cases intentionally recorded as deterministic replay failures rather than Rust test failures.
- Additional probe: unknown-op serde decode was run separately and passed, proving unknown op kinds reject at decode.
- Offline probe run: `cargo test -p ql-collab --test auto_flush offline -- --nocapture` with isolated target; result 8 passed.
- Undo/redo interleave probes run: `grouped_undo`, `merge_interval_undo`, `remote_interleave`; result 4 relevant tests passed.

---
#: 1
Finding: Requested source HEAD was not checked out during this lane.
Severity: INFO
Files: docs/phase6/entry-plan.md:1
Evidence: `git log --oneline -1` returned `dfa3d113c90 docs(quantbook): point Phase 6 entry-plan at the now-ready 5.8 megaudit package`; requested source was `1465b1db4c4`. `git show --stat --oneline -1` showed a docs-only change to `docs/phase6/entry-plan.md`.
Recommendation: If strict provenance matters, rerun the lane or compare this transcript against the exact requested commit. The observed HEAD mismatch did not touch engine source files.
---

---
#: 2
Finding: Concurrent CreateTable of the same table name makes the merged log unrebuildable.
Severity: HIGH
Files: crates/ql-oplog/src/replay.rs:1451
Evidence: PROVEN by temporary two-peer convergence probe. Both peers started from the same sheet, peer A created table `T`, peer B concurrently created table `T`, then both exchanged bytes. The merged op logs and caches converged, but both `rebuild_workbook` calls returned `Err(Replay(TableCreateRejected { index: 2, name: "T", reason: "table with this canonical name already exists" }))`. A deterministic replay failure is not a successful deterministic table merge. The hard rejection is implemented at `apply_create_table`, which returns `TableCreateRejected` when `workbook.tables().lookup(&canonical).is_some()`.
Recommendation: Add a collaboration-safe table identity/name conflict policy. Viable closure directions are stable table IDs with name conflict diagnostics, deterministic synthesized rename/correction ops, or a non-aborting conflict state that still materializes the workbook.
---

---
#: 3
Finding: Concurrent RenameTable of different source tables to the same target makes the merged log unrebuildable.
Severity: HIGH
Files: crates/ql-oplog/src/replay.rs:1030, crates/ql-oplog/src/replay.rs:1121
Evidence: PROVEN by temporary two-peer convergence probe. Base workbook had tables `A` and `B`; peer A renamed `A` to `X`, peer B concurrently renamed `B` to `X`, then both exchanged bytes. Both peers converged to the same op log/cache, but both `rebuild_workbook` calls returned `Err(Replay(TableCreateRejected { index: 4, name: "X", reason: "table with this canonical name already exists (rename target)" }))`. The source comments explicitly document this as a "V1 LIMITATION - hard-fail" cross-table target collision.
Recommendation: Close the table rename collision semantics before Phase 5 exit. The replay path must not abort the entire workbook for a valid concurrent table rename pattern; surface a conflict diagnostic and still materialize a deterministic table set.
---

---
#: 4
Finding: Concurrent RenameColumn of different columns to the same target makes the merged log unrebuildable.
Severity: HIGH
Files: crates/ql-oplog/src/replay.rs:1227, crates/ql-oplog/src/replay.rs:1237
Evidence: PROVEN by temporary two-peer convergence probe. Base table `T` had columns `A` and `B`; peer A renamed `A` to `Z`, peer B concurrently renamed `B` to `Z`, then both exchanged bytes. Both peers converged to the same op log/cache, but both `rebuild_workbook` calls returned `Err(Replay(TableColumnRejected { index: 3, table: "T", column: "Z", reason: "column with this canonical name already exists (rename target)" }))`. The source comments call this a "HARD-FAIL - V1 limitation".
Recommendation: Add stable column identity or a deterministic, repair-aware collision resolution path. At minimum, produce conflict diagnostics without aborting replay of the whole workbook.
---

---
#: 5
Finding: Forward-compatible Op::Unknown does not exist; unknown op kinds do not survive round-trip.
Severity: MED
Files: crates/ql-oplog/src/op.rs:47, crates/ql-oplog/src/op.rs:493
Evidence: PROVEN by temporary serde probe. `serde_json::from_str::<Op>(r#"{"kind":"FutureOp","payload":"x"}"#)` returned an unknown-variant decode error listing the known variants through `SetDateSystem`. `Op` uses `#[serde(deny_unknown_fields, tag = "kind")]` and the enum ends at `SetDateSystem`; there is no `Unknown(String)` arm even though the audit checklist names `Op::Unknown`. Wire sub-enums have unknown arms, but the top-level op does not.
Recommendation: If Phase 5 requires forward-compatible op-log loading, add an opaque/catch-all unknown op representation and preserve it through export/import/persistence without replay panic. If top-level unknown ops are intentionally unsupported, update the Phase 5 contract/checklist to remove `Op::Unknown`.
---

---
#: 6
Finding: Same custom format id with different strings deterministically aborts replay.
Severity: MED
Files: crates/ql-oplog/src/replay.rs:837, crates/ql-oplog/src/replay.rs:840
Evidence: PROVEN by temporary two-peer convergence probe. Peer A registered custom format id `Custom(PeerId(777), 1)` as `"0.00"` while peer B concurrently registered the same id as `"yyyy-mm-dd"`. After byte exchange, both peers converged to the same op log/cache, but both `rebuild_workbook` calls returned `Err(Replay(FormatRejected { index: 1, source: IdCollision { id: Custom(PeerId(777), 1), existing: "0.00", attempted: "yyyy-mm-dd" } }))`. Replay delegates `RegisterFormat` to `workbook.formats_mut().register_at(...)`, which rejects the collision.
Recommendation: If public producers can emit explicit custom ids, prevent duplicate peer/counter allocation at the producer boundary or define a non-aborting conflict diagnostic. If only malformed logs can create this shape, document it as malformed-only and keep it out of the Phase 5 convergence matrix.
---

VERDICT: FAIL

Coverage note:
- A1: Partially completed. Multi-peer probes covered the requested high-risk pairs: RemoveSheet/RestoreSheet, RenameSheet/RenameSheet, MoveSheet/MoveSheet, RegisterFormat/RegisterFormat same id different string, CreateTable/DropTable, RenameTable/RenameColumn-adjacent table rename collisions, ResizeTable/PutValue-in-range, metadata pairs, and SetName. All known op variants were also covered by wire export/import/replay round-trip. A late optional peer-pair probe for ClearFormula, SetCellFormat, and BatchCommit was blocked by the workspace Cargo artifact lock after the decisive findings were already proven.
- A2: Completed for targeted names/tables. SetName same-name concurrency converged. Table create/rename/column-rename collisions produced HIGH findings.
- A3: Completed through existing offline auto-flush/offline tests; 8 offline tests passed.
- A4: Completed through targeted existing grouped undo, merge-interval undo, and remote interleave tests; 4 relevant tests passed.
- A5: Partially completed. Core RemoveSheet->RestoreSheet preservation and cache convergence were probed, and `classify_delta_op` was statically reviewed for full-rebuild triggers. NAPI `workbookSnapshotDelta` was not empirically executed in this lane.
- A6: Partially completed. Raw Loro export/import/replay round-trip covered every known Op variant, and unknown wire enum values survived decode until replay diagnostics. Full `.qbook` directory persistence was not re-probed here.
- A7: Partially completed. Out-of-range cell replay, unknown wire enums, unknown top-level op decode, and malformed RemoveSheet were probed without panic. NAPI NaN/Infinity and malformed Buffer boundaries were not empirically executed.
- A8: Completed for public `CollabSession::append_op`: out-of-range `RemoveSheet { id: 65535 }` did not reproduce cache-vs-replay divergence; live cache kept sheet 0 visible and replay left sheet 0 unremoved with its cell preserved.
