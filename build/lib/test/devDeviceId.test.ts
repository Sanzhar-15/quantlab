/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import es from 'event-stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import VinylFile from 'vinyl';
import { cleanNodeModules } from '../util.ts';

// Quantlab (F-STRIP-DEVID-1): the upstream device-id package reads or creates the shared Microsoft developer-tools id
// file under the user's home. The app's developer device id is its own (base/node/id.ts generateDevDeviceId), so
// (1) no source module outside tests names the package, in any form, and (2) the packaged app ships none of its files.

const packageName = ['@vscode', 'deviceid'].join('/');
const root = path.join(import.meta.dirname, '../../..');

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === 'test' ? [] : sourceFiles(full);
		}
		return [full];
	});
}

function filesNaming(files: string[], needle: string): string[] {
	return files.filter(file => fs.readFileSync(file).includes(needle)).map(file => path.relative(root, file));
}

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

// Runs the build's own .moduleignore filters (util.cleanNodeModules, applied as gulpfile.vscode.ts applies them: the
// shared file, then the platform file) over empty files at the given paths and returns the paths that survive.
function survivors(platform: string, relativePaths: string[]): Promise<string[]> {
	const files = relativePaths.map(relative => new VinylFile({ cwd: root, base: root, path: path.join(root, relative), contents: Buffer.from('') }));
	return new Promise((resolve, reject) => {
		es.readArray(files)
			.pipe(cleanNodeModules(path.join(root, 'build', '.moduleignore')))
			.pipe(cleanNodeModules(path.join(root, 'build', `.moduleignore.${platform}`)))
			.pipe(es.writeArray((error: Error | null, kept: VinylFile[]) => error ? reject(error) : resolve(kept.map(file => file.relative.split(path.sep).join('/')))));
	});
}

suite('devDeviceId', () => {

	test('no non-test file under src names the package, in any form that spells it out', function () {
		this.timeout(30_000); // reads every file under src
		const all = sourceFiles(path.join(root, 'src'));
		assert.ok(all.length > 1000, `expected the whole src tree, found ${all.length} files`);
		assert.deepStrictEqual(filesNaming(all, packageName), []);
	});

	test('the source guard detects the forms a parsed-import check missed', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeviceid-guard-'));
		try {
			const forms = [
				`import "${packageName}";`,
				'import(`' + packageName + '`);',
				`require(/*x*/"${packageName}");`,
				`import { getDeviceId } from '${packageName}';`,
				`const name = '${packageName}'; // a bare string`,
			];
			const written = forms.map((form, index) => {
				const file = path.join(dir, `form${index}.ts`);
				fs.writeFileSync(file, form);
				return file;
			});
			assert.strictEqual(filesNaming(written, packageName).length, forms.length);
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	// A computed or escaped name (`'@vscode/' + 'deviceid'`) is not detectable by text; that case is closed by the
	// packaging test below, which makes the module absent from the packaged app.
	test('build/.moduleignore removes every file of the package from the packaged app, on every platform', async () => {
		const packageDir = path.join(root, 'node_modules', packageName);
		assert.ok(fs.existsSync(packageDir), `${packageDir} is missing, the installed package is the source of the file list`);
		const installed = walk(packageDir).map(file => path.relative(root, file).split(path.sep).join('/'));
		assert.ok(installed.includes(`node_modules/${packageName}/package.json`));

		const representative = [
			...installed,
			`node_modules/${packageName}/build/Release/deviceid.node`,
			`node_modules/${packageName}/prebuilds/darwin-arm64/deviceid.node`,
			`node_modules/${packageName}/binding.gyp`,
			`node_modules/${packageName}/deps/x/y.c`,
			`node_modules/${packageName}/test/x.js`,
			`node_modules/${packageName}/azure-pipelines/azure-pipeline.yml`,
			`node_modules/${packageName}/.config/TSAOptions.json`,
			`node_modules/x/node_modules/${packageName}/dist/index.js`,
		];
		const controls = [
			'node_modules/@vscode/spdlog/build/Release/spdlog.node',
			'node_modules/@vscode/spdlog/package.json',
			'node_modules/jschardet/package.json',
		];

		for (const platform of ['darwin', 'linux', 'win32']) {
			const kept = await survivors(platform, [...representative, ...controls]);
			assert.deepStrictEqual(kept.filter(file => file.includes('deviceid')), [], `${platform}: files of the package survive`);
			assert.deepStrictEqual(controls.filter(file => !kept.includes(file)), [], `${platform}: the filter dropped unrelated packages, the check proves nothing`);
		}
	});
});
