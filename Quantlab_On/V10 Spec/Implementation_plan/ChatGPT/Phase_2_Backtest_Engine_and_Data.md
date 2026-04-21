# Phase 2 - Backtest Engine, Data Provenance, and Reproducibility

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Replace TS mock engine with real Python backtest engine under `engine/`.
- Implement execution model, order simulation, short selling, slippage, commissions.
- Implement data provenance, feature store, and environment reproducibility.
- Produce artifacts and metrics consistent with Technical Spec schemas.

## Spec Coverage
- Technical: 2, 3, 4, 5, 6, 7, 8, 9, 10.1-10.4, 17.1-17.3, 18.1-18.5
- Product: 4 (Action view), 6 (History), 7 (Data file handling)
- Test: 2 (G001-G089), 3 (unit tests)
- Decisions: A1-A3, B7-B9, B12, F35-F36, M80

## Decision Constraints (must implement)
- Engine code lives in `engine/` with Python 3.11 bundled.
- In-place upgrades with migration scripts.
- Artifact storage in `~/.quantlab/history/` with retention (30 days or 100 runs).
- Breaking history compatibility acceptable for V1.
- Data sources: Alpaca Data + local CSV/Parquet.

## Implementation Plan
### 1) Python Engine Package
- Create `engine/quantlab/` package with:
  - `backtest/`, `orders/`, `portfolio/`, `metrics/`, `data/`, `artifacts/`.
- Provide CLI entrypoint for backtests.
- Support bundled Python and optional external Python path (`quantlab.python.path`).

### 2) Execution Model and Order Simulation
- Implement signal vs execution bar semantics.
- Implement order types with gap behavior.
- Time-in-force: GFD, GTC, IOC.
- Short selling with 100 percent collateral.
- Slippage and commission models.
- Order idempotency and client order IDs (Tech 10.2).
- Rate limiting and retry rules (Tech 10.4).

### 3) Data Provenance and Feature Store
- Implement DataRev and UniverseRev generation.
- CSV/Parquet loader with schema validation.
- Feature store contract (Tech 7).
- Data lineage fields in artifact manifest.

### 4) Environment Reproducibility
- Capture environment snapshot (Python version, packages, OS, engine version).
- Write manifest into artifacts folder.

### 5) Runner Manager Integration (TS)
- Replace `JobRunner` with RunnerManager spawning Python backtests.
- JSON-RPC protocol for progress/log/complete.
- Update `EngineHost` process lifecycle management.
- Update `HistoryState` to read new manifest and result schema.

### 6) Artifact Contracts
- Implement result, trades, equity, config artifacts per 17.1-17.3.
- Align `ResultsExporter` to new schema (HTML + CSV required; PDF optional).

### 7) Migration Behavior (V1)
- V1 allows breaking history compatibility; enforce explicit UX:
  - On detecting legacy artifacts, show banner: "Legacy runs not supported in V1.".
  - Provide pre-upgrade export guidance in release notes.
- For V1.x, add migration scripts as needed (future phase).

### 8) Resource Limits and Concurrency
- Enforce memory ceilings (4GB backtest per decision).
- Allow concurrent backtests with queue and resource caps.
- Add disk space checks before starting large runs.

## Target Code Locations
- New: `engine/quantlab/*`.
- Update: `extensions/quantlab/src/core/engine/EngineHost.ts`.
- Replace: `extensions/quantlab/src/core/engine/JobRunner.ts`.
- Update: `extensions/quantlab/src/core/state/HistoryState.ts` and `views/action/*`.

## Tests and Validation (Phase Gate)
- Golden vectors G001-G049 must pass.
- Engine unit test coverage >= 80%.
- Determinism tests for hashing and results.

## Risks and Mitigations
- Risk: Performance regressions with large datasets.
  - Mitigation: streaming loader, incremental indicators, memory caps.
- Risk: Schema mismatch between engine artifacts and UI.
  - Mitigation: schema validation and migration scripts.

## Exit Criteria
- Backtests run through Python engine end-to-end with UI.
- Golden vectors G001-G049 pass within tolerance.
- History view renders metrics/trades/equity from new artifacts.

