# Prompt 11 — Completion Engine, Model Registry & Resilience

**Phase**: 6 (Completion & Resilience)
**Prerequisites**: Prompt 08 (gateway), Prompt 09 (context engine)
**Estimated Scope**: ~6 files created, ~800 lines

---

## Objective

Implement the tiered completion engine (inline code completions with ghost text), FIM adapter, degradation manager (5 levels of graceful degradation), and memory manager. This enables the inline code completion experience.

---

## Spec References

- QIC Spec v6.2: §4.4 Completion Architecture (lines 3228–3273) — Tiered completion
- QIC Spec v6.2: §4.2 Model Recommendations (lines 3119–3185) — FIM models
- QIC Spec v6.2: §12.1 Degradation Manager (lines 7763–7857) — 5 degradation levels
- QIC Spec v6.2: §12.2 Memory Manager (lines 7857–7939) — Budget allocation

## Audit Fixes Incorporated

- **I-2 (CRITICAL)**: Specify the completion bypass path (does NOT go through the orchestrator). Completion path: keystroke → debounce → context assembly → LLM → ghost text.
- **I-SG7 (HIGH)**: Add explicit completion flow diagram with full bypass path specification.
- **VII-DS5 (HIGH)**: Add 6-tier completion waterfall specification.
- **VII-DS16 (MEDIUM)**: Add per-component memory budgets with eviction policies.
- **IX-CC2 (MEDIUM)**: Register QIC as standard InlineCompletionProvider; do NOT create a second controller.
- **XI-SV4 (partial)**: CompletionEngine must re-check consent on every request.
- **XII-AR7 (MEDIUM)**: Add recovery conditions for each degradation level and manual recovery command.

---

## Implementation Instructions

### 1. CompletionEngine (`src/vs/workbench/contrib/qic/common/completion/completionEngine.ts`)

**AUDIT FIX I-2**: This is a SEPARATE path from the orchestrator — no tool routing, no step execution.

**AUDIT FIX I-SG7**: Explicit completion flow diagram — the full bypass path:

```
Keystroke → 150ms debounce → CompletionEngine.provideCompletions()
→ Context assembly (prefix/suffix/imports/types, 4K budget)
→ Tier selection (waterfall: local GPU → local CPU → cache → cloud)
→ FIM or instruction-based prompt construction
→ Provider request (bypasses orchestrator entirely)
→ Ghost text display
```

**AUDIT FIX VII-DS5**: 6-tier completion waterfall — each tier is attempted in order. If a tier fails or exceeds its timeout, fall through to the next:

| Tier | Source | Timeout | Fallback Behavior |
|------|--------|---------|-------------------|
| 1 | Local GPU (e.g., ollama with Code Llama) | 200ms | Fall to Tier 2 |
| 2 | Local CPU (e.g., llama.cpp quantized) | 400ms | Fall to Tier 3 |
| 3 | Session cache (exact prefix match) | 10ms | Fall to Tier 4 |
| 4 | Cloud provider (via Gateway) | 2000ms | After 500ms, start Tier 5 in parallel |
| 5 | Static analysis (type-based heuristics) | 50ms | Fall to Tier 6 |
| 6 | Empty response (no completion) | 0ms | Return empty |

When Tier 4 (cloud) is selected and 500ms elapses without a response, Tier 5 (static analysis) fires in parallel. Whichever responds first wins. If neither responds, return empty (Tier 6).

**AUDIT FIX XI-SV4**: CompletionEngine must re-check LLM consent on EVERY request. Never cache consent status.

