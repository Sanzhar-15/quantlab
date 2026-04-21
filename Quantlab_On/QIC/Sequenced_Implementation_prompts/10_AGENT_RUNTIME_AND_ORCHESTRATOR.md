# Prompt 10 — Agent Runtime: Orchestrator, Tool Router, Lane Router & Permissions

**Phase**: 5b (Agent Runtime)
**Prerequisites**: Prompt 09 (context engine), Prompt 08 (gateway), Prompt 07 (mutation engine)
**Estimated Scope**: ~8 files created, ~1200 lines
**CRITICAL PROMPT**: This is the most important prompt — it implements the core agentic loop.

---

## Objective

Implement the agent orchestrator (the central agentic loop), lane router (message classification), step executor, tool router with permission manager, and UI service stubs. This is where QIC becomes an AI agent capable of multi-turn tool use.

---

## Spec References

- QIC Spec v6.2: §7.1 Step Executor (lines 4977–5062)
- QIC Spec v6.2: §7.2 Tool Router (lines 5062–5163)
- Implementation Plan v3: §5.9 Agent Orchestrator (lines 1281–1380) — The orchestrator pseudocode

## Audit Fixes Incorporated (3 CRITICAL + 2 HIGH + 12 from deep audit)

- **I-1 (CRITICAL -- MOST IMPORTANT)**: The implementation plan's agentic loop is BROKEN. The `for await` stream loop does NOT re-send tool results back to the LLM. You MUST use an explicit while-loop: outer loop sends to gateway, inner loop reads stream; on tool_call -> execute -> append result -> break inner loop to re-send. On done with no tool calls -> return.
- **S-1 (CRITICAL)**: Implement the Agent Orchestrator that was missing from the spec.
- **S-2 (CRITICAL)**: Implement the Lane Router that was missing from the spec.
- **I-5 (HIGH)**: Handle concurrent `handleUserMessage` calls (queue or cancel).
- **I-6 (HIGH)**: UI stubs must require `QIC_AUTO_APPROVE_FOR_TESTING=true` env var to auto-approve edits.
- **I-SG5 (MEDIUM)**: Add summarize lane trigger when conversation token count exceeds 80% of budget.
- **I-SG7 (HIGH)**: Add bypass routing for completion lane and fast-apply in handleUserMessage().
- **II-PG3 (MEDIUM)**: Enforce `[STUB]` warning pattern for ALL stubs with `console.warn('[STUB] ClassName.methodName -- Phase N will replace');`.
- **IV-AO5 (HIGH)**: Add message queuing with cancel-current option.
- **X-PS2 (CRITICAL)**: Add `register()` method and `ToolImplementation` type to ToolRouter.
- **X-PS3 (HIGH)**: Add SecurityAuditLoggerStub to files-to-create.
- **XI-SV1 (CRITICAL)**: Add secret scanning to ALL error display paths.
- **XII-AR2 (HIGH)**: Add conversation size management: MAX_TOOL_RESULT_TOKENS = 10,000 per result.
- **XII-AR3 (HIGH)**: Handle permission dialog cancellation (CancellationError).
- **XII-AR5 (MEDIUM)**: Add token budget check in agentic loop before each re-send.
- **III-QI4 (HIGH)**: Add trust-awareness to PermissionManager for strategy files.
- **X-PS6 (note)**: NOTE: Prompt 14 (Security Hardening) should be executed BEFORE this prompt.

---

## Implementation Instructions

### 1. AgentOrchestrator (`src/vs/workbench/contrib/qic/common/runtime/agentOrchestrator.ts`)

**THIS IS THE MOST CRITICAL CLASS IN THE ENTIRE QIC SYSTEM.**

**NOTE (AUDIT FIX X-PS6)**: Prompt 14 (Security Hardening) should be executed BEFORE this prompt. Its actual dependencies are only Prompts 04 and 06, and executing it first eliminates the SecurityAuditLogger stub gap. If Prompt 14 cannot be executed first, use the SecurityAuditLoggerStub defined below (X-PS3).

