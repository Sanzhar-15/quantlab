# Prompt 08 — Gateway, Provider Adapters, Rate Limiter & Streaming

**Phase**: 4 (Network Layer)
**Prerequisites**: Prompt 07 (circuit breakers), Prompt 06 (egress enforcer)
**Estimated Scope**: ~10 files created, ~1500 lines

---

## Objective

Implement the Gateway (central LLM communication hub), three provider adapters (Anthropic, OpenAI, Ollama), the token-bucket rate limiter with cross-lane quota sharing, and the streaming response handler with SSE parsing. This is where QIC connects to AI providers.

---

## Spec References

- QIC Spec v6.2: §9.3 Rate Limiting (lines 5687–5938) — Token bucket + quota sharing
- QIC Spec v6.2: §9.4 Streaming Handler (lines 5938–6236) — SSE parsing, backpressure
- QIC Spec v6.2: §9.2 Request Prioritisation (lines 5597–5687) — Request manager
- QIC Spec v6.2: §4.2 Model Recommendations (lines 3119–3185)
- QIC Spec v6.2: §4.5 Model Version Management (lines 3273–3512) — ModelRegistry

## Implementation Plan References

- Phase 4 (lines 1031–1160) — Gateway, providers, rate limiter, streaming, request manager

## Audit Fixes Incorporated

- **S-3 (CRITICAL)**: Implement concrete provider adapter specifications (auth, streaming format, error normalization)
- **C-2 (HIGH)**: Rate limiter defaults must be configurable, not hard-coded. Use conservative defaults with header-based auto-discovery.
- **C-4 (HIGH)**: Use model aliases (e.g., `claude-latest-fast`) instead of pinned model IDs. ModelRegistry resolves aliases.
- **S-11 (MEDIUM)**: Do NOT add a Google adapter — remove phantom Google entries from rate limiter config.

---

## Implementation Instructions

### 1. Gateway (`src/vs/workbench/contrib/qic/common/gateway/gateway.ts`)

The central hub for all LLM communication:

```typescript
export class Gateway {
    constructor(
        private readonly providers: Map<string, ProviderAdapter>,
        private readonly rateLimiter: RateLimiter,
        private readonly circuitBreakers: Map<string, CircuitBreaker>,
        private readonly egressEnforcer: EgressBoundaryEnforcer,
        private readonly secretScanner: OptimizedSecretScanner
    ) {}

    /**
     * Send a request to the appropriate provider.
     * Handles: consent check → secret redaction → rate limiting → circuit breaking → send
     */
    async sendRequest(request: GatewayRequest): Promise<ProviderResponse>;  // REMEDIATION FIX 2c: Renamed from send() to sendRequest() — Prompts 09, 10 call gateway.sendRequest()

    /**
     * Send a streaming request. Returns an async iterable of chunks.
     */
    async sendStreaming(request: GatewayRequest): AsyncIterable<StreamChunk>;

    /**
     * Get the health of all providers.
     */
    async getProviderHealth(): Promise<Map<string, ProviderHealth>>;
}

// REMEDIATION FIX 2b: Import GatewayRequest and RequestPriority from canonical/interfaces.ts
// Do NOT define locally — this violates INV-A1 (single source of truth).
// import { GatewayRequest, RequestPriority } from '../canonical/interfaces.js';
```

### 2. Anthropic Adapter (`src/vs/workbench/contrib/qic/common/gateway/providers/anthropicAdapter.ts`)

```typescript
export class AnthropicAdapter implements ProviderAdapter {
    id = 'anthropic';
    name = 'Anthropic';
    type = 'llm' as const;

    constructor(private readonly config: AnthropicConfig) {}

    // Auth: X-Api-Key header or via environment variable ANTHROPIC_API_KEY
    // Streaming: SSE format with event types: message_start, content_block_start,
    //   content_block_delta, content_block_stop, message_delta, message_stop
    // Error normalization: Map Anthropic error types to QIC error codes
    // Rate limit headers: Parse X-RateLimit-* headers for auto-discovery

    async sendRequest(request: ProviderRequest): Promise<ProviderResponse>;
    async sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk>;
}
```

### 3. OpenAI Adapter (`src/vs/workbench/contrib/qic/common/gateway/providers/openaiAdapter.ts`)

```typescript
export class OpenAIAdapter implements ProviderAdapter {
    id = 'openai';
    name = 'OpenAI';
    type = 'llm' as const;

    // Auth: Authorization: Bearer header or OPENAI_API_KEY env
    // Streaming: SSE with data: {"choices": [{"delta": ...}]} format
    // Tool calls: Different format from Anthropic — normalize to QIC's ToolCall
    // Error normalization: Map OpenAI error types to QIC error codes
}
```

