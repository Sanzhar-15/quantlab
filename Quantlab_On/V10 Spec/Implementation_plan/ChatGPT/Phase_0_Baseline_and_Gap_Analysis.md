# Phase 0 - Baseline, Gap Matrix, and Architecture Alignment (V10)

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Establish an accurate baseline of what is already implemented in the current repo.
- Build a spec-to-code gap matrix for Product V10.5, Technical V2.5, Test V1.2, Ops V1.3.
- Lock cross-language architecture boundaries (TS extension vs Python engine vs daemon).
- Apply the approved implementation decisions as non-negotiable constraints.
- Resolve build/packaging path for bundled Python + embedded venv.

## Decision Constraints (from Quantlab_Implementation_Decisions.md)
- Engine lives under `engine/` (Python 3.11 bundled with embedded venv).
- Live daemon is Python; TS IPC bridge in Electron.
- IPC: JSON-RPC 2.0 over Unix sockets (macOS/Linux) and Named Pipes (Windows).
- Debug file format: Apache Arrow IPC (.arrow).
- Artifact storage: `~/.quantlab/history/` with retention policy; breaking migration acceptable for V1.
- Live trading is in V1; Alpaca + Mock broker only; Alpaca Data + local CSV/Parquet.
- Real-time data required; provider failover deferred to V1.1.
- Extension trust is per-workspace with version-based revocation.
- AI panel is in V1 with Claude default provider (pluggable later).
- Audit logs are tamper-evident with 7-year retention.
- System tray required with Linux fallback.
- Updates blocked for live sessions; warn only for paper sessions.
- Design system must be authored as `DESIGN_SYSTEM.md`.
- Strict V1 scope freeze with explicit non-goals list.

## Current Implementation Baseline (verified from code)
### Core UI and Extension
- Built-in extension at `extensions/quantlab/` with Chart/Action/Trade custom editors and five activity bar panels.
- Workbench patches already exist for titlebar selectors, history button, toast container, and Quantlab CSS tokens.
- Theme and notification plumbing exists (`ui/tokens`, `ui/notifications`, `ui/errors`, `ui/onboarding`).

### Engine and Data (current state)
- `EngineHost` and `JobRunner` are TS-only mocks producing synthetic results.
- `DataService` provides mock OHLCV data or loads a BTC CSV from workspace.
- `VisualizationRunner` is a TS parser, not a Python execution engine.
- No Python engine code exists yet under `engine/`.

### Trading (current state)
- `SessionManager` exists with Alpaca/Mock adapters; polling-based updates and basic risk alerts.
- No daemon process, IPC, or session recovery.
- No exposure reservation model or reconciliation layers.

### Security/Trust (current state)
- Secrets stored only in VS Code SecretStorage (no encrypted fallback).
- Workspace trust exists but no extension trust UI/policy.
- No AI panel implementation.
- Code modification uses string parsing, not LibCST.

### Testing (current state)
- Small TS unit test set only.
- No golden vectors, live vectors, chaos, or benchmark harness.

## V10 Gap Matrix (high level)
### Product Spec V10.5
- Live session UI behaviors (close flows, tray, recovery, connection loss) not implemented.
- Extension trust model and review UI not implemented.
- Pre-trade validation checklist incomplete.
- Design system source of truth missing.

### Technical Spec V2.5
- Live daemon architecture (1.5/1.6) not implemented.
- Data provider adapter (10.5), reconciliation (10.6/10.7), reservation model (11.4.1) not implemented.
- Protocol versioning, ordering, ack/retry, and auth not implemented.
- Audit log (12.3), benchmark harness (13.3) not implemented.
- Calendar/timezone/decimal schemas (14.3-14.5) not implemented.
- Code modification contract (18.6) not implemented.
- Debug file performance + Arrow memory mapping (19.5/19.6) not implemented.
- AI panel sanitization and security model (20.5/20.6) not implemented.

### Test Spec V1.2
- Golden vectors G001-G105 not implemented.
- Live trading vectors L001-L070 not implemented.
- Security, determinism, chaos, performance tests not implemented.

### Ops Spec V1.3
- Update blocking during live sessions not implemented.
- Calendar tooling + CI validation missing.
- Telemetry (opt-in) policy not wired into product.

## Packaging and Build Strategy (must resolve in Phase 0)
- Define build pipeline for bundled Python + embedded venv:
  - Windows: embed Python zip + venv creation at build.
  - macOS: framework Python inside app bundle.
  - Linux: AppImage with bundled Python.
- Decide packaging scripts location (likely `build/` + `engine/` build scripts).
- Define how Python dependencies are installed at build time (pinned requirements).
- Define runtime selection logic (`quantlab.python.path` override).
- Decide how engine upgrades run migrations (`~/.quantlab/version.json`).

## Artifact Migration and Compatibility (V1)
- V1 allows breaking changes: UI must detect old artifacts and show a clear message.
- Explicitly document: old runs are not readable after upgrade; user can export before upgrade.

## Update System Integration (must resolve in Phase 0)
- Decide whether to adapt existing VS Code update infrastructure or replace with electron-updater.
- Document chosen path and owning code locations.

## Phase 0 Deliverables
- Detailed gap matrix mapping every spec section to code modules with status.
- Architecture diagram updated to match decision constraints (engine/daemon/IPC).
- Packaging and runtime strategy doc (bundled Python, embedded venv, upgrade flow).
- Migration policy for artifacts (breaking V1), retention policy, and locations.
- Design system doc stub with token inventory and component list.
- Backlog with dependencies, risk flags, and phase gates aligned to decisions.

## Exit Criteria
- Decision constraints embedded into the plan as non-negotiables.
- Gap matrix reviewed and approved.
- Build/packaging strategy and update path resolved.
- Phase gates and scope freeze published.

## References
- Appendix A: Build and Packaging Workflow.
- Appendix C: Dependencies and Timeline.

