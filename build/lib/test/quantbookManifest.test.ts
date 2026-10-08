/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { gateQuantbookManifest, quantbookAuthorised, quantbookNotebookTypes } from '../quantbookManifest.ts';

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
});
