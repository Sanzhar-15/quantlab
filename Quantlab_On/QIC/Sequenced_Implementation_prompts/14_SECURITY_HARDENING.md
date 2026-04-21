# Prompt 14 — Security Hardening: Terminal Guard, Tool Chain Monitor & Audit Logger

> **NOTE (AUDIT FIX X-PS6)**: This prompt's actual dependencies are only Prompt 04 (canonical types) and Prompt 06 (security foundation). It CAN and SHOULD be executed before Prompt 10 to eliminate the SecurityAuditLogger stub gap. The listed prerequisite on Prompt 10 is only for the tool router integration, which can be wired later.

**Phase**: 8 (Security Hardening)
**Prerequisites**: Prompt 04 (canonical types), Prompt 06 (security foundation). Prompt 10 (tool router) is needed only for final wiring.
**Estimated Scope**: ~5 files created, ~700 lines

---

## Objective

Implement the final security layer: TerminalSecurityGuard (4-layer command validation), ToolChainMonitor (dangerous sequence detection), and SecurityAuditLogger (hash-chained audit log). This replaces ALL remaining security stubs.

**CRITICAL**: After this prompt, all SECURITY stubs (TerminalSecurityGuard, ToolChainMonitor, SecurityAuditLogger) must be replaced with real implementations. (REMEDIATION FIX 3c: Full [STUB] elimination across ALL components is verified in Prompt 19 integration testing.)

---

## Spec References

- QIC Spec v6.2: §10.2 Terminal Security (lines 6945–7062) — 4-layer validation
- QIC Spec v6.2: §10.3 Tool Chain Monitor (lines 7062–7158) — Dangerous sequences
- QIC Spec v6.2: §10.4 Audit Logger (lines 7158–7291) — Hash-chained log

## Audit Fixes Incorporated

- **X-PS6 (note)**: Dependency correction — actual prerequisites are Prompt 04 and Prompt 06 only.
- **III-QI6 (HIGH)**: Integrate SecurityAuditLogger with existing engine audit ledger via shared SHA-256 hash-chain and cross-audit reference IDs.
- **VII-DS12 (MEDIUM)**: Add full Layer 3 specification — structured command parsing with per-command argument rules.
- **VII-DS13 (MEDIUM)**: Add DataFlowAnalysis interface to ToolChainMonitor.
- **XI-SV1 (CRITICAL)**: SecurityAuditLogger must redact secrets before writing.
- **XI-SV3 (CRITICAL)**: Replace simple prefix allowlist with structured ArgumentAnalyzer.

---

## Implementation Instructions

### 1. TerminalSecurityGuard (`src/vs/workbench/contrib/qic/common/security/terminalGuard.ts`)

4-layer command validation for `run_terminal` and `run_command` tools:

```typescript
export class TerminalSecurityGuard {
    constructor(
        private readonly argumentAnalyzer: ArgumentAnalyzer  // AUDIT FIX XI-SV3
    ) {}

    /**
     * Validate a command through 4 security layers:
     * Layer 1: Blocklist — reject commands matching dangerous patterns
     * Layer 2: Allowlist — only permit known-safe command prefixes
     * Layer 3: Structured argument analysis (AUDIT FIX VII-DS12, XI-SV3)
     * Layer 4: Context analysis — check command history for escalation patterns
     */
    async validateCommand(
        command: string,
        context: ToolContext
    ): Promise<{ allowed: boolean; reason?: string; layer?: number }>;
}

// Dangerous command patterns (Layer 1 blocklist)
const BLOCKED_PATTERNS = [
    /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf /
    /:(){ :|:& };:/,                   // Fork bomb
    /mkfs\./,                           // Filesystem format
    /dd\s+if=.*of=\/dev\//,           // Direct disk write
    /chmod\s+777\s+\//,               // Open permissions on root
    /curl.*\|\s*(bash|sh)/,           // Pipe to shell
    /wget.*\|\s*(bash|sh)/,           // Pipe to shell
    />\s*\/etc\//,                     // Overwrite system files
    /sudo\s+rm/,                       // Sudo destructive operations
    // ... more patterns
];

// Safe command prefixes (Layer 2 allowlist)
// AUDIT FIX XI-SV3: These prefixes are ONLY the first pass. Layer 3 (ArgumentAnalyzer)
// performs structured per-command validation. A command passing Layer 2 can still be
// rejected by Layer 3 if its arguments are dangerous.
const ALLOWED_PREFIXES = [
    'git', 'npm', 'npx', 'pip', 'python', 'node',
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
    'echo', 'pwd', 'date', 'which', 'env',
    'tsc', 'eslint', 'prettier', 'jest', 'pytest',
    'cargo', 'go', 'rustc', 'make', 'cmake',
];
```

