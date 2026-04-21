# QIC Sequenced Implementation Prompts

## Overview

21 sequenced prompts for implementing the Quantlab Intelligence Console (QIC) — an AI-powered coding assistant panel in Quantlab's right-hand sidebar, comparable to Cursor AI's RHS bar.

These prompts are designed to be executed sequentially by Claude Code, with each prompt being self-contained and producing a verifiable deliverable.

## Source Documents

| Document | Size | Purpose |
|----------|------|---------|
| `QIC_SPEC_V6_2_COMPLETE.md` | 8,465 lines | Technical specification (types, interfaces, invariants) |
| `QIC_V6_2_IMPLEMENTATION_PLAN_V3_FINAL.md` | 2,274 lines | 12-phase implementation plan with gate criteria |
| `QIC_V6_2_DEEP_AUDIT.md` | 447 lines | 28 findings (7 critical, 12 high, 9 medium) |

## Audit Findings Addressed

All 28 audit findings are addressed inline within the prompts:

| Severity | Count | Addressed In |
|----------|-------|-------------|
| CRITICAL | 7 | Prompts 00, 08, 10 |
| HIGH | 12 | Prompts 03, 04, 05, 06, 08, 10, 12, 17, 18 |
| MEDIUM | 9 | Prompts 04, 09 |

The 3 most critical fixes:
1. **I-1**: Broken agentic loop → Fixed in Prompt 10 with explicit while-loop
2. **S-1/S-2**: Missing orchestrator/lane router → Added in Prompt 10
3. **I-3**: No early egress blocking → Block-all stub in Prompt 00

## Prompt Sequence

> **IMPORTANT (AUDIT FIX X-PS6)**: Execute Prompt 14 BEFORE Prompt 10. Prompt 14's actual dependencies are only Prompts 04 (canonical types) and 06 (security foundation). Running 14 before 10 eliminates the SecurityAuditLogger stub gap entirely.

```
Phase 0 — Crash Safety Foundation
├── 00  Scaffold & Workbench Integration     (NEW — integrates QIC into Quantlab)
├── 01  JournaledAtomicWriter                (crash-safe atomic writes)
├── 02  FileContent Types & Streams          (OOM prevention)
└── 03  Checkpoint Validity & Persistence    (CV-1–CV-5, SQLite state)

Phase 1 — Foundation Types
├── 04  Canonical Types & Registries         (types, tools, errors, lanes)
└── 05  Storage, State Machines & Timeout    (FSMs, cancellation, BM25 schema)

Phase 2 — Security
└── 06  Security Foundation                  (egress, consent, Aho-Corasick, encryption)

Phase 3 — Reliability
└── 07  Mutation Engine & Error Recovery     (edits, matching, circuit breakers)

Phase 4 — Network
└── 08  Gateway & Provider Adapters          (Anthropic/OpenAI/Ollama, rate limiter)

Phase 5 — Intelligence
├── 09  Context Engine                       (embedding, indexing, reranking)
├── 14  Security Hardening  ★ MOVED HERE     (terminal guard, audit logger)
└── 10  Agent Runtime & Orchestrator  ★      (THE core agentic loop)

Phase 6 — Completion
└── 11  Completion Engine & Resilience       (inline completions, degradation)

Phase 7 — UI
├── 12  Chat Panel Webview                   (primary user interface)
└── 13  Diff Preview & Permissions UI        (edit approval, permission dialogs)

Phase 8 — Tool Implementations
└── 15  All 22 Tool Implementations          (file, search, terminal, LSP, etc.)

Phase 9 — Quant Domain
└── 16  Quant Features                       (DataFrame, Arrow IPC, Python engine bridge)

Phase 10 — Observability
└── 17  Telemetry & Reproducibility          (privacy telemetry, replay mode)

Integration
├── 18  Activation Sequence & Wiring         (connect all components)
├── 19  Integration Testing                  (E2E, benchmarks, validation)
└── 20  Final Polish & Release Prep          (fixes, docs, ship)
```

