# Phase 7 - Testing, Ops, and Release Readiness

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Implement the full Test Spec V1.2 with phase gates.
- Implement Ops Spec V1.3 requirements (updates, calendars, telemetry, rollout).
- Prepare release documentation, design system, and compliance artifacts.

## Spec Coverage
- Test Spec V1.2 (all sections)
- Ops Spec V1.3 (all sections)
- Technical: 13.3, 19.5 (performance acceptance)
- Product: 11 (regulatory disclosures), 12 (code modification safety messaging)
- Decisions: C16-C20, D21-D25, I54-I57, J58-J62, K67-K68, E26

## Decision Constraints (must implement)
- Phase gates with required test suites (D25).
- Opt-in telemetry only, crash-rate gating for rollout.
- Auto-updates blocked for live sessions; warn only for paper.
- AppImage only on Linux; code signing required for Windows/macOS.
- Bundled Open VSX extensions at build time.
- Scope freeze with explicit non-goals list.
- Timeline estimate ~38 weeks with 20% buffer (2-3 engineers).
- External security audit: required unless explicitly waived (E26).

## Implementation Plan
### 1) Test Infrastructure
- Python test runner and fixtures for engine/daemon.
- Shared test data repository for golden vectors and live vectors.
- Schema validation tests using JSON schema.

### 2) Phase Gates (Required)
- Phase 1: Engine unit tests >= 80% coverage.
- Phase 2: Golden vectors G001-G049 pass.
- Phase 3: Integration tests >= 70% UI coverage.
- Phase 4: All vectors including L001-L070 pass.

### 3) Security, Determinism, Chaos
- Secrets backend tests (Test 6.5).
- AI panel security tests (Test 6.6).
- Determinism tests for hashing and reproducibility.
- Minimal chaos tests (daemon kill, network loss, disk full).

### 4) Performance and Debug Tests
- Debug file performance tests (Test 9, 11.4).
- Benchmark harness in CI (Tech 13.3).
- Dedicated perf runner (4-core, 8GB RAM, SSD).

### 5) Operations Requirements
- Update system:
  - Choose update infrastructure path (VS Code updater vs electron-updater) per Phase 0 decision.
  - Live session block with daemon check + UI messaging.
  - Staged rollout with crash-rate gates only.
- Calendar maintenance tooling + CI validation for next 12 months.
- Telemetry pipeline (opt-in only):
  - Crash reports (sanitized), feature counts, performance metrics.
  - Explicit consent UI and local opt-out.
  - Storage/aggregation strategy documented (self-hosted or none).
- Backup retention and recovery procedures.

### 6) Design System Enforcement
- Publish `DESIGN_SYSTEM.md` (tokens, components, patterns, accessibility rules).
- Add lint/checklist in PR template for token usage and contrast.
- Ensure webviews load shared tokens via ThemeProvider.

### 7) Security Review Checkpoints
- Internal security review required before live trading GA.
- External audit scheduled; if skipped, require explicit leadership sign-off.

### 8) Release Readiness
- Risk disclosures and live trading compliance checklist.
- Code signing pipeline and certificate readiness.
- Monthly VS Code upstream merge cadence documented.

### 9) Parallelization Rules (J59)
- Allow Phase 2 (engine) and Phase 3 (UI/tray) in parallel after Phase 1.
- Phase 4 (live safety) gates on Phase 2 + Phase 3 completion.
- Phase 5 (debugger) can start after Phase 2 core artifacts.
- Phase 7 only after Phase gates are satisfied.

## Target Code Locations
- New: `engine/quantlab/tests/*`, `engine/quantlab/test_vectors/*`.
- New/Update: `extensions/quantlab/src/test/*`.
- Update: update service code in `src/vs/platform/update/*` or existing updater.

## Exit Criteria
- All required tests and phase gates are passing.
- Ops runbooks, telemetry, and update system verified.
- Design system documented and enforced.
- Release checklist signed off.

## References
- Appendix C: Dependencies and Timeline.

