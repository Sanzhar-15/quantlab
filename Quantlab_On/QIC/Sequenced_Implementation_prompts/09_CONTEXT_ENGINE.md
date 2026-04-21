# Prompt 09 — Context Engine: Embedding, Indexing, Reranking & Tool Selection

**Phase**: 5a (Context Engine)
**Prerequisites**: Prompt 06 (security), Prompt 05 (BM25 schema), Prompt 08 (gateway for embedding)
**Estimated Scope**: ~7 files created, ~1000 lines

---

## Objective

Implement the context engine: secure embedding service, incremental file indexer (BM25 + vector hybrid), RRF reranker, context assembler, and dynamic tool selector. This provides the RAG pipeline that gives the LLM relevant workspace context.

---

## Spec References

- QIC Spec v6.2: §8.1 Secure Embedding (lines 5165–5227)
- QIC Spec v6.2: §8.2 RAG Pipeline (lines 5227–5325) — Incremental indexer
- QIC Spec v6.2: §8.3 Reranking (lines 5325–5384) — RRF with weights
- QIC Spec v6.2: §8.4 Dynamic Tool Selection (lines 5384–5514) — Token-budgeted
- QIC Spec v6.2: §4.3 Token Budget (lines 3185–3228) — Context assembly

## Audit Fixes Incorporated

- **S-10 (MEDIUM)**: Fix RRF formula description to include weights: `Σ weight_i / (k + rank_i)`
- **C-5 (MEDIUM)**: Define context assembler profiles for all 8 lanes (not just 3)
- **I-SG3 (MEDIUM)**: Add explicit context assembly profiles for ALL 8 lanes with spec-aligned budgets
- **I-SG8 (LOW)**: Fix RRF formula description to include per-source weights with exact values
- **IV-AO4 (MEDIUM)**: Route embedding requests through the Gateway instead of a separate consent/redaction pipeline
- **VII-DS9 (MEDIUM)**: Add LanceDB initialization to IncrementalIndexer with `code_embeddings` and `doc_embeddings` tables
- **VII-DS14 (MEDIUM)**: Add EmbeddingProvider interface with `dimensions`, `maxTokens`, `embed()`, `embedBatch()` and local fallback
- **IX-CC5 (MEDIUM)**: Replace independent file watchers with IFileService.onDidFilesChange()
- **VIII-PC9 (MEDIUM)**: Add LanceDB fallback to BM25-only search if initialization fails

---

## Implementation Instructions

### 1. SecureEmbeddingService (`src/vs/workbench/contrib/qic/common/context/secureEmbedding.ts`)

Wraps embedding providers with consent checking and secret redaction.

**AUDIT FIX IV-AO4**: Route embedding requests through the Gateway instead of maintaining a separate consent/redaction pipeline. The Gateway already handles consent, redaction, rate limiting, and circuit breaking. Add an `'embedding'` request type to `ProviderRequest` and register embedding providers alongside LLM providers in the Gateway.

**AUDIT FIX VII-DS14**: Implement the `EmbeddingProvider` interface and local fallback.

```typescript
/**
 * AUDIT FIX VII-DS14: EmbeddingProvider interface per spec §3.5 (lines 2897–2927).
 */
export interface EmbeddingProvider {
    readonly dimensions: number;
    readonly maxTokens: number;
    embed(text: string, options?: EmbedOptions): Promise<Float32Array>;
    embedBatch(texts: string[], options?: EmbedOptions): Promise<Float32Array[]>;
}

export class SecureEmbeddingService {
    constructor(
        private readonly gateway: Gateway,
        private readonly config: EmbeddingConfig
    ) {}

    /**
     * Generate embeddings for text chunks.
     *
     * AUDIT FIX IV-AO4: All requests route through the Gateway:
     *   SecureEmbeddingService → Gateway.sendRequest({ type: 'embedding', ... })
     *   → Gateway handles: consent → redaction → rate limiting → circuit breaking
     *   → Embedding provider adapter
     *
     * Instead of:
     *   SecureEmbeddingService → consent check → redaction → EmbeddingProvider
     */
    async embed(texts: string[]): Promise<Float32Array[]> {
        return this.gateway.sendRequest({
            type: 'embedding',
            texts,
            provider: 'embedding',
            priority: 'low'
        });
    }

    /**
     * AUDIT FIX VII-DS14: Get the active embedding provider, with local fallback.
     * If remote provider is unavailable and localFallback.enabled is true,
     * use local provider instead.
     */
    private async getProvider(): Promise<EmbeddingProvider> {
        if (await this.remoteProvider?.isAvailable()) return this.remoteProvider;
        if (this.config.localFallback?.enabled) return this.localProvider;
        throw new QicError('QIC-C002', 'No embedding provider available');
    }

    /**
     * Check if embedding service is available and consented.
     */
    async isAvailable(): Promise<boolean>;
}
```