**Recommended execution order**: 00, 01, 02, 03, 04, 05, 06, 07, 08, 09, **14**, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20

## Parallelism Opportunities

Some prompts can execute in parallel:
- **01 and 02** are independent (both Phase 0)
- **04 and 05** can partially overlap (both Phase 1)
- **09 and 11** are semi-independent (different subsystems)
- **12 and 14** can overlap (UI vs security hardening)

## Execution Instructions

For each prompt:

1. **Read** the prompt file completely
2. **Study** the referenced spec sections (line numbers provided)
3. **Check** existing files mentioned in "Codebase Context"
4. **Implement** following the detailed instructions
5. **Verify** against the acceptance criteria checklist
6. **Test** by running `npx tsc --noEmit` and the specified tests

## Architecture Decision

QIC is implemented as a **workbench contribution** (not a VS Code extension):
- Location: `src/vs/workbench/contrib/qic/`
- Registered in: `src/vs/workbench/workbench.common.main.ts`
- Uses internal VS Code APIs (not extension API)
- Deeper integration with editor, better performance
- Follows same pattern as existing Quantlab customizations

## Key Invariants (Must Hold at All Times)

| ID | Rule | Enforced By |
|----|------|-------------|
| INV-T1 | Preview Before Apply | ApprovalToken type signature |
| INV-T2 | No Silent Execution | SecurityAuditLogger |
| INV-T3 | Secret Protection | EgressBoundaryEnforcer |
| INV-T4 | Checkpoint Integrity | CV-1 through CV-5 |
| INV-T5 | Cancellation Safety | Hierarchical AbortController |
| INV-A1 | Single Source of Truth | canonical/index.ts |
| INV-A2 | Atomic Multi-File Ops | JournaledAtomicWriter |
| INV-A3 | Checkpoint Crash Safety | PENDING/COMPLETE markers |
| INV-A4 | Timeout Domain Separation | USER_INTERACTION = Infinity |

## Audit Fixes Applied

All 21 prompts have been updated with 104 fixes from the deep audit (`QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md`). Key changes:

- **FileContent type reconciled** — spec and prompt variants merged into a consistent 4-variant type with `type` field and spec-aligned thresholds (1MB/50MB)
- **Service identifiers added** — all 5 QIC service identifiers created via `createDecorator` for proper dependency injection
- **Security hardening strengthened** — API keys moved to SecretStorage, symlink path traversal protection, command injection defense with structured parsing, secret redaction on error messages
- **Quantlab integration prioritized** — Python sidecar replaced with bridge to existing engine daemon, existing IPC types reused, consent/sanitization/audit systems integrated with existing Quantlab modules
- **Activation timeout addressed** — split into sync Phase A (< 5s) and async Phase B with progressive status bar updates
- **Keybinding collision fixed** — `Ctrl+Shift+N` changed to `Ctrl+Alt+N` to avoid conflict with existing bindings
- **Prompt execution reordered** — Prompt 14 now executes between 09 and 10, eliminating SecurityAuditLogger stub gap
- **CI test coverage expanded** — 7 CI test suites with npm scripts, load tests, anti-pattern checks, 4 additional validation scripts

### Per-Prompt Fix Summary

| Prompt | Fix IDs Applied | Count |
|--------|----------------|-------|
| 16 | III-QI2, III-QI3, VIII-PC1, III-QI10 | 4 |
| 17 | (none — already up to date) | 0 |
| 18 | IX-CC1, X-PS1, X-PS4, VIII-PC4, VIII-PC5, VIII-PC6, XII-AR1, XII-AR4, XII-AR8, XI-SV7, IV-AO3 | 11 |
| 19 | II-PG1, VIII-PC2, VIII-PC7, IV-AO2, X-PS9, IV-AO12 | 6 |
| 20 | III-QI9 | 1 |
| README | X-PS6 | 1 |
