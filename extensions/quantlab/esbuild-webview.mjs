/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../esbuild-webview-common.mjs';

const baseDir = typeof import.meta.dirname === 'string'
	? import.meta.dirname
	: path.dirname(fileURLToPath(import.meta.url));

const srcDir = path.join(baseDir, 'webview');
const chartDir = path.join(srcDir, 'chart');
const actionDir = path.join(srcDir, 'action');
const tradeDir = path.join(srcDir, 'trade');
const resourcesDir = path.join(srcDir, 'resources');
const statsDir = path.join(srcDir, 'stats');
const visualiseDir = path.join(srcDir, 'visualise');
const qvizSpecDir = path.join(srcDir, 'qviz-spec');
const outDir = path.join(baseDir, 'dist', 'webview');
// The chart engine is the TERMINAL's (`packages/chart-core`, `packages/chart-render-canvas2d` of the client repo),
// emitted by the client's `apps/desktop/src/quantlab-charts/build/emit.cjs` into this generated directory (never
// committed: `.build/` is ignored). The fork's own `Charts/` copy is not a build input. There is no second source:
// a missing directory, a manifest that does not verify, or an `@charts-plus/*` specifier the manifest does not list
// is a build error.
const engineDir = path.resolve(baseDir, '..', '..', '.build', 'ql-charts-engine');
const ENGINE_KIND = 'quantlab-charts-engine';

/**
 * Verifies the emitted engine against its MANIFEST.json (every listed file's size and sha256; no missing, no extra
 * file) and returns the specifier -> file map. Throws on the first difference.
 * @returns {Map<string, string>}
 */
function loadVerifiedEngine() {
	const manifestPath = path.join(engineDir, 'MANIFEST.json');
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`quantlab charts engine: ${manifestPath} is missing. Emit the terminal's engine first: `
			+ `node <client>/apps/desktop/src/quantlab-charts/build/emit.cjs --out ${engineDir}`);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	if (manifest.kind !== ENGINE_KIND) {
		throw new Error(`quantlab charts engine: MANIFEST.json kind is ${JSON.stringify(manifest.kind)} (expected ${JSON.stringify(ENGINE_KIND)})`);
	}
	if (!Array.isArray(manifest.files) || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
		throw new Error('quantlab charts engine: MANIFEST.json holds no files or no entries');
	}
	/** @type {Set<string>} */
	const declared = new Set();
	for (const file of manifest.files) {
		if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || typeof file.bytes !== 'number'
			|| file.path === '' || file.path.startsWith('/') || file.path.split('/').includes('..') || file.path === 'MANIFEST.json') {
			throw new Error(`quantlab charts engine: malformed manifest entry ${JSON.stringify(file)}`);
		}
		const abs = path.join(engineDir, file.path);
		if (!fs.existsSync(abs)) {
			throw new Error(`quantlab charts engine: MISSING ${file.path}`);
		}
		const bytes = fs.readFileSync(abs);
		const actual = crypto.createHash('sha256').update(bytes).digest('hex');
		if (bytes.length !== file.bytes || actual !== file.sha256) {
			throw new Error(`quantlab charts engine: MISMATCH ${file.path} (bytes ${bytes.length}, sha256 ${actual}; manifest ${file.bytes}, ${file.sha256})`);
		}
		declared.add(file.path);
	}
	for (const entry of fs.readdirSync(engineDir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) {
			continue;
		}
		const rel = path.relative(engineDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
		if (rel !== 'MANIFEST.json' && !declared.has(rel)) {
			throw new Error(`quantlab charts engine: EXTRA file ${rel} (not in MANIFEST.json)`);
		}
	}
	/** @type {Map<string, string>} */
	const aliases = new Map();
	for (const entry of manifest.entries) {
		if (typeof entry.specifier !== 'string' || !declared.has(entry.path)) {
			throw new Error(`quantlab charts engine: entry ${JSON.stringify(entry)} does not name a listed file`);
		}
		aliases.set(entry.specifier, path.join(engineDir, entry.path));
	}
	console.log(`quantlab charts engine: verified ${manifest.files.length} files, clientHead ${manifest.clientHead}, clientDirty ${manifest.clientDirty}`);
	return aliases;
}

const aliasMap = loadVerifiedEngine();

const chartsAliasPlugin = {
	name: 'charts-alias',
	setup(build) {
		build.onResolve({ filter: /^@charts-plus\// }, args => {
			const target = aliasMap.get(args.path);
			if (target) {
				return { path: target };
			}
			return {
				errors: [{
					text: `Cannot resolve "${args.path}": the emitted terminal engine at ${engineDir} lists `
						+ `${[...aliasMap.keys()].join(', ')} and nothing else.`,
				}],
			};
		});
	}
};

// The bundles' metafile, written to `<repo>/.build/quantlab-webview.metafile.json` (ignored, never packaged): the
// record of every input of the webview bundles this run produced (CT-1 reads it: 0 inputs under `Charts/`).
const metafilePath = path.resolve(baseDir, '..', '..', '.build', 'quantlab-webview.metafile.json');
const metafilePlugin = {
	name: 'webview-metafile',
	setup(build) {
		build.onEnd(result => {
			if (result.errors.length > 0) {
				return;
			}
			if (!result.metafile) {
				throw new Error('webview-metafile: esbuild returned no metafile');
			}
			fs.writeFileSync(metafilePath, JSON.stringify({ outdir: build.initialOptions.outdir, ...result.metafile }));
		});
	}
};

run({
	entryPoints: {
		'chart': path.join(chartDir, 'index.ts'),
		'chart-style': path.join(chartDir, 'chart.css'),
		'action': path.join(actionDir, 'index.ts'),
		'action-style': path.join(actionDir, 'action.css'),
		'trade': path.join(tradeDir, 'index.ts'),
		'trade-style': path.join(tradeDir, 'trade.css'),
		'resources': path.join(resourcesDir, 'index.ts'),
		'resources-style': path.join(resourcesDir, 'resources.css'),
		'stats': path.join(statsDir, 'index.ts'),
		'stats-style': path.join(statsDir, 'stats.css'),
		'visualise': path.join(visualiseDir, 'index.ts'),
		'visualise-style': path.join(visualiseDir, 'visualise.css'),
		'qviz-spec': path.join(qvizSpecDir, 'index.ts'),
		'qviz-spec-style': path.join(qvizSpecDir, 'qviz-spec.css')
	},
	srcDir,
	outdir: outDir,
	// Under the product build's `--outputRoot` the bundles keep their `dist/webview/` place (the default would
	// flatten to the basename `webview/`, where ChartWebview.ts and the other providers do not look).
	outputRootSubpath: path.join('dist', 'webview'),
	additionalOptions: {
		metafile: true,
		plugins: [chartsAliasPlugin, metafilePlugin]
	}
}, process.argv);
