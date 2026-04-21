# Phase 4 Evaluation (Complete-Implementation-plan)

Date: 2026-01-26
Evaluator: Codex (ChatGPT)
Scope: Phase 4 in `Complete-Implementation-plan/05_Phase_4_Live_Trading.md`

---

## Verdict
**Phase 4 is detailed but not fully optimal.** There are critical architecture mismatches (daemon vs extension), path inconsistencies, and a few decision‑aligned gaps that need correction before execution.

---

## Major Strengths
1. **Emergency flatten**: Two‑stage protocol, quote validation, retry strategy, and out‑of‑hours handling are fully specified (Ops §2.6).
2. **Audit log**: Tamper‑evident log, hash chaining, export, and tests are defined (E31).
3. **Data provider scope**: Alpaca Data only for V1, failover deferred (B12/B15).
4. **Network and sleep/wake**: Circuit breaker + sleep/wake handling are implemented (N81/N82).
5. **Auto‑update protection**: Belt‑and‑suspenders blocking for live sessions is covered (C16).

---

## Decision Mismatches / Gaps (Must Fix)

### 1) Engine path mismatch (Decision A1)
**Decision A1**: Engine package root is `engine/quantlab/`.

**Plan issue**: Phase 4 tasks reference `engine/daemon/*`, `engine/audit/*`, `engine/ledger/*`, `engine/metrics/*` rather than `engine/quantlab/...`.

**Fix**: Normalize all Phase 4 engine file targets to `engine/quantlab/...`.

---

### 2) Live‑critical logic placed in extension host (architecture mismatch)
**Decisions A4/A5**: Live daemon must run independently of UI; critical trading logic must survive UI closure.

**Plan issue**: Several critical components are located in the extension host:
- Quote validation + flatten logic (`extensions/quantlab/src/core/trading/flatten.ts`)
- DataProviderAdapter + Alpaca data adapter (`extensions/quantlab/src/core/data/*`)
- Fill reconciliation (`extensions/quantlab/src/core/trading/fills.ts`)
- Broker disconnect handling (`extensions/quantlab/src/core/broker/*`)
- Position reconciliation algorithm (`extensions/quantlab/src/core/trading/reconcile.ts`)

**Why it matters**: If UI closes or crashes, the daemon must still trade safely. Placing core live‑trading logic in the extension undermines daemon independence.

**Fix**:
- Move data provider, flatten, fill reconciliation, and broker disconnect handling into the **Python daemon**.
- Keep extension host as UI + control surface only.

---

### 3) Corporate actions appear in reconciliation logic despite deferral (Decision L71)
**Decision L71**: Corporate actions are deferred to V1.1.

**Plan issue**: Reconciliation snippet checks `data_provider.get_corporate_actions()` even though corporate actions are deferred. Tasks strike out detection but the algorithm still references it.

**Fix**: Remove corporate‑action checks from V1 reconciliation logic; keep placeholder for V1.1.

---

### 4) Risk limits beyond consecutive losses not implemented
**Spec/Decisions**: Daily loss and max drawdown limits are required (Product §5.5, Decision L74 defaults).

**Plan issue**: Phase 4 includes circuit breaker for network issues and consecutive loss (Phase 1) but **does not implement daily loss / drawdown enforcement** anywhere in Phase 4.

**Fix**: Add daily loss + drawdown enforcement (daemon‑side) with alerts and circuit breaker actions.

---

## Additional Observations (Not blockers)
- **Quote validation latency**: Uses TS staleness monitor; once moved to daemon, ensure quote age logic uses daemon timestamps.
- **Audit log viewer UI**: Good, but ensure export path supports 7‑year retention (archive/rotation policy).

---

## Required Fixes (Priority Order)
1. Normalize `engine/*` paths to `engine/quantlab/*` (Decision A1).
2. Move live‑critical logic (flatten, data provider, fill reconciliation, broker disconnect handling) into Python daemon (A4/A5).
3. Remove corporate‑action checks from V1 reconciliation logic (L71).
4. Add daily loss + max drawdown enforcement in daemon (Product §5.5, Decision L74 defaults).

---

## Final Assessment
Phase 4 is **near‑optimal but not safe to execute** until the four fixes above are applied. After correction, it will be fully aligned with the Decisions Document and daemon‑first architecture.