### 4. Ollama Adapter (`src/vs/workbench/contrib/qic/common/gateway/providers/ollamaAdapter.ts`)

```typescript
export class OllamaAdapter implements ProviderAdapter {
    id = 'ollama';
    name = 'Ollama';
    type = 'llm' as const;

    // Auth: None (local)
    // Base URL: configurable, default http://localhost:11434
    // REMEDIATION FIX 5a / AUDIT FIX XI-SV6: Validate Ollama URL is localhost only.
    // Hostname MUST be 'localhost', '127.0.0.1', or '::1'.
    // Reject any other hostname to prevent SSRF via misconfigured Ollama URL.
    private validateBaseUrl(url: string): void {
        const parsed = new URL(url);
        const allowedHosts = ['localhost', '127.0.0.1', '::1'];
        if (!allowedHosts.includes(parsed.hostname)) {
            throw new QicError('QIC-N001',
                `Ollama URL must be localhost. Got: ${parsed.hostname}`);
        }
    }
    // Streaming: NDJSON format (one JSON object per line)
    // No tool_use support — handle gracefully
    // Health check: GET /api/tags
}
```

### 5. MockProviderAdapter (`src/vs/workbench/contrib/qic/common/gateway/providers/mockAdapter.ts`)

**AUDIT FIX II-PG2**: Add a MockProviderAdapter for testing alongside real adapters. This enables all subsequent prompts (09-20) to test their components without requiring real API keys:

```typescript
export class MockProviderAdapter implements ProviderAdapter {
    id = 'mock';
    name = 'Mock Provider';
    type = 'llm' as const;
    private responses: Map<string, string> = new Map();

    async isAvailable(): Promise<boolean> { return true; }
    async getHealth(): Promise<ProviderHealth> {
        return { status: 'healthy', latencyMs: 10, errorRate: 0, lastChecked: new Date().toISOString() };
    }
    // REMEDIATION FIX 2d: Returns Promise<ProviderResponse> not Promise<T>
    async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
        // Return canned responses for testing
        const key = typeof request.messages?.[request.messages.length - 1]?.content === 'string'
            ? request.messages[request.messages.length - 1].content as string : '';
        const response = this.responses.get(key) ?? 'Mock response for: ' + key;
        return { content: [{ type: 'text', text: response }] };
    }
    async *sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk> {
        const key = request.messages?.[request.messages.length - 1]?.content ?? '';
        const response = this.responses.get(key) ?? 'Mock response for: ' + key;
        yield { type: 'text', text: response };
        yield { type: 'done', stopReason: 'end_turn' } as StreamChunk;  // REMEDIATION FIX 2d: Matches canonical StreamChunk done variant
    }
    cancelRequest(requestId: string): void {}  // REMEDIATION FIX 2d: Added requestId parameter

    // Test helper: pre-configure responses
    setResponse(input: string, output: string): void {
        this.responses.set(input, output);
    }
}
```

### 6. Rate Limiter (`src/vs/workbench/contrib/qic/common/gateway/rateLimiter.ts`)

Token-bucket algorithm with cross-lane quota sharing:

```typescript
export class RateLimiter {
    private buckets = new Map<string, TokenBucket>();

    constructor(private readonly config: RateLimiterConfig) {}

    /**
     * Acquire tokens for a request. Blocks until tokens available or timeout.
     * Returns true if tokens acquired, false if rate limited.
     */
    async acquire(
        providerId: string,
        lane: LaneName,
        tokensNeeded: number
    ): Promise<{ acquired: boolean; waitMs?: number }>;

    /**
     * Update limits based on provider response headers (auto-discovery).
     * AUDIT FIX C-2: Limits are configurable, not hard-coded.
     */
    updateFromHeaders(providerId: string, headers: Record<string, string>): void;
}

// AUDIT FIX C-2: Conservative defaults, overridden by response headers
// AUDIT FIX IV-AO10: Default limits are conservative estimates. Actual limits
// are auto-discovered from provider response headers and take precedence.
// Anthropic: parse 'anthropic-ratelimit-requests-remaining' header
// OpenAI: parse 'x-ratelimit-remaining-requests' header
// This auto-adjusts to the user's actual API tier.
export const DEFAULT_RATE_LIMITS: Record<string, ProviderRateLimit> = {
    'anthropic': { requestsPerMinute: 60, tokensPerMinute: 100_000, tokensPerDay: 1_000_000 },
    'openai': { requestsPerMinute: 60, tokensPerMinute: 90_000 },
    'ollama': { requestsPerMinute: Infinity, tokensPerMinute: Infinity },  // Local — no limits
    // AUDIT FIX S-11 + IV-AO11: No Google entry — no adapter exists.
    // If Google/Gemini support is needed later, add it with its own rate limits.
};
```

