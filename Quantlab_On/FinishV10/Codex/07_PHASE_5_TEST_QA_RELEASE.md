# Phase 5 - Testing, QA, and Release

Goal: Make Quantlab releasable with high confidence.

## Testing
- IPC end-to-end tests using real daemon (not mock).
- Golden vector suites for backtest, order types, edge cases.
- Live trading test vectors for session lifecycle, risk limits, kill switch.
- UI integration tests for chart/action/trade/history panels.

## CI/CD
- Add CI matrix for Linux/macOS/Windows where supported.
- Enforce lint + unit + integration on every PR.
- Add security scanning and dependency audit.

## Release
- Build pipeline for signed installers.
- Update workflow integration and release notes generation.
- Telemetry/diagnostics policy (if any) clarified.

## Acceptance Criteria
- All tests pass, coverage thresholds met.
- Golden vectors G001-G105 pass.
- Live test vectors L001-L070 pass in paper trading.
- Release artifacts signed and reproducible.

Dependencies: Phase 4.
