# Opus-B megaudit — Phase 5.2 D-1 full-arc closure (fixture coverage + cross-crate invariants + doc drift) 2026-05-20

Auditor: Opus-B subagent (independent of the engineer; Lane 3 of 3-way parallel megaudit).
HEAD audited: `3eaaac201b4`.
Scope: fixture coverage gap analysis + cross-crate invariant analysis + doc drift sweep + new-call-site coverage + performance scan.
Total: 213,407 tokens / 128 tool uses / 1145s wall.

## Verdict: PASS-WITH-FINDINGS

**3 HIGH (1 invariant, 2 doc) + 4 MEDIUM + 3 LOW.** No release-breaker blockers; all findings are pre-step-8 polish candidates.

## HIGH

### H1 — Release-build LEGACY_PEER guard is a no-op (cross-crate invariant)

**Files:** `crates/ql-collab/src/session.rs:170, 209` + `crates/ql-oplog/src/log.rs:194`

`CollabSession::new` and `CollabSession::from_snapshot` use `debug_assert_ne!(peer_id.as_u64(), 0, ...)`. In `--release` builds, debug_assert_ne! expands to nothing → release binary silently accepts CollabSession::new(PeerId::new(0)).

Worse: `OpLog::set_peer_id(peer: u64)` has NO peer==0 check at all — only rejects u64::MAX.

**Consequence:** A production peer with LEGACY_PEER collides with the qbook envelope migration path: intern("X") allocates Custom(LEGACY_PEER, 0) which already maps to the legacy-encoded "first custom id" (numFmtId=164) post-migration. Cross-peer same-string design assumes LEGACY_PEER is sentinel-only.

### H2 — Doc-drift in d-1-starting-checklist intro paragraph

**File:** `docs/phase5/d-1-starting-checklist.md:11`

Intro says "Steps 1-4 of 8 shipped; steps 5-8 pending. ... currently step 5. Per-step audit transcripts: ... step-{1..4}-..." — but body shows steps 1-7 SHIPPED + step 8 pending. Fresh sessions reading this would start at step 5 thinking it's NEXT (it's done).

### H3 — Docstring claims a test that doesn't exist (oplog_persistence)

**File:** `crates/ql-io/src/oplog_persistence.rs:62-64`

Module docstring promises `legacy_path_with_pre_step_4_op_shape_fails_loudly_at_iter` but this test does NOT exist. Tests present: `legacy_pre_tier_d3_raw_loro_snapshot_still_loads` + `legacy_path_with_corrupt_loro_body_fails_loudly`. Step-7 closure documented this as "limitation" but the docstring still references the OLD name → readers (including a fresh-session LLM) believe the test exists and skip the step-8 closure work.

## MEDIUM

- M1 — `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1-7.3 has pre-D-1 FormatTable shape (`next_custom_id`, single `by_string`, no `local_peer`/`with_peer`). No SUPERSEDED-BY-D-1 pointer.
- M2 — `docs/phase5/entry-plan.md:60` says "Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work" but Tier D3 is SHIPPED.
- M3 — `crates/ql-io-xlsx/src/read/styles_import.rs:12, 52-53` has stale `FormatId(N)` / `.0` / `next_custom_id` references.
- M4 — Fixture coverage gap: `mortgage_calculator.xlsx` (sparse {167, 168, 170, 171, 174, 176, 179, 181, 184}) not exercised. The step-6 audit identified COMBIN_COMBINA.xlsx as the canonical sparse-counter fixture but the validation test is synthetic. **Deferred to V2** (fixture-quality improvement, not correctness fix).

## LOW

- L1 — `FormatEntryId` not re-exported at `ql_io::*`.
- L2 — Producer-side `intern_format` lacks counter-overflow pre-check (panic vector at u32::MAX).
- L3 — `read_display` silent fallback to General on parse failure violates the global "no fallbacks" rule. Pre-D-1 issue (not introduced by D-1). **Deferred** — out of D-1 scope.

## Things checked + clean (no findings)

- **OPLOG_MAGIC uniqueness:** b"QLOL" only file-magic in codebase; no Loro b"loro" collision.
- **WORKBOOK_SCHEMA_VERSION (8) vs OPLOG_SCHEMA_VERSION (1):** clearly distinguished — no conflation.
- **New error variants:** all 4 have dedicated tests (CounterOverflow, BuiltinOutOfRange, OplogUnsupportedVersion, OplogTruncatedHeader).
- **Public API re-exports:** FormatIdWire, PeerId, LEGACY_PEER, OPLOG_* all properly re-exported.
- **Performance:** No O(N²) in XlsxNumFmtTranslation::build; sort + 2 linear passes.
- **Direct FormatId::Builtin(n) construction sites:** only safe paths (legacy_from_u32 guarded, with_peer builtin seed, from_storage with downstream register_at catch).
- **Doc-drift in active product docs:** crdt-data-model.md § D-1, ide-consumer-contract.md, MASTER-PLAN.md, v1-exit-packet.md, current_work.md all properly reflect steps 1-7 shipped + step 8 pending.
- **No checked-in `.qbook` or `oplog.bin` fixtures** — no backward-compat fixture risk.
- **`pre-step-N` markers in code:** all retrospective or correctly forward-looking.

## Stats

- Tool calls: 38 (Bash: 30, Read: 8)
- Cross-crate greps: ~25
- Read-only analysis (no probe tests — Opus-A's scope)