### 7. StreamingResponseHandler (`src/vs/workbench/contrib/qic/common/gateway/streamingHandler.ts`)

SSE parsing with backpressure and reconnection.

**AUDIT FIX VII-DS3**: Add detailed StreamingHandler specification including provider-specific SSE normalization, tool call assembly from streaming chunks, and backpressure handling:

```typescript
export class StreamingResponseHandler {
    /**
     * Pending tool calls being assembled from streaming chunks.
     * Tool call JSON arrives in fragments — accumulate until complete.
     */
    private pendingToolCalls: Map<string, { name: string; jsonParts: string[] }> = new Map();

    /**
     * Parse an SSE stream from a provider into QIC StreamChunks.
     * Handles provider-specific SSE format normalization.
     */
    async *parseSSEStream(
        response: Response,
        format: 'anthropic' | 'openai' | 'ollama'
    ): AsyncIterable<StreamChunk>;

    /**
     * Normalize Anthropic SSE events to unified StreamChunk.
     * Anthropic uses: message_start, content_block_start, content_block_delta,
     *   content_block_stop, message_delta, message_stop
     */
    private normalizeAnthropicEvent(event: AnthropicSSE): StreamChunk | null {
        switch (event.type) {
            case 'content_block_delta':
                if (event.delta.type === 'text_delta')
                    return { type: 'text', text: event.delta.text };
                if (event.delta.type === 'input_json_delta')
                    return { type: 'tool_call_delta', id: this.currentToolCallId,
                             argumentsDelta: event.delta.partial_json };
                break;
            case 'content_block_start':
                if (event.content_block.type === 'tool_use')
                    return { type: 'tool_call_start', id: event.content_block.id,
                             name: event.content_block.name };
                break;
            case 'content_block_stop':
                if (this.currentToolCallId)
                    return { type: 'tool_call_end', id: this.currentToolCallId };
                break;
            case 'message_delta':
                return { type: 'done', usage: event.usage, stopReason: event.delta.stop_reason };
        }
        return null;
    }

    /**
     * Normalize OpenAI SSE events to unified StreamChunk.
     * OpenAI uses: data: {"choices": [{"delta": {...}}]} format
     */
    private normalizeOpenAIEvent(event: OpenAISSE): StreamChunk | null {
        const choice = event.choices?.[0];
        if (!choice) return null;
        if (choice.delta?.content)
            return { type: 'text', text: choice.delta.content };
        if (choice.delta?.tool_calls) {
            const tc = choice.delta.tool_calls[0];
            if (tc.function?.name)
                return { type: 'tool_call_start', id: tc.id ?? tc.index.toString(), name: tc.function.name };
            if (tc.function?.arguments)
                return { type: 'tool_call_delta', id: tc.id ?? tc.index.toString(),
                         argumentsDelta: tc.function.arguments };
        }
        if (choice.finish_reason)
            return { type: 'done', stopReason: choice.finish_reason };
        return null;
    }

    /**
     * Handle tool call accumulation from streaming chunks.
     * Tool calls arrive incrementally — accumulate partial JSON until complete.
     * Returns completed ToolCall when tool_call_end is received, null otherwise.
     */
    accumulateToolCall(chunk: StreamChunk): ToolCall | null {
        if (chunk.type === 'tool_call_start') {
            this.pendingToolCalls.set(chunk.id, { name: chunk.name, jsonParts: [] });
            return null;
        }
        if (chunk.type === 'tool_call_delta') {
            const pending = this.pendingToolCalls.get(chunk.id);
            if (pending) pending.jsonParts.push(chunk.argumentsDelta);
            return null;
        }
        if (chunk.type === 'tool_call_end') {
            const pending = this.pendingToolCalls.get(chunk.id);
            if (pending) {
                this.pendingToolCalls.delete(chunk.id);
                const argsJson = pending.jsonParts.join('');
                return { id: chunk.id, name: pending.name, arguments: JSON.parse(argsJson) };
            }
        }
        return null;
    }

    /**
     * Backpressure handling: pause the readable stream when consumer is slow.
     * Resume when consumer catches up (pull-based consumption via async iteration).
     */
}

// REMEDIATION FIX 2a: Import StreamChunk from canonical/interfaces.ts
// Do NOT define locally — this violates INV-A1 (single source of truth).
// import { StreamChunk } from '../canonical/interfaces.js';
```

