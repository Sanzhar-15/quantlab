# Prompt 06 — Security Foundation: Egress Controls, Consent & Secret Scanning

**Phase**: 2 (Security Foundation)
**Prerequisites**: Prompts 04–05 (Phase 1 types and state machines)
**Estimated Scope**: ~8 files created, ~1200 lines

---

## Objective

Implement the security foundation: egress boundary enforcer (replacing the Phase 0 stub), first-run consent flow, Aho-Corasick optimized secret scanner with 60+ patterns, and conversation encryption. This establishes invariant INV-T3 (Secret Protection): no data leaves the system without consent and secret redaction.

---

## Spec References

- QIC Spec v6.2: §2.3 Data Flow Guarantees (lines 1536–1647) — Egress boundaries
- QIC Spec v6.2: §2.4 First-Run Consent (lines 1647–1806) — Consent flow
- QIC Spec v6.2: §10.1 Secret Patterns (lines 6236–6945) — All 60+ patterns + Aho-Corasick
- QIC Spec v6.2: §5.3 Encrypted Conversation (lines 3592–3716) — ConversationCipher

## Audit Fixes Incorporated

- **I-3 (CRITICAL)**: Replace the block-all-by-default stub with real EgressBoundaryEnforcer
- **S-6 (HIGH)**: Use `node:crypto` consistently (NOT Web Crypto API `crypto.subtle`)

---

## Implementation Instructions

### 1. EgressBoundaryEnforcer (`src/vs/workbench/contrib/qic/common/security/egressEnforcer.ts`)

Replace the Phase 0 stub. This is the gatekeeper for ALL data leaving the system:

```typescript
export type EgressBoundary = 'llm' | 'embedding' | 'telemetry' | 'network';

export class EgressBoundaryEnforcer {
    constructor(
        private readonly consentStore: ConsentStore,
        private readonly secretScanner: SecretScanner
    ) {}

    /**
     * Check if data can be sent through a specific egress boundary.
     * 1. Check consent for the boundary type
     * 2. Scan and redact secrets
     * 3. Return sanitized data or block
     */
    async checkAndSanitize(
        boundary: EgressBoundary,
        data: string,
        context: { sessionId: string; purpose: string }
    ): Promise<{ allowed: boolean; sanitizedData?: string; reason?: string }>;
}
```

### 2. ConsentStore (`src/vs/workbench/contrib/qic/common/security/consentStore.ts`)

Persistent storage for user consent decisions.

**AUDIT FIX III-QI5**: QIC's ConsentStore should EXTEND the existing consent system at `extensions/quantlab/src/ai/consent.ts`. Add QIC-specific categories (`consent:llm:chat`, `consent:llm:completion`, `consent:embedding`, `consent:web`, `consent:telemetry`) alongside existing Quantlab categories (`strategy_code`, `error_messages`, `data_samples`, `performance_metrics`). Create an adapter layer that bridges the extension-side consent (`extensions/quantlab/src/ai/consent.ts`) with the workbench-side ConsentStore (`src/vs/workbench/contrib/qic/`), using a shared `IConsentService` interface.

> **REMEDIATION FIX 5c**: Note that the existing Quantlab class is named `ConsentManager` (not `ConsentStore`). QIC's `ConsentStore` is a workbench-level reimplementation using `IStorageService`/`IDialogService` since the extension-level `ConsentManager` uses `vscode.*` API which is not available in the workbench layer. The adapter bridges these two implementations.

**AUDIT FIX XI-SV4**: ConsentStore must emit an `onDidRevokeConsent` event. All components listening to consent changes must cancel queued/cached requests immediately on revocation. The Gateway's RequestManager must cancel queued requests for the revoked category, and the CompletionEngine must NOT cache consent status -- it must re-check on every request:

```typescript
import { Emitter, Event } from 'vs/base/common/event';

export interface ConsentRecord {
    boundary: EgressBoundary;
    granted: boolean;
    grantedAt: string;
    scope: 'session' | 'workspace' | 'global';
    version: string;          // Consent version (re-prompt on version change)
}

export class ConsentStore {
    private readonly _onDidRevokeConsent = new Emitter<EgressBoundary>();
    readonly onDidRevokeConsent: Event<EgressBoundary> = this._onDidRevokeConsent.event;

    constructor(private readonly storageService: IStorageService) {}

    async hasConsent(boundary: EgressBoundary): Promise<boolean>;
    async grantConsent(boundary: EgressBoundary, scope: 'session' | 'workspace' | 'global'): Promise<void>;

    /**
     * Revoke consent for a boundary. Fires onDidRevokeConsent event.
     * All components listening to this event must cancel queued/cached
     * requests immediately on revocation.
     */
    async revokeConsent(boundary: EgressBoundary): Promise<void> {
        await this.storageService.remove(this.consentKey(boundary));
        this._onDidRevokeConsent.fire(boundary);  // Notify all listeners
    }

    async getAllConsents(): Promise<ConsentRecord[]>;
    async isFirstRun(): Promise<boolean>;
    async markFirstRunComplete(): Promise<void>;
}
```

### 3. FirstRunManager (`src/vs/workbench/contrib/qic/common/security/firstRunManager.ts`)

Manages the first-run consent flow:

```typescript
export class FirstRunManager {
    constructor(
        private readonly consentStore: ConsentStore,
        private readonly uiService: UIService  // Will use stub until Phase 7
    ) {}

    /**
     * Check if first run, and if so, show consent flow.
     * Must be called during activation before any AI features activate.
     */
    async checkAndPrompt(): Promise<FirstRunResult>;
}

export interface FirstRunResult {
    isFirstRun: boolean;
    consentsGranted: EgressBoundary[];
    consentsDeclined: EgressBoundary[];
    canProceed: boolean;   // true if minimum consent granted
}
```

### 4. OptimizedSecretScanner (`src/vs/workbench/contrib/qic/common/security/secretScanner.ts`)

Implement the Aho-Corasick based secret scanner with all 60+ patterns from spec §10.1:

```typescript
export class OptimizedSecretScanner {
    private automaton: AhoCorasickAutomaton;

    constructor() {
        this.automaton = this.buildAutomaton();
    }

    /**
     * Scan text for secrets and return redacted version.
     */
    scan(text: string): ScanResult;

    /**
     * Create a streaming scanner for processing large files.
     */
    createStreamingScanner(): StreamingSecretScanner;

    private buildAutomaton(): AhoCorasickAutomaton;
}

export interface ScanResult {
    hasSecrets: boolean;
    redactedText: string;
    findings: SecretFinding[];
}

export interface SecretFinding {
    pattern: string;
    startIndex: number;
    endIndex: number;
    severity: 'high' | 'medium' | 'low';
}
```

#### Aho-Corasick Implementation

**AUDIT FIX IV-AO6**: Specify implementation strategy for Aho-Corasick. Primary: Use the `ahocorasick` npm package (pure JavaScript). This avoids native addon compatibility issues while still being significantly faster than sequential regex matching. Add `ahocorasick` to `package.json` dependencies.

Fallback: If the package is unavailable, implement a prefix-based pre-filter:
1. Build a `Map<string, RegExp[]>` of prefix to pattern list
2. Scan text for known prefixes using `indexOf()`
3. Only run full regex for patterns with matching prefixes

Performance target: O(n) in text length for prefix scan phase. Known prefixes: `AKIA`, `AIza`, `sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `xoxb-`, `SG.`, `sk_live_`, `hf_`, `glpat-`, `npm_`, `pypi-`, `postgres://`, `mongodb://`, `redis://`, `Bearer`, `Basic`, `-----BEGIN`.

If using the pure-JS automaton fallback, implement as follows:

```typescript
class AhoCorasickAutomaton {
    private goto: Map<number, Map<string, number>> = new Map();
    private fail: Map<number, number> = new Map();
    private output: Map<number, string[]> = new Map();
    private stateCount = 0;

    addPattern(pattern: string, label: string): void;
    build(): void;  // Build failure links
    search(text: string): Array<{ position: number; pattern: string }>;
}
```

#### Secret Patterns (all 60+ from spec §10.1)

**AUDIT FIX III-QI5**: QIC's OptimizedSecretScanner should import and merge existing sanitization patterns from `extensions/quantlab/src/ai/sanitize.ts`. Create a shared pattern registry that both systems contribute to. Add Quantlab-specific secret patterns to the scanner:
- Alpaca API key/secret patterns (the existing broker integration)
- Broker credentials (strategy-specific tokens or credentials)
- Data provider API keys (market data services)

