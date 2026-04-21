# Prompt 04 — Canonical Types, Tool Registry & Error Registry

**Phase**: 1 (Foundation)
**Prerequisites**: Prompts 00–03 complete (Phase 0)
**Estimated Scope**: ~8 files created, ~800 lines

---

## Objective

Implement the canonical type system — the single source of truth for ALL types in QIC. This enforces invariant INV-A1 (Single Source of Truth): all types are exported from `canonical/index.ts` and no other module may define competing type definitions.

---

## Spec References

- QIC Spec v6.2: §2.1.1 EditScript / FileContent (lines 210–444)
- QIC Spec v6.2: §2.1.2 PermissionCheckResult (lines 444–511)
- QIC Spec v6.2: §2.1.3 Lane Configuration (lines 511–964)
- QIC Spec v6.2: §3.5 Core Interfaces (lines 2798–3113)
- QIC Spec v6.2: Appendix A Tool Registry (lines 8177–8233) — 22 tools
- QIC Spec v6.2: Appendix B Error Registry (lines 8233–8304) — 30+ error codes

## Audit Fixes Incorporated

- **S-8 (HIGH)**: Fix `inspect_notebook` and `preview_dataframe` to have `hasSideEffects: false`
- **S-9 (HIGH)**: Mark `web_search` as `status: 'not-yet-implemented'` with a TODO
- **C-6 (MEDIUM)**: Add `get_definition` to `chat-gather`'s allowed tools
- **I-SG4 (MEDIUM)**: Confirm `get_definition` in `chat-gather`'s allowedTools list
- **I-SG6 (MEDIUM)**: `inspect_notebook` and `preview_dataframe` set to `hasSideEffects: false, permission: { required: false }`; `analyze_backtest` remains `hasSideEffects: true`
- **IV-AO1 (HIGH)**: Add TokenCounter utility class using tiktoken `cl100k_base` encoding
- **VII-DS6 (HIGH)**: Resolve INV-T2 contradiction — audit logging vs. permission requirement are separate concerns
- **X-PS2 (CRITICAL)**: Add `ToolImplementation` interface and `ToolHandler` type to canonical types
- **X-PS5 (HIGH)**: Add `sendStreaming()` and `getHealth()` to `ProviderAdapter` interface
- **X-PS7 (MEDIUM)**: Add gateway-specific types (`StreamChunk`, `RequestPriority`, `GatewayRequest`) to canonical
- **VIII-PC3 (partial)**: Note to add `tiktoken` to package.json dependencies

---

## Implementation Instructions

### 1. Canonical Types (`src/vs/workbench/contrib/qic/common/canonical/types.ts`)

Define ALL core types. This is the largest and most important type file:

