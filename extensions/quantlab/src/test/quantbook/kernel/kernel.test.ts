/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import { assertStrategyMayLeave, ConsentRecord, ConsentRequiredError, ConsentStore, grantConsent } from '../../../quantbook/kernel/consent';
import { KERNEL_CONSENT_KEY, StateMemento, workspaceConsentStore } from '../../../quantbook/kernel/consentStore';
import { isCloudKernelAvailable, KernelKind, kernelOptions, resolveKernelChoice } from '../../../quantbook/kernel/kernelOptions';
import { selectKernel, storedKernelChoice } from '../../../quantbook/kernel/kernelPicker';

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

function memoryState(): StateMemento & { readonly values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	return {
		values,
		get: <T>(key: string) => values.get(key) as T | undefined,
		async update(key, value) {
			if (value === undefined) {
				values.delete(key);
			} else {
				values.set(key, value);
			}
		},
	};
}

suite('quantbook kernel - picker and stored consent (CK-1, CK-2)', () => {

	const now = () => new Date('2026-10-05T12:00:00.000Z');

	function run(overrides: { compute?: typeof compute; pick: KernelKind | undefined; consent?: boolean; workspace?: string; store?: ConsentStore }) {
		const written: KernelKind[] = [];
		const asked: string[] = [];
		const offered: string[][] = [];
		const store = overrides.store === undefined ? memoryStore() : overrides.store;
		const result = selectKernel({
			compute: overrides.compute,
			stored: undefined,
			workspace: overrides.workspace,
			consentStore: store,
			now,
			writeChoice: async kind => { written.push(kind); },
			ui: {
				pick: async options => { offered.push(options.map(o => o.kind)); return overrides.pick; },
				confirmCloudConsent: async workspace => {
					asked.push(workspace);
					if (overrides.consent === undefined) {
						throw new Error('consent was asked for but the test declared no answer');
					}
					return overrides.consent;
				},
			},
		});
		return { result, written, asked, offered, store };
	}

	test('the setting value default means no stored choice; a non-string setting throws by name', () => {
		assert.strictEqual(storedKernelChoice('default'), undefined);
		assert.strictEqual(storedKernelChoice('local'), 'local');
		assert.throws(() => storedKernelChoice(undefined), /\[kernel_choice_invalid\]/);
	});

	test('no compute record: only local is offered; picking it writes local and asks no consent', async () => {
		const r = run({ pick: 'local' });
		assert.strictEqual(await r.result, 'local');
		assert.deepStrictEqual([r.offered, r.written, r.asked], [[['local']], ['local'], []]);
	});

	test('a dismissed picker writes nothing', async () => {
		const r = run({ compute, pick: undefined, workspace: 'file:///ws' });
		assert.strictEqual(await r.result, undefined);
		assert.deepStrictEqual([r.written, r.asked], [[], []]);
	});

	test('a pick that was not offered throws and writes nothing', async () => {
		const r = run({ pick: 'cloud', workspace: 'file:///ws' });
		await assert.rejects(r.result, /\[kernel_choice_invalid\]/);
		assert.deepStrictEqual(r.written, []);
	});

	test('cloud without an open workspace throws by name and writes nothing', async () => {
		const r = run({ compute, pick: 'cloud' });
		await assert.rejects(r.result, /\[kernel_consent_no_workspace\]/);
		assert.deepStrictEqual(r.written, []);
	});

	test('cloud with consent declined: nothing written, no consent recorded', async () => {
		const r = run({ compute, pick: 'cloud', consent: false, workspace: 'file:///ws' });
		assert.strictEqual(await r.result, undefined);
		assert.deepStrictEqual([r.written, r.asked, r.store.get('file:///ws')], [[], ['file:///ws'], undefined]);
	});

	test('cloud with consent given: consent recorded, then cloud written; a second pick does not ask again', async () => {
		const r = run({ compute, pick: 'cloud', consent: true, workspace: 'file:///ws' });
		assert.strictEqual(await r.result, 'cloud');
		assert.deepStrictEqual(r.store.get('file:///ws'), { workspace: 'file:///ws', grantedAt: '2026-10-05T12:00:00.000Z' });
		const again = run({ compute, pick: 'cloud', workspace: 'file:///ws', store: r.store });
		assert.strictEqual(await again.result, 'cloud');
		assert.deepStrictEqual(again.asked, []);
	});

	test('the workspace-state store round-trips a record, clears it, and refuses a corrupt one by name', async () => {
		const state = memoryState();
		const store = workspaceConsentStore(state);
		assert.strictEqual(store.get('file:///ws'), undefined);
		await grantConsent('file:///ws', store, now());
		assert.deepStrictEqual(store.get('file:///ws'), { workspace: 'file:///ws', grantedAt: '2026-10-05T12:00:00.000Z' });
		assert.strictEqual(assertStrategyMayLeave('cloud', 'file:///ws', 'code', store).source, 'code');
		assert.throws(() => assertStrategyMayLeave('cloud', 'file:///other', 'code', store), /\[kernel_consent_mismatch\]/);
		await store.clear('file:///ws');
		assert.strictEqual(state.values.has(KERNEL_CONSENT_KEY), false);
		state.values.set(KERNEL_CONSENT_KEY, { workspace: 'file:///ws' });
		assert.throws(() => store.get('file:///ws'), /\[kernel_consent_corrupt\]/);
	});
});