### 2. IncrementalIndexer (`src/vs/workbench/contrib/qic/common/context/incrementalIndexer.ts`)

Hybrid BM25 + vector index with incremental updates.

**AUDIT FIX IX-CC5**: Subscribe to VS Code's file system events instead of creating independent watchers. Use `IFileService.onDidFilesChange()` to avoid duplicate file system watches and reuse Quantlab's existing file watching infrastructure.

**AUDIT FIX VII-DS9**: Initialize LanceDB for vector storage with `code_embeddings` and `doc_embeddings` tables.

**AUDIT FIX VIII-PC9**: If LanceDB initialization fails, fall back to BM25-only search. Log warning.

```typescript
import { connect } from 'lancedb';

export class IncrementalIndexer {
    private vectorIndex: VectorIndex | null = null;

    constructor(
        private readonly db: QicDatabase,
        private readonly embeddingService: SecureEmbeddingService,
        private readonly fileService: IFileService  // AUDIT FIX IX-CC5: use IFileService, NOT IFileSystemWatcher
    ) {
        /**
         * AUDIT FIX IX-CC5: Subscribe to VS Code's file system events
         * instead of creating independent watchers.
         */
        this.fileService.onDidFilesChange(changes => {
            for (const change of changes.rawChanges) {
                if (change.type === FileChangeType.UPDATED) {
                    this.reindexFile(change.resource);
                } else if (change.type === FileChangeType.DELETED) {
                    this.removeFromIndex(change.resource);
                } else if (change.type === FileChangeType.ADDED) {
                    this.reindexFile(change.resource);
                }
            }
        });
    }

    /**
     * Index the entire workspace. Called on first activation.
     * Target: < 30s for 10K files.
     *
     * AUDIT FIX VII-DS9: Initialize LanceDB for vector storage.
     * AUDIT FIX VIII-PC9: If LanceDB init fails, fall back to BM25-only.
     */
    async indexWorkspace(workspacePath: string): Promise<IndexResult> {
        // Initialize LanceDB vector index
        try {
            this.vectorIndex = new VectorIndex();
            await this.vectorIndex.initialize(
                path.join(workspacePath, '.qic', 'vectors.lance')
            );
        } catch (error) {
            // AUDIT FIX VIII-PC9: LanceDB fallback
            console.warn(
                '[QIC] Vector search unavailable. Using keyword search only.',
                error
            );
            this.vectorIndex = null;
        }

        // ... BM25 indexing proceeds regardless ...
    }

    /**
     * Incrementally update index for changed files.
     * Called by IFileService.onDidFilesChange (AUDIT FIX IX-CC5).
     */
    async updateFile(filePath: string, changeType: 'modified' | 'created' | 'deleted'): Promise<void>;

    /**
     * Search using hybrid BM25 + vector approach.
     * AUDIT FIX VIII-PC9: If vectorIndex is null, use BM25-only search.
     */
    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const bm25Results = await this.searchBM25(query, options);

        if (!this.vectorIndex || !options?.includeVector) {
            return bm25Results;
        }

        // Hybrid search when vector index is available
        const vectorResults = await this.vectorIndex.search(
            await this.embeddingService.embed([query]).then(r => r[0]),
            'code_embeddings',
            options?.maxResults ?? 20
        );

        return this.reranker.rerank([
            { results: bm25Results, weight: 0.4, name: 'bm25' },
            { results: vectorResults, weight: 0.4, name: 'vector' },
        ]);
    }

    private async reindexFile(resource: URI): Promise<void>;
    private async removeFromIndex(resource: URI): Promise<void>;
}

interface SearchOptions {
    maxResults?: number;         // Default: 20
    fileFilter?: string;         // Glob pattern
    includeVector?: boolean;     // Enable vector search (requires embeddings)
}

interface SearchResult {
    filePath: string;
    content: string;
    score: number;
    source: 'bm25' | 'vector' | 'hybrid';
    lineRange?: { start: number; end: number };
}
```