```typescript
// === EditScript Types ===
export interface EditScript {
    version: 1;
    edits: FileEdit[];
}

export interface FileEdit {
    path: string;
    operations: EditOperation[];
}

export type EditOperation =
    | { type: 'replace'; range: Range; newText: string }
    | { type: 'insert'; position: Position; text: string }
    | { type: 'delete'; range: Range };

export interface Range {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface Position {
    line: number;
    column: number;
}

// === Permission Types ===
// REMEDIATION FIX 1c: Changed to use `status` and `scope` fields.
// Prompt 10 checks `permission.status === 'denied'` and uses `scope`
// instead of `level`. The old `granted: boolean` + `level` shape would
// silently bypass all permission checks.
export interface PermissionCheckResult {
    status: 'granted' | 'denied';
    scope: 'once' | 'session' | 'always';
    reason?: string;             // Why denied
    expiresAt?: string;          // ISO 8601
}

// IMPORTANT: Permission checks MUST return PermissionCheckResult, NEVER boolean
// This is enforced by CI (§14.2 check #2)

// === Tool Types ===
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: JSONSchema;
    hasSideEffects: boolean;
    permission: ToolPermission;
    status?: 'active' | 'not-yet-implemented';
}

export interface ToolPermission {
    required: boolean;
    level?: 'once' | 'session' | 'always';
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

// REMEDIATION FIX 1b: Aligned field names with consumer usage (Prompt 10).
// Matches the Anthropic API tool_result format that Prompt 10 constructs.
export interface ToolResult {
    toolCallId: string;
    content: string;
    isError: boolean;
}

export interface ToolContext {
    sessionId: string;
    workspacePath: string;
    activeFilePath?: string;
    targetPath?: string;         // REMEDIATION FIX 1g: Added for Prompt 10's PermissionManager
    permissions: Map<string, PermissionCheckResult>;
}

// REMEDIATION FIX: ToolResultPayload is what tool implementations actually return.
// Tools don't know their toolCallId — only the ToolRouter does. So tools return
// just {content, isError}, and the ToolRouter wraps it into a full ToolResult
// by adding toolCallId from the ToolCall.
export type ToolResultPayload = Omit<ToolResult, 'toolCallId'>;
// Equivalent to: { content: string; isError: boolean }

// AUDIT FIX X-PS2: ToolImplementation interface and ToolHandler type
// Required by ToolRouter (Prompt 10) and tool implementations (Prompt 15)
export interface ToolImplementation {
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResultPayload>;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResultPayload>;

// AUDIT FIX VII-DS6 — Resolving INV-T2 contradiction:
// INV-T2 defines the AUDIT requirement: ALL tool calls are logged via SecurityAuditLogger.
// The Tool Registry defines the PERMISSION requirement: only tools with hasSideEffects: true need approval.
// These are DIFFERENT concerns:
//   - Audit logging: ALL 22 tools (INV-T2 satisfied via SecurityAuditLogger)
//   - Permission check: Only tools with hasSideEffects: true (Tool Registry authoritative)
// Document this in canonical/types.ts.

// === Provider Types ===
export interface ProviderRequest {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    signal?: AbortSignal;
}

export interface ProviderResponse {
    content: ContentBlock[];
    usage?: TokenUsage;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string | ContentBlock[];
}

// === Approval Types ===
export interface ApprovalToken {
    id: string;
    editScriptHash: string;
    grantedAt: string;
    grantedBy: 'user' | 'auto-test';
    expiresAt: string;
}

// === Error Types ===
// REMEDIATION FIX 1a: Changed from interface to class.
// Prompts 08, 09, 10, 15 all use `throw new QicError('QIC-T001', 'message')`.
// The class constructor looks up ERROR_REGISTRY for severity/name.
export class QicError extends Error {
    public readonly code: string;
    public readonly qicName: string;
    public readonly severity: 'info' | 'warning' | 'error';
    public readonly userMessage: string | null;
    public readonly details?: unknown;

    constructor(code: string, message: string, details?: unknown) {
        super(message);
        this.code = code;
        const template = ERROR_REGISTRY[code];
        this.qicName = template?.name ?? 'UnknownError';
        this.severity = template?.severity ?? 'error';
        this.userMessage = message;
        this.details = details;
        Object.setPrototypeOf(this, QicError.prototype);
    }
}

// NOTE: ERROR_REGISTRY is defined in errors.ts and imported here.
// Forward reference — at runtime, errors.ts is loaded before types.ts
// consumers instantiate QicError. Alternatively, the lookup can be
// deferred or ERROR_REGISTRY can be injected.

// === JSON Schema (simplified) ===
export interface JSONSchema {
    type: string;
    properties?: Record<string, JSONSchema>;
    required?: string[];
    items?: JSONSchema;
    description?: string;
    enum?: (string | number)[];
}
```

### 2. Lane Configurations (`src/vs/workbench/contrib/qic/common/canonical/lanes.ts`)

Define all 8 lanes with their configurations:

```typescript
export type LaneName =
    | 'completion'
    | 'chat-ask'
    | 'chat-gather'
    | 'chat-plan'
    | 'chat-act'
    | 'repair'
    | 'fast-apply'
    | 'summarize';

export interface LaneConfiguration {
    name: LaneName;
    promptKey: string;
    maxTokens: number;
    inputTokenBudget: number;    // REMEDIATION FIX 1f: Added for Prompt 10's token budget check
    allowedTools: string[];
    temperature: number;
    description: string;
}

export const LANE_CONFIGURATIONS: Record<LaneName, LaneConfiguration> = {
    'completion': {
        name: 'completion',
        promptKey: 'completion',
        maxTokens: 4096,
        inputTokenBudget: 4_096,     // FIM context window
        allowedTools: [],
        temperature: 0.0,
        description: 'Inline code completion (FIM)'
    },
    'chat-ask': {
        name: 'chat-ask',
        promptKey: 'chat-ask',
        maxTokens: 8192,
        inputTokenBudget: 16_000,
        allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory'],
        temperature: 0.3,
        description: 'Answer questions about code'
    },
    'chat-gather': {
        name: 'chat-gather',
        promptKey: 'chat-gather',
        maxTokens: 16384,
        inputTokenBudget: 32_000,
        allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory'],
        // AUDIT FIX C-6: Added get_definition (was missing from spec)
        temperature: 0.2,
        description: 'Gather context for planning'
    },
    'chat-plan': {
        name: 'chat-plan',
        promptKey: 'chat-plan',
        maxTokens: 16384,
        inputTokenBudget: 32_000,
        allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory'],
        temperature: 0.3,
        description: 'Generate implementation plan'
    },
    'chat-act': {
        name: 'chat-act',
        promptKey: 'chat-act',
        maxTokens: 32768,
        inputTokenBudget: 200_000,   // Full context for agentic loop
        allowedTools: ['*'],  // All tools
        temperature: 0.2,
        description: 'Execute plan with tools'
    },
    'repair': {
        name: 'repair',
        promptKey: 'repair',
        maxTokens: 8192,
        inputTokenBudget: 32_000,
        allowedTools: ['read_file', 'write_file', 'search_code', 'run_command'],
        temperature: 0.1,
        description: 'Fix errors after tool execution'
    },
    'fast-apply': {
        name: 'fast-apply',
        promptKey: 'fast-apply',
        maxTokens: 8192,
        inputTokenBudget: 16_000,
        allowedTools: ['read_file', 'write_file'],
        temperature: 0.0,
        description: 'Quick inline edit application'
    },
    'summarize': {
        name: 'summarize',
        promptKey: 'summarize',
        maxTokens: 4096,
        inputTokenBudget: 16_000,
        allowedTools: [],
        temperature: 0.3,
        description: 'Compress conversation history when context window exceeded'
    }
};
```

### 3. Prompt Templates (`src/vs/workbench/contrib/qic/common/canonical/prompts.ts`)

Define all 8 prompt templates per spec §2.1.3. Each template is a system prompt string:

```typescript
export const PROMPT_TEMPLATES: Record<string, string> = {
    'completion': `You are a code completion assistant for Quantlab...`,
    'chat-ask': `You are QIC, an AI coding assistant integrated into Quantlab...`,
    'chat-gather': `You are gathering context for a coding task...`,
    'chat-plan': `You are planning an implementation approach...`,
    'chat-act': `You are executing a coding plan. Use the available tools...`,
    'repair': `A previous tool execution produced errors. Fix them...`,
    'fast-apply': `Apply the following edit to the specified file...`,
    'summarize': `Summarize the following conversation, preserving key decisions...`
};
```