```typescript
export class CompletionEngine {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly debounceMs = 150;  // AUDIT FIX I-SG7: 150ms debounce per flow diagram
    private lastRequest: AbortController | null = null;

    constructor(
        private readonly gateway: Gateway,
        private readonly contextAssembler: ContextAssembler,
        private readonly modelRegistry: ModelRegistry,
        private readonly degradationManager: DegradationManager,
        private readonly consentStore: ConsentStore  // AUDIT FIX XI-SV4
    ) {}

    /**
     * Trigger completion for the current cursor position.
     * Flow: keystroke → 150ms debounce → CompletionEngine.provideCompletions()
     *       → Context assembly (4K budget) → Tier selection → Provider request
     *       (bypasses orchestrator entirely) → Ghost text
     *
     * This is the "thin path" — bypasses the orchestrator entirely.
     * No tool routing, no step execution, no permission checks.
     */
    async provideCompletions(
        document: TextDocument,
        position: Position,
        signal: AbortSignal
    ): Promise<CompletionResult | null> {
        // AUDIT FIX XI-SV4: Re-check consent on EVERY request — never cache this
        if (!this.consentStore.hasConsent('llm')) {
            return [];
        }

        // Cancel any pending request
        this.lastRequest?.abort();
        this.lastRequest = new AbortController();

        // Check degradation level
        if (this.degradationManager.getLevel() >= DegradationLevel.NoCompletions) {
            return null;
        }

        // Assemble context (uses 'completion' lane budget, 4K token budget)
        const context = await this.contextAssembler.assemble('completion', '', {
            activeFile: document.uri.toString(),
            // Include surrounding code as context (prefix, suffix, imports, types)
        });

        // AUDIT FIX VII-DS5: 6-tier completion waterfall
        // Tier 1: Local GPU → Tier 2: Local CPU → Tier 3: Session cache
        // → Tier 4: Cloud (with parallel Tier 5 fallback after 500ms)
        // → Tier 5: Static analysis → Tier 6: Empty response
        const model = this.modelRegistry.getRecommendedModel('completion');

        // Send request (NOT through orchestrator — direct gateway call)
        // REMEDIATION FIX: Use sendRequest() (canonical method name per Prompt 08 fix 2c)
        const response = await this.gateway.sendRequest({
            model,
            messages: [{
                role: 'user',
                content: this.buildFIMPrompt(document, position, context)
            }],
            lane: 'completion',
            priority: 'high',
            temperature: 0.0,
            maxTokens: 256,
            signal: this.lastRequest.signal
        });

        return this.parseCompletionResponse(response);
    }

    /**
     * Build Fill-In-the-Middle (FIM) prompt.
     */
    private buildFIMPrompt(document: TextDocument, position: Position, context: AssembledContext): string;
}
```

### 2. FIMAdapter (`src/vs/workbench/contrib/qic/common/completion/fimAdapter.ts`)

Adapts FIM format for different providers:

```typescript
export class FIMAdapter {
    /**
     * Format a FIM request for the specific provider.
     * Different providers use different FIM markers.
     */
    formatFIMRequest(
        prefix: string,
        suffix: string,
        providerId: string
    ): { prompt: string; stop?: string[] };
}
```

### 3. DegradationManager (`src/vs/workbench/contrib/qic/common/resilience/degradationManager.ts`)

5-level graceful degradation:

```typescript
export enum DegradationLevel {
    Normal = 0,           // All features active
    ReducedQuality = 1,   // Use faster/cheaper models
    NoCompletions = 2,    // Disable inline completions
    LocalOnly = 3,        // Only local operations (no LLM calls)
    Emergency = 4         // Minimal functionality (save work only)
}

export class DegradationManager {
    private level: DegradationLevel = DegradationLevel.Normal;

    constructor(
        private readonly memoryManager: MemoryManager,
        private readonly gateway: Gateway
    ) {}

    /**
     * Get current degradation level.
     */
    getLevel(): DegradationLevel;

    /**
     * Evaluate conditions and potentially change degradation level.
     * Called periodically and after significant events.
     */
    async evaluate(): Promise<DegradationLevel>;

    /**
     * Force a specific degradation level (for testing or manual override).
     */
    setLevel(level: DegradationLevel): void;
}
```

Degradation triggers:
- Level 1: Provider latency > 2x normal, or error rate > 10%
- Level 2: Memory pressure high, or provider error rate > 30%
- Level 3: All providers unavailable, or memory critical, or **database unavailable** (REMEDIATION FIX 5b / AUDIT FIX XII-AR1 partial: If SQLite database is unavailable, set DegradationLevel.LocalOnly — no state persistence means no safe agentic operations)
- Level 4: Emergency (OOM imminent, disk full)

