/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **W3 frozen-panes promotion (2026-06-09) -- thin re-export shim.**
 *
 * The A1 formula-ref tokenizer (a 3-HIGH-bug history) MOVED to `src/quantbook/shared/a1FormulaRefs.ts`
 * so the host-side dep-graph window imports this ONE tokenizer, not a webview fork. This shim re-exports
 * it verbatim so the webview's importers (`clipboardLogic.ts`, `formulaIntel.ts`, and the golden test)
 * keep their `./a1FormulaRefs` import path unchanged. The module is DOM/vscode-free + napi-free, bundled
 * directly by the webview esbuild (the `HOST_RUNTIME_FILTER` allows the pure `src/quantbook/shared/`).
 */

export * from '../../src/quantbook/shared/a1FormulaRefs';