#### BM25 Implementation

Use the schema from Prompt 05. Implement:
- Document tokenization (split on whitespace + camelCase + snake_case)
- Term frequency calculation
- IDF calculation: `log((N - df + 0.5) / (df + 0.5) + 1)` where N=total docs, df=doc frequency
- BM25 score: `IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl/avgdl))` with k1=1.2, b=0.75

### 3. RRFReranker (`src/vs/workbench/contrib/qic/common/context/reranker.ts`)

Reciprocal Rank Fusion with per-source weights:

```typescript
/**
 * Default RRF source weights.
 * AUDIT FIX I-SG8: Explicit weight values documented alongside formula.
 */
const DEFAULT_RRF_WEIGHTS: Record<string, number> = {
    bm25: 0.4,
    vector: 0.4,
    recency: 0.1,
    'file-proximity': 0.1,
};

export class RRFReranker {
    private readonly k = 60;  // RRF constant

    /**
     * Rerank results from multiple sources using weighted RRF.
     *
     * AUDIT FIX S-10 + I-SG8: Complete formula with weights:
     *   score(doc) = SUM weight_i / (k + rank_i) for each source
     *   where weights are: BM25=0.4, vector=0.4, recency=0.1, file-proximity=0.1
     *
     * For each document, iterate over all sources where the document appears.
     * Sum the weighted reciprocal rank contributions. Sort by total score descending.
     */
    rerank(
        sources: Array<{
            results: SearchResult[];
            weight: number;
            name: string;
        }>,
        maxResults?: number
    ): SearchResult[];
}
```

### 4. ContextAssembler (`src/vs/workbench/contrib/qic/common/context/contextAssembler.ts`)

Assembles context for LLM requests within token budgets:

```typescript
export class ContextAssembler {
    /**
     * Assemble context for a lane, respecting token budget.
     * AUDIT FIX C-5: All 8 lanes have explicit budget profiles.
     */
    async assemble(
        lane: LaneName,
        userMessage: string,
        options?: {
            activeFile?: string;
            selectedText?: string;
            recentFiles?: string[];
        }
    ): Promise<AssembledContext>;
}

/**
 * AUDIT FIX C-5 + I-SG3: Budget profiles for ALL 8 lanes.
 *
 * The spec (§4.3, lines 3185–3228) only defines budgets for completion (4K),
 * chat (32K), and gather (64K). The following profiles map ALL 8 lanes to
 * explicit budgets with documented rationale:
 *
 * - chat-ask:     32K — uses 'chat' profile (standard Q&A interaction)
 * - chat-gather:  64K — uses 'gather' profile (needs broad context for research)
 * - chat-plan:    64K — uses 'gather' profile (planning needs broad context)
 * - chat-act:     32K — uses 'chat' profile (acting needs focused context)
 * - repair:       32K — uses 'chat' profile with priority on error context
 * - fast-apply:    8K — minimal profile (only selected code + intent)
 * - summarize:    32K — uses 'chat' profile (needs full conversation history)
 * - completion:    4K — uses 'completion' profile (inline, latency-sensitive)
 */
const LANE_BUDGETS: Record<LaneName, ContextBudget> = {
    'chat-ask':     { total: 32768, system: 2048, context: 20480, query: 4096, reserve: 6144 },
    'chat-gather':  { total: 65536, system: 2048, context: 45056, query: 8192, reserve: 10240 },
    'chat-plan':    { total: 65536, system: 2048, context: 45056, query: 8192, reserve: 10240 },
    'chat-act':     { total: 32768, system: 2048, context: 20480, query: 4096, reserve: 6144 },
    'repair':       { total: 32768, system: 2048, context: 20480, query: 4096, reserve: 6144,
                      contextPriority: 'error' },  // Priority on error context
    'fast-apply':   { total: 8192, system: 512, context: 5120, query: 1024, reserve: 1536 },
    'summarize':    { total: 32768, system: 2048, context: 20480, query: 4096, reserve: 6144,
                      contextPriority: 'conversation-history' },  // Full conversation history
    'completion':   { total: 4096, system: 512, context: 2048, query: 512, reserve: 1024 },
};
```

