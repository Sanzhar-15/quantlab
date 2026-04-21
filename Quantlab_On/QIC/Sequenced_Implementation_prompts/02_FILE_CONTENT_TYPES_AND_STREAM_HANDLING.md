# Prompt 02 — FileContent Types & Stream-Based File Handling

**Phase**: 0 (Pre-Implementation Crash Safety)
**Prerequisites**: Prompt 00 complete (Prompt 01 can run in parallel)
**Estimated Scope**: ~3 files created, ~300 lines

---

## Objective

Implement the `FileContent` discriminated union type system and stream-based file handling to prevent OOM on large files. This ensures QIC never loads large files fully into memory.

---

## Spec References

- QIC Spec v6.2: §2.1.1 EditScript / FileContent (lines 210–444) — FileContent type definition
- QIC Spec v6.2: §6.1 related — Stream-based processing for large files

## Implementation Plan References

- Phase 0 task 3 (line 378): "Implement stream-based file handling (FileContent types)"
- Phase 0 gate: "Process 100MB file without OOM"

---

## Implementation Instructions

### File: `src/vs/workbench/contrib/qic/common/crashSafe/fileContent.ts`

#### 1. FileContent Discriminated Union

```typescript
/**
 * FileContent — Discriminated union for handling files of all sizes.
 * Prevents OOM by using streams for large files.
 *
 * Size tiers (reconciled with QIC Spec v6.2 §3.4):
 * - small: < 1MB → inline string (full content in memory)
 * - medium: 1MB–50MB → stream-based (AsyncIterable<Uint8Array>)
 * - large: > 50MB → reference only (path + hash, for checkpoints)
 * - huge: > 100MB → rejected with user notification
 *
 * NOTE: Uses 'type' discriminant field (not 'kind') for consistency with all
 * other QIC types. The spec defines 3 variants (inline/stream/reference);
 * we add a 4th 'rejected' variant for clear error UX on oversized files.
 */
export type FileContent =
    | { type: 'inline'; data: string; sizeBytes: number }           // < 1MB
    | { type: 'stream'; handle: AsyncIterable<Uint8Array>; sizeBytes: number } // 1MB–50MB
    | { type: 'reference'; path: string; hash: string }             // > 50MB (for checkpoints)
    | { type: 'rejected'; path: string; sizeBytes: number; maxAllowed: number }; // > 100MB
```

**Rationale for reconciliation (Audit Fix VII-DS1)**:
- Uses spec's `type` field name (not `kind`) for consistency with all other QIC types
- Uses spec's 1MB inline threshold (100KB was too aggressive — most source files are < 1MB)
- Uses `AsyncIterable<Uint8Array>` for the stream variant (more practical than bare FileHandle)
- Keeps spec's `reference` variant (needed for checkpoint storage of large files)
- Adds `rejected` variant (needed for clear error UX on files exceeding 100MB)
- Removes the `chunked` variant — it is redundant with `stream` using smaller chunk sizes

**IMPORTANT**: All downstream prompts (07, 09, 15) must use this reconciled type with the `type` discriminant field.

#### 2. FileHandlingConfig

```typescript
export interface FileHandlingConfig {
    inlineThreshold: number;      // Default: 1 * 1024 * 1024 (1MB) — files below this are inline
    streamThreshold: number;      // Default: 50 * 1024 * 1024 (50MB) — files below this are streamed
    referenceThreshold: number;   // Default: 100 * 1024 * 1024 (100MB) — files below this are reference-only
    // Files above referenceThreshold are rejected
    chunkSize: number;            // Default: 64 * 1024 (64KB) — chunk size for stream reads
}

export const DEFAULT_FILE_HANDLING_CONFIG: FileHandlingConfig = {
    inlineThreshold: 1 * 1024 * 1024,        // 1MB
    streamThreshold: 50 * 1024 * 1024,        // 50MB
    referenceThreshold: 100 * 1024 * 1024,    // 100MB
    chunkSize: 64 * 1024,                     // 64KB
};
```

#### 3. File Content Loader

