# Prompt 17 — Telemetry, Reproducibility & Session Cache

**Phase**: 10 (Telemetry & Documentation)
**Prerequisites**: Prompt 06 (consent store), Prompt 08 (gateway)
**Estimated Scope**: ~5 files created, ~600 lines

---

## Objective

Implement privacy-respecting opt-in telemetry, reproducibility logging (record all LLM requests/responses), session cache for request deduplication, and replay mode for debugging.

---

## Spec References

- QIC Spec v6.2: §12.3 Telemetry (lines 7939–7974)
- Implementation Plan v3: Phase 10 (lines 1820–1882) — Telemetry, reproducibility, replay

## Audit Fixes Incorporated

- **I-8 (HIGH)**: Session cache key must hash the ENTIRE messages array (not just the last message). Document clearly.

---

## Implementation Instructions

### 1. TelemetryService (`src/vs/workbench/contrib/qic/common/telemetry/telemetryService.ts`)

```typescript
export class TelemetryService {
    constructor(
        private readonly consentStore: ConsentStore,
        private readonly egressEnforcer: EgressBoundaryEnforcer
    ) {}

    /**
     * Log a telemetry event (only if user has opted in).
     * Privacy requirements:
     * - No user identifiers
     * - No file contents
     * - No file paths (hash only)
     * - No secrets
     */
    async logEvent(category: TelemetryCategory, event: TelemetryEvent): Promise<void>;
}

type TelemetryCategory = 'performance' | 'errors' | 'usage' | 'quality';

// Sampling rates per category
const SAMPLING_RATES: Record<TelemetryCategory, number> = {
    performance: 0.1,   // 10%
    errors: 1.0,        // 100%
    usage: 0.01,        // 1%
    quality: 0.1         // 10%
};
```

### 2. ReproducibilityLogger (`src/vs/workbench/contrib/qic/common/telemetry/reproducibilityLogger.ts`)

```typescript
export class ReproducibilityLogger {
    /**
     * Log all external requests/responses as JSONL.
     * Stored in {workspaceStorage}/recordings/
     */
    async logRequest(request: ProviderRequest, response: ProviderResponse): Promise<void>;
    async getRecordingPath(): Promise<string>;
}
```

### 3. SessionCache (`src/vs/workbench/contrib/qic/common/telemetry/sessionCache.ts`)

```typescript
export class SessionCache {
    private cache = new Map<string, CachedResponse>();
    private readonly maxSizeMb = 50;

    /**
     * Check if a request is cached.
     * AUDIT FIX I-8: Key is hash of ENTIRE messages array + model + tools + temperature.
     * NOT just the last user message.
     */
    get(request: ProviderRequest): ProviderResponse | null;

    /**
     * Cache a response.
     */
    set(request: ProviderRequest, response: ProviderResponse): void;

    /**
     * Compute cache key from the complete request payload.
     */
    private computeKey(request: ProviderRequest): string {
        // Hash: model + JSON.stringify(messages) + JSON.stringify(tools) + temperature
        // AUDIT FIX I-8: Hash entire messages array, not just last message
        return crypto.createHash('sha256')
            .update(JSON.stringify({
                model: request.model,
                messages: request.messages,  // ENTIRE array
                tools: request.tools,
                temperature: request.temperature
            }))
            .digest('hex');
    }
}
```

### 4. ReplayModeSupport (`src/vs/workbench/contrib/qic/common/telemetry/replayMode.ts`)

```typescript
export class ReplayModeSupport {
    private recordings: Map<string, ProviderResponse> = new Map();
    private mode: 'off' | 'strict' | 'best-effort' | 'fallback' = 'off';

    /**
     * Activate replay mode from a recording file.
     * 3 modes:
     * - strict: exact match required, fail if not found
     * - best-effort: fuzzy match, return closest
     * - fallback: try cache first, then live request
     */
    async activateReplayMode(recordingPath: string, mode: 'strict' | 'best-effort' | 'fallback'): Promise<void>;
    deactivateReplayMode(): void;
    getReplayResponse(request: ProviderRequest): ProviderResponse | null;
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/telemetry/telemetryService.ts` | Privacy telemetry |
| `src/vs/workbench/contrib/qic/common/telemetry/reproducibilityLogger.ts` | Request recording |
| `src/vs/workbench/contrib/qic/common/telemetry/sessionCache.ts` | Response caching |
| `src/vs/workbench/contrib/qic/common/telemetry/replayMode.ts` | Replay support |
| `src/vs/workbench/contrib/qic/test/common/telemetry/sessionCache.test.ts` | Cache tests |

---

## Acceptance Criteria

```
□ Telemetry respects opt-out (no events sent if not consented)
□ No PII in any telemetry event (no user identifiers, file paths hash only)
□ Sampling rates applied correctly per category
□ ReproducibilityLogger records all LLM requests/responses as JSONL
□ SessionCache key hashes ENTIRE messages array (audit fix I-8)
□ SessionCache respects 50MB size limit with LRU eviction
□ Replay mode can reproduce a recorded session (strict mode)
□ Session cache hit rate > 0% for repeated identical requests
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

No additional fixes from the deep audit (QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md) were required for this prompt. The existing audit fix (I-8) was already incorporated.