```typescript
export class AgentOrchestrator {
    private messageQueue: QueuedMessage[] = [];  // AUDIT FIX I-5 + IV-AO5
    private isProcessing = false;

    constructor(
        private readonly agentState: PersistentAgentStateMachine,
        private readonly conversationState: ConversationState,
        private readonly laneRouter: LaneRouter,
        private readonly contextAssembler: ContextAssembler,
        private readonly gateway: Gateway,
        private readonly toolRouter: ToolRouter,
        private readonly stepExecutor: StepExecutor,
        private readonly mutationEngine: MutationEngine,
        private readonly uiService: UIService,
        private readonly cancellationManager: CancellationManager,
        private readonly timeoutManager: TimeoutManager,
        private readonly secretScanner: OptimizedSecretScanner,   // AUDIT FIX XI-SV1
        private readonly tokenCounter: TokenCounter                // AUDIT FIX XII-AR2, XII-AR5
    ) {}

    /**
     * Handle a user message. This is the main entry point.
     *
     * AUDIT FIX I-5 + IV-AO5: If already processing, queue the message,
     * notify the user, and offer cancel-current option. Process queue in
     * finally block.
     *
     * AUDIT FIX I-SG7: Bypass routing for completion and fast-apply lanes.
     *
     * AUDIT FIX I-SG5: Check conversation token count and invoke summarize
     * lane if over 80% of budget.
     */
    async handleUserMessage(text: string): Promise<void> {
        // ═══════════════════════════════════════════════════════
        // AUDIT FIX IV-AO5: Message queuing with cancel option
        // ═══════════════════════════════════════════════════════
        if (this.isProcessing) {
            this.messageQueue.push({ text, timestamp: Date.now() });
            this.uiService.showInfo(
                'Processing your previous request. Your message has been queued. ' +
                'Use "Cancel current request" to process your new message immediately.'
            );
            return;
        }

        this.isProcessing = true;
        try {
            // ═══════════════════════════════════════════════════════
            // AUDIT FIX I-SG5: Summarize lane trigger
            // ═══════════════════════════════════════════════════════
            const conversationTokens = this.tokenCounter.countMessages(
                this.conversationState.getMessages()
            );
            const budgetThreshold = 12_800;  // 80% of 16K conversation budget
            if (conversationTokens > budgetThreshold) {
                await this.invokeSummarizeLane();
            }

            // ═══════════════════════════════════════════════════════
            // AUDIT FIX I-SG7: Bypass routing
            // ═══════════════════════════════════════════════════════
            const lane = await this.laneRouter.classify(text, this.conversationState);

            // BYPASS 1: Completion lane routes directly to CompletionEngine
            // CompletionEngine is NOT invoked through the orchestrator.
            // It's triggered by the InlineCompletionProvider (Prompt 11).
            if (lane === 'completion') {
                throw new Error('Completion lane should not reach orchestrator — ' +
                    'handled by CompletionEngine via InlineCompletionProvider');
            }

            // BYPASS 2: Fast-apply skips planning, goes directly to edit
            if (lane === 'fast-apply') {
                return this.handleFastApply(text);
            }

            // Normal flow: context assembly → LLM → tool loop
            await this.processMessage(text);
        } finally {
            this.isProcessing = false;
            // AUDIT FIX IV-AO5: Process queued messages in finally block
            if (this.messageQueue.length > 0) {
                const next = this.messageQueue.shift()!;
                // Process next in queue (non-recursive — use setImmediate or similar)
                setImmediate(() => this.handleUserMessage(next.text).catch(err => {
                    this.showError(err);
                }));
            }
        }
    }

    /**
     * AUDIT FIX IV-AO5: Cancel current request and process queued message.
     */
    cancelCurrentAndProcessNext(): void {
        this.cancellationManager.cancelAll();
        // The finally block in handleUserMessage will pick up the next queued message
    }

    /**
     * AUDIT FIX I-SG5: Invoke summarize lane to compress conversation history.
     * Automatically invoked when conversation token count exceeds 80% of budget
     * (12,800 tokens). Replaces old messages with a summary.
     * CONSTRAINT: Never summarize the last 3 user/assistant exchanges.
     */
    private async invokeSummarizeLane(): Promise<void> {
        const messages = this.conversationState.getMessages();
        // Keep the last 3 exchanges (6 messages: 3 user + 3 assistant)
        const keepCount = 6;
        if (messages.length <= keepCount) return;

        const toSummarize = messages.slice(0, messages.length - keepCount);
        const toKeep = messages.slice(messages.length - keepCount);

        const context = await this.contextAssembler.assemble('summarize',
            'Summarize the following conversation history concisely.');
        const summary = await this.gateway.sendRequest({
            model: context.model,
            messages: [
                { role: 'system', content: context.systemPrompt },
                { role: 'user', content: JSON.stringify(toSummarize) }
            ],
            lane: 'summarize',
            priority: 'low'
        });

        this.conversationState.replaceMessagesWithSummary(summary.content, toKeep);
    }

    /**
     * AUDIT FIX I-SG7: Handle fast-apply bypass — skip planning, go directly to edit.
     */
    private async handleFastApply(text: string): Promise<void>;

    /**
     * AUDIT FIX XI-SV1: Secret scanning on ALL error display paths.
     * Every error shown to the user MUST pass through SecretScanner first.
     */
    private showError(error: Error): void {
        const sanitized = this.secretScanner.redact(error.message).redactedText;
        this.uiService.showError(sanitized);
    }

    /**
     * The core agentic loop.
     *
     * ██████████████████████████████████████████████████████████████
     * █ AUDIT FIX I-1 (CRITICAL):                                 █
     * █ The implementation plan's pseudocode is BROKEN.            █
     * █ The for-await loop does NOT re-send tool results.          █
     * █ We use an explicit while-loop with re-send after each      █
     * █ tool call.                                                 █
     * ██████████████████████████████████████████████████████████████
     */
    private async processMessage(text: string): Promise<void> {
        const scope = this.cancellationManager.createScope('message-' + Date.now());

        try {
            // 1. Classify into lane
            const lane = await this.laneRouter.classify(text, this.conversationState);

            // 2. Add user message
            this.conversationState.addUserMessage(text);
            this.conversationState.setLane(lane);

            // 3. Transition agent state
            await this.agentState.transition('processing');

            // 4. Assemble context
            const context = await this.contextAssembler.assemble(lane, text);

            // 5. Build messages array
            const messages = [
                { role: 'system' as const, content: context.systemPrompt },
                ...this.conversationState.getMessages()
            ];

            // ═══════════════════════════════════════════════════════
            // AGENTIC LOOP — The heart of QIC
            // ═══════════════════════════════════════════════════════
            const MAX_TOOL_ROUNDS = 25;  // Safety limit
            let round = 0;

            while (round < MAX_TOOL_ROUNDS) {
                round++;
                scope.signal.throwIfAborted();

                // 6. Send to LLM via gateway
                const stream = this.gateway.sendStreaming({
                    model: context.model,
                    messages,
                    tools: context.tools,
                    lane,
                    priority: 'normal',
                    signal: scope.signal
                });

                // 7. Process stream
                let hasToolCalls = false;
                const toolCalls: ToolCall[] = [];
                let assistantText = '';

                for await (const chunk of stream) {
                    scope.signal.throwIfAborted();

                    switch (chunk.type) {
                        case 'text':
                            assistantText += chunk.text;
                            this.uiService.streamChatToken(chunk.text);
                            break;

                        case 'tool_call_end':
                            hasToolCalls = true;
                            // Accumulate complete tool call
                            const toolCall = /* accumulated from start+delta+end chunks */;
                            toolCalls.push(toolCall);
                            break;

                        case 'done':
                            // Stream finished for this round
                            break;
                    }
                }

                // 8. If no tool calls, we're done
                if (!hasToolCalls) {
                    this.conversationState.addAssistantMessage([{ type: 'text', text: assistantText }]);
                    await this.agentState.transition('idle');
                    return;
                }

                // 9. Execute tool calls and append results
                // Add assistant message with tool calls
                this.conversationState.addAssistantMessage([
                    ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
                    ...toolCalls.map(tc => ({
                        type: 'tool_use' as const,
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments
                    }))
                ]);

                for (const toolCall of toolCalls) {
                    // REMEDIATION FIX 2k: Added permissions field to match canonical ToolContext
                    const result = await this.toolRouter.execute(toolCall, {
                        sessionId: this.agentState.sessionId,
                        workspacePath: context.workspacePath,
                        permissions: new Map(),
                    });

                    // ═══════════════════════════════════════════
                    // AUDIT FIX XII-AR2: Truncate tool results
                    // before appending to conversation.
                    // ═══════════════════════════════════════════
                    const MAX_TOOL_RESULT_TOKENS = 10_000;
                    let truncatedContent = result.content;
                    const resultTokens = this.tokenCounter.count(result.content);
                    if (resultTokens > MAX_TOOL_RESULT_TOKENS) {
                        truncatedContent = this.tokenCounter.truncateToFit(
                            result.content, MAX_TOOL_RESULT_TOKENS
                        );
                        truncatedContent += '\n[... truncated, full result was '
                            + result.content.length + ' chars]';
                    }

                    this.conversationState.addToolResult(toolCall.id, {
                        ...result,
                        content: truncatedContent
                    });
                }

                // ═══════════════════════════════════════════════
                // AUDIT FIX XII-AR5: Token budget check before
                // each re-send. If over 150% of budget, truncate.
                // ═══════════════════════════════════════════════
                const totalTokens = this.tokenCounter.countMessages(
                    this.conversationState.getMessages()
                );
                const budget = LANE_CONFIGURATIONS[lane].inputTokenBudget;  // REMEDIATION FIX 2f: Use canonical field name
                if (totalTokens > budget * 1.5) {
                    // Over 150% of budget — truncate old messages
                    await this.truncateConversation(budget);
                }

                // ═══════════════════════════════════════════════
                // AUDIT FIX XII-AR2: Trigger summarize lane if
                // total conversation exceeds max budget.
                // ═══════════════════════════════════════════════
                const MAX_CONVERSATION_TOKENS = 200_000;
                if (totalTokens > MAX_CONVERSATION_TOKENS) {
                    await this.invokeSummarizeLane();
                }

                // 10. UPDATE MESSAGES for re-send
                // This is the CRITICAL fix — we rebuild messages with tool results
                messages.length = 0;
                messages.push(
                    { role: 'system' as const, content: context.systemPrompt },
                    ...this.conversationState.getMessages()
                );

                // Loop continues → sends updated messages to gateway
            }

            // Safety limit reached
            this.uiService.showWarning('Reached maximum tool call rounds. Stopping.');
            await this.agentState.transition('idle');

        } catch (error) {
            if (scope.signal.aborted) {
                this.uiService.showInfo('Request cancelled.');
            } else {
                // AUDIT FIX XI-SV1: Secret scanning on error display
                this.showError(error);
            }
            await this.agentState.transition('error');
        }
    }

    /**
     * AUDIT FIX XII-AR5: Truncate conversation when over budget.
     */
    private async truncateConversation(targetBudget: number): Promise<void>;
}
```

