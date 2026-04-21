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
const outDir = path.join(baseDir, 'dist', 'webview');
const chartsRoot = path.resolve(baseDir, '..', '..', 'Charts', 'packages');

/** @type {Map<string, string>} */
const aliasMap = new Map();

if (fs.existsSync(chartsRoot)) {
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

const chartsAliasPlugin = {
	name: 'charts-alias',
	setup(build) {
		build.onResolve({ filter: /^@charts-plus\// }, args => {
			const target = aliasMap.get(args.path);
			if (target) {
				return { path: target };
			}
			return undefined;
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
		'visualise-style': path.join(visualiseDir, 'visualise.css')
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		plugins: [chartsAliasPlugin]
	}
}, process.argv);