**AUDIT FIX VII-DS12 + XI-SV3**: Full Layer 3 specification — structured command parsing with per-command argument rules. Replace the simple prefix allowlist approach with a structured `ArgumentAnalyzer`.

```typescript
// src/vs/workbench/contrib/qic/common/security/argumentAnalyzer.ts
import * as shellQuote from 'shell-quote';

export class ArgumentAnalyzer {
    // Per-command argument validation rules
    private readonly commandRules: Map<string, CommandArgumentRule> = new Map([
        ['python', {
            blockedFlags: ['-c'],  // python -c allows arbitrary code execution
            requiresApproval: [],
            notes: 'Block -c flag (inline code execution)',
        }],
        ['git', {
            blockedFlags: ['-c'],  // git -c can set arbitrary config including protocol
            blockedSubcommands: ['remote set-url'],
            requiresApproval: ['push', 'push --force'],
            notes: 'Block -c (protocol injection), require approval for push',
        }],
        ['npx', {
            requiresApproval: ['*'],  // ALL npx commands require approval
            requiredFlags: ['--yes'],  // Suggest using --yes for non-interactive
            notes: 'npx downloads and executes packages — always require approval',
        }],
        ['npm', {
            blockedSubcommands: ['exec'],  // npm exec is equivalent to npx
            requiresApproval: ['install', 'ci', 'run'],
            notes: 'Block npm exec; require approval for install/ci/run',
        }],
        ['node', {
            blockedFlags: ['-e', '--eval'],  // Inline code execution
            notes: 'Block inline eval flags',
        }],
        ['curl', {
            blockedFlags: ['-o', '--output', '-O', '--remote-name'],
            notes: 'Block file download flags (use web_fetch tool instead)',
        }],
        ['wget', {
            blockedFlags: [],
            requiresApproval: ['*'],  // All wget requires approval
            notes: 'All wget requires approval',
        }],
    ]);

    /**
     * Parse a command string into structured parts using shell-quote.
     * Detect and reject shell metachars that could enable injection.
     */
    analyzeCommand(rawCommand: string): ArgumentAnalysisResult {
        // Step 1: Check for shell metachars (pipes, redirects, subshells)
        if (this.containsShellMetachars(rawCommand)) {
            return { allowed: false, reason: 'Command contains shell metacharacters (|, ;, &&, ||, $(), ``)' };
        }

        // Step 2: Parse with shell-quote for structured argument splitting
        const parsed = shellQuote.parse(rawCommand);

        // Step 3: Extract command name and arguments
        const command = parsed[0] as string;
        const args = parsed.slice(1);

        // Step 4: Apply per-command rules
        const rule = this.commandRules.get(command);
        if (rule) {
            return this.applyRule(command, args, rule);
        }

        return { allowed: true };
    }

    /**
     * Check for dangerous shell metacharacters.
     */
    private containsShellMetachars(command: string): boolean {
        // Detect: |, ;, &&, ||, $(...), `...`, >, >>, <
        // These enable command chaining, subshell execution, and I/O redirection
        return /[|;&`]|\$\(|>>?|</.test(command);
    }
}
```

### 2. ToolChainMonitor (`src/vs/workbench/contrib/qic/common/security/toolChainMonitor.ts`)

Detect dangerous tool call sequences:

```typescript
export class ToolChainMonitor {
    private readonly recentCalls = new Map<string, ToolCall[]>();

    /**
     * Record a tool call for sequence analysis.
     */
    recordToolCall(toolCall: ToolCall, context: ToolContext): void;

    /**
     * Analyze the current call chain for suspicious sequences.
     */
    analyzeCurrentChain(sessionId: string): ChainAnalysis;

    /**
     * Check if a proposed tool call would create a dangerous sequence.
     */
    wouldCreateDangerousSequence(
        proposedCall: ToolCall,
        sessionId: string
    ): { dangerous: boolean; reason?: string };
}