### 2. LaneRouter (`src/vs/workbench/contrib/qic/common/runtime/laneRouter.ts`)

**AUDIT FIX S-2**: Implement lane classification (missing from spec):

```typescript
export class LaneRouter {
    /**
     * Classify a user message into a lane.
     * Priority-ordered classification strategy:
     * 1. Explicit user directive (e.g., "/ask", "/edit")
     * 2. Tool-use patterns (mentions of file operations, terminal commands)
     * 3. Question patterns (starts with "what", "how", "why", etc.)
     * 4. Context-based (conversation history suggests continuation)
     * 5. Default: 'chat-ask'
     */
    async classify(
        message: string,
        conversationState: ConversationState
    ): Promise<LaneName>;
}
```

### 3. StepExecutor (`src/vs/workbench/contrib/qic/common/runtime/stepExecutor.ts`)

Executes individual plan steps:

```typescript
export class StepExecutor {
    async execute(step: PlanStep, context: StepContext): Promise<StepResult>;
}
```

### 4. ToolRouter (`src/vs/workbench/contrib/qic/common/runtime/toolRouter.ts`)

Routes tool calls to implementations with permission checking.

**AUDIT FIX X-PS2**: Add `register()` method and `ToolImplementation` type. Prompt 15 calls `toolRouter.register('read_file', ...)` which requires this method to exist.

