# Phase 6 (Product Surfaces) — Entry-Readiness Analysis

**Status:** ✅ LOCKED 2026-05-26 — the Phase 6 decision-lock is complete (Codex-validated, gpt-5.5 xhigh). **The authoritative locked decisions + sequence live in `docs/phase6/decision-lock.md`** (this document remains the entry-readiness analysis that informed it). The §5 sequencing below is SUPERSEDED by `decision-lock.md` §2 (which stages 6.4 into 6.4A/6.4B + inserts a `6.4-0` function-metadata substrate).

**Authored at:** engine `741b9530b3d` (V3.6.1.2 + B8/CellValueJson doc closes; engine SOURCE unchanged at `1465b1db4c4` = V3.6 PHASE TERMINATION CLEAN) + IDE `d028568b53b` (V3.6.1.2).

---

## 1. What Phase 6 is

**Engine Phase 6 = "Product Surfaces"** (`MASTER-PLAN.md` §706): expose the same engine through a stable session API, a local service, WASM/Node/C/Python bindings, **Python UDFs**, SQL/connectors, and a real `AI()` backend.

**This is the v1-critical path.** Per the dual-plan mapping (`MASTER-PLAN.md` §0):

| Engine phase | Canonical product phase(s) | v1 status |
|---|---|---|
| Engine 5 (CRDT collaboration) — *the recent "Phase 5.7 V3.x" work* | **Product Phase 9** | **v1.5-DEFERRED** |
| **Engine 6 (Product Surfaces)** | **Product Phase 5 (Python kernel + UDFs) + 6 (VS Code surface) + 7 (UX) + 8 (SQL/connectors)** | **v1-CRITICAL** |
| Engine 7 (Hardening + Ship) | Product Phase 10 | v1 |

**Strategic significance:** the product wedge (per the strategy brief — "Python-signal → pokeable-sheet") is **Product Phase 5 = Engine sub-item 6.4 (Python UDFs)**. The canonical plan puts a **Month-6 kill gate** on Python integration ("if debug-from-cell unworkable / BoundFrame leaky / `qb.show(df)` flaky, Phase 5 stretches"). So Phase 6 — specifically 6.1 (session API) → 6.4 (Python UDFs) — is where v1 ship value concentrates, and it is on the kill-gate path.

---

## 2. Entry-gate assessment (upstream foundations)

Phase 6's stated entry gate (`MASTER-PLAN.md` §710): *"Phase 4 compatibility and Phase 5 collaboration are stable enough to expose; core runtime API no longer churns daily."*

| Foundation | Status | Evidence |
|---|---|---|
| Engine 2B (Correct Runtime Contract) | ✅ done | Prereq for Phase 3; Phase 3+4 proceeded on top |
| Engine 3 (One Engine — graph/runtime unified) | ✅ SHIPPED | "3.10 Phase 3 Megaudit ✅ SHIPPED 2026-05-12 (W5-43)"; "Phase 3 graph runtime is shipped" (§381); GAP-G-01/G-03 W5-50. The early "fast engine + runtime engine are not one engine" problem is **resolved** — important because Phase 6 UDFs/SQL/AI must not bypass graph invalidation. |
| Engine 4 (Excel Coverage) | ✅ SHIPPED | A4-01 (4135 workspace tests) + A4-02 (311-row compat matrix, 83%) + A4-03 (177/177 corpus) all ✅; exit packet at `docs/phase4/exit-packet.md` |
| Engine 5 (Collaboration) | ✅ **gate CLOSED 2026-05-26** | 5.8 Phase 5 Megaudit ran (PASS-WITH-FINDINGS; 0 reachable HIGH; risk register 39/39 confirmed). Phase 5 COMPLETE — see §3 + `docs/phase5/phase-5-exit-packet.md`. |
| Core runtime API stability | ✅ (compute) / ⚠️ (collab surface) | The compute runtime stabilized at Phase 3/4. The **collab/IDE napi surface is still evolving** (V3.6.1 B10 just added `workbookSnapshotDelta` consumer wiring). This is expected — **Phase 6.1 is the step that consolidates a single stable session API across all bindings**, so residual collab-surface churn is *resolved by* 6.1, not a hard blocker to entering. |

---

## 3. THE GATE: 5.8 Phase 5 Megaudit — ✅ CLOSED 2026-05-26 (PASS-WITH-FINDINGS)