### 5. DynamicToolSelector (`src/vs/workbench/contrib/qic/common/context/dynamicToolSelector.ts`)

Select the most relevant tools for a request within token budget:

```typescript
export class DynamicToolSelector {
    /**
     * Select tools based on semantic relevance to the user's message,
     * staying within a 2000-token budget for tool schemas.
     * Essential tools (read_file, search_code) are always included.
     */
    selectTools(
        lane: LaneName,
        userMessage: string,
        maxTokenBudget?: number    // Default: 2000
    ): ToolDefinition[];
}
```

### 6. VectorIndex (`src/vs/workbench/contrib/qic/common/context/vectorIndex.ts`)

**AUDIT FIX VII-DS9**: LanceDB vector storage as specified in spec §5.1 (lines 3524–3527).

```typescript
import { connect } from 'lancedb';
import * as path from 'path';

/**
 * AUDIT FIX VII-DS9: LanceDB vector index with code_embeddings and doc_embeddings tables.
 * Spec: lancedb: { database: '{workspaceStorage}/vectors.lance'; tables: ['code_embeddings', 'doc_embeddings'] }
 */
export class VectorIndex {
    private db: lancedb.Connection | null = null;

    async initialize(storagePath: string): Promise<void> {
        this.db = await connect(storagePath);

        // Create tables if they don't exist
        await this.db.createTable('code_embeddings', [
            { vector: new Float32Array(768), path: '', chunk: '', line_start: 0, line_end: 0 }
        ], { mode: 'create_if_not_exists' });

        await this.db.createTable('doc_embeddings', [
            { vector: new Float32Array(768), path: '', content: '', type: '' }
        ], { mode: 'create_if_not_exists' });
    }

    async search(query: Float32Array, table: string, limit: number): Promise<SearchResult[]> {
        if (!this.db) throw new QicError('QIC-C003', 'Vector index not initialized');
        return this.db.openTable(table).search(query).limit(limit).execute();
    }

    async addCodeEmbedding(embedding: Float32Array, path: string, chunk: string,
                            lineStart: number, lineEnd: number): Promise<void>;

    async addDocEmbedding(embedding: Float32Array, path: string, content: string,
                           type: string): Promise<void>;

    async removeByPath(path: string): Promise<void>;

    dispose(): void {
        this.db = null;
    }
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/context/secureEmbedding.ts` | Embedding with security + EmbeddingProvider interface (VII-DS14) |
| `src/vs/workbench/contrib/qic/common/context/incrementalIndexer.ts` | BM25 + vector indexer with IFileService events (IX-CC5) |
| `src/vs/workbench/contrib/qic/common/context/vectorIndex.ts` | LanceDB vector storage with code_embeddings + doc_embeddings tables (VII-DS9) |
| `src/vs/workbench/contrib/qic/common/context/reranker.ts` | RRF reranker with weighted formula (I-SG8) |
| `src/vs/workbench/contrib/qic/common/context/contextAssembler.ts` | Context assembly with 8-lane budget profiles (I-SG3) |
| `src/vs/workbench/contrib/qic/common/context/dynamicToolSelector.ts` | Tool selection |
| `src/vs/workbench/contrib/qic/test/common/context/incrementalIndexer.test.ts` | Indexer tests |
| `src/vs/workbench/contrib/qic/test/common/context/reranker.test.ts` | Reranker tests |