```typescript
// REMEDIATION FIX 2e: Import ToolImplementation and ToolHandler from canonical/types.ts
// Do NOT define locally — canonical is the single source of truth (INV-A1).
// import { ToolImplementation, ToolHandler } from '../canonical/types.js';

export class ToolRouter {
    private readonly implementations = new Map<string, ToolImplementation>();

    constructor(
        private readonly permissionManager: PermissionManager,
        private readonly auditLogger: SecurityAuditLogger  // Uses stub (X-PS3) until Prompt 14
    ) {}

    /**
     * AUDIT FIX X-PS2: Register a tool handler.
     * Called by Prompt 15 for each of the 22 tools.
     * Throws if a tool with the same name is already registered.
     */
    register(toolName: string, handler: ToolHandler): void {
        if (this.implementations.has(toolName)) {
            throw new Error(`Tool '${toolName}' already registered`);
        }
        this.implementations.set(toolName, { execute: handler });
    }

    async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
        const impl = this.implementations.get(toolCall.name);
        if (!impl) {
            throw new QicError('QIC-T001', `Unknown tool: ${toolCall.name}`);
        }

        // XII-AR3: Handle permission dialog cancellation
        let permission: PermissionCheckResult;
        try {
            permission = await this.permissionManager.check(toolCall.name, context);
        } catch (e) {
            // AUDIT FIX XII-AR3: Catch CancellationError from showPermissionDialog
            if (e instanceof CancellationError) {
                // REMEDIATION FIX 2g: Aligned with canonical ToolResult shape
                // (toolCallId, content, isError only — no extra fields)
                return {
                    toolCallId: toolCall.id,
                    content: 'Permission request cancelled by user. Panel closed during permission request.',
                    isError: true
                };
            }
            throw e;
        }

        if (permission.status === 'denied') {
            return {
                toolCallId: toolCall.id,
                content: `Permission denied: ${permission.reason}`,
                isError: true
            };
        }

        // INV-T2: Log ALL tool calls via SecurityAuditLogger
        this.auditLogger.logToolCall({
            toolName: toolCall.name,
            action: 'execute',
            args: toolCall.arguments,
            sessionId: context.sessionId,
            timestamp: Date.now()
        });

        // REMEDIATION FIX: Tools return ToolResultPayload (content + isError).
        // ToolRouter wraps with toolCallId to produce a full ToolResult.
        const payload = await impl.execute(toolCall.arguments, context);
        return { toolCallId: toolCall.id, ...payload };
    }
}
```