**✅ DONE 2026-05-26.** The 5.8 Phase 5 Megaudit RAN and returned **PASS-WITH-FINDINGS → PHASE 5 COMPLETE**: ZERO reachable HIGH across 4 lanes, risk register 39/39 confirmed (0 falsely-closed), all 4 exit criteria met for the reachable surface. Exit Criterion #2 was amended (collaborative table-merge deferred — Lane A's table aborts are real but UNREACHABLE: no collaborative table producer; tables are single-writer `WorkbookRuntime`-only). Op::Unknown contract amended (top-level unknown ops intentionally reject at decode). **This gate is CLOSED; Phase 6 entry is unblocked.** Canonical: `docs/phase5/megaudit-5-8/closures.md` (synthesis) + `docs/phase5/phase-5-exit-packet.md`. The original pre-run analysis is preserved below for provenance.

**[Pre-run analysis — provenance]** The casual prior-session note "Phase 6 is gated on V3.6 exit, which is achieved" was **incomplete**: **V3.6 exit ≠ Phase 5 exit.**

- V3.6 is sub-phase **5.7 V3.6**. Its V3.6.0.X phase-termination megaudit covered *only the V3.6 D-decision surface* (D1–D9).
- The engine plan defines a distinct **`5.8 Phase 5 Megaudit`** (`MASTER-PLAN.md` §679) and an explicit **Audit Checkpoint: "Megaudit after 5.7"** (§684). Its dependency ("5.1–5.7 V2+ complete") is now **met** (5.7 V3.6 phase-clean), so 5.8 is **UNBLOCKED and outstanding**.
- Scope of 5.8 = the **entire Phase 5 collaboration surface**, not just V3.6: V1 + D-1 + 5.3 + 5.5 (V2 V2 / V2 V3 steps 1–6 / V2 V4 V1) + 5.7 (V1 + V2.1–V2.9 + V3.1 + V3.2 + V3.3 + V3.4 + V3.5 + V3.6). Cross-sub-phase interactions (transport × snapshot × undo × format × sheet-ops × delta) are exactly what per-sub-phase audits cannot see — the same reason the V3.6.0.X 3-lane megaudit caught CONVERGENT-HIGH-1 (RestoreSheet preserved-cells) that the per-step D8 audit missed.

**[Pre-run recommendation — provenance, now DONE]** run the **5.8 Phase 5 Megaudit** as the FIRST Phase-6-entry action. **It is fully set out + execution-ready at `docs/phase5/megaudit-5-8/`** (PLAN.md + 4 lane prompts + synthesis template; 5-way: Codex Lane A + Opus Lanes B/C/D + claude-self synthesis; ~4–6 days). The next window dispatches per `docs/phase5/megaudit-5-8/PLAN.md` §6. It is the formal Phase 5 exit and satisfies Phase 6's "Phase 5 stable enough to expose" gate. Phase 5 Exit Criteria to verify (§690): `ql-collab` real ✅; cells/formulas/names/sheets/**tables** merge deterministically (verify tables + names explicitly — recent work centered on cells/sheets/format); offline sync + conflict diagnostics ✅; single-writer op log not confused with collaboration ✅.

---

## 4. Phase 6 scope (sub-items 6.1–6.7)

| # | Sub-item | Effort | Depends on | Notes |
|---|---|---|---|---|
| **6.1** | **Stable Engine Session API** | 4–6 d | — | **Foundation; everything else binds to it.** One Rust trait backing all bindings; cancellation; structured errors (API6-01..03). Consolidates the still-churning collab/IDE surface. |
| 6.2 | `ql-service` engine-as-service | 1 wk | 6.1 | Local transport (HTTP/gRPC — deliberate choice), auth hooks, streaming diagnostics, cancellation, versioned protocol (SVC-6-01..04). |
| 6.3 | WASM / Node / C / Python bindings | 2–3 wk | 6.1 | Make `ql-bindings-{wasm,node,c}` + `quantbook-py` real over the session API (BND-6-01..04). Note: `ql-bindings-node` already exists (the IDE consumes it) — this generalizes + adds the others. |
| **6.4** | **Python UDFs (`ql-udf`, PyO3)** | 1–2 wk | 6.1, fn metadata | **The strategic wedge (Product Phase 5).** Register/execute Python UDFs with sandbox, timeouts, cancellation, type-conversion matrix, deterministic error mapping (UDF-6-01..04). On the canonical **Month-6 Python kill gate**. |
| 6.5 | SQL surface + connectors (`ql-sql`, `ql-connectors`) | 1–2 wk | 6.1, graph invalidation | SQL over sheets/tables, external refresh, credentials boundary, Arrow interop (SQL-6-01..03, CONN-6-01..02). v1 connector set = Terminal + local files + DuckDB-attach (canonical §5). |
| 6.6 | `AI()` real backend (`ql-ai`) | 1 wk | 6.1/6.2 cancellation | Replace the Phase-1 sentinel with a real provider boundary; provenance; no-secret-leak (AI-6-01..04). *Uncertain: provider + product policy.* |
| 6.7 | Phase 6 Audit | 4–6 d | 6.1–6.6 | FFI/service-security/Python-exec/connector-creds/AI-data-flow/binding-consistency (A6-01..04). Security/design audit also required **after 6.1** before exposing service/bindings. |

