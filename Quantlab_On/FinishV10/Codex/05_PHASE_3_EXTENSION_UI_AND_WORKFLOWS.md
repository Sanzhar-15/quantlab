# Phase 3 - Extension UI and Workflow Completeness

Goal: Complete the user-facing workflow: data, action, chart, trade, history, reconciliation, audit, debugger.

## Core UI Fixes
- Trade view: wire real daemon data streams (positions, orders, fills, risk alerts).
- History: implement search, pinning, compare, artifact viewer.
- Data panel: implement data sources and universe management (non-placeholder).
- Reconciliation panel: surface daemon reconciliation status and actions.
- Audit panel: surface audit ledger entries and export.
- Debugger: implement `quantlab.engine.readDebugFile` and mmap-based reader for large debug files.

## Data Pipeline
- Use worker-based parsing for large CSV/parquet to avoid extension host blocking.
- Implement parquet ingestion or remove menu claims until supported.
- Align timeframe names across UI, engine, and daemon.

## UX Consistency
- Align terminology (symbol vs symbols, order types, time-in-force).
- Add live session warnings, banners, and status indicators.

## Acceptance Criteria
- Trade panel fully reflects daemon state and updates in real time.
- History panel and chart can open artifacts from completed jobs.
- Debugger can load large debug files without UI freeze.
- Data sources support CSV and (if implemented) Parquet reliably.

Dependencies: Phase 2.
Gate: required before Phase 4.
