# Critical Codebase Fixes

These three findings will block implementation if not resolved. The plan's code samples and integration designs assume structures that do not match the actual codebase.

---

## CRITICAL-1: ModelRegistry Structure Mismatch

### The Problem

The plan (docs 01 and 07) assumes `LANE_MODEL_RECOMMENDATIONS` is `Record<LaneName, string[]>` -- an ordered array of model aliases per lane, where the system tries each in order.

**Actual structure** (`modelRegistry.ts` lines 30-39):
```typescript
const LANE_MODEL_RECOMMENDATIONS: Record<string, string> = {
    'completion': 'local-fast',
    'chat-ask': 'claude-latest',
    'chat-gather': 'claude-latest',
    'chat-plan': 'claude-latest',
    'chat-act': 'claude-latest',
    'repair': 'claude-latest',
    'fast-apply': 'local-fast',
    'summarize': 'gpt-latest',
};
```

It maps each lane to a **single** model alias, not an array. The fallback logic lives separately in `getAvailableModelForLane()` (lines 103-136), which has a hardcoded `fallbackOrder` array independent of per-lane preferences.

### Why This Matters

The plan's entire strategy for "cloud models preferred, BYOK as fallback" depends on per-lane ordered preference lists. The current structure cannot express "try cloud-default first, then claude-latest, then gpt-latest" for a given lane.

### Fix Required in Plan

**Option A (Recommended): Restructure to array-based recommendations.**

Update the plan to explicitly call out this structural change as a prerequisite:

```typescript
// BEFORE (current):
const LANE_MODEL_RECOMMENDATIONS: Record<string, string> = {
    'chat-ask': 'claude-latest',
};

// AFTER (new):
const LANE_MODEL_RECOMMENDATIONS: Record<LaneName, string[]> = {
    'chat-ask': ['cloud-default', 'claude-latest', 'gpt-latest', 'local-fast'],
};
```

And rewrite `getAvailableModelForLane()` to iterate the per-lane array instead of using the separate `fallbackOrder`. This is a clean improvement that makes the fallback logic more explicit and per-lane configurable.

**Option B: Keep the single-string map, modify fallback order.**

Keep `LANE_MODEL_RECOMMENDATIONS` as-is (single model per lane). Modify `getAvailableModelForLane()` to prepend cloud models to the global fallback order:

```typescript
const fallbackOrder = providers.has('quantlab-cloud')
    ? ['cloud-default', 'cloud-fast', 'claude-latest', 'gpt-latest', 'local-fast']
    : ['claude-latest', 'gpt-latest', 'local-fast'];
```

This is simpler but less flexible -- you can't have different cloud model preferences per lane (e.g., `cloud-fast` for completion but `cloud-default` for chat-act).

**Recommendation:** Option A. The per-lane array approach is the right long-term design. The plan should add this as a Phase 1 deliverable and include the `getAvailableModelForLane()` rewrite in the "files that change" list.

### Impact on Plan Documents

- **Doc 01, Section 5**: Remove the incorrect type assumption. Show the actual before/after restructuring.
- **Doc 07, "ModelRegistry Fallback Chain"**: Rewrite to match the actual (restructured) algorithm.
- **Doc 06, Phase 1 deliverables**: Add "Restructure ModelRegistry fallback to per-lane preference arrays" as an explicit deliverable.

---

## CRITICAL-2: ProviderAdapter Typing vs. GatewayRequest Fields

### The Problem

The plan's `QuantlabCloudAdapter` needs to send `lane`, `priority`, and `sessionId` to the server. But the `ProviderAdapter` interface only receives `ProviderRequest`, which does not include these fields:

```typescript
// ProviderAdapter interface (interfaces.ts):
sendRequest(request: ProviderRequest): Promise<ProviderResponse>;

// ProviderRequest (types.ts):
interface ProviderRequest {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    signal?: AbortSignal;
}
// No lane, no priority, no sessionId.
```

The Gateway constructs a `GatewayRequest` (which extends `ProviderRequest` with those fields) and passes it to the adapter. Due to JavaScript's structural typing, the extra fields survive the spread and ARE present at runtime on the object the adapter receives. But this is an untyped, fragile, implicit dependency.

### Why This Matters

The cloud adapter's entire protocol depends on sending lane/priority/sessionId to the server. If anyone refactors the Gateway to explicitly construct a `ProviderRequest` (dropping extra fields), the cloud adapter silently breaks. This is a maintenance trap.