**AUDIT FIX XII-AR7**: Recovery conditions — each degradation level must define what returns the system to a lower level:

| Level | Trigger (escalate) | Recovery Condition (de-escalate) |
|-------|-------------------|----------------------------------|
| 0 → 1 | Latency > 2x or error rate > 10% | Latency < 1.5x AND error rate < 5% for 60s |
| 1 → 2 | Memory high or error rate > 30% | Memory normal AND error rate < 15% for 60s |
| 2 → 3 | All providers down or memory critical | At least one provider responds AND memory < high |
| 3 → 4 | OOM imminent or disk full | Memory freed AND disk space available |

Register a user-facing manual recovery command:
```typescript
// Register 'qic.retryConnection' command for manual recovery
CommandsRegistry.registerCommand('qic.retryConnection', async (accessor) => {
    const degradationManager = accessor.get(IDegradationManager);
    // Attempt to reconnect all providers and re-evaluate degradation level
    await degradationManager.attemptRecovery();
    // If recovery succeeds, the level will be reduced automatically
    // If it fails, notify the user via status bar
});
```
This command lets users manually trigger recovery when they know the underlying issue (network, provider outage) has been resolved.

### 4. MemoryManager (`src/vs/workbench/contrib/qic/common/resilience/memoryManager.ts`)

Budget allocation and pressure response.

**AUDIT FIX VII-DS16**: Per-component memory budgets with eviction policies. Total budget: 500MB.

| Component | Budget | Eviction Policy |
|-----------|--------|-----------------|
| `embeddingCache` | 150 MB | LRU (least recently used) |
| `bm25Index` | 100 MB | FIFO (oldest entries first) |
| `conversationState` | 50 MB | Oldest-session (evict least recent session) |
| `completionCache` | 50 MB | LRU with TTL (entries expire after 5 minutes) |
| `vectorIndex` | 100 MB | Managed by LanceDB (built-in compaction) |
| `overhead` | 50 MB | Reserved for runtime overhead |

```typescript
export class MemoryManager {
    private readonly budgetMb: number = 500;  // Total budget
    private readonly allocations = new Map<string, number>();

    // AUDIT FIX VII-DS16: Per-component budgets with eviction policies
    private readonly componentBudgets: Record<string, { budgetMb: number; evictionPolicy: string }> = {
        embeddingCache:    { budgetMb: 150, evictionPolicy: 'lru' },
        bm25Index:         { budgetMb: 100, evictionPolicy: 'fifo' },
        conversationState: { budgetMb: 50,  evictionPolicy: 'oldest-session' },
        completionCache:   { budgetMb: 50,  evictionPolicy: 'lru-with-ttl' },
        vectorIndex:       { budgetMb: 100, evictionPolicy: 'lancedb' },
        overhead:          { budgetMb: 50,  evictionPolicy: 'reserved' },
    };

    /**
     * Request memory allocation for a component.
     * Validates against the component's individual budget before granting.
     */
    requestAllocation(component: string, sizeBytes: number): boolean;

    /**
     * Release memory allocation.
     */
    release(component: string): void;

    /**
     * Get current memory pressure level.
     */
    getPressure(): 'normal' | 'elevated' | 'high' | 'critical';

    /**
     * Respond to memory pressure events.
     * Evicts caches progressively based on pressure level,
     * using each component's configured eviction policy.
     */
    async handlePressure(level: string): Promise<void>;
}
```

### 5. Inline Completion Provider (VS Code integration)

**AUDIT FIX IX-CC2**: Register QIC as a **standard** `InlineCompletionProvider` using the language features service. Do NOT create a second `InlineCompletionsController` — Quantlab already has one. QIC plugs into the existing controller as a registered provider.

