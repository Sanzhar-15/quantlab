/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isUUID } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IStateService } from '../../../state/node/state.js';
import { quantlabDevDeviceIdKey } from '../../common/telemetry.js';
import { resolveDevDeviceId as resolveDesktopDevDeviceId } from '../../electron-main/telemetryUtils.js';
import { resolveDevDeviceId as resolveNodeDevDeviceId } from '../../node/telemetryUtils.js';

// Quantlab (F-STRIP-DEVID-1 c1 M1): an existing profile holds, under the upstream key `telemetry.devDeviceId`, the id
// that `@vscode/deviceid` took from the shared Microsoft developer-tools file. The app must never reuse it.
const legacyKey = 'telemetry.devDeviceId';
const legacyId = '11111111-1111-4111-8111-111111111111';

class MemoryState implements IStateService {
	declare readonly _serviceBrand: undefined;
	readonly writes: string[] = [];
	constructor(readonly items: Record<string, unknown>) { }
	getItem<T>(key: string, defaultValue: T): T;
	getItem<T>(key: string, defaultValue?: T): T | undefined;
	getItem<T>(key: string, defaultValue?: T): T | undefined { return Object.hasOwn(this.items, key) ? this.items[key] as T : defaultValue; }
	setItem(key: string, data?: object | string | number | boolean | undefined | null): void { this.writes.push(key); this.items[key] = data; }
	setItems(items: readonly { key: string; data?: object | string | number | boolean | undefined | null }[]): void { items.forEach(item => this.setItem(item.key, item.data)); }
	removeItem(key: string): void { this.writes.push(key); delete this.items[key]; }
	async close(): Promise<void> { }
}

suite('devDeviceId resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const logService = new NullLogService();

	test('the app-local key is not the upstream key', () => {
		assert.notStrictEqual(quantlabDevDeviceIdKey, legacyKey);
	});

	test('desktop: a legacy id is replaced by a new UUID stored under the new key, and the legacy key is left untouched', async () => {
		const state = new MemoryState({ [legacyKey]: legacyId });

		const resolved = await resolveDesktopDevDeviceId(state, logService);

		assert.notStrictEqual(resolved, legacyId);
		assert.ok(isUUID(resolved), `not a UUID: ${resolved}`);
		assert.match(resolved, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.strictEqual(state.items[quantlabDevDeviceIdKey], resolved);
		assert.strictEqual(state.items[legacyKey], legacyId);
		assert.deepStrictEqual(state.writes, [quantlabDevDeviceIdKey]);
	});

	test('desktop again and the CLI afterwards return the persisted new id', async () => {
		const state = new MemoryState({ [legacyKey]: legacyId });
		const first = await resolveDesktopDevDeviceId(state, logService);

		assert.strictEqual(await resolveDesktopDevDeviceId(state, logService), first);
		assert.strictEqual(await resolveNodeDevDeviceId(state, logService), first);
		assert.notStrictEqual(first, legacyId);
	});

	test('CLI on a state holding only the legacy key generates an id and writes nothing', async () => {
		const state = new MemoryState({ [legacyKey]: legacyId });

		const resolved = await resolveNodeDevDeviceId(state, logService);

		assert.notStrictEqual(resolved, legacyId);
		assert.ok(isUUID(resolved), `not a UUID: ${resolved}`);
		assert.deepStrictEqual(state.writes, []);
		assert.deepStrictEqual(Object.keys(state.items), [legacyKey]);
	});
});