### 5. PermissionManager (`src/vs/workbench/contrib/qic/common/runtime/permissionManager.ts`)

**AUDIT FIX III-QI4**: Add trust-awareness. When a tool targets a strategy file, escalate to 'once' permission regardless of the tool's default permission level.

```typescript
export class PermissionManager {
    constructor(
        private readonly permissionStore: PermissionStore,
        private readonly uiService: UIService,
        private readonly workspaceTrust: IWorkspaceTrustService  // AUDIT FIX III-QI4
    ) {}

    /**
     * Check permission for a tool call.
     * MUST return PermissionCheckResult, NEVER boolean.
     *
     * AUDIT FIX III-QI4: When a tool call targets a file within a recognized
     * strategy directory (detected by the presence of strategy markers or file
     * patterns), escalate to 'once' permission level regardless of the tool's
     * default permission level. This ensures every strategy modification
     * requires explicit user approval.
     */
    async check(toolName: string, context: ToolContext): Promise<PermissionCheckResult> {
        const toolDef = this.getToolDefinition(toolName);

        // AUDIT FIX III-QI4: Trust-aware permission escalation
        if (this.isStrategyFile(context.targetPath)) {
            // Strategy files always require explicit 'once' approval
            return this.requestPermission(toolName, context, 'once');
        }

        if (!toolDef.permission?.required) {
            return { status: 'granted', scope: 'always' };
        }

        // Check stored permissions
        const stored = await this.permissionStore.get(toolName, context.sessionId);
        if (stored && !this.isExpired(stored)) {
            return { status: 'granted', scope: stored.scope };
        }

        // Request permission from user via UI
        return this.requestPermission(toolName, context, toolDef.permission.defaultScope);
    }

    /**
     * AUDIT FIX III-QI4: Detect strategy files that require trust verification.
     */
    private isStrategyFile(targetPath?: string): boolean {
        if (!targetPath) return false;
        // Strategy markers: presence of strategy config files, recognized patterns
        const strategyPatterns = [
            /strategies?\//i,
            /\.strategy\.(ts|py|json)$/i,
            /backtest/i,
        ];
        return strategyPatterns.some(p => p.test(targetPath));
    }
}
```