```typescript
// In qic.contribution.ts, register as a STANDARD provider:
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';

class QicInlineCompletionProvider implements InlineCompletionProvider {
    async provideInlineCompletions(
        model: ITextModel,
        position: IPosition,
        context: InlineCompletionContext,
        token: CancellationToken
    ): Promise<InlineCompletions>;

    freeInlineCompletions(completions: InlineCompletions): void;
}

// Registration — use the language features service, NOT a custom controller:
const qicProvider = new QicInlineCompletionProvider(completionEngine);
languageFeaturesService.inlineCompletionsProvider.register('*', qicProvider);
// groupId: 'qic-ai' — identifies QIC completions
// yieldsToGroupIds: ['copilot'] — QIC yields to GitHub Copilot if both are active
```

**CRITICAL**: Do NOT create a second `InlineCompletionsController`. The existing Quantlab editor controller manages all registered providers. QIC registers as a provider with `groupId='qic-ai'` and `yieldsToGroupIds=['copilot']` so it cooperates with any existing completion providers.
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/completion/completionEngine.ts` | Inline completion |
| `src/vs/workbench/contrib/qic/common/completion/fimAdapter.ts` | FIM formatting |
| `src/vs/workbench/contrib/qic/common/resilience/degradationManager.ts` | 5-level degradation |
| `src/vs/workbench/contrib/qic/common/resilience/memoryManager.ts` | Memory management |
| `src/vs/workbench/contrib/qic/browser/qicInlineCompletionProvider.ts` | Editor integration |
| `src/vs/workbench/contrib/qic/test/common/completion/completionEngine.test.ts` | Tests |

---

## Acceptance Criteria

```
□ CompletionEngine bypasses orchestrator — direct gateway path (audit fix I-2)
□ Completions are debounced (150ms per audit fix I-SG7)
□ Previous completion requests are cancelled on new keystroke
□ FIM prompts are correctly formatted for Anthropic and OpenAI
□ 6-tier completion waterfall implemented (audit fix VII-DS5)
□ Consent re-checked on every completion request, never cached (audit fix XI-SV4)
□ DegradationManager correctly transitions between 5 levels
□ DegradationManager has recovery conditions for each level (audit fix XII-AR7)
□ 'qic.retryConnection' command registered for manual recovery (audit fix XII-AR7)
□ Completions are disabled at DegradationLevel.NoCompletions
□ MemoryManager enforces 500MB total budget with per-component allocations (audit fix VII-DS16)
□ Memory pressure triggers cache eviction using component-specific policies
□ Inline completion provider registered via languageFeaturesService (audit fix IX-CC2)
□ QIC does NOT create a second InlineCompletionsController (audit fix IX-CC2)
□ Ghost text appears in the editor from completion results
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| I-SG7 | HIGH | Added explicit completion flow diagram: Keystroke → 150ms debounce → provideCompletions() → Context assembly (4K) → Tier selection → Provider request (bypasses orchestrator) → Ghost text |
| VII-DS5 | HIGH | Added 6-tier completion waterfall: Local GPU → Local CPU → Session cache → Cloud (parallel fallback after 500ms) → Static analysis → Empty response |
| VII-DS16 | MEDIUM | Added per-component memory budgets: embeddingCache 150MB/lru, bm25Index 100MB/fifo, conversationState 50MB/oldest-session, completionCache 50MB/lru-with-ttl, vectorIndex 100MB/lancedb, overhead 50MB |
| IX-CC2 | MEDIUM | Register QIC as standard InlineCompletionProvider with groupId='qic-ai', yieldsToGroupIds=['copilot']; use languageFeaturesService; do NOT create second InlineCompletionsController |
| XI-SV4 | partial | CompletionEngine re-checks consent on EVERY request via consentStore.hasConsent('llm'), never caches consent |
| XII-AR7 | MEDIUM | Added recovery conditions for each degradation level; registered 'qic.retryConnection' command for manual recovery |
| **XII-AR1** | HIGH (partial) | REMEDIATION FIX 5b: Added database unavailability as DegradationLevel.LocalOnly trigger. If SQLite is unavailable, no safe agentic operations are possible. |
