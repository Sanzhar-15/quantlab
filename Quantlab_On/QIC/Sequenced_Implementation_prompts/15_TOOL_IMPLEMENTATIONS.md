# Prompt 15 — Tool Implementations: All 22 Tools

**Phase**: 8-9 (Cross-phase)
**Prerequisites**: Prompt 10 (tool router), Prompt 14 (security), Prompt 06 (egress/secrets)
**Estimated Scope**: ~10 files created, ~1500 lines

---

## Objective

Implement all 22 tools from the tool registry. Each tool is a function that executes a specific operation and returns a `ToolResultPayload` (`{content: string, isError: boolean}`). The ToolRouter wraps the payload with `toolCallId` to produce a full `ToolResult` — tools never need to know their call ID.

---

## Spec References

- QIC Spec v6.2: Appendix A Tool Registry (lines 8177–8233) — All 22 tool definitions
- QIC Spec v6.2: §13.1 LSP Tool Definitions (lines 7974–8016)

## Audit Fixes Incorporated

- **I-SG1 (HIGH)**: Add web_search tool specification with provider, result format, egress, and caching.
- **I-SG6 (MEDIUM)**: Change inspect_notebook and preview_dataframe to hasSideEffects: false, permission not required.
- **III-QI4 (HIGH)**: Add trust hash invalidation hook to write_file.
- **XI-SV2 (CRITICAL)**: Add symlink resolution to ALL file operation tools.
- **XI-SV6 (HIGH)**: Add URL validation to web_fetch for SSRF prevention.
- **XI-SV7 (partial)**: Add note about blocking/redacting .vscode/settings.json in read_file.

---

## Implementation Instructions

Create tool implementations in `src/vs/workbench/contrib/qic/common/tools/`:

### File Operations (6 tools)

**`tools/fileOps.ts`**:

```typescript
export class FileOperationTools {
    constructor(
        private readonly fileService: IFileService,
        private readonly fileContentLoader: FileContentLoader,
        private readonly secretScanner: OptimizedSecretScanner
    ) {}

    // 1. read_file — Read file content, respecting FileContent tiers
    async readFile(args: { path: string; startLine?: number; endLine?: number }): Promise<ToolResultPayload>;

    // 2. write_file — Write content to file (requires permission)
    async writeFile(args: { path: string; content: string }): Promise<ToolResultPayload>;

    // 3. delete_file — Delete a file (requires permission)
    async deleteFile(args: { path: string }): Promise<ToolResultPayload>;

    // 4. move_file — Move/rename a file (requires permission)
    async moveFile(args: { source: string; destination: string }): Promise<ToolResultPayload>;

    // 5. create_directory — Create a directory (requires session permission)
    async createDirectory(args: { path: string }): Promise<ToolResultPayload>;

    // 6. list_directory — List directory contents
    async listDirectory(args: { path: string; recursive?: boolean }): Promise<ToolResultPayload>;
}
```

**Security**: All file paths must be validated:
- Must be within workspace (no path traversal via `../`)
- Use `path.resolve()` and check against workspace root
- Redact secrets from file content before returning to LLM

**AUDIT FIX XI-SV2 (CRITICAL)**: Add symlink resolution to ALL file operation tools. A resolved path may pass the workspace check but the real path (after symlink resolution) could point outside the workspace. Both checks are required.

```typescript
// Add to FileOperationTools — used by ALL 6 file tools:
async validatePath(requestedPath: string): Promise<string> {
    const resolved = path.resolve(this.workspaceRoot, requestedPath);
    // Check 1: resolved path must be within workspace
    if (!resolved.startsWith(this.workspaceRoot)) {
        throw new QicError('QIC-P001', 'Path outside workspace');
    }
    // Check 2: real path (after symlink resolution) must ALSO be within workspace
    const realPath = await fs.realpath(resolved);
    if (!realPath.startsWith(this.workspaceRoot)) {
        throw new QicError('QIC-P002', 'Symlink target outside workspace');
    }
    return realPath;
}
```

Every file operation tool (read_file, write_file, delete_file, move_file, create_directory, list_directory) MUST call `validatePath()` before performing any I/O.

**AUDIT FIX III-QI4**: Trust hash invalidation hook for write_file:

```typescript
// In writeFile implementation, after successful write:
async writeFile(args: { path: string; content: string }): Promise<ToolResultPayload> {
    const validatedPath = await this.validatePath(args.path);
    // ... perform the write ...

    // AUDIT FIX III-QI4: If file is part of a validated strategy, invalidate trust hash
    const trustService = this.accessor.get(ITrustValidationService);
    if (trustService.isTrackedFile(validatedPath)) {
        trustService.invalidateHash(validatedPath);
        this.auditLogger.logToolExecution('write_file', 'trust-invalidated', context, {
            message: 'File is part of a validated strategy — trust hash invalidated. Re-validation required.',
            path: validatedPath,
        });
    }

    return { content: `Wrote ${args.content.length} bytes to ${args.path}`, isError: false };
}
```

**AUDIT FIX XI-SV7 (partial)**: The `read_file` tool should block or redact `.vscode/settings.json` to prevent API key leakage. Settings files commonly contain API keys, tokens, and other secrets that should never be exposed to the LLM.

```typescript
// In readFile implementation, before returning content:
const BLOCKED_PATHS = ['.vscode/settings.json', '.env', '.env.local'];
const relativePath = path.relative(this.workspaceRoot, validatedPath);
if (BLOCKED_PATHS.some(bp => relativePath === bp || relativePath.endsWith(bp))) {
    return { content: 'File blocked for security: may contain API keys (QIC-P003)', isError: true };
}
```

### Search Tools (2 tools)

**`tools/searchTools.ts`**:

```typescript
export class SearchTools {
    constructor(
        private readonly indexer: IncrementalIndexer
    ) {}

    // 7. search_code — Search code content using hybrid BM25+vector
    async searchCode(args: { query: string; filePattern?: string; maxResults?: number }): Promise<ToolResultPayload>;

    // 8. search_files — Search for files by name pattern
    async searchFiles(args: { pattern: string; directory?: string }): Promise<ToolResultPayload>;
}
```

### Reference Tools (2 tools)

**`tools/referenceTools.ts`**:

```typescript
export class ReferenceTools {
    // 9. get_references — Find all references to a symbol
    async getReferences(args: { path: string; position: Position }): Promise<ToolResultPayload>;

    // 10. get_definition — Go to definition of a symbol
    async getDefinition(args: { path: string; position: Position }): Promise<ToolResultPayload>;
}
```

Use VS Code's language service: `vscode.commands.executeCommand('vscode.executeReferenceProvider')` and `vscode.executeDefinitionProvider`.

### Terminal Tools (2 tools)

**`tools/terminalTools.ts`**:

```typescript
export class TerminalTools {
    constructor(
        private readonly terminalGuard: TerminalSecurityGuard
    ) {}

    // 11. run_terminal — Run command in terminal (interactive, shows output)
    async runTerminal(args: { command: string; cwd?: string }): Promise<ToolResultPayload>;

    // 12. run_command — Run command silently, capture output
    async runCommand(args: { command: string; cwd?: string; timeout?: number }): Promise<ToolResultPayload>;
}
```

Both tools MUST go through `TerminalSecurityGuard.validateCommand()` before execution.

### Network Tools (2 tools)

**`tools/networkTools.ts`**:

```typescript
export class NetworkTools {
    constructor(
        private readonly egressEnforcer: EgressBoundaryEnforcer,
        private readonly secretScanner: OptimizedSecretScanner  // AUDIT FIX I-SG1
    ) {}

    // 13. web_fetch — Fetch content from a URL
    // AUDIT FIX XI-SV6: Validate URL before fetching
    async webFetch(args: { url: string; method?: string; headers?: Record<string, string> }): Promise<ToolResultPayload> {
        // AUDIT FIX XI-SV6: SSRF prevention — block private/internal addresses
        this.validateUrlForSSRF(args.url);
        // ... proceed with fetch
    }

    // 14. web_search — Search the web
    // AUDIT FIX I-SG1: Full implementation specification
    async webSearch(args: { query: string; maxResults?: number }): Promise<ToolResultPayload>;
}
```

**AUDIT FIX I-SG1**: Full `web_search` tool specification:

```typescript
// web_search implementation details:
//
// Provider: Tavily / Brave Search / Google Custom Search (configurable)
//   - Provider selected via 'qic.webSearch.provider' setting
//   - API key stored in SecretStorage (NOT in settings.json)
//
// Result format:
interface WebSearchResult {
    url: string;
    title: string;
    snippet: string;
    relevance_score: number;
}
// Returns: WebSearchResult[] (max 10 results by default)
//
// Egress boundary: 'egress-web-search' (requires per-session consent)
//   - Uses EgressBoundaryEnforcer.checkEgress('egress-web-search')
//   - Consent is per-session, not per-request
//
// Secret redaction: Redact any secrets from search queries before sending
//   - const redactedQuery = this.secretScanner.redact(args.query).redactedText;
//   - If redaction changes the query, log a warning
//
// Caching: Cache search results for 5 minutes
//   - Key: SHA-256(provider + query + maxResults)
//   - TTL: 300 seconds
//
// Rate limiting: Separate from LLM rate limits
//   - Default: 10 requests per minute
//
// Fallback: Return empty results with warning when no provider configured
//   - { content: JSON.stringify({ results: [], warning: 'No web search provider configured' }), isError: false }
```

**AUDIT FIX XI-SV6**: URL validation for `web_fetch` — SSRF prevention:

```typescript
// Add to NetworkTools:
private validateUrlForSSRF(url: string): void {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Resolve hostname to IP and check against blocked ranges
    // Block RFC 1918 private addresses:
    //   10.0.0.0/8        (10.x.x.x)
    //   172.16.0.0/12     (172.16.x.x - 172.31.x.x)
    //   192.168.0.0/16    (192.168.x.x)
    // Block loopback:
    //   127.0.0.0/8       (127.x.x.x)
    // Block link-local:
    //   169.254.0.0/16    (169.254.x.x)
    // Block IPv6 equivalents:
    //   ::1, fe80::/10, fc00::/7

    const BLOCKED_PATTERNS = [
        /^10\./,                                        // 10.0.0.0/8
        /^172\.(1[6-9]|2[0-9]|3[01])\./,              // 172.16.0.0/12
        /^192\.168\./,                                  // 192.168.0.0/16
        /^127\./,                                       // 127.0.0.0/8 (loopback)
        /^169\.254\./,                                  // 169.254.0.0/16 (link-local)
        /^0\./,                                         // 0.0.0.0/8
        /^::1$/,                                        // IPv6 loopback
        /^fe80:/i,                                      // IPv6 link-local
        /^fc00:/i,                                      // IPv6 unique local
        /^fd/i,                                         // IPv6 unique local
    ];

    // Also block: localhost, metadata endpoints (169.254.169.254)
    if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
        throw new QicError('QIC-N001', `SSRF blocked: ${hostname} is not allowed`);
    }

    // DNS resolution check: resolve hostname and verify IP is not in blocked ranges
    // This prevents DNS rebinding attacks where a public hostname resolves to a private IP
    const resolved = await dns.resolve4(hostname);
    for (const ip of resolved) {
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(ip)) {
                throw new QicError('QIC-N002', `SSRF blocked: ${hostname} resolves to private IP ${ip}`);
            }
        }
    }
}
```

### Package Tool (1 tool)

**`tools/packageTools.ts`**:

```typescript
// 15. install_package — Install a package via npm/pip
async installPackage(args: { package: string; manager?: 'npm' | 'pip' }): Promise<ToolResultPayload>;
```

### LSP Tools (3 tools)

**`tools/lspTools.ts`**:

```typescript
export class LSPTools {
    // 16. rename_symbol — Rename a symbol across the codebase
    async renameSymbol(args: { path: string; position: Position; newName: string }): Promise<ToolResultPayload>;

    // 17. apply_code_action — Apply a code action (quick fix, refactoring)
    async applyCodeAction(args: { path: string; range: Range; actionKind: string }): Promise<ToolResultPayload>;

    // 18. organize_imports — Organize imports in a file
    async organizeImports(args: { path: string }): Promise<ToolResultPayload>;
}
```

### Notebook/DataFrame Tools (3 tools)

**`tools/notebookTools.ts`** (stubs for now — real impl in Prompt 16):

**AUDIT FIX I-SG6**: `inspect_notebook` and `preview_dataframe` are read-only operations and MUST be marked as `hasSideEffects: false` with `permission: { required: false }`. They should be freely invocable by the LLM without requiring user approval each time.