### 6. UI Service Stub (`src/vs/workbench/contrib/qic/common/runtime/uiServiceStub.ts`)

**AUDIT FIX I-6**: Stub requires env var for auto-approval.

**AUDIT FIX II-PG3**: Every stub method MUST include the `[STUB]` warning pattern:
`console.warn('[STUB] ClassName.methodName -- Phase N will replace');`

```typescript
export class UIServiceStub implements UIService {
    async showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null> {
        console.warn('[STUB] UIService.showDiffPreview — Prompt 13 will replace');
        if (process.env.QIC_AUTO_APPROVE_FOR_TESTING !== 'true') {
            throw new Error('[STUB] Cannot auto-approve edits without QIC_AUTO_APPROVE_FOR_TESTING=true');
        }
        return { id: 'stub-' + Date.now(), editScriptHash: '...', grantedAt: new Date().toISOString(), grantedBy: 'auto-test', expiresAt: '...' };
    }

    async showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult> {
        console.warn('[STUB] UIService.showPermissionDialog — Prompt 13 will replace');
        if (process.env.QIC_AUTO_APPROVE_FOR_TESTING !== 'true') {
            throw new Error('[STUB] Cannot auto-approve without QIC_AUTO_APPROVE_FOR_TESTING=true');
        }
        return { status: 'granted', scope: 'once' };
    }

    streamChatToken(text: string): void {
        console.warn('[STUB] UIService.streamChatToken — Prompt 12 will replace');
    }

    showInfo(message: string): void {
        console.warn('[STUB] UIService.showInfo — Prompt 13 will replace');
        console.log('[QIC-INFO]', message);
    }

    showWarning(message: string): void {
        console.warn('[STUB] UIService.showWarning — Prompt 13 will replace');
        console.log('[QIC-WARN]', message);
    }

    showError(message: string): void {
        console.warn('[STUB] UIService.showError — Prompt 13 will replace');
        console.error('[QIC-ERROR]', message);
    }
}
```

### 7. SecurityAuditLoggerStub (`src/vs/workbench/contrib/qic/common/runtime/securityAuditLoggerStub.ts`)

**AUDIT FIX X-PS3**: The ToolRouter requires SecurityAuditLogger, but the real implementation is in Prompt 14. This stub provides a placeholder that follows the `[STUB]` warning pattern (II-PG3).

