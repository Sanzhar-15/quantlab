/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import es from 'event-stream';
import rename from 'gulp-rename';
import { Stream } from 'stream';
import File from 'vinyl';
import { gateQuantbookManifest, gateQuantlabPackageJsonStream, quantbookAuthorised, quantbookNotebookTypes } from '../quantbookManifest.ts';

const root = path.join(import.meta.dirname, '../../..');
const readJson = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

// A packaged manifest may lack `contributes.notebooks` (the gate deletes an emptied list); it reads as no types.
function declaredNotebookTypes(manifest: ReturnType<typeof gateQuantbookManifest>): string[] {
	const notebooks = manifest.contributes?.notebooks;
	return notebooks === undefined ? [] : (notebooks as { type: string }[]).map(n => n.type);
}

function notebookActivationEvents(manifest: ReturnType<typeof gateQuantbookManifest>): string[] {
	return (manifest.activationEvents as string[]).filter(e => e.startsWith('onNotebook:'));
}

suite('quantbookManifest', () => {

	// The rule: the packaged quantlab manifest declares a Quantbook notebook type, or activates on one,
	// exactly when product.json authorises Quantbook.
	test('the packaged manifest declares the Quantbook notebook types exactly when the product key authorises Quantbook', () => {
		const source = readJson('extensions/quantlab/package.json');
		for (const authorised of [true, false]) {
			const packaged = gateQuantbookManifest(structuredClone(source), authorised);
			for (const type of quantbookNotebookTypes) {
				assert.strictEqual(declaredNotebookTypes(packaged).includes(type), authorised, `notebook type ${type}, authorised=${authorised}`);
				assert.strictEqual(notebookActivationEvents(packaged).includes(`onNotebook:${type}`), authorised, `onNotebook:${type}, authorised=${authorised}`);
			}
		}
	});

	test('the product.json in this tree is gated by its own key', () => {
		const product = readJson('product.json');
		const packaged = gateQuantbookManifest(structuredClone(readJson('extensions/quantlab/package.json')), quantbookAuthorised(product));
		assert.strictEqual(declaredNotebookTypes(packaged).some(t => quantbookNotebookTypes.includes(t)), product['quantlab.quantbookEnabled']);
	});

	test('everything else in the manifest is kept', () => {
		const source = readJson('extensions/quantlab/package.json');
		const packaged = gateQuantbookManifest(structuredClone(source), false);
		const { activationEvents: a1, contributes: c1, ...rest1 } = source;
		const { activationEvents: a2, contributes: c2, ...rest2 } = packaged;
		assert.deepStrictEqual(rest2, rest1);
		assert.deepStrictEqual(a2, a1.filter((e: string) => !quantbookNotebookTypes.some(t => e === `onNotebook:${t}`)));
		const { notebooks: n1, ...otherContributes1 } = c1;
		const { notebooks: n2, ...otherContributes2 } = c2 as Record<string, unknown>;
		assert.deepStrictEqual(otherContributes2, otherContributes1);
		assert.deepStrictEqual(n2 ?? [], n1.filter((n: { type: string }) => !quantbookNotebookTypes.includes(n.type)));
	});

	test('a key that is not a boolean is refused by name', () => {
		assert.throws(() => quantbookAuthorised({}), /'quantlab\.quantbookEnabled' must be true or false \(got undefined\)/);
		assert.throws(() => quantbookAuthorised({ 'quantlab.quantbookEnabled': 'false' }), /must be true or false \(got "false"\)/);
	});

	test('a manifest lacking a Quantbook type or its activation event is refused by name when gating', () => {
		const source = readJson('extensions/quantlab/package.json');
		const noType = structuredClone(source);
		noType.contributes.notebooks = [];
		assert.throws(() => gateQuantbookManifest(noType, false), /declares no notebook of type 'quantlab-reactive-notebook'/);
		const noEvent = structuredClone(source);
		noEvent.activationEvents = noEvent.activationEvents.filter((e: string) => !e.startsWith('onNotebook:'));
		assert.throws(() => gateQuantbookManifest(noEvent, false), /no activation event 'onNotebook:quantlab-reactive-notebook'/);
		const noArrays = structuredClone(source);
		delete noArrays.contributes.notebooks;
		assert.throws(() => gateQuantbookManifest(noArrays, false), /no 'contributes\.notebooks' or 'activationEvents' array/);
	});

	// The packaging stream: files carry their source path (cwd = repo root, base = the extension folder), as
	// fromLocal emits them, and the gate runs before the rename under `extensions/<name>/`.
	function quantlabFiles(): File[] {
		const base = path.join(root, 'extensions', 'quantlab');
		return ['package.json', 'out/src/extension.js'].map(relative => new File({
			cwd: root,
			base,
			path: path.join(base, relative),
			contents: Buffer.from(relative === 'package.json' ? fs.readFileSync(path.join(base, 'package.json'), 'utf8') : '// js'),
		}));
	}

	function collect(stream: Stream): Promise<File[]> {
		return new Promise((resolve, reject) => {
			const files: File[] = [];
			stream.on('data', (f: File) => files.push(f));
			stream.on('error', reject);
			stream.on('end', () => resolve(files));
		});
	}

	test('the packaging stream gates the quantlab manifest at its source path, exactly once, and passes the other files unchanged', async () => {
		const files = await collect(gateQuantlabPackageJsonStream(es.readArray(quantlabFiles()), false)
			.pipe(rename(p => p.dirname = `extensions/quantlab/${p.dirname}`)));
		const manifest = files.find(f => f.relative === path.join('extensions', 'quantlab', 'package.json'))!;
		assert.ok(manifest, files.map(f => f.relative).join(', '));
		const packaged = JSON.parse(manifest.contents!.toString('utf8'));
		for (const type of quantbookNotebookTypes) {
			assert.strictEqual(declaredNotebookTypes(packaged).includes(type), false);
			assert.strictEqual(notebookActivationEvents(packaged).includes(`onNotebook:${type}`), false);
		}
		const js = files.find(f => f.relative === path.join('extensions', 'quantlab', 'out', 'src', 'extension.js'))!;
		assert.strictEqual(js.contents!.toString('utf8'), '// js');
	});

	test('a stream whose manifest never reaches the gate (renamed first) fails by name', async () => {
		const renamedFirst = es.readArray(quantlabFiles()).pipe(rename(p => p.dirname = `extensions/quantlab/${p.dirname}`));
		await assert.rejects(collect(gateQuantlabPackageJsonStream(renamedFirst, false)), /\[quantbook-manifest\] extensions\/quantlab\/package\.json passed the manifest gate 0 time\(s\)/);
	});
});