```typescript
export class FileContentLoader {
    constructor(
        private readonly config: FileHandlingConfig = DEFAULT_FILE_HANDLING_CONFIG
    ) {}

    /**
     * Load a file as the appropriate FileContent variant based on size.
     * Stat the file first to determine size without reading.
     *
     * Classification logic:
     *   sizeBytes < inlineThreshold (1MB)       → { type: 'inline', data, sizeBytes }
     *   sizeBytes < streamThreshold (50MB)      → { type: 'stream', handle, sizeBytes }
     *   sizeBytes < referenceThreshold (100MB)  → { type: 'reference', path, hash }
     *   sizeBytes >= referenceThreshold          → { type: 'rejected', path, sizeBytes, maxAllowed }
     */
    async loadFile(path: string, fileService: IFileService): Promise<FileContent>;

    /**
     * Convert any FileContent to a string (for inline files) or throw for others.
     * Use sparingly — only when full content is actually needed.
     */
    async toFullString(content: FileContent): Promise<string>;

    /**
     * Process FileContent with a callback, handling all variants.
     * This is the preferred way to consume FileContent.
     * Uses the 'type' discriminant for dispatch.
     */
    async processContent<T>(
        content: FileContent,
        handlers: {
            onInline: (data: string, sizeBytes: number) => T | Promise<T>;
            onStream: (handle: AsyncIterable<Uint8Array>, sizeBytes: number) => T | Promise<T>;
            onReference: (path: string, hash: string) => T | Promise<T>;
            onRejected: (path: string, sizeBytes: number, maxAllowed: number) => T | Promise<T>;
        }
    ): Promise<T>;
}
```

#### 4. Streaming Secret Scanner Support

Add a utility for processing file content through a secret scanner in streaming mode:

```typescript
/**
 * Create a transform that redacts secrets from streaming content.
 * Used by the egress boundary enforcer to process files before sending to LLM.
 */
export function createRedactingTransform(
    scanner: { scanChunk(text: string): string }
): TransformStream<string, string>;
```

### Test File: `src/vs/workbench/contrib/qic/test/common/crashSafe/fileContent.test.ts`

1. Small file (< 1MB) → returns `type: 'inline'` with full content as `data` string
2. Medium file (1MB–50MB) → returns `type: 'stream'` with `AsyncIterable<Uint8Array>` handle
3. Large file (50MB–100MB) → returns `type: 'reference'` with path and hash
4. Huge file (> 100MB) → returns `type: 'rejected'` with path, sizeBytes, and maxAllowed
5. `processContent` correctly dispatches to the right handler using `type` discriminant
6. `toFullString` works for inline, throws for stream/reference/rejected
7. Streaming processing doesn't exceed memory budget (mock 50MB file via stream)
8. Reference variant correctly computes file hash (SHA-256)

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/crashSafe/fileContent.ts` | FileContent types + loader |
| `src/vs/workbench/contrib/qic/test/common/crashSafe/fileContent.test.ts` | Tests |

---

## Acceptance Criteria

```
□ FileContent discriminated union with 4 variants using 'type' discriminant (inline, stream, reference, rejected)
□ FileContentLoader correctly classifies files by reconciled size tiers: <1MB inline, 1-50MB stream, 50-100MB reference, >100MB rejected
□ Processing a mock 50MB file via stream does NOT load it fully into memory
□ Files > 50MB produce 'reference' variant with path and SHA-256 hash
□ Files > 100MB are rejected with path, sizeBytes, and maxAllowed info
□ processContent() dispatches correctly for all 4 variants via 'type' field
□ No usage of 'kind' discriminant field anywhere (must use 'type')
□ TypeScript compiles with no errors
□ All tests pass
```

---

## Audit Fixes Applied

| Fix ID | Severity | Description |
|--------|----------|-------------|
| **VII-DS1** | CRITICAL | Replaced entire FileContent type definition with reconciled version merging spec (3 variants, `type` field, 1MB/50MB thresholds) and prompt (4 variants, rejection). Changed discriminant from `kind` to `type`. Updated thresholds from 100KB/10MB/100MB to 1MB/50MB/100MB. Removed redundant `chunked` variant. Added `reference` variant for checkpoint storage. Updated FileHandlingConfig, FileContentLoader, processContent handlers, tests, and acceptance criteria to match. |