```typescript
/**
 * AUDIT FIX X-PS3: SecurityAuditLogger stub.
 * AUDIT FIX II-PG3: All methods follow [STUB] warning pattern.
 *
 * NOTE (X-PS6): If Prompt 14 is executed before this prompt, this stub
 * is unnecessary and should not be created.
 */
export class SecurityAuditLoggerStub implements SecurityAuditLogger {
    logToolCall(entry: AuditEntry): void {
        console.warn('[STUB] SecurityAuditLogger.logToolCall — Prompt 14 will replace');
        console.log('[AUDIT-STUB]', entry.toolName, entry.action);
    }

    logPermissionGrant(entry: AuditEntry): void {
        console.warn('[STUB] SecurityAuditLogger.logPermissionGrant — Prompt 14 will replace');
    }

    logEgressAttempt(entry: AuditEntry): void {
        console.warn('[STUB] SecurityAuditLogger.logEgressAttempt — Prompt 14 will replace');
    }

    async flush(): Promise<void> {}
}
```

### 8. TerminalSecurityGuard and ToolChainMonitor Stubs

**AUDIT FIX II-PG3**: Stubs for security components also follow the `[STUB]` pattern.

```typescript
export class TerminalSecurityGuardStub implements TerminalSecurityGuard {
    validateCommand(command: string): ValidationResult {
        console.warn('[STUB] TerminalSecurityGuard.validateCommand — Prompt 14 will replace');
        return { allowed: true };
    }
}

export class ToolChainMonitorStub implements ToolChainMonitor {
    recordToolCall(entry: ToolCallEntry): void {
        console.warn('[STUB] ToolChainMonitor.recordToolCall — Prompt 14 will replace');
    }
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/runtime/agentOrchestrator.ts` | Core agentic loop with bypass routing (I-SG7), summarize trigger (I-SG5), secret-scanned errors (XI-SV1), token budget enforcement (XII-AR2, XII-AR5) |
| `src/vs/workbench/contrib/qic/common/runtime/laneRouter.ts` | Message classification |
| `src/vs/workbench/contrib/qic/common/runtime/stepExecutor.ts` | Step execution |
| `src/vs/workbench/contrib/qic/common/runtime/toolRouter.ts` | Tool routing with register() method (X-PS2) and permission dialog cancellation handling (XII-AR3) |
| `src/vs/workbench/contrib/qic/common/runtime/permissionManager.ts` | Permission checks with trust-aware escalation for strategy files (III-QI4) |
| `src/vs/workbench/contrib/qic/common/runtime/uiServiceStub.ts` | UI stub with [STUB] warning pattern (II-PG3) |
| `src/vs/workbench/contrib/qic/common/runtime/securityAuditLoggerStub.ts` | SecurityAuditLogger stub (X-PS3) with [STUB] pattern (II-PG3) |
| `src/vs/workbench/contrib/qic/test/common/runtime/agentOrchestrator.test.ts` | Orchestrator tests |
| `src/vs/workbench/contrib/qic/test/common/runtime/laneRouter.test.ts` | Lane router tests |

---

## Acceptance Criteria

