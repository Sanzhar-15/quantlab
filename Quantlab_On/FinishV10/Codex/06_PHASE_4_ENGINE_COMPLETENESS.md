# Phase 4 - Engine Completeness

Goal: Complete Python engine feature set required by V10 spec.

## Live Trading
- Alpaca live adapter (not just paper).
- Real-time quote fetching for exposure checks and slippage.
- Reconciliation (positions, fills, cash) with auto-correct.
- Broker disconnect handling with circuit breaker integration.

## Backtest & Analytics
- Fill model completeness for all order types.
- Intraday borrow fee proration.
- Corporate actions (splits/dividends) or explicit deferral with UI warnings.

## Debugging
- Debug state capture for time-travel debugger.
- Efficient debug file reader (mmap) + index integrity checks.

## Acceptance Criteria
- Live adapter passes paper and live sandbox tests.
- Reconciliation produces actionable diff + auto-correct.
- Debug files load and seek in O(1) for large runs.

Dependencies: Phase 3.
Gate: required before Phase 5.
