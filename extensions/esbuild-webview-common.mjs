/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * @fileoverview Common build script for extension scripts used in in webviews.
 */
import path from 'node:path';
import esbuild from 'esbuild';

/**
 * @typedef {Partial<import('esbuild').BuildOptions> & {
 * 	entryPoints: string[] | Record<string, string> | { in: string, out: string }[];
 * 	outdir: string;
 * }} BuildOptions
 */

/**
 * Build the source code once using esbuild.
 *
 * @param {BuildOptions} options
 * @param {(outDir: string) => unknown} [didBuild]
 */
async function build(options, didBuild) {
	await esbuild.build({
		bundle: true,
		minify: true,
		sourcemap: false,
		format: 'esm',
		platform: 'browser',
		target: ['es2024'],
		...options,
	});

	await didBuild?.(options.outdir);
}

/**
 * Build the source code once using esbuild, logging errors instead of throwing.
 *
 * @param {BuildOptions} options
 * @param {(outDir: string) => unknown} [didBuild]
 */
async function tryBuild(options, didBuild) {
	try {
		await build(options, didBuild);
	} catch (err) {
		// No-Fallbacks: a watch-mode build failure must be UNMISTAKABLE. The prior bare
		// `console.error(err)` could scroll past, leaving a STALE bundle served with no
		// clear signal. Emit a loud banner; keep the watcher alive (exiting would kill
		// the watch -- the point of watch mode is to rebuild on the next save).
		console.error('\n=== esbuild WATCH BUILD FAILED -- the previous (STALE) bundle is still in use; fix the error and save to rebuild ===');
		console.error(err);
	}
}

/**
 * @param {{
 * 	srcDir: string;
 *  outdir: string;
 *  outputRootSubpath?: string;
 *  entryPoints: string[] | Record<string, string> | { in: string, out: string }[];
 * 	additionalOptions?: Partial<import('esbuild').BuildOptions>
 * }} config
 * @param {string[]} args
 * @param {(outDir: string) => unknown} [didBuild]
 */
export async function run(config, args, didBuild) {
	let outdir = config.outdir;
	const outputRootIndex = args.indexOf('--outputRoot');
	if (outputRootIndex >= 0) {
		const outputRoot = args[outputRootIndex + 1];
		// Under `--outputRoot` the build relocates the bundle into the packaged extension root.
		// Most webviews emit to a SINGLE-level outdir (e.g. `notebook-out`), so `path.basename`
		// reconstructs the full extension-relative path losslessly. A webview whose outdir is
		// NESTED under the extension (e.g. Quantbook's `dist/webview/quantbook`) would lose the
		// intermediate dirs to `path.basename`, landing the bundle where the runtime cannot find
		// it -- such a caller passes its full extension-relative `outputRootSubpath` to preserve
		// the nesting. Omitted -> the prior basename behavior, so every existing caller is
		// byte-identical.
		const outputSubpath = config.outputRootSubpath ?? path.basename(outdir);
		outdir = path.join(outputRoot, outputSubpath);
	}

	/** @type {BuildOptions} */
	const resolvedOptions = {
		entryPoints: config.entryPoints,
		outdir,
		logOverride: {
			'import-is-undefined': 'error',
		},
		...(config.additionalOptions || {}),
	};

	const isWatch = args.indexOf('--watch') >= 0;
	if (isWatch) {
		await tryBuild(resolvedOptions, didBuild);
		const watcher = await import('@vscode/watcher');
		watcher.subscribe(config.srcDir, () => tryBuild(resolvedOptions, didBuild));
	} else {
		return build(resolvedOptions, didBuild).catch(err => {
			// No-Fallbacks: surface WHY the build failed before exiting. The prior
			// `.catch(() => process.exit(1))` swallowed the esbuild error, so a syntax
			// error / wrong-platform native binary exited 1 with NO message -- the
			// caller saw a bare failure and could not tell why.
			console.error(err);
			process.exit(1);
		});
	}
}