**Total: ~8–12 weeks.** Audit checkpoints: security/design audit after 6.1 (before exposing surfaces); full audit after 6.6.

---

## 5. Recommended sequencing

> ⚠️ **SUPERSEDED by `docs/phase6/decision-lock.md` §2** (LOCKED 2026-05-26). The locked sequence stages the wedge as **6.1A → 6.1B → 6.1C(audit) → 6.4-0(fn-metadata) → 6.4A(MVP UDF + minimal Python slice) → 6.4B(harden) → 6.3 → 6.2 → 6.5 → 6.6 → 6.7**. The pre-lock recommendation below is retained for provenance.

1. **5.8 Phase 5 Megaudit** (gate; 3-lane; ~4–6 d) → formal Phase 5 exit. *Do not enter Phase 6 before this passes / closes.*
2. **Phase 6 decision-lock** (docs-only, mirrors V3.6.0.1 lock): pick HTTP-vs-gRPC for 6.2; confirm binding priority order; confirm `AI()` provider policy or defer 6.6; confirm whether to pull **6.4 (Python UDFs) earlier** given its strategic/kill-gate weight.
3. **6.1 Stable Engine Session API** (foundation) + its security/design audit.
4. **6.4 Python UDFs** — *recommend prioritizing ahead of 6.2/6.3/6.5* because it is the wedge + on the Month-6 kill gate; the IDE already consumes `ql-bindings-node`, so the Node path needed to exercise UDFs from the formula bar largely exists.
5. Then 6.2 / 6.3 / 6.5 / 6.6 per locked priority, 6.7 audit to close.

---

## 6. Risks / open questions for Phase 6 entry

- ~~**R-P6-1 — Phase 5 exit not yet signed off.**~~ ✅ **RESOLVED 2026-05-26** — the 5.8 megaudit ran (PASS-WITH-FINDINGS; Phase 5 COMPLETE). "Phase 5 stable enough to expose" is now audited, not asserted.
- **R-P6-2 — collab-surface API churn vs 6.1 lock.** The IDE collab napi is still evolving (V3.6.1 backlog: B9 `removedCells`, CellValueJson union, incremental DOM). 6.1 must lock a session API that the IDE can migrate to without a third rewrite. Decide which collab-surface items freeze pre-6.1.
- **R-P6-3 — PyO3 + GIL + free-threaded Python.** Canonical risk #12: free-threaded 3.13t blocked (Polars #21889); v1 ships GIL-only Python. 6.4 must assume GIL-only; re-evaluate at Month-6. Sandbox/timeout/cancellation semantics (UDF-6-02) are the hard part, not the call path.
- **R-P6-4 — UDF/SQL/AI must not bypass graph invalidation** (Phase 6 Exit Criteria). Phase 3's unified graph makes this *possible*; 6.4/6.5/6.6 must each wire explicit dependency invalidation (volatile/lazy semantics for UDFs; refresh-dirties-dependents for SQL).
- **R-P6-5 — strategic allocation.** Engine 5 (collab) = Product Phase 9 = **v1.5-deferred**. Remaining collab backlog (D7 `#REF!`, sheet-tabs, V3.6.2+ incremental DOM) is v1.5-optional. **It should not pre-empt Phase 6**, which is the v1 ship path. Flag any pull to "finish collab" against this.
- **R-P6-6 — `AI()` provider/product policy undecided** (6.6). May defer 6.6 to late Phase 6 / v1.5 without blocking the wedge.

---

## 7. Verdict

**Phase 6 is ENTRY-READY (2026-05-26): Phases 2B/3/4 shipped, Phase 5 COMPLETE** — the 5.8 Phase 5 Megaudit ran and closed (PASS-WITH-FINDINGS; 0 reachable HIGH; risk register 39/39). The correct next action is the **Phase 6 decision-lock** (§5 step 2), then **6.1 Stable Session API → 6.4 Python UDFs (the wedge)**, which is on the canonical Month-6 kill gate. (Post-exit Phase 5 polish — `export_snapshot` tombstone filter, `CellValueJson` retype, coverage gaps — is non-blocking; tracked in `docs/phase5/phase-5-exit-packet.md` §5.)

**Deliverables when Phase 6 is locked** (per `MASTER-PLAN.md` §780): this `entry-plan.md` (lock it), `exit-packet.md`, `docs/api/session-api.md`, `docs/security/udf-ai-connectors.md`.