```
□ Agentic loop correctly re-sends tool results to LLM (AUDIT FIX I-1)
□ Multi-tool interactions work: tool call → result → LLM response → another tool call → result → final response
□ Safety limit of 25 tool rounds prevents infinite loops
□ LaneRouter classifies messages into appropriate lanes
□ Concurrent messages are queued, not rejected; user is notified; cancel-current option available (AUDIT FIX I-5, IV-AO5)
□ Completion lane throws error when it reaches orchestrator (AUDIT FIX I-SG7)
□ Fast-apply lane skips planning and goes directly to handleFastApply() (AUDIT FIX I-SG7)
□ Summarize lane triggers when conversation tokens exceed 80% of budget (12,800 tokens) (AUDIT FIX I-SG5)
□ Summarize lane never summarizes the last 3 user/assistant exchanges (AUDIT FIX I-SG5)
□ PermissionManager returns PermissionCheckResult, NEVER boolean
□ PermissionManager escalates to 'once' for strategy files (AUDIT FIX III-QI4)
□ Permission dialog cancellation returns denied result, does NOT hang (AUDIT FIX XII-AR3)
□ UI stub requires QIC_AUTO_APPROVE_FOR_TESTING=true for auto-approval (AUDIT FIX I-6)
□ All stubs follow [STUB] warning pattern: console.warn('[STUB] ClassName.methodName — Prompt N') (AUDIT FIX II-PG3)
□ SecurityAuditLoggerStub exists and implements all SecurityAuditLogger methods (AUDIT FIX X-PS3)
□ ToolRouter.register() method exists and rejects duplicate registrations (AUDIT FIX X-PS2)
□ All error display paths pass through SecretScanner.redact() first (AUDIT FIX XI-SV1)
□ Tool results are truncated to MAX_TOOL_RESULT_TOKENS=10,000 before appending (AUDIT FIX XII-AR2)
□ Token budget check runs before each re-send; truncate if over 150% of budget (AUDIT FIX XII-AR5)
□ All tool calls are logged via SecurityAuditLogger (INV-T2, uses stub for now)
□ Cancellation propagates correctly through the agentic loop
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

The following audit findings from `QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md` have been incorporated into this prompt:

| Fix ID | Severity | Summary | Where Applied |
|--------|----------|---------|---------------|
| **I-SG5** | MEDIUM | Add summarize lane trigger: automatically invoke when conversation token count exceeds 80% of budget (12,800 tokens). Replace old messages with summary. Never summarize last 3 exchanges. | AgentOrchestrator.handleUserMessage() + invokeSummarizeLane() |
| **I-SG7** | HIGH | Add bypass routing in handleUserMessage(): completion lane throws error (bypasses orchestrator, handled by CompletionEngine); fast-apply skips planning, goes directly to handleFastApply(). | AgentOrchestrator.handleUserMessage() |
| **II-PG3** | MEDIUM | Enforce [STUB] warning pattern for ALL stubs. Every stub method must include: `console.warn('[STUB] ClassName.methodName -- Phase N will replace');` | UIServiceStub, SecurityAuditLoggerStub, TerminalSecurityGuardStub, ToolChainMonitorStub |
| **IV-AO5** | HIGH | Add message queuing: if isProcessing, queue message and notify user. Process queue in finally block. Add cancel-current option via cancelCurrentAndProcessNext(). | AgentOrchestrator.handleUserMessage() + cancelCurrentAndProcessNext() |
| **X-PS2** | CRITICAL | Add `register()` method to ToolRouter: `register(toolName: string, handler: ToolHandler): void` that throws if tool already registered. Add ToolImplementation type and ToolHandler type. | ToolRouter class |
| **X-PS3** | HIGH | Add SecurityAuditLoggerStub to files-to-create with logToolCall(), logPermissionGrant(), logEgressAttempt(), flush() methods, all following [STUB] pattern. | securityAuditLoggerStub.ts |
| **XI-SV1** | CRITICAL | Add secret scanning to ALL error display paths: `showError()` method runs `secretScanner.redact(error.message).redactedText` before displaying. | AgentOrchestrator.showError() + processMessage() catch block |
| **XII-AR2** | HIGH | Add conversation size management: MAX_TOOL_RESULT_TOKENS = 10,000 per result. Truncate before appending. Check total before each re-send. Trigger summarize lane if over budget. | AgentOrchestrator.processMessage() tool result handling |
| **XII-AR3** | HIGH | Handle permission dialog cancellation: catch CancellationError from showPermissionDialog, return denied result instead of hanging indefinitely. | ToolRouter.execute() permission check |
| **XII-AR5** | MEDIUM | Add token budget check in agentic loop before each re-send. If over 150% of budget, truncate conversation. | AgentOrchestrator.processMessage() loop body |
| **III-QI4** | HIGH | Add trust-awareness to PermissionManager: when tool targets a strategy file, escalate to 'once' permission regardless of default. Strategy files detected via path patterns. | PermissionManager.check() + isStrategyFile() |
| **X-PS6** | NOTE | NOTE: Prompt 14 (Security Hardening) should be executed BEFORE this prompt. Its actual dependencies are only Prompts 04 and 06, and executing it first eliminates the SecurityAuditLogger stub gap. | Header note + SecurityAuditLoggerStub comment |
