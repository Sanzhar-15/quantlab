/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getMachineId, getSqmMachineId, generateDevDeviceId } from '../../node/id.js';
import { getMac } from '../../node/macAddress.js';
import { flakySuite } from './testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

flakySuite('ID', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getMachineId', async function () {
		const errors = [];
		const id = await getMachineId(err => errors.push(err));
		assert.ok(id);
		assert.strictEqual(errors.length, 0);
	});

	test('getSqmId', async function () {
		const errors = [];
		const id = await getSqmMachineId(err => errors.push(err));
		assert.ok(typeof id === 'string');
		assert.strictEqual(errors.length, 0);
	});

	test('generateDevDeviceId is a UUID made by the app', function () {
		assert.match(generateDevDeviceId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.notStrictEqual(generateDevDeviceId(), generateDevDeviceId());
	});

	test('getMac', async () => {
		const macAddress = getMac();
		assert.ok(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(macAddress), `Expected a MAC address, got: ${macAddress}`);
	});
});