### 8. RequestManager (`src/vs/workbench/contrib/qic/common/gateway/requestManager.ts`)

Priority queue with load shedding.

**AUDIT FIX VII-DS4**: Add detailed RequestManager specification with per-lane quota allocation, load shedding when rate limits near capacity, and request deduplication:

```typescript
export class RequestManager {
    private queue: PriorityQueue<QueuedRequest>;

    /**
     * Per-lane quota allocation:
     * - completion: 40% of total rate limit capacity
     * - chat (chat-ask, chat-act, chat-gather, chat-plan): 50%
     * - background (repair, summarize, fast-apply): 10%
     */
    private quotas: Map<string, { percentage: number; used: number }> = new Map([
        ['completion', { percentage: 0.4, used: 0 }],
        ['chat', { percentage: 0.5, used: 0 }],
        ['background', { percentage: 0.1, used: 0 }],
    ]);

    /**
     * Deduplication cache for identical completion requests.
     * Key: hash of (model + messages + max_tokens)
     */
    private pendingRequests: Map<string, Promise<ProviderResponse>> = new Map();

    /**
     * Enqueue a request with priority. Returns when executed.
     * Deduplicates identical completion requests.
     */
    async enqueue(request: GatewayRequest): Promise<ProviderResponse> {
        // Request deduplication for completion lane
        if (request.lane === 'completion') {
            const key = this.computeDeduplicationKey(request);
            const pending = this.pendingRequests.get(key);
            if (pending) return pending;
        }

        const priority = this.calculatePriority(request);
        if (this.shouldShed(request)) {
            throw new QicError('QIC-N003', 'Request shed due to capacity');
        }
        return this.queue.enqueue(request, priority);
    }

    /**
     * Shed load when under pressure (drop low-priority requests).
     * Returns number of requests shed.
     */
    shedLoad(): number;

    /**
     * Determine if a request should be shed based on quota usage.
     */
    private shouldShed(request: GatewayRequest): boolean {
        const quotaGroup = this.getQuotaGroup(request.lane);
        const quota = this.quotas.get(quotaGroup);
        if (!quota) return false;
        return quota.used >= quota.percentage * this.rateLimiter.remaining;
    }

    /**
     * Cancel all queued requests for a specific consent category.
     * Called when consent is revoked (AUDIT FIX XI-SV4 integration).
     */
    cancelQueuedByCategory(category: string): void;
}
```

### 9. ModelRegistry (`src/vs/workbench/contrib/qic/common/gateway/modelRegistry.ts`)

Model alias resolution, deprecation detection, lane compatibility.

**AUDIT FIX I-SG2**: Replace all hard-coded model IDs with alias-based resolution. Make concrete model IDs configurable, not hard-coded. Implement header-based auto-discovery of provider capabilities. Add a "model health check" that validates configured models on startup. Default aliases should resolve to current-generation models at implementation time:

```typescript
export class ModelRegistry {
    // AUDIT FIX C-4 + I-SG2: Use aliases, not pinned model IDs.
    // Concrete IDs are configurable via settings, not hard-coded.
    private aliases: Record<string, string>;

    constructor(private readonly configService: IConfigurationService) {
        // Default aliases — these resolve to current-generation models.
        // Concrete IDs should be updated at implementation time to reflect
        // the latest available models. They are ALSO overridable via
        // qic.models.aliases configuration setting.
        this.aliases = {
            'claude-latest': configService.getValue('qic.models.claudeLatest') ?? 'claude-sonnet-4-20250514',
            'gpt-latest': configService.getValue('qic.models.gptLatest') ?? 'gpt-4o',
            'local-fast': configService.getValue('qic.models.localFast') ?? 'qwen2.5-coder:7b',
        };
    }

    resolveAlias(alias: string): string;
    isDeprecated(modelId: string): boolean;
    supportsLane(modelId: string, lane: LaneName): boolean;
    getRecommendedModel(lane: LaneName): string;

    /**
     * AUDIT FIX I-SG2: Validate configured models on startup.
     * Sends a minimal probe request to each configured provider.
     */
    async healthCheck(): Promise<Map<string, { available: boolean; error?: string }>> {
        const results = new Map();
        for (const [alias, modelId] of Object.entries(this.aliases)) {
            try {
                const provider = this.getProviderForModel(modelId);
                const health = await provider.getHealth();
                results.set(alias, { available: health.status === 'healthy' });
            } catch (error) {
                results.set(alias, { available: false, error: String(error) });
            }
        }
        return results;
    }
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/gateway/gateway.ts` | Central gateway |
| `src/vs/workbench/contrib/qic/common/gateway/providers/anthropicAdapter.ts` | Anthropic |
| `src/vs/workbench/contrib/qic/common/gateway/providers/openaiAdapter.ts` | OpenAI |
| `src/vs/workbench/contrib/qic/common/gateway/providers/ollamaAdapter.ts` | Ollama |
| `src/vs/workbench/contrib/qic/common/gateway/providers/mockAdapter.ts` | Mock provider for testing (AUDIT FIX II-PG2) |
| `src/vs/workbench/contrib/qic/common/gateway/rateLimiter.ts` | Rate limiter |
| `src/vs/workbench/contrib/qic/common/gateway/streamingHandler.ts` | SSE parsing |
| `src/vs/workbench/contrib/qic/common/gateway/requestManager.ts` | Request queue |
| `src/vs/workbench/contrib/qic/common/gateway/modelRegistry.ts` | Model management |
| `src/vs/workbench/contrib/qic/test/common/gateway/rateLimiter.test.ts` | Rate limiter tests |
| `src/vs/workbench/contrib/qic/test/common/gateway/streamingHandler.test.ts` | Streaming tests |

