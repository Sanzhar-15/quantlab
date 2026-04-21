# Quantlab V10 Finish Plan (Codex)

Date: 2026-01-29
Owner: Codex (Deep audit + optimal finish plan)
Scope: VS Code fork + built-in Quantlab extension + Python engine/daemon + build/release

This plan merges prior findings with a deeper, systems-level audit. It is structured as phased work with gates.

## Guiding Principles
- Single source of truth for protocol contracts, schemas, and CLI flags.
- Daemon-first architecture for live trading (crash isolation, safety, auditing).
- Deterministic, testable pipelines (backtest, optimization, Monte Carlo, WFA).
- Fail-safe behavior over convenience for live trading.
- Cross-platform parity (Linux/macOS/Windows) unless explicitly constrained.

## Top Risks (Must Resolve First)
1) IPC transport/auth mismatch prevents daemon UI integration and live trading.
2) CLI argument mismatch prevents daemon start; readiness detection is broken.
3) IPC message contract mismatch (method names + casing + payload shape) breaks core flows.
4) Safety and trust controls exist but are not enforced in live trading path.

## Phases Overview
- Phase 0: Freeze architecture + contracts + migration plan
- Phase 1: IPC transport/auth + protocol normalization
- Phase 2: Live daemon lifecycle + safety enforcement
- Phase 3: Extension UI + workflows + data pipeline
- Phase 4: Engine completeness (live brokers, reconciliation, debug state)
- Phase 5: Test/QA + CI + release
- Phase 6: Operations + security + governance

## Phase Gates (Summary)
- Gate A: IPC handshake works, daemon start works, end-to-end live session start works in dev.
- Gate B: Safety/trust + kill switch enforced for live trading.
- Gate C: UI charts/action/trade/histories fully wired to engine artifacts.
- Gate D: Live broker adapter, reconciliation, audit ledger integration complete.
- Gate E: CI green, coverage + golden vectors + live test vectors pass, release checklist complete.

## Deliverables
- Updated IPC spec + shared schema files
- Unified CLI contract + migration shim
- Fully wired daemon lifecycle + extension integration
- Complete UI for trade, history, reconciliation, audit, debugger
- Engine feature completeness + performance/benchmark harness
- Release + security + ops playbook

See files 01-06 for detailed tasks, dependencies, and acceptance criteria.