(Flesh these out fully based on the spec's §2.1.3 PROMPT_TEMPLATES section, lines 680–964)

### 4. Tool Registry (`src/vs/workbench/contrib/qic/common/canonical/tools.ts`)

Define all 22 tools per Appendix A with AUDIT FIXES:

```typescript
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
    // ... all 22 tools from Appendix A ...

    // AUDIT FIX S-8 / I-SG6: inspect_notebook and preview_dataframe are READ-ONLY operations.
    // They must be set to hasSideEffects: false, permission: { required: false }.
    // These should be freely invocable by the LLM without user approval each time.
    // Example:
    //   'inspect_notebook': {
    //       name: 'inspect_notebook', description: '...',
    //       parameters: { ... }, hasSideEffects: false,
    //       permission: { required: false }
    //   },
    //   'preview_dataframe': {
    //       name: 'preview_dataframe', description: '...',
    //       parameters: { ... }, hasSideEffects: false,
    //       permission: { required: false }
    //   },
    //
    // analyze_backtest REMAINS hasSideEffects: true (it writes analysis results):
    //   'analyze_backtest': {
    //       name: 'analyze_backtest', description: '...',
    //       parameters: { ... }, hasSideEffects: true,
    //       permission: { required: true, level: 'session' }
    //   },

    // AUDIT FIX S-9: web_search has status: 'not-yet-implemented'
};
```

### 5. Error Registry (`src/vs/workbench/contrib/qic/common/canonical/errors.ts`)

Define all error codes from Appendix B (QIC-T001 through QIC-Y003):

```typescript
// REMEDIATION FIX 1a (continued): ERROR_REGISTRY stores templates (not QicError instances).
// QicError class constructor looks up this registry.
export interface QicErrorTemplate {
    code: string;
    name: string;
    severity: 'info' | 'warning' | 'error';
    userMessage: string | null;
}

export const ERROR_REGISTRY: Record<string, QicErrorTemplate> = {
    'QIC-T001': { code: 'QIC-T001', name: 'ToolNotFound', severity: 'error', userMessage: 'The requested action is not available.' },
    // ... all 30+ error codes ...
};

// createQicError() factory — alias for `new QicError(code, message, details)`.
// Kept for backward compatibility with any code using the factory pattern.
export function createQicError(code: string, message?: string, details?: unknown): QicError {
    const template = ERROR_REGISTRY[code];
    if (!template) throw new Error(`Unknown error code: ${code}`);
    return new QicError(code, message ?? template.userMessage ?? template.name, details);
}
```

### 6. Core Interfaces (`src/vs/workbench/contrib/qic/common/canonical/interfaces.ts`)

Define the service interfaces from §3.5:

```typescript
export interface ProviderAdapter {
    id: string;
    name: string;
    type: 'llm' | 'embedding';
    isAvailable(): Promise<boolean>;
    getHealth(): Promise<ProviderHealth>;  // AUDIT FIX VII-DS20 / X-PS5
    sendRequest(request: ProviderRequest): Promise<ProviderResponse>;
    sendStreaming(request: ProviderRequest): AsyncIterable<StreamChunk>;  // AUDIT FIX X-PS5
    cancelRequest(requestId: string): void;
}

export interface UIService {
    showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult>;
    showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null>;
    streamChatToken(token: string): void;
    showInfo(message: string): void;
    showWarning(message: string): void;
    showError(message: string): void;
}

export interface ProviderHealth {
    status: 'healthy' | 'degraded' | 'unavailable';
    latencyMs: number;
    errorRate: number;
    lastChecked: string;
}

// AUDIT FIX X-PS7: Gateway-specific types in canonical
// These types are needed by Prompts 08, 10, 11, 17 and must live in canonical
// to satisfy INV-A1 (single source of truth).
// Place in canonical/types.ts or a new canonical/gateway.ts (re-exported from index.ts).

// REMEDIATION FIX 1d: Changed to discriminated union with underscores.
// Prompt 08 defines this exact shape in its StreamingResponseHandler,
// and Prompt 10 switches on `chunk.type === 'tool_call_end'` (underscore).
// The old interface with hyphens ('tool-call-start') and flat optional
// fields is incompatible with both consumers.
export type StreamChunk =
    | { type: 'text'; text: string }
    | { type: 'tool_call_start'; id: string; name: string }
    | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
    | { type: 'tool_call_end'; id: string }
    | { type: 'done'; usage?: TokenUsage; stopReason?: string }
    | { type: 'error'; error: QicError };

export type RequestPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

// REMEDIATION FIX 1e: Reconciled with Prompt 08 which defines
// `providerId?: string` and Prompt 10 which doesn't pass `sessionId`.
// Made `sessionId` optional and added `providerId`.
export interface GatewayRequest extends ProviderRequest {
    lane: LaneName;
    priority: RequestPriority;
    providerId?: string;         // Optional: route to specific provider
    sessionId?: string;          // Optional: for request tracking
}
```

### 7. Barrel Export (`src/vs/workbench/contrib/qic/common/canonical/index.ts`)

The single source of truth — ALL canonical types exported from here:

```typescript
// INV-A1: This file is the SOLE type authority for QIC.
// No other module may define types that compete with these.
// CI validation enforces this invariant.

export * from './types.js';
export * from './lanes.js';
export * from './prompts.js';
export * from './tools.js';
export * from './errors.js';
export * from './interfaces.js';
export * from './tokenCounter.js';
```

### 8. Token Counting Utility (`src/vs/workbench/contrib/qic/common/canonical/tokenCounter.ts`)

AUDIT FIX IV-AO1: Token counting is a dependency for Prompts 04, 08, 09, 10, 11. Without a shared strategy, each component may estimate differently. This utility provides a single source of truth for token counting across all QIC components.

```typescript
import { encoding_for_model } from 'tiktoken';
import { Message } from './types.js';

export class TokenCounter {
    private encoder = encoding_for_model('cl100k_base'); // Works for Claude & GPT

    count(text: string): number {
        return this.encoder.encode(text).length;
    }

    countMessages(messages: Message[]): number {
        let total = 0;
        for (const msg of messages) {
            total += 4; // message overhead tokens
            if (typeof msg.content === 'string') {
                total += this.count(msg.content);
            } else {
                for (const block of msg.content) {
                    if (block.type === 'text') {
                        total += this.count(block.text);
                    }
                }
            }
            if (msg.role) total += 1;
        }
        total += 2; // priming tokens
        return total;
    }

    truncateToFit(text: string, maxTokens: number): string {
        const tokens = this.encoder.encode(text);
        if (tokens.length <= maxTokens) return text;
        return this.encoder.decode(tokens.slice(0, maxTokens));
    }
}

// Export as singleton for consistent counting across all components
export const tokenCounter = new TokenCounter();
```

> **Note**: `cl100k_base` slightly overestimates for Anthropic models, which is safer (prevents exceeding limits).

> **AUDIT FIX VIII-PC3**: Add `tiktoken` to `package.json` dependencies when implementing this prompt. This is a runtime dependency required by the token counter, context assembler, and dynamic tool selector.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/canonical/types.ts` | Core types |
| `src/vs/workbench/contrib/qic/common/canonical/lanes.ts` | 8 lane configs |
| `src/vs/workbench/contrib/qic/common/canonical/prompts.ts` | 8 prompt templates |
| `src/vs/workbench/contrib/qic/common/canonical/tools.ts` | 22 tool definitions |
| `src/vs/workbench/contrib/qic/common/canonical/errors.ts` | Error code registry |
| `src/vs/workbench/contrib/qic/common/canonical/interfaces.ts` | Service interfaces |
| `src/vs/workbench/contrib/qic/common/canonical/tokenCounter.ts` | Token counting utility (IV-AO1) |
| `src/vs/workbench/contrib/qic/common/canonical/index.ts` | Barrel export |

---

## Acceptance Criteria

```
□ All types exported from canonical/index.ts (INV-A1)
□ All 8 lanes defined in LANE_CONFIGURATIONS with correct allowedTools
□ All 8 prompt templates defined in PROMPT_TEMPLATES
□ All 22 tools defined in TOOL_REGISTRY with correct schemas
□ inspect_notebook and preview_dataframe have hasSideEffects: false (audit S-8 / I-SG6)
□ web_search has status: 'not-yet-implemented' (audit S-9)
□ get_definition included in chat-gather allowed tools (audit C-6 / I-SG4)
□ All 30+ error codes defined in ERROR_REGISTRY
□ PermissionCheckResult is the ONLY permission return type (never boolean)
□ TypeScript compiles with no errors
□ Every lane's promptKey exists in PROMPT_TEMPLATES
□ ToolImplementation interface and ToolHandler type defined (audit X-PS2)
□ ProviderAdapter includes sendStreaming() and getHealth() (audit X-PS5)
□ StreamChunk, RequestPriority, GatewayRequest types in canonical (audit X-PS7)
□ TokenCounter class exported as singleton with count/countMessages/truncateToFit (audit IV-AO1)
□ INV-T2 contradiction resolved via comment in types.ts (audit VII-DS6)
□ tiktoken listed as package.json dependency note (audit VIII-PC3)
```

---

## Audit Fixes Applied

The following audit fix IDs from QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md have been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **I-SG4** | MEDIUM | `get_definition` confirmed in `chat-gather`'s allowedTools |
| **I-SG6** | MEDIUM | `inspect_notebook` and `preview_dataframe` set to `hasSideEffects: false, permission: { required: false }`; `analyze_backtest` kept as `hasSideEffects: true` |
| **IV-AO1** | HIGH | Added TokenCounter utility class using tiktoken `cl100k_base` encoding with `count()`, `countMessages()`, `truncateToFit()` methods, exported as singleton |
| **VII-DS6** | HIGH | Added comment resolving INV-T2 contradiction: audit logging (all tools) vs permission checks (side-effect tools only) are separate concerns |
| **X-PS2** | CRITICAL | Added `ToolImplementation` interface and `ToolHandler` type to canonical types |
| **X-PS5** | HIGH | Added `sendStreaming()` returning `AsyncIterable<StreamChunk>` and `getHealth()` returning `Promise<ProviderHealth>` to `ProviderAdapter` interface |
| **X-PS7** | MEDIUM | Added `StreamChunk`, `RequestPriority`, and `GatewayRequest` types to canonical for use by Prompts 08, 10, 11, 17 |
| **VIII-PC3** | HIGH (partial) | Added note to add `tiktoken` to package.json dependencies when implementing |
