# Phase 5 - Debugger, Artifacts, and Benchmark Harness

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Implement time-travel debugger artifacts and Arrow-based debug files.
- Meet debug file performance requirements (V1 target <= 500MB).
- Implement report export schemas and benchmark harness.

## Spec Coverage
- Technical: 13.3, 17.4, 19.1-19.6
- Product: 4.2 (Chart view time-travel debugger)
- Test: 9, 11.4 (debug performance tests)
- Decisions: A6, K64-K66

## Decision Constraints (must implement)
- Debug format is Apache Arrow IPC (.arrow).
- Full bar state required (OHLCV, indicators, conditions, portfolio state, user vars).
- PDF export optional; HTML + CSV required.
- Performance target for V1: <= 500MB debug files.

## Implementation Plan
### 1) Debug File Writer (Python)
- Capture OHLCV, indicators, conditions, signals, portfolio state, user vars.
- Enforce privacy bounds (no secrets, account identifiers).
- Sampling policy for files > 100k bars.

### 2) Arrow Memory-Mapped Reader
- Implement cross-platform Arrow IPC reader with index.
- Validate local-path only; lock files to prevent corruption.

### 3) UI Time-Travel Integration
- Chart view scrubber and inspection panel.
- On-demand range reads from Arrow file.
- Reduced-motion support.

### 4) Report Export Schemas
- Implement HTML and CSV exports per schema.
- PDF optional: only if dependencies are available.
- Update `ResultsExporter` to match schema.

### 5) Benchmark Harness
- Implement reproducible benchmark harness.
- CI gate compares against baseline thresholds.

## Target Code Locations
- New: `engine/quantlab/debug/*`, `engine/quantlab/reports/*`, `engine/quantlab/benchmark/*`.
- Update: `extensions/quantlab/src/views/chart/*`.
- Update: `extensions/quantlab/src/views/action/ResultsExporter.ts`.

## Tests and Validation (Phase Gate)
- Debugger correctness tests (Test Spec 11).
- Performance tests for debug file load/seek (Test 9/11.4).
- Benchmarks tracked in CI.

## Exit Criteria
- Debug files meet V1 performance targets.
- Time-travel debugger works on large datasets (<= 500MB) without stalls.
- Report exports match schema (HTML/CSV), PDF optional.

