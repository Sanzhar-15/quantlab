/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Side-effecting Vega-Lite render. Takes a pure GeneralPlan and embeds the
 * chart in a DOM container via vega-embed.
 *
 * MUST run in the webview context.
 *
 * Bundling note (audit-fix AF30/AF31): vega-embed is loaded via a dynamic
 * `import('vega-embed')` so a build pipeline that supports code-splitting
 * (esbuild with `splitting: true`, Vite, webpack) can place it in a
 * separate chunk. The CURRENT shared webview build config in
 * `extensions/esbuild-webview-common.mjs` does NOT set `splitting: true`,
 * so a webview that bundles general-applier.ts will pull vega-embed into
 * its main chunk (still better than a static import everywhere -- the
 * extension host bundle is built separately and won't include it). When
 * the qviz webview is added in Phase 5, that webview's per-target
 * esbuild config should set `splitting: true` so the chunk-split applies.
 *
 * The compile/apply split keeps this file the only place that depends on
 * vega-lite / vega / vega-embed. compileGeneralPlan is unit-testable without
 * any of them.
 *
 * Lifecycle (mirrors timeseries applier.ts):
 *
 *   let view: VegaEmbedHandle | undefined;
 *   onPlanChange(async plan => {
 *     view = await applyGeneralPlan(container, plan, view);
 *   });
 *
 * `existing` is finalized before the new view is created. Disposal errors
 * propagate (audit-fix AF20: previously this swallowed them silently).
 */

import type { Result as VegaEmbedResult, EmbedOptions } from 'vega-embed';
import type { GeneralPlan } from './types';

/**
 * Re-export of vega-embed's Result type under a shorter alias. Type-only
 * import: erased at runtime, so the static-import surface stays free of
 * any vega-embed runtime code. The package only loads when applyGeneralPlan
 * is actually called (via the dynamic import below).
 *
 * Subset of the contract we depend on:
 *   - finalize(): void          tear-down for the view + listeners
 *   - view: View                Vega view instance (for advanced callers)
 *   - spec: VisualizationSpec   resolved spec (post-vega-embed normalization)
 */
export type VegaEmbedHandle = VegaEmbedResult;

interface VegaEmbedFn {
	(container: HTMLElement, spec: unknown, options?: EmbedOptions): Promise<VegaEmbedResult>;
}

interface VegaEmbedModule {
	readonly default: VegaEmbedFn;
}

/**
 * Apply a GeneralPlan to a fresh Vega view bound to `container`.
 *
 * Returns the handle so callers can keep a reference for later disposal.
 *
 * Audit-aligned: mirrors applyTimeseriesPlan(plan, existing) so leak
 * patterns are identical for both render targets.
 */
export async function applyGeneralPlan(
	container: HTMLElement,
	plan: GeneralPlan,
	existing?: VegaEmbedHandle
): Promise<VegaEmbedHandle> {
	// Audit-fix AF20: previously this swallowed disposal errors with
	// `try { ... } catch { void e; }`. CLAUDE.md prohibits silent
	// fallbacks. If `existing.finalize()` throws, the caller almost
	// certainly wants to know -- continuing to create a new view on top
	// of a half-disposed predecessor is the worse outcome (timer/listener
	// leaks, two canvases sharing a container).
	if (existing) {
		disposeView(existing, container);
	}

	const mod = await loadVegaEmbed();
	const { expressionInterpreter } = await import('vega-interpreter');
	// CSP fix (2026-05-11): webviews run under a strict CSP that forbids
	// `unsafe-eval`, so Vega's default expression engine (which compiles
	// expressions via `new Function(...)`) crashes every render with
	// "Evaluating a string as JavaScript violates the following CSP".
	// `ast: true` makes Vega parse expressions to an AST and `expr:`
	// hands the AST to the interpreter -- no runtime code generation.
	const options: EmbedOptions = {
		actions: false,
		renderer: 'canvas',
		ast: true,
		expr: expressionInterpreter,
	};
	const result = await mod.default(container, plan.spec, options);
	return result;
}

/**
 * Tear down a Vega view and clear its container. Call before discarding the
 * handle returned by applyGeneralPlan.
 */
export function disposeView(handle: VegaEmbedHandle, container?: HTMLElement): void {
	if (handle && typeof handle.finalize === 'function') {
		handle.finalize();
	}
	if (container) {
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}
	}
}

/**
 * Dynamic import of vega-embed. Kept in a single helper so a future swap
 * (e.g. swapping to a smaller bundle) only touches one place.
 *
 * The literal-string `import('vega-embed')` form lets a bundler with
 * code-splitting (Vite, webpack, esbuild with `splitting: true`) emit a
 * separate chunk so the main bundle stays vega-free until a general-family
 * chart is opened. Without splitting, the import still works -- it just
 * lands in the main chunk.
 *
 * Throws a clear error if the module isn't present at runtime -- the only
 * place we'd surface "vega-embed not installed" so the user sees a useful
 * message rather than a generic module-resolve failure.
 */
async function loadVegaEmbed(): Promise<VegaEmbedModule> {
	const mod = (await import('vega-embed')) as VegaEmbedModule;
	if (typeof mod.default !== 'function') {
		throw new Error(
			'vega-embed default export is not a function -- expected (container, spec, options) => Promise<Result>'
		);
	}
	return mod;
}
