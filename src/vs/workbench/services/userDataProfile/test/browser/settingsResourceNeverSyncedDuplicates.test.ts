/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { NeverSyncedSettingsError } from '../../../../../platform/userDataSync/common/settingsMerge.js';
import { assertNoNeverSynced, assertNoNeverSyncedProperty, assertOrdinaryKept, DEMO_EMAIL, DEMO_PASSWORD, RawStyle, rawSettings } from '../../../../../platform/userDataSync/test/common/rawNeverSyncedSettings.js';
import { TestUserDataSyncUtilService } from '../../../../../platform/userDataSync/test/common/userDataSyncClient.js';
import { SettingsResource } from '../../browser/settingsResource.js';

// QuantLab F-SYNC-STRIP-1 (M1): a profile export (SettingsResource.getSettingsContent / getContent) holds no occurrence of a
// never-synced key and none of its values, however many times the raw JSONC of the settings file writes the key. There was no
// test for the SettingsResource class itself before this one: it is built here from its three constructor services (a real
// FileService over an in-memory provider, the sync util test double, a null log), with only `settingsResource` of the profile.
suite('SettingsResource profile export - never-synced settings written more than once (STRIP-1)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: IFileService;
	let testObject: SettingsResource;
	const settingsResource = URI.from({ scheme: Schemas.inMemory, path: '/user/settings.json' });
	const profile = { settingsResource } as Partial<IUserDataProfile> as IUserDataProfile;

	setup(() => {
		const logService = new NullLogService();
		const service = disposables.add(new FileService(logService));
		disposables.add(service.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		fileService = service;
		testObject = new SettingsResource(fileService, new TestUserDataSyncUtilService(), logService);
	});

	async function writeSettings(content: string): Promise<void> {
		await fileService.writeFile(settingsResource, VSBuffer.fromString(content));
	}

	async function readSettings(): Promise<string> {
		return (await fileService.readFile(settingsResource)).value.toString();
	}

	const keySets: { name: string; keys: readonly string[] }[] = [
		{ name: 'email', keys: [DEMO_EMAIL] },
		{ name: 'password', keys: [DEMO_PASSWORD] },
		{ name: 'both keys', keys: [DEMO_EMAIL, DEMO_PASSWORD] },
	];
	const combinations: { name: string; keys: readonly string[]; occurrences: number; style: RawStyle }[] = [];
	for (const { name, keys } of keySets) {
		for (const occurrences of [1, 4, 12]) {
			combinations.push({ name: `${name} x${occurrences} plain`, keys, occurrences, style: 'plain' });
		}
		for (const style of ['comments', 'trailing-comma', 'compact', 'escaped-key'] as const) {
			combinations.push({ name: `${name} x4 ${style}`, keys, occurrences: 4, style });
		}
	}
	combinations.push({ name: 'both keys x4 keys-only-trailing-comma', keys: [DEMO_EMAIL, DEMO_PASSWORD], occurrences: 4, style: 'keys-only-trailing-comma' });

	for (const { name, keys, occurrences, style } of combinations) {

		test(`getSettingsContent: ${name}`, async () => {
			const fixture = rawSettings(keys, occurrences, style, 'SENTINEL', 'local');
			await writeSettings(fixture.text);

			const { settings } = await testObject.getSettingsContent(profile);

			assert.ok(settings !== null, 'the export must hold the settings');
			assertNoNeverSynced(settings, fixture.sentinels, name);
			assertNoNeverSyncedProperty(settings, name);
			assertOrdinaryKept(settings, fixture.ordinary, name);
			assert.strictEqual(await readSettings(), fixture.text, 'the settings file keeps its text');
		});

		test(`getContent (the exported string): ${name}`, async () => {
			const fixture = rawSettings(keys, occurrences, style, 'SENTINEL', 'local');
			await writeSettings(fixture.text);

			const exported = await testObject.getContent(profile);

			assertNoNeverSynced(exported, fixture.sentinels, name);
			const settings = (<{ settings: string | null }>JSON.parse(exported)).settings;
			assert.ok(settings !== null);
			assertNoNeverSyncedProperty(settings, name);
			assertOrdinaryKept(settings, fixture.ordinary, name);
		});
	}

	test('a profile without a settings file exports no settings', async () => {
		assert.deepStrictEqual(await testObject.getSettingsContent(profile), { settings: null });
	});

	test('an empty settings file is exported as an empty object', async () => {
		await writeSettings('');
		assert.deepStrictEqual(await testObject.getSettingsContent(profile), { settings: '{}' });
	});

	test('a settings file that does not parse fails the export, naming no value', async () => {
		await writeSettings('{ "editor.fontSize": 14 "qic.demo.password": "SENTINEL-broken" }');
		await assert.rejects(
			testObject.getSettingsContent(profile),
			(error: unknown) => error instanceof NeverSyncedSettingsError && !error.message.includes('SENTINEL-broken')
		);
	});
});
