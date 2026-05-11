/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
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
const chartsRoot = path.resolve(baseDir, '..', '..', 'Charts', 'packages');

/** @type {Map<string, string>} */
const aliasMap = new Map();

const chartsRootExists = fs.existsSync(chartsRoot);
if (chartsRootExists) {
	const entries = fs.readdirSync(chartsRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const distIndex = path.join(chartsRoot, entry.name, 'dist', 'index.js');
		if (fs.existsSync(distIndex)) {
			aliasMap.set(`@charts-plus/${entry.name}`, distIndex);
		}
		const distWorker = path.join(chartsRoot, entry.name, 'dist', 'worker.js');
		if (fs.existsSync(distWorker)) {
			aliasMap.set(`@charts-plus/${entry.name}/worker`, distWorker);
		}
	}
}

// Megaudit-2 A6-MAJOR-4: previously `return undefined` for unaliased
// `@charts-plus/*` imports, which silently delegated to esbuild's
// default resolver -- and since the package isn't on npm, that produced
// a generic "could not resolve" error that pointed at the IMPORT line
// rather than the missing alias. Two real failure modes:
//   (1) `chartsRoot` (the sibling Charts repo) is missing entirely;
//       every alias miss is the same root cause.
//   (2) `chartsRoot` is present but a specific package hasn't been
//       built (no dist/index.js) -- the user needs to run the Charts
//       build, NOT debug a webview import.
// Both now fail loudly via `errors[]` with actionable messages instead
// of dribbling out as cryptic "could not resolve" downstream.
const chartsAliasPlugin = {
	name: 'charts-alias',
	setup(build) {
		build.onResolve({ filter: /^@charts-plus\// }, args => {
			const target = aliasMap.get(args.path);
			if (target) {
				return { path: target };
			}
			if (!chartsRootExists) {
				return {
					errors: [{
						text: `Cannot resolve "${args.path}": sibling Charts repo not found at ${chartsRoot}. `
							+ 'Clone @charts-plus to that path and build it (e.g., pnpm -C ../../Charts build).',
					}],
				};
			}
			return {
				errors: [{
					text: `Cannot resolve "${args.path}": no alias mapping registered. `
						+ `Expected ${path.join(chartsRoot, args.path.replace(/^@charts-plus\//, ''), 'dist', 'index.js')} `
						+ '(or .../worker.js for /worker imports). Run the Charts build to produce dist/.',
				}],
			};
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
	additionalOptions: {
		plugins: [chartsAliasPlugin]
	}
}, process.argv);
