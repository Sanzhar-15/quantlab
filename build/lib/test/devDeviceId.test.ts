/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Quantlab (F-STRIP-DEVID-1): `@vscode/deviceid` reads or creates the shared Microsoft developer-tools id file under
// the user's home. The app's developer device id is its own (base/node/id.ts generateDevDeviceId), so the package
// ships in no manifest and no source module outside tests imports it.

const root = path.join(import.meta.dirname, '../../..');
const deviceIdPackage = '@vscode/deviceid';
const shippedManifests = ['package.json', 'remote/package.json', 'remote/web/package.json'];

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === 'test' ? [] : sourceFiles(full);
		}
		return /\.(ts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
	});
}

suite('devDeviceId', () => {

	test('no shipped manifest depends on @vscode/deviceid', () => {
		const dependents = shippedManifests.filter(manifest => {
			const json = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
			return [json.dependencies, json.optionalDependencies, json.devDependencies].some(deps => deps !== undefined && Object.hasOwn(deps, deviceIdPackage));
		});
		assert.deepStrictEqual(dependents, []);
	});

	test('no source module outside tests imports @vscode/deviceid', () => {
		const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@vscode\/deviceid['"]/;
		const importers = sourceFiles(path.join(root, 'src')).filter(file => importPattern.test(fs.readFileSync(file, 'utf8')));
		assert.deepStrictEqual(importers.map(file => path.relative(root, file)), []);
	});
});