```typescript
// 19. inspect_notebook — Inspect a Jupyter notebook
//     hasSideEffects: false, permission: { required: false }  // AUDIT FIX I-SG6
// 20. preview_dataframe — Preview a DataFrame
//     hasSideEffects: false, permission: { required: false }  // AUDIT FIX I-SG6
// 21. analyze_backtest — Analyze backtest results
//     hasSideEffects: true (writes analysis results — keep permission requirement)
```

### Checkpoint Tool (1 tool)

**`tools/checkpointTools.ts`**:

```typescript
// 22. create_checkpoint — Create a checkpoint of current file state
async createCheckpoint(args: { files?: string[]; message?: string }): Promise<ToolResultPayload>;
```

### Tool Registration

Register all tools with the ToolRouter:

```typescript
// src/vs/workbench/contrib/qic/common/tools/toolRegistry.ts
export function registerAllTools(
    toolRouter: ToolRouter,
    services: ServiceCollection
): void {
    const fileOps = new FileOperationTools(/* ... */);
    toolRouter.register('read_file', (args, ctx) => fileOps.readFile(args));
    toolRouter.register('write_file', (args, ctx) => fileOps.writeFile(args));
    // ... register all 22 tools
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/tools/fileOps.ts` | File tools (6) |
| `src/vs/workbench/contrib/qic/common/tools/searchTools.ts` | Search tools (2) |
| `src/vs/workbench/contrib/qic/common/tools/referenceTools.ts` | Reference tools (2) |
| `src/vs/workbench/contrib/qic/common/tools/terminalTools.ts` | Terminal tools (2) |
| `src/vs/workbench/contrib/qic/common/tools/networkTools.ts` | Network tools (2) |
| `src/vs/workbench/contrib/qic/common/tools/packageTools.ts` | Package tool (1) |
| `src/vs/workbench/contrib/qic/common/tools/lspTools.ts` | LSP tools (3) |
| `src/vs/workbench/contrib/qic/common/tools/notebookTools.ts` | Notebook stubs (3) |
| `src/vs/workbench/contrib/qic/common/tools/checkpointTools.ts` | Checkpoint tool (1) |
| `src/vs/workbench/contrib/qic/common/tools/toolRegistration.ts` | Registration |

---

## Acceptance Criteria

```
□ All 22 tools registered with ToolRouter
□ File tools validate paths with symlink resolution (audit fix XI-SV2)
□ File tools call validatePath() which checks both resolved AND real path against workspace root
□ File tools redact secrets from content before returning
□ read_file blocks .vscode/settings.json and .env files (audit fix XI-SV7)
□ write_file invalidates trust hash for tracked strategy files (audit fix III-QI4)
□ Terminal tools validate commands through TerminalSecurityGuard
□ Network tools check egress consent before fetching
□ web_fetch validates URLs for SSRF — blocks private IPs, loopback, link-local (audit fix XI-SV6)
□ web_search fully implemented with provider, result format, caching, secret redaction (audit fix I-SG1)
□ LSP tools use VS Code's language service commands
□ inspect_notebook: hasSideEffects: false, permission not required (audit fix I-SG6)
□ preview_dataframe: hasSideEffects: false, permission not required (audit fix I-SG6)
□ create_checkpoint uses TransactionSafeCheckpointManager
□ Each tool returns ToolResultPayload ({content, isError}) — ToolRouter wraps with toolCallId
□ TypeScript compiles with no errors
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| I-SG1 | HIGH | Added full web_search tool specification: provider (Tavily/Brave/Google), result format, egress boundary (egress-web-search, per-session consent), secret redaction on queries, 5-minute cache, rate limiting |
| I-SG6 | MEDIUM | Changed inspect_notebook and preview_dataframe to hasSideEffects: false, permission: { required: false } — these are read-only operations |
| III-QI4 | HIGH | Added trust hash invalidation hook to write_file: after write completes, if file is part of a validated strategy, invalidate trust hash and log warning |
| XI-SV2 | CRITICAL | Added symlink resolution to ALL file operation tools via validatePath(): checks both path.resolve() AND fs.realpath() against workspace root; throws QIC-P001/QIC-P002 on violation |
| XI-SV6 | HIGH | Added URL validation to web_fetch for SSRF prevention: blocks RFC 1918 private addresses (10.x, 172.16-31.x, 192.168.x), loopback (127.x), link-local (169.254.x), and DNS rebinding attacks |
| XI-SV7 | partial | Added note: read_file blocks or redacts .vscode/settings.json and .env files to prevent API key leakage |