Include at minimum these categories:
- **API Keys**: AWS, GCP, Azure, Anthropic, OpenAI, GitHub, GitLab, Stripe, Twilio, SendGrid, etc.
- **Private Keys**: RSA, ECDSA, Ed25519, PGP
- **Tokens**: JWT, OAuth, Bearer tokens
- **Connection Strings**: PostgreSQL, MySQL, MongoDB, Redis, AMQP
- **Cloud Credentials**: AWS access key/secret, GCP service account, Azure SAS tokens
- **Crypto**: Private keys, mnemonics, seed phrases
- **Platform-specific**: Slack, Discord, Telegram bot tokens, npm tokens
- **Quantlab-specific**: Alpaca API keys, broker credentials, data provider API keys

Each pattern has:
- A prefix for Aho-Corasick fast pre-filtering (e.g., `AKIA` for AWS keys)
- A full regex for validation after prefix match
- A test string that should match
- A severity level

**AUDIT FIX VII-DS11**: Some patterns require a `contextRequired` field for false positive reduction. Add this field to the `SecretPatternDefinition` interface:

```typescript
export interface SecretPatternDefinition {
    name: string;
    prefix: string;               // For Aho-Corasick pre-filtering
    pattern: RegExp;              // Full validation regex
    testString: string;           // Known-match test string
    severity: 'high' | 'medium' | 'low';
    contextRequired?: RegExp;     // Optional: nearby text must match this regex to confirm
}
```

Examples of patterns with `contextRequired`:

```typescript
{ name: 'ssn-us', prefix: '', pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  contextRequired: /ssn|social\s*security|tax\s*id/i,
  severity: 'medium', testString: '123-45-6789' },
{ name: 'cohere-api-key', prefix: '', pattern: /[a-zA-Z0-9]{40}/,
  contextRequired: /cohere/i,
  severity: 'low', testString: '<40-char-alphanumeric-string>' },
```

Without `contextRequired`, the SSN pattern flags every 9-digit number (phone numbers, zip+4 codes, etc.), creating massive false positive noise. When `contextRequired` is set, only flag the pattern if the surrounding context (within 200 chars) matches the context regex.

### 5. ConversationCipher (`src/vs/workbench/contrib/qic/common/security/conversationCipher.ts`)

Encrypt conversation history at rest. **AUDIT FIX S-6**: Use `node:crypto` ONLY (not Web Crypto API).

**AUDIT FIX I-SG10**: Explicitly use `node:crypto` for ALL crypto operations in the extension host. Reserve `crypto.subtle` ONLY for webview-side operations (if any). The VS Code extension host is Node.js -- `crypto.subtle` would fail or behave unexpectedly:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

export class ConversationCipher {
    private readonly algorithm = 'aes-256-gcm';

    /**
     * Derive encryption key from workspace-specific material.
     * Uses pbkdf2Sync from node:crypto (NOT Web Crypto API).
     */
    async deriveKey(workspacePath: string, salt?: Buffer): Promise<{ key: Buffer; salt: Buffer }> {
        const derivedSalt = salt ?? randomBytes(16);
        const key = pbkdf2Sync(workspacePath, derivedSalt, 100_000, 32, 'sha256');
        return { key, salt: derivedSalt };
    }

    /**
     * Encrypt conversation messages.
     * AES-256-GCM encryption using Node.js crypto (NOT Web Crypto API).
     */
    encrypt(plaintext: string, key: Buffer): EncryptedPayload {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return { iv, ciphertext: encrypted, authTag };
    }

    /**
     * Decrypt conversation messages.
     */
    decrypt(payload: EncryptedPayload, key: Buffer): string {
        const decipher = createDecipheriv('aes-256-gcm', key, payload.iv);
        decipher.setAuthTag(payload.authTag);
        const decrypted = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    }
}

export interface EncryptedPayload {
    iv: Buffer;          // 12 bytes for GCM
    ciphertext: Buffer;
    authTag: Buffer;     // 16 bytes for GCM
}
```

### 6. StreamingSecretScanner (`src/vs/workbench/contrib/qic/common/security/streamingScanner.ts`)

For processing large files without loading into memory:

```typescript
export class StreamingSecretScanner {
    private buffer = '';
    private readonly overlapSize: number;  // Handle patterns spanning chunk boundaries

