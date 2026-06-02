# ENG-FUSION — Reactive fusion primitives (`publish_dataset`, `bind_range`) — entry plan

**Status:** COMPLETE 2026-06-02. Pre-Phase-7 engine mini-phase on `feat/quantbook-engine`. Shipped across
EF-1 (`c797ddd5a9b` docs) -> EF-2 (`01a4372b5ab` publish_dataset) -> EF-3 (`3d86557416d` bind_range) ->
EF-4 (`b1f5366f58b` bindings) -> EF-5 (doc-sync + closure). FUSION-01..04 met. Verified: ql-exec 851 lib +
8 §10.4 exit tests; ql-service 40 + cluster_e; node smoke; pyo3 eng-fusion smoke + golden_flow; clippy 0-new.
The moat primitives are now live across all three transports; FE-1.5 (reactive fusion) is engine-unblocked.

Master plan (`docs/MASTER-PLAN.md`, section `ENG-FUSION - Reactive Fusion Primitives`): unblock the product
moat — implement the two reserved section-3.5 stubs `publish_dataset` and `bind_range`
(`crates/ql-exec/src/session.rs:3245/3254`, currently `not_implemented_in_v1_core`) plus the re-publish
dirty-notify path, so a Python value can be pushed into the sheet and reactively dirty dependent cells.
Acceptance: **FUSION-01** publish writes + tracks provenance · **FUSION-02** a bound range round-trips edits
· **FUSION-03** re-publish dirties dependents and `recalc_dirty` updates them · **FUSION-04** all three
bindings return the same semantics. Effort ~2-3 wk.

**Why now (cross-repo authority):** the 2026-06-02 "beyond Excel/Sheets" megaudit (7 lanes) found the moat
(reactive Python<->grid fusion) engine-blocked by these two stubs (SYNTHESIS T1 / S-E-H1). The operator
locked D-ENG-FUSION = YES. The FE build plan v2 (IDE repo, gitignored) section ENG-FUSION is the product-
side authority; this doc is the engine half.

The contract froze at 6.3-5; the reserved section-3.5 methods (`write_range`, `publish_dataset`,
`bind_range`, `refresh_source`, `materialize_query`) and their DTOs (`PublishedRef`, `BoundRange`,
`DirtyResult`) already exist with locked signatures (`ql-session/src/{session,dto}.rs`). ENG-FUSION flips
the two remaining `not_implemented` stubs (`ql-exec/src/session.rs`) to real impls **without changing any
signature** — no contract re-freeze.