### Fix Required in Plan

**Option A (Recommended): Widen the ProviderAdapter interface.**

```typescript
// Updated interface:
export interface ProviderAdapter {
    sendRequest(request: ProviderRequest & Partial<GatewayMetadata>): Promise<ProviderResponse>;
    sendStreaming(request: ProviderRequest & Partial<GatewayMetadata>): AsyncIterable<StreamChunk>;
    // ...
}

export interface GatewayMetadata {
    lane: LaneName;
    priority: RequestPriority;
    sessionId?: string;
}
```

Existing adapters ignore the extra fields (they don't use `lane`). The cloud adapter reads them. This is safe, explicit, and backwards-compatible.

**Option B: Pass metadata via adapter config, not per-request.**

The cloud adapter receives lane/priority via a separate mechanism (e.g., the adapter maintains a "current lane" state set by the Gateway before each call). This is stateful and messy.

**Option C: Accept the implicit passthrough, document it.**

Add a comment in `gateway.ts`:
```typescript
// NOTE: GatewayRequest fields (lane, priority, sessionId) are passed through
// to the adapter via object spread. Cloud adapters may access these fields
// even though they are not part of ProviderRequest.
```

This works but is fragile.

**Recommendation:** Option A. Widen the interface with `Partial<GatewayMetadata>`. It's a non-breaking change (all existing adapters continue to work since the new fields are optional) and makes the contract explicit.

### Impact on Plan Documents

- **Doc 01, Section 1**: Show the updated `ProviderAdapter` interface with `GatewayMetadata`.
- **Doc 02**: Confirm that the request body includes these fields by contract, not by accident.
- **Doc 07, "What Stays the Same"**: Note that `interfaces.ts` needs a small change (adding `GatewayMetadata` type and widening the adapter method signatures).

---

## CRITICAL-3: Gateway Egress Boundary Hardcoded to 'llm'

### The Problem

The Gateway currently hardcodes the egress boundary to `'llm'` for all requests:

```typescript
// gateway.ts, line 44:
const egressResult = await this.egressEnforcer.checkAndSanitize('llm', messageContent, {
    sessionId: request.sessionId ?? 'unknown',
    purpose: `${request.lane} request`,
});
```

The plan proposes adding a `'quantlab-cloud'` egress boundary for separate consent tracking (users should be able to consent to sending data to Quantlab's servers independently of consenting to send to Anthropic/OpenAI).

But the Gateway has no mechanism to select the boundary based on which provider will serve the request. The model/provider resolution happens before the egress check, but the boundary selection isn't wired to the provider ID.

### Why This Matters

Without this fix:
- A user who consents to `'llm'` (direct-to-provider) but NOT to `'quantlab-cloud'` would have their cloud requests silently pass through the wrong consent boundary.
- A user who consents to `'quantlab-cloud'` but NOT to `'llm'` would be blocked from using the cloud path because the Gateway always checks `'llm'`.

The consent model breaks.

### Fix Required in Plan

**Option A (Recommended): Provider-aware egress boundary.**

Map provider IDs to egress boundaries:

```typescript
// In Gateway:
private getEgressBoundary(providerId: string): EgressBoundary {
    if (providerId === 'quantlab-cloud') return 'quantlab-cloud';
    return 'llm';  // anthropic, openai, ollama all use 'llm'
}

// In sendRequest():
const egressResult = await this.egressEnforcer.checkAndSanitize(
    this.getEgressBoundary(providerId), messageContent, { ... }
);
```

**Option B: Treat cloud as 'llm' boundary (simpler).**

Don't add a separate `'quantlab-cloud'` boundary. All LLM requests use the `'llm'` boundary regardless of provider. The consent dialog text explains that data may be sent through Quantlab's servers or directly to providers depending on connection mode.

This is simpler but loses the ability to have separate consent for direct vs. proxied connections.

**Recommendation:** Option A is more correct long-term, especially for enterprise/compliance users who need fine-grained data flow control. But Option B is acceptable for MVP (Phase 2) with Option A deferred to Phase 4.

### Impact on Plan Documents

- **Doc 01, Section 6**: Specify which option is chosen and when.
- **Doc 03**: Add `getEgressBoundary()` to the Gateway component description.
- **Doc 07, "What Stays the Same"**: Move `gateway.ts` from "unchanged" to "modified" list.
- **Doc 06, Phase 1 vs Phase 4**: Decide when to implement provider-aware egress.
