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
 * **WIRED INTO THE PACKAGED/CI BUILD (2026-06-09):** this script is now listed in
 * `build/lib/extensions.ts` `esbuildMediaScripts`, so `compile-extension-media`
 * (dev) and `compile-extension-media-build` / `extensions-ci` (packaged) build it
 * automatically -- a fresh clone / `.vsix` no longer ships a missing Cell Grid bundle.
 * The `--outputRoot` basename-flatten in `esbuild-webview-common.mjs` `run()` (which
 * keeps only `path.basename(outdir)` and would land the bundle at `<extRoot>/quantbook`,
 * NOT the nested `dist/webview/quantbook/` the runtime resolves in `cellGridPanel.ts`)
 * is reconciled WITHOUT a runtime change: we pass the full extension-relative
 * `outputRootSubpath` below so the packaged bundle lands at `<extRoot>/dist/webview/quantbook/`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../esbuild-webview-common.mjs';

const baseDir = typeof import.meta.dirname === 'string'
	? import.meta.dirname
	: path.dirname(fileURLToPath(import.meta.url));

const srcDir = path.join(baseDir, 'webview');
const sheetsDir = path.join(srcDir, 'sheets-webview');
// FE-2 BAKEOFF (2026-06-09): the render-bench webview source. A SECOND entry alongside the sheets
// webview (below). It imports the sheets webview's renderer + the extracted RenderOrchestrator from
// `../sheets-webview/*`, which esbuild bundles transitively (the bundle is self-contained).
const benchDir = path.join(srcDir, 'render-bench');
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
//
const HOST_RUNTIME_FILTER = /(^|\/)(session|loader)(\.d\.ts|\.[cm]?[jt]sx?)?$|\/src\/quantbook\/|\.(node|dylib|so|dll)$/;
// **W3 frozen-panes promotion (2026-06-09)**: the `src/quantbook/shared/` subtree is the EXCEPTION to the
// `\/src\/quantbook\/` arm -- it holds PURE, DOM/vscode-free, napi-free modules (`gridLayoutA1.ts`,
// `a1FormulaRefs.ts`) promoted out of the webview so the host-side dep-graph window imports ONE copy, not a
// fork. The webview re-exports them via thin shims, so esbuild must RESOLVE (bundle) those imports rather
// than fail-loud. esbuild's `onResolve` filter is a Go RE2 regex (NO lookahead), so the exclusion can't live
// in the regex; we keep the broad filter and EXEMPT `src/quantbook/shared/` INSIDE the callback. Every other
// `src/quantbook/` path (session.ts, loader.ts, reactiveKernel, ...) still fails the build loudly. The
// pure-only invariant of `shared/` holds because anything napi/vscode-touching there would re-trip the
// `session`/`loader`/native arms above (and break the host bundle's own purity tests).
const SHARED_SUBTREE = /\/src\/quantbook\/shared\//;
// Absolute path of the shared subtree, for the importer-origin guard below.
const SHARED_DIR = path.join(baseDir, 'src', 'quantbook', 'shared') + path.sep;
const noHostRuntimePlugin = {
	name: 'no-host-runtime',
	setup(build) {
		build.onResolve({ filter: HOST_RUNTIME_FILTER }, args => {
			// **Codex MED-5**: test the NORMALIZED ABSOLUTE target, not the raw specifier. A raw match like
			// `../../src/quantbook/shared/../session` contains `/src/quantbook/shared/` (so a raw-string exempt
			// would pass it) yet resolves to host `session` -- a path-traversal bypass. Resolve against the
			// importer dir (or the configured resolveDir for an entry) + normalize, THEN check the shared subtree.
			const fromDir = args.resolveDir || (args.importer ? path.dirname(args.importer) : baseDir);
			const abs = args.path.startsWith('.') ? path.normalize(path.resolve(fromDir, args.path)) : args.path;
			if (SHARED_SUBTREE.test(abs)) {
				return undefined; // pure shared module (verified on the normalized path) -- bundle it normally
			}
			return {
				errors: [{
					text: `FE-0b build isolation: the sheets webview bundle must not import host runtime `
						+ `("${args.path}" from "${args.importer}", resolved "${abs}"). Browser bundles are `
						+ `vscode/napi-free -- move shared logic into a pure module (e.g. cellRender.ts or `
						+ `src/quantbook/shared/) or import it with \`import type\`.`,
				}],
			};
		});
		// **W3 frozen-panes promotion -- Codex MED-2**: the broad filter above matches the import SPECIFIER, so
		// a RELATIVE escape from inside the shared subtree (`import ... from '../session'` in a `shared/` file)
		// would NOT match `/src/quantbook/` on its specifier and could be bundled -- re-leaking napi. Guard the
		// IMPORTER boundary: any RELATIVE import whose importer lives under `src/quantbook/shared/` MUST resolve
		// to a target still inside `shared/` (a type-only import is already erased by esbuild before resolution,
		// so anything reaching here is a VALUE import). Resolve the specifier against the importer dir and fail
		// loud if it escapes the shared subtree -- keeping `shared/`'s pure-only invariant enforced, not assumed.
		build.onResolve({ filter: /^\.\.?\// }, args => {
			if (!args.importer.startsWith(SHARED_DIR)) {
				return undefined; // not a shared-subtree importer -- the normal rules apply
			}
			const resolved = path.resolve(path.dirname(args.importer), args.path);
			if (resolved.startsWith(SHARED_DIR)) {
				return undefined; // stays inside shared/ -- fine (another pure shared module)
			}
			return {
				errors: [{
					text: `FE-0b build isolation: a src/quantbook/shared/ module must stay PURE -- it may not `
						+ `relative-import OUT of the shared subtree ("${args.path}" from "${args.importer}" `
						+ `resolves to "${resolved}"). That would risk re-leaking host runtime (napi/vscode) into the `
						+ `browser bundle. Keep shared/ self-contained or use \`import type\` for a type-only need.`,
				}],
			};
		});
	},
};

run({
	// Record-form entryPoints: the KEY is the output basename (esbuild ignores outbase nesting for
	// named entries), so every bundle lands FLAT at `dist/webview/quantbook/<key>.js` regardless of
	// which subdir its source lives in. That is what lets the render-bench source live in a sibling
	// `render-bench/` dir yet emit next to the sheets bundle (`cellGridPanel.ts` / `renderBenchPanel.ts`
	// each resolve their own flat name).
	entryPoints: {
		'sheets-webview': path.join(sheetsDir, 'index.ts'),
		'sheets-webview-style': path.join(sheetsDir, 'sheets-webview.css'),
		// FE-2 BAKEOFF: the render-bench webview + its stylesheet.
		'render-bench': path.join(benchDir, 'index.ts'),
		'render-bench-style': path.join(benchDir, 'render-bench.css'),
	},
	// Watch the whole `webview/` tree so a bench edit triggers a rebuild too (was `sheetsDir`).
	srcDir,
	outdir: outDir,
	// Under `--outputRoot` (packaged/CI build) preserve the FULL extension-relative nesting
	// `dist/webview/quantbook` -- the shared `run()` would otherwise basename-flatten it to
	// `quantbook` and the runtime (`cellGridPanel.ts` `dist/webview/quantbook/`) would not find
	// the bundle. Must stay in lockstep with `outDir`'s tail + the `cellGridPanel.ts` resolution.
	outputRootSubpath: path.join('dist', 'webview', 'quantbook'),
	additionalOptions: {
		plugins: [noHostRuntimePlugin],
	},
}, process.argv);