// Dangerous sequences to detect:
// 1. read_file → run_terminal (exfiltrating file contents)
// 2. search_code → write_file → run_terminal (injecting then executing)
// 3. Rapid write_file to many system paths
// 4. web_fetch → write_file → run_terminal (download and execute)
// 5. delete_file on > 10 files in sequence
```

**AUDIT FIX VII-DS13**: Add `DataFlowAnalysis` interface to ToolChainMonitor. Track what data each tool accessed and flag if sensitive data access is followed by network or terminal egress.

```typescript
// Add to ToolChainMonitor:

interface DataFlowEntry {
    toolName: string;
    toolCallId: string;
    timestamp: number;
    dataAccessed: DataAccessDescriptor[];
    dataEgressed: DataEgressDescriptor[];
}

interface DataAccessDescriptor {
    type: 'file' | 'env' | 'secret' | 'network-response';
    path?: string;             // file path or env var name
    sensitivityLevel: 'public' | 'internal' | 'sensitive' | 'secret';
}

interface DataEgressDescriptor {
    type: 'terminal' | 'network' | 'file-write';
    destination: string;       // URL, command, or file path
}

export class DataFlowAnalysis {
    private readonly flowLog: DataFlowEntry[] = [];

    /**
     * Record data access by a tool.
     */
    recordAccess(toolName: string, toolCallId: string, access: DataAccessDescriptor): void;

    /**
     * Record data egress by a tool.
     */
    recordEgress(toolName: string, toolCallId: string, egress: DataEgressDescriptor): void;

    /**
     * Check if the current session has a sensitive-data-then-egress pattern.
     * Returns a warning if sensitive data was accessed and then followed by
     * a network or terminal egress within the same session.
     */
    checkForSensitiveEgress(sessionId: string): {
        flagged: boolean;
        reason?: string;
        accessEntry?: DataFlowEntry;
        egressEntry?: DataFlowEntry;
    };
}

// Integration: ToolChainMonitor calls DataFlowAnalysis.checkForSensitiveEgress()
// before allowing any tool with egress capability (run_terminal, web_fetch, web_search).
```

### 3. SecurityAuditLogger (`src/vs/workbench/contrib/qic/common/security/auditLogger.ts`)

Hash-chained audit log for tamper detection.

**AUDIT FIX III-QI6**: QIC's SecurityAuditLogger should share the SHA-256 hash-chain algorithm with the existing Quantlab engine audit ledger. Define clear audit boundaries:

| Audit Domain | Scope | Owner |
|-------------|-------|-------|
| **Engine audit** | Trading decisions, order routing, risk checks | Existing Quantlab engine |
| **Extension audit** | Strategy analysis, backtest results, research | Quantlab extension layer |
| **QIC audit** | Tool executions, permissions, code modifications | QIC SecurityAuditLogger |

Cross-audit reference IDs: When a QIC tool execution triggers an action that would also appear in the engine or extension audit (e.g., modifying a strategy file that invalidates a trust hash), include a `crossAuditRef` field in the QIC audit entry that links to the corresponding engine/extension audit entry ID.

**AUDIT FIX XI-SV1 (CRITICAL)**: SecurityAuditLogger MUST redact secrets before writing any entry. Use the `OptimizedSecretScanner` from Prompt 06 to scan and redact entry details.

```typescript
export class SecurityAuditLogger {
    private lastHash: string = '0'.repeat(64);  // Genesis hash

    constructor(
        private readonly logPath: string,
        private readonly secretScanner: OptimizedSecretScanner  // AUDIT FIX XI-SV1
    ) {}

    /**
     * Log an authorization grant.
     */
    logAuthzGranted(tool: string, context: ToolContext): void;

    /**
     * Log an authorization denial.
     */
    logAuthzDenied(tool: string, reason: string): void;

    /**
     * Log a tool execution with result.
     */
    logToolExecution(tool: string, status: string, context: ToolContext, meta?: any): void;

    /**
     * Log a security violation.
     */
    logViolation(type: string, details: any): void;

    /**
     * Log an egress request (data leaving the system).
     */
    logEgressRequest(boundary: string, meta: any): void;

    /**
     * Verify the integrity of the entire audit chain.
     * Returns false if any entry has been tampered with.
     */
    async verifyChainIntegrity(): Promise<boolean>;