---

## Acceptance Criteria

```
□ SecureEmbeddingService routes embedding requests through Gateway (audit fix IV-AO4)
□ SecureEmbeddingService falls back to local provider when remote unavailable (audit fix VII-DS14)
□ EmbeddingProvider interface exposes dimensions, maxTokens, embed(), embedBatch() (audit fix VII-DS14)
□ IncrementalIndexer uses IFileService.onDidFilesChange(), NOT independent watchers (audit fix IX-CC5)
□ IncrementalIndexer indexes 10K files in < 30s
□ IncrementalIndexer updates incrementally on file change
□ LanceDB initializes with code_embeddings and doc_embeddings tables (audit fix VII-DS9)
□ If LanceDB initialization fails, BM25-only search works as fallback (audit fix VIII-PC9)
□ BM25 search returns relevant results for code queries
□ RRFReranker applies weighted formula: score(doc) = SUM weight_i / (k + rank_i) with BM25=0.4, vector=0.4, recency=0.1, file-proximity=0.1 (audit fix I-SG8)
□ ContextAssembler respects token budgets for all 8 lanes with correct totals: chat-ask=32K, chat-gather=64K, chat-plan=64K, chat-act=32K, repair=32K, fast-apply=8K, summarize=32K, completion=4K (audit fix I-SG3)
□ DynamicToolSelector stays within 2000-token budget
□ DynamicToolSelector always includes essential tools (read_file, search_code)
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

The following audit findings from `QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md` have been incorporated into this prompt:

| Fix ID | Severity | Summary | Where Applied |
|--------|----------|---------|---------------|
| **I-SG3** | MEDIUM | Add explicit context assembly profiles for ALL 8 lanes: chat-ask=32K, chat-gather=64K, chat-plan=64K, chat-act=32K, repair=32K (priority on error context), fast-apply=8K (selected code + intent only), summarize=32K (full conversation history), completion=4K | ContextAssembler LANE_BUDGETS |
| **I-SG8** | LOW | Fix RRF formula description: `score(doc) = SUM weight_i / (k + rank_i)` where weights: BM25=0.4, vector=0.4, recency=0.1, file-proximity=0.1 | RRFReranker class + DEFAULT_RRF_WEIGHTS |
| **IV-AO4** | MEDIUM | Route embedding requests through the Gateway instead of separate consent/redaction pipeline: `SecureEmbeddingService -> Gateway.sendRequest({ type: 'embedding', ... })` | SecureEmbeddingService.embed() |
| **VII-DS9** | MEDIUM | Add LanceDB initialization to IncrementalIndexer. Use `lancedb.connect()` with tables `code_embeddings` and `doc_embeddings`. Added vectorIndex.ts to files-to-create | VectorIndex class + IncrementalIndexer.indexWorkspace() |
| **VII-DS14** | MEDIUM | Add EmbeddingProvider interface with `dimensions`, `maxTokens`, `embed()`, `embedBatch()` and local fallback: "If remote provider unavailable and localFallback.enabled, use local provider" | EmbeddingProvider interface + SecureEmbeddingService.getProvider() |
| **IX-CC5** | MEDIUM | Replace independent file watchers with IFileService.onDidFilesChange(): subscribe to VS Code's file system events instead of creating independent watchers | IncrementalIndexer constructor |
| **VIII-PC9** | MEDIUM | Add LanceDB fallback: if LanceDB initialization fails, fall back to BM25-only search. Log warning | IncrementalIndexer.indexWorkspace() + search() |
