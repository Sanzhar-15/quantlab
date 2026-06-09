/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **W3 frozen-panes promotion (2026-06-09) -- thin re-export shim.**
 *
 * The pure A1 layout math MOVED to `src/quantbook/shared/gridLayoutA1.ts` so the host-side dep-graph
 * window imports ONE module, not a webview fork. This shim re-exports it verbatim so the webview's
 * existing importers (`canvasGrid.ts`, `index.ts`, `gridBlitA1.ts`, `a1FormulaRefs.ts`,
 * `renderOrchestrator.ts`, `render-bench/index.ts`, and the golden test) keep their `./gridLayoutA1`
 * import path unchanged. The module is DOM/vscode-free + napi-free, so the webview esbuild bundles it
 * directly (the `HOST_RUNTIME_FILTER` is narrowed to allow the pure `src/quantbook/shared/` subtree).
 */

export * from '../../src/quantbook/shared/gridLayoutA1';