    private appendEntry(entry: AuditEntry): void {
        // AUDIT FIX XI-SV1 (CRITICAL): Redact secrets BEFORE writing
        const redacted = this.secretScanner.redact(JSON.stringify(entry.details)).redactedText;
        entry.details = JSON.parse(redacted);

        // AUDIT FIX III-QI6: Use SHA-256 hash-chain (shared algorithm with engine audit)
        const serialized = JSON.stringify(entry);
        const hash = crypto.createHash('sha256')
            .update(this.lastHash + serialized)
            .digest('hex');
        this.lastHash = hash;

        // AUDIT FIX III-QI6: Include crossAuditRef if applicable
        const logEntry = { ...entry, hash, crossAuditRef: entry.crossAuditRef ?? null };
        // Write entry + hash to append-only log file
    }
}
```

### 4. Replace ALL Stubs

Replace the stub implementations from Prompt 10:

- `src/vs/workbench/contrib/qic/common/runtime/uiServiceStub.ts` — Should no longer be imported (Prompt 12/13 replaced it)
- The stub `TerminalSecurityGuard` — Replaced by real implementation
- The stub `ToolChainMonitor` — Replaced by real implementation
- The stub `SecurityAuditLogger` — Replaced by real implementation

### 5. CI Enforcement

Add a test that verifies no stubs remain:

```typescript
// test/noStubs.test.ts
test('no [STUB] warnings remain in production code', () => {
    const sourceFiles = glob.sync('src/**/*.ts', { ignore: ['**/test/**'] });
    for (const file of sourceFiles) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toContain('[STUB]');
    }
});
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/security/terminalGuard.ts` | 4-layer validation |
| `src/vs/workbench/contrib/qic/common/security/toolChainMonitor.ts` | Sequence detection |
| `src/vs/workbench/contrib/qic/common/security/auditLogger.ts` | Hash-chained log |
| `src/vs/workbench/contrib/qic/common/security/argumentAnalyzer.ts` | Structured command argument validation (REMEDIATION FIX 3c) |
| `src/vs/workbench/contrib/qic/test/common/security/terminalGuard.test.ts` | Guard tests |
| `src/vs/workbench/contrib/qic/test/noStubs.test.ts` | Stub verification |

---

## Acceptance Criteria

```
□ TerminalSecurityGuard blocks dangerous commands (rm -rf /, fork bomb, etc.)
□ TerminalSecurityGuard allows safe commands (git, npm, ls, etc.)
□ TerminalSecurityGuard Layer 3 uses structured ArgumentAnalyzer with shell-quote (audit fix VII-DS12, XI-SV3)
□ ArgumentAnalyzer blocks python -c, git -c, npx (requires approval), npm exec (audit fix XI-SV3)
□ ArgumentAnalyzer detects shell metacharacters via containsShellMetachars() (audit fix VII-DS12)
□ ToolChainMonitor detects read→exfiltrate sequences
□ ToolChainMonitor prevents download→execute sequences
□ ToolChainMonitor includes DataFlowAnalysis tracking sensitive data access → egress (audit fix VII-DS13)
□ SecurityAuditLogger produces hash-chained entries (SHA-256, shared with engine audit)
□ SecurityAuditLogger redacts secrets before writing (audit fix XI-SV1)
□ SecurityAuditLogger includes cross-audit reference IDs (audit fix III-QI6)
□ SecurityAuditLogger.verifyChainIntegrity() detects tampered entries
□ ALL security stubs (TerminalSecurityGuard, ToolChainMonitor, SecurityAuditLogger) are real implementations (REMEDIATION FIX 3c)
□ NOTE: Full [STUB] elimination across ALL components is verified in Prompt 19 integration testing. UI stubs from Prompt 10 may still exist if Prompt 14 executes before Prompt 12/13.
□ No-stubs CI test passes
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| X-PS6 | note | Dependency correction: actual prerequisites are Prompt 04 and Prompt 06 only; can be executed before Prompt 10 to eliminate SecurityAuditLogger stub gap |
| III-QI6 | HIGH | SecurityAuditLogger shares SHA-256 hash-chain with engine audit ledger; defined audit domain boundaries (engine/extension/QIC); added cross-audit reference IDs |
| VII-DS12 | MEDIUM | Full Layer 3 specification: structured command parsing with shell-quote library, per-command argument rules, containsShellMetachars() check |
| VII-DS13 | MEDIUM | Added DataFlowAnalysis interface to ToolChainMonitor: tracks data accessed by each tool, flags sensitive data access followed by network/terminal egress |
| XI-SV1 | CRITICAL | SecurityAuditLogger redacts secrets before writing using secretScanner.redact() |
| XI-SV3 | CRITICAL | Replaced simple prefix allowlist with structured ArgumentAnalyzer; parses commands with shell-quote; validates per-command (blocks python -c, git -c, npx requires approval, npm exec blocked) |