## Locked decisions (2026-06-02, with the operator)
- **D-DATA — JSON value-matrix.** `publish_dataset` `data` = `{"values": [[scalar|null, ...], ...]}`,
  converted **per cell** (heterogeneous): finite number -> Number (reject NaN/+/-Inf loudly), string ->
  Text, bool -> Boolean, null -> Blank; a non-scalar element (object/array) or a non-rectangular `values`
  -> loud `bad_argument`. Distinct from `materialize_query`'s per-*column* Arrow inference. Arrow-IPC stays
  an FE concern (FE-1's Arrow bridge decodes Arrow -> matrix JS/Py-side); it can be added later as another
  `data` variant without breaking `{"values":...}`.
- **D-REACTIVE — re-publish is the dirty-notify path.** On re-publish under the same `name`, after writing
  the new block, also dirty the dependents of previously-produced-but-now-vacated cells (the
  `refresh_source` `for old in old_cells { graph.on_set_value(...) }` fan-out, which `materialize_query`
  alone does not do). `refresh_source` (re-run a *stored* SQL/file producer) is unchanged. The FE bridge
  calls `publish_dataset(name, new_data, target)` then `recalc_dirty()`.
- **D-BINDINGS-LIFECYCLE.** `bind_range` registers `binding_id -> CellRange` in a new session-local
  `bindings: HashMap<String, CellRange>`. Bindings are region pointers independent of cell content, so —
  unlike `provenance`/`cell_provenance` (data-derived, cleared on undo/redo) — they are **kept across
  undo/redo**. Re-binding an existing id overwrites after loud validation (No-Fallbacks).
- **D-TRANSPORTS — all three.** napi (real return DTOs), pyo3 (new wrappers), service (real wire DTOs) +
  a cross-transport reactive smoke. Satisfies the Phase-6 "all bindings share one contract" exit criterion.
- **No-Fallbacks throughout.** Validate-all-before-mutate (mirror `write_range`/`materialize_query`); every
  failure is a loud `EngineError` (`bad_argument`/`not_found`); no partial writes; no silent defaults.

## Decomposition
- **EF-1 — docs entry.** This file + the MASTER-PLAN `## ENG-FUSION` section. (DONE in this commit.)
- **EF-2 — `publish_dataset` engine core.** `json_block_to_cell_values` (the `{"values":...}` converter);
  extract a shared `record_block_provenance` helper from `materialize_query` Phases 4-5 (pure refactor,
  guarded by the existing `materialize_query_*` suite; inline-duplicate fallback if audit flags it); the
  impl (validate target -> convert -> fit-check -> capture `old_cells` -> `write_range` -> record
  provenance -> re-publish shrink fan-out -> `PublishedRef{name}`); unit tests incl. the shrink-dirty moat
  test.
- **EF-3 — `bind_range` engine core.** `bindings` field + init + undo/redo keep; the impl + a `binding(id)`
  getter; unit tests.
- **EF-4 — binding exposure + reactive integration.** napi/pyo3/service per D-TRANSPORTS; one reactive
  integration test per transport (publish -> recalc -> dependent recomputed).
- **EF-5 — closure.** doc-sync (`session-api.md` section 3.5 + Appendix A, MASTER-PLAN markers, exit note);
  parallel Codex (high, read-only) + fresh-Opus closure audit; fold; memory handoff.

## Closure audit (EF-5, 2026-06-02)
Parallel **Codex (gpt-5.5, high, read-only) + fresh-Opus** lanes; every finding verified at source.
**Both lanes: SHIP-WITH-FIXES, NO HIGH.** `record_block_provenance` confirmed behaviour-equivalent to the
pre-refactor `materialize_query` bookkeeping; No-Fallbacks honoured end-to-end; bindings parity clean.
**FOLDED (2 MED, Codex-caught):**
- **MED-1 (provenance namespace collision):** `publish_dataset` recorded into the same `provenance` map
  `refresh_source` replays through `materialize_query`, so `refresh_source` on a published id mis-parsed
  `{"values":...}` as SQL (and a publish could clobber a SQL source's refreshability). FIX: tag entries with
  `ProducerKind {Query, Published}`; `refresh_source` rejects `Published` with a clear `bad_argument`
  (re-publish to update). Test `refresh_source_rejects_published_dataset`.
- **MED-2 (oversized input pre-cap alloc):** the JSON matrix was converted + retained in provenance before
  the `1<<20` write cap fired. FIX: cap input cells in `json_block_to_cell_values` (after row 0, before the
  bulk convert), mirroring `materialize_query`'s input cap. Test `publish_dataset_oversized_input_is_bad_argument`.
- Doc-sync: stale `router.rs`/`wire.rs` "always 501" section comments + the `refresh-source` "Always 501"
  leftover; `session-api.md` publish row made explicit on shrink-keeps-values + not-`refresh_source`-able.
**FILED (not v1-blocking):** (1) `bind_range` registry has no resolver/unbind over the transports + no
removal path (v1 = a validated server-side reservation; the FE holds the coordinates and reads via
`query_range`) — add a resolver/unbind when the FE consumes `qb.bind()`; (2) clear-on-shrink option for
`publish_dataset` (v1 keeps vacated values, consistent with the other producers) — v2; (3) IDE
`types.ts` `publishDataset`/`bindRange` `void` drift — CLOSED 2026-06-02 via FE-0a Part A (IDE
`e233276c76d`): the 5 §3.5 methods retyped to real DTOs + `sql_error`/`sql_table_build`/`source_not_found`
added to the union + allowlist (`tsc` clean). (4) **Unbounded identifier retention (deep-audit MED,
pre-existing 6.5-2 class):** `record_block_provenance` clones `source_id`/`query_id` into every per-cell
`Event::Provenance` (at the `1<<20` cap a large caller-supplied id is a per-cell multiplier), and the event
log + `bindings` map are unbounded. Bounded in v1 by single-client-localhost + self-authored ids; intern the
id (`Arc<str>`) + bound the event log as a v1.5/pre-multi-client hardening item (alongside the 6.7-filed
UDF/connector resource hardening).

## Build/commit discipline (carried)
Mac bridge (`mac zsh -lc` + explicit `cd`; `export PATH=$HOME/.cargo/bin:$PATH`); commit with node
v22.21.1 on PATH so the husky hook fires (never `--no-verify`); ASCII on code lines; stage an explicit file
list (never `git add` wholesale — untracked `.out`/`.node` cruft); never predict a hash (trust VM git
porcelain + exit codes); pyo3 parity via a `$HOME/.cache` venv + maturin (system py is stale; PEP-668).