## Dependencies

**AUDIT FIX VIII-PC3**: Add `better-sqlite3` to `package.json` dependencies if not already present (it may have been added by Prompt 03 or 05). This prompt's components do not directly use SQLite, but downstream integration requires it. Ensure the package is compiled against Quantlab's Electron version via `npx electron-rebuild -m node_modules/better-sqlite3`.

---

## Acceptance Criteria

```
□ Gateway enforces egress check + secret redaction before every provider call
□ All 3 provider adapters normalize responses to QIC's ProviderResponse type
□ Anthropic adapter parses SSE streaming format correctly
□ OpenAI adapter parses streaming format correctly
□ Ollama adapter handles missing tool_use support gracefully
□ RateLimiter uses token-bucket algorithm (not fixed window)
□ RateLimiter updates limits from provider response headers (audit C-2)
□ RateLimiter has no Google entries (audit S-11)
□ Streaming handler processes tool calls correctly — assembles partial JSON from streaming chunks (AUDIT FIX II-PG5)
□ StreamingResponseHandler normalizes Anthropic content_block_delta and OpenAI choices[0].delta to unified StreamChunk
□ ModelRegistry uses aliases instead of pinned IDs (audit C-4)
□ ModelRegistry detects deprecated models
□ ModelRegistry health check validates configured models on startup (AUDIT FIX I-SG2)
□ RequestManager drops low-priority requests under load
□ RequestManager enforces per-lane quota allocation (completion 40%, chat 50%, background 10%)
□ MockProviderAdapter is available and returns canned responses for testing
□ CircuitBreaker prevents requests to failing providers
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **I-SG2** | HIGH | Replaced hard-coded model IDs with alias-based resolution via ModelRegistry. Added configurable aliases (`claude-latest`, `gpt-latest`, `local-fast`). Added model health check on startup. |
| **II-PG2** | MEDIUM | Added MockProviderAdapter for testing alongside real adapters. Includes `setResponse()` test helper for pre-configuring canned responses. |
| **II-PG5** | MEDIUM | Added acceptance criterion: "Streaming handler processes tool calls correctly (assembles partial JSON)." |
| **IV-AO10** | MEDIUM | Made rate limits configurable. Default limits are conservative. Actual limits auto-discovered from provider response headers (`anthropic-ratelimit-requests-remaining`, `x-ratelimit-remaining-requests`). |
| **IV-AO11** | LOW | Removed Google from rate limiter defaults. Added comment about forward compatibility. |
| **VII-DS3** | HIGH | Added detailed StreamingHandler specification: provider-specific SSE normalization (Anthropic `content_block_delta` vs OpenAI `choices[0].delta`), tool call assembly from streaming chunks with partial JSON accumulation, backpressure handling. |
| **VII-DS4** | HIGH | Added detailed RequestManager specification with priority queue: completion 40%, chat 50%, background 10% quota allocation. Load shedding when rate limits near capacity. Request deduplication for completion lane. |
| **VIII-PC3** | MEDIUM | Added note to add `better-sqlite3` to `package.json` dependencies if not already present. |
| **XI-SV6** | HIGH (partial) | REMEDIATION FIX 5a: Added Ollama URL localhost validation. Hostname must be `localhost`, `127.0.0.1`, or `::1` to prevent SSRF. |
