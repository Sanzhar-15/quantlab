# QIC — Existing AI Infrastructure Analysis

Analysis of `extensions/quantlab/src/ai/` for reuse in QIC.

## Components QIC Can Directly Reuse (Pattern-Level)

| Component | File | Reuse Strategy |
|-----------|------|----------------|
| Consent categories | `consent.ts` | QIC's ConsentStore (Prompt 06) adopts the same category model (`strategy_code`, `error_messages`, `data_samples`, `performance_metrics`) and blocked categories (`broker_credentials`, `trading_history`, `personal_data`, `api_keys`). Reimplemented at workbench level using `IStorageService`/`IDialogService` since extension-level `ConsentManager` uses `vscode.*` API. |
| Sanitization patterns | `sanitize.ts` | QIC's OptimizedSecretScanner (Prompt 06) incorporates all 15+ regex patterns from `sanitize.ts` (API keys, broker credentials, SSNs, AWS keys, GitHub tokens) into its Aho-Corasick automaton. The existing patterns serve as the baseline; QIC adds ~45 more for a total of 60+. |
| Audit entry structure | `audit.ts` | QIC's SecurityAuditLogger (Prompt 14) uses the same field schema (`sessionId`, `timestamp`, `durationMs`, `hadRedactions`, `consentCategories`) and JSONL format. QIC extends with hash-chaining (SHA-256) for tamper detection, consistent with the existing engine audit. |

## Components QIC Needs to Extend

| Component | File | Extension Strategy |
|-----------|------|-------------------|
| Provider configuration | `provider.ts` | QIC's AnthropicAdapter (Prompt 08) reuses the connection configuration pattern (API key via SecretStorage, model selection, rate limiting). Extends with: multi-provider support (OpenAI, Ollama), streaming via `AsyncIterable<StreamChunk>`, circuit breaker, and request prioritization. |
| Context building | `context.ts` | QIC's ContextAssembler (Prompt 09) reuses the size-budgeted approach (30K char limit maps to token budgets). Extends with: BM25+vector hybrid search, per-lane token budgets, and reranking. |
| Rate limiting | `provider.ts` | QIC's RateLimiter (Prompt 08) extends the simple timestamp-based approach with per-provider token bucket, lane-based quota allocation, and request shedding. |

## Components QIC Must Build New

| Component | Reason |
|-----------|--------|
| JournaledAtomicWriter (Prompt 01) | No existing crash-safe write infrastructure |
| FileContent tiered types (Prompt 02) | No existing stream-based file handling |
| Canonical type system (Prompt 04) | New unified type system for all QIC components |
| State machines (Prompt 05) | No existing FSM infrastructure for agent state |
| Aho-Corasick scanner (Prompt 06) | Existing sanitize.ts uses linear regex scan; QIC needs O(n) multi-pattern matching |
| Mutation engine (Prompt 07) | No existing edit/diff engine |
| Gateway (Prompt 08) | New central hub for multi-provider LLM communication |
| Agent orchestrator (Prompt 10) | No existing agentic loop with tool use |
| 22 tools (Prompt 15) | New tool implementations |
| Webview chat UI (Prompt 12) | New chat interface (existing panels use TreeView, not webview chat) |
