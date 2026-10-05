/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import { assertStrategyMayLeave, ConsentRecord, ConsentRequiredError, ConsentStore, grantConsent } from '../../../quantbook/kernel/consent';
import { isCloudKernelAvailable, kernelOptions, resolveKernelChoice } from '../../../quantbook/kernel/kernelOptions';

function memoryStore(): ConsentStore {
	const records = new Map<string, ConsentRecord>();
	return {
		get: workspace => records.get(workspace),
		async set(record) { records.set(record.workspace, record); },
		async clear(workspace) { records.delete(workspace); },
	};
}

const compute = { endpoint: 'https://compute.example', interfaceArtefact: 'compute-v1.json' };

suite('quantbook kernel - options (CK-1)', () => {

	test('no compute record: local only, and it is the default', () => {
		const options = kernelOptions(undefined);
		assert.deepStrictEqual(options.map(o => [o.kind, o.isDefault]), [['local', true]]);
	});

	test('a record naming only one of endpoint / interface artefact offers no cloud option', () => {
		assert.strictEqual(isCloudKernelAvailable({ endpoint: compute.endpoint }), false);
		assert.strictEqual(isCloudKernelAvailable({ interfaceArtefact: compute.interfaceArtefact }), false);
		assert.strictEqual(isCloudKernelAvailable({ endpoint: '', interfaceArtefact: compute.interfaceArtefact }), false);
		assert.deepStrictEqual(kernelOptions({ endpoint: compute.endpoint }).map(o => o.kind), ['local']);
	});

	test('a complete record: cloud is the default, local is one switch away', () => {
		assert.deepStrictEqual(kernelOptions(compute).map(o => [o.kind, o.isDefault]), [['cloud', true], ['local', false]]);
	});

	test('choice resolution: default, stored, and named refusals', () => {
		assert.strictEqual(resolveKernelChoice(undefined, undefined), 'local');
		assert.strictEqual(resolveKernelChoice(undefined, compute), 'cloud');
		assert.strictEqual(resolveKernelChoice('local', compute), 'local');
		assert.throws(() => resolveKernelChoice('cloud', undefined), /\[kernel_cloud_unavailable\]/);
		assert.throws(() => resolveKernelChoice('remote', compute), /\[kernel_choice_invalid\]/);
	});
});

suite('quantbook kernel - consent gate (CK-2)', () => {

	test('without a consent record the cloud kernel gets no strategy code', () => {
		assert.throws(
			() => assertStrategyMayLeave('cloud', 'file:///ws', 'def run(): pass', memoryStore()),
			(err: unknown) => err instanceof ConsentRequiredError && err.code === 'kernel_consent_required' && err.workspace === 'file:///ws'
		);
	});

	test('consent is per workspace and can be withdrawn', async () => {
		const store = memoryStore();
		const record = await grantConsent('file:///ws', store, new Date('2026-10-05T19:30:00.000Z'));
		assert.deepStrictEqual(record, { workspace: 'file:///ws', grantedAt: '2026-10-05T19:30:00.000Z' });
		assert.deepStrictEqual(assertStrategyMayLeave('cloud', 'file:///ws', 'src', store), { source: 'src', consent: record });
		assert.throws(() => assertStrategyMayLeave('cloud', 'file:///other', 'src', store), ConsentRequiredError);
		await store.clear('file:///ws');
		assert.throws(() => assertStrategyMayLeave('cloud', 'file:///ws', 'src', store), ConsentRequiredError);
	});

	test('a store answering with another workspace\'s record is refused', () => {
		const lying: ConsentStore = { get: () => ({ workspace: 'file:///a', grantedAt: 'x' }), set: async () => { }, clear: async () => { } };
		assert.throws(() => assertStrategyMayLeave('cloud', 'file:///b', 'src', lying), /\[kernel_consent_mismatch\]/);
	});

	test('the gate is not a pass-through for the local kernel', () => {
		assert.throws(() => assertStrategyMayLeave('local', 'file:///ws', 'src', memoryStore()), /\[kernel_consent_misuse\]/);
	});
});