    /**
     * Process a chunk of text, returning redacted output.
     * Maintains internal buffer for cross-chunk pattern matching.
     */
    processChunk(chunk: string): string;

    /**
     * Flush remaining buffer (call after last chunk).
     */
    flush(): string;
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/security/egressEnforcer.ts` | Egress boundary enforcement |
| `src/vs/workbench/contrib/qic/common/security/consentStore.ts` | Consent persistence |
| `src/vs/workbench/contrib/qic/common/security/firstRunManager.ts` | First-run flow |
| `src/vs/workbench/contrib/qic/common/security/secretScanner.ts` | Aho-Corasick scanner |
| `src/vs/workbench/contrib/qic/common/security/secretPatterns.ts` | 60+ patterns |
| `src/vs/workbench/contrib/qic/common/security/conversationCipher.ts` | Encryption |
| `src/vs/workbench/contrib/qic/common/security/streamingScanner.ts` | Streaming scanner |
| `src/vs/workbench/contrib/qic/test/common/security/secretScanner.test.ts` | Scanner tests |

## Files to Modify

| File | Change |
|------|--------|
| `src/vs/workbench/contrib/qic/common/egressBlocker.ts` | Replace stub with import of real enforcer |
| `src/vs/workbench/contrib/qic/common/state/conversationState.ts` | **AUDIT FIX VIII-PC8**: Wire ConversationCipher into `persist()` and `restore()`. Replace encryption stubs from Phase 0. Example: `persist()` should encrypt via `this.cipher.encrypt(plaintext)` and store to `conversations_encrypted` table; `restore()` should decrypt via `this.cipher.decrypt(payload)` |
| ~~`src/vs/workbench/contrib/qic/common/crashSafe/checkpointManager.ts`~~ | **DEFERRED TO PROMPT 07** (REMEDIATION FIX 3a): VII-DS17 (secret scanning at checkpoint export) is deferred to Prompt 07 where `checkpointManager.ts` is created. Prompt 06 creates the SecretScanner, but `checkpointManager.ts` does not exist yet until Prompt 07. |

---

## Acceptance Criteria

```
□ EgressBoundaryEnforcer replaces Phase 0 stub (no more [STUB] warning for egress)
□ FirstRunManager shows consent flow on first activation
□ ConsentStore persists and retrieves consent records
□ SecretScanner detects all 60+ patterns with Aho-Corasick
□ Every secret pattern has a test case that matches
□ StreamingSecretScanner handles 100MB+ files without OOM
□ ConversationCipher uses node:crypto exclusively (audit fix S-6)
□ Encrypt → Decrypt round-trip preserves data exactly
□ No data leaves system without consent check (INV-T3)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **I-SG10** | HIGH | Explicitly specified `node:crypto` for ALL crypto in extension host. Added `import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';`. Reserved `crypto.subtle` ONLY for webview-side operations. |
| **III-QI5** | HIGH | ConsentStore extends existing consent system at `extensions/quantlab/src/ai/consent.ts`. OptimizedSecretScanner imports and merges existing sanitization patterns from `extensions/quantlab/src/ai/sanitize.ts`. Added Quantlab-specific secret patterns (Alpaca API keys, broker credentials, data provider API keys). |
| **IV-AO6** | MEDIUM | Added Aho-Corasick implementation guidance: primary use `ahocorasick` npm package (pure JavaScript); fallback prefix-based pre-filter with `Map<string, RegExp[]>`; documented known prefixes; added `ahocorasick` to package.json. |
| **VII-DS11** | MEDIUM | Added `contextRequired` field to `SecretPatternDefinition` for false positive reduction. SSN requires `/ssn\|social\|security/i` nearby; Cohere API key requires `/cohere/i` nearby. |
| **VIII-PC8** | MEDIUM | Added "Files to Modify" entry: modify `conversationState.ts` to wire ConversationCipher into `persist()` and `restore()`. Replace encryption stubs from Phase 0. |
| **XI-SV4** | HIGH | Added consent revocation event system. ConsentStore emits `onDidRevokeConsent` event. All components listening to consent changes must cancel queued/cached requests immediately on revocation. |
| **VII-DS17** | MEDIUM | ~~Added secret scanning at checkpoint export.~~ **DEFERRED TO PROMPT 07** (REMEDIATION FIX 3a): `checkpointManager.ts` is created in Prompt 07, so the secret scanning integration must happen there. |
