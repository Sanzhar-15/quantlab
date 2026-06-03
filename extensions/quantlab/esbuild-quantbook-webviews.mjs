/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

/**
 * FE-0b-1 (2026-06-02) -- ISOLATED esbuild build for Quantbook webviews.
 *
 * Deliberately SEPARATE from the shared `esbuild-webview.mjs`:
 *   1. Build isolation -- the shared build carries the `@charts-plus/*` alias
 *      plugin coupled to the sibling Charts repo. A Quantbook webview compile
 *      error (or a missing Charts repo) must NOT take down the other build and
 *      vice versa. Running this as its OWN `node` invocation keeps a Quantbook
 *      failure independently attributable (a distinct process + exit code) and
 *      means it has NO `@charts-plus` alias surface at all.
 *   2. Output namespace -- emits to `dist/webview/quantbook/` (NOT
 *      `dist/webview/`) so the Quantbook bundles never collide with the shared
 *      webview bundles.
 *
 * Invoke: `node ./esbuild-quantbook-webviews.mjs` (one-shot) or
 *         `node ./esbuild-quantbook-webviews.mjs --watch`.
 * Wrapped by the `build:webviews:quantbook` / `watch:webviews:quantbook`
 * package.json scripts.
 *
 * **DEFERRED -- F5 (FE megaudit, docs/fe/2026-06-03-fe-megaudit/SYNTHESIS.md):** this
 * script is NOT yet wired into any aggregate / CI / `vscode:prepublish` build path
 * (`build/lib/extensions.ts` `esbuildMediaScripts` does not list it) -- so a packaged
 * build that doesn't run `npm run build:webviews:quantbook` ships a missing bundle
 * (the panel's `readyWatchdog` then shows a loud "rebuild it" error after 6s). This
 * matches the existing chart/action/trade webview pattern (they are also manual). When
 * wiring it in, reconcile the `--outputRoot` basename-flatten in `esbuild-webview-common.mjs`
 * `run()` (it would land the bundle at `<root>/quantbook`, NOT the nested
 * `dist/webview/quantbook/` the runtime hardcodes in `cellGridPanel.ts`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../esbuild-webview-common.mjs';

const baseDir = typeof import.meta.dirname === 'string'
	? import.meta.dirname
	: path.dirname(fileURLToPath(import.meta.url));

const srcDir = path.join(baseDir, 'webview');
const sheetsDir = path.join(srcDir, 'sheets-webview');
// Namespaced under dist/webview/quantbook/ -- isolated from the shared bundles.
const outDir = path.join(baseDir, 'dist', 'webview', 'quantbook');

// Build-isolation guard: the browser bundle must NEVER import host runtime
// (`src/quantbook/session.ts`/`loader.ts` pull the napi binding) or a native addon.
// Today the only real import is `./cellRender`; the snapshot type is `import type`
// (erased by esbuild before resolution), so this never fires. But if a future edit
// adds a *value* import resolving into a host module or a native addon, the build
// FAILS LOUDLY here instead of silently shipping napi into the webview.
//
// **FE megaudit L-k (2026-06-03)**: the prior denylist was narrow -- it caught only
// `session(.[cm][jt]s)` + `.node`, missing `.tsx`/`.d.ts` host modules and the other
// native binary extensions (`.dylib`/`.so`/`.dll`) plus the `loader` host module that
// resolves the napi binding. Broadened to:
//   - host modules by name: `session` / `loader` with any ts/js extension (incl. .tsx, .d.ts),
//   - any `src/quantbook/` host-source path,
//   - native binaries: `.node` / `.dylib` / `.so` / `.dll`.
const HOST_RUNTIME_FILTER = /(^|\/)(session|loader)(\.d\.ts|\.[cm]?[jt]sx?)?$|\/src\/quantbook\/|\.(node|dylib|so|dll)$/;
const noHostRuntimePlugin = {
	name: 'no-host-runtime',
	setup(build) {
		build.onResolve({ filter: HOST_RUNTIME_FILTER }, args => ({
			errors: [{
				text: `FE-0b build isolation: the sheets webview bundle must not import host runtime `
					+ `("${args.path}" from "${args.importer}"). Browser bundles are vscode/napi-free -- `
					+ `move shared logic into a pure module (e.g. cellRender.ts) or import it with \`import type\`.`,
			}],
		}));
	},
};

run({
	entryPoints: {
		'sheets-webview': path.join(sheetsDir, 'index.ts'),
		'sheets-webview-style': path.join(sheetsDir, 'sheets-webview.css'),
	},
	srcDir: sheetsDir,
	outdir: outDir,
	additionalOptions: {
		plugins: [noHostRuntimePlugin],
	},
}, process.argv);
