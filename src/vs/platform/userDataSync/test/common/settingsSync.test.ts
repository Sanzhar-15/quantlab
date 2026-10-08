/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../configuration/common/configurationRegistry.js';
import { IFileService } from '../../../files/common/files.js';
import { Registry } from '../../../registry/common/platform.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../userDataProfile/common/userDataProfile.js';
import { ISettingsSyncContent, parseSettingsSyncContent, SettingsSynchroniser } from '../../common/settingsSync.js';
import { ISyncData, IUserDataSyncStoreService, SyncResource, SyncStatus, UserDataSyncError, UserDataSyncErrorCode } from '../../common/userDataSync.js';
import { UserDataSyncClient, UserDataSyncTestServer } from './userDataSyncClient.js';

suite('SettingsSync - Auto', () => {

	const server = new UserDataSyncTestServer();
	let client: UserDataSyncClient;
	let testObject: SettingsSynchroniser;

	teardown(async () => {
		await client.instantiationService.get(IUserDataSyncStoreService).clear();
	});

	const disposableStore = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
			'id': 'settingsSync',
			'type': 'object',
			'properties': {
				'settingsSync.machine': {
					'type': 'string',
					'scope': ConfigurationScope.MACHINE
				},
				'settingsSync.machineOverridable': {
					'type': 'string',
					'scope': ConfigurationScope.MACHINE_OVERRIDABLE
				}
			}
		});
		client = disposableStore.add(new UserDataSyncClient(server));
		await client.setUp(true);
		testObject = client.getSynchronizer(SyncResource.Settings) as SettingsSynchroniser;
	});

	test('when settings file does not exist', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const fileService = client.instantiationService.get(IFileService);
		const settingResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;

		assert.deepStrictEqual(await testObject.getLastSyncUserData(), null);
		let manifest = await client.getLatestRef(SyncResource.Settings);
		server.reset();
		await testObject.sync(manifest);

		assert.deepStrictEqual(server.requests, []);
		assert.ok(!await fileService.exists(settingResource));

		const lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.deepStrictEqual(lastSyncUserData!.ref, remoteUserData.ref);
		assert.deepStrictEqual(lastSyncUserData!.syncData, remoteUserData.syncData);
		assert.strictEqual(lastSyncUserData!.syncData, null);

		manifest = await client.getLatestRef(SyncResource.Settings);
		server.reset();
		await testObject.sync(manifest);
		assert.deepStrictEqual(server.requests, []);

		manifest = await client.getLatestRef(SyncResource.Settings);
		server.reset();
		await testObject.sync(manifest);
		assert.deepStrictEqual(server.requests, []);
	}));

	test('when settings file is empty and remote has no changes', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const fileService = client.instantiationService.get(IFileService);
		const settingsResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
		await fileService.writeFile(settingsResource, VSBuffer.fromString(''));

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.strictEqual(parseSettingsSyncContent(lastSyncUserData!.syncData!.content)?.settings, '{}');
		assert.strictEqual(parseSettingsSyncContent(remoteUserData.syncData!.content)?.settings, '{}');
		assert.strictEqual((await fileService.readFile(settingsResource)).value.toString(), '');
	}));

	test('when settings file is empty and remote has changes', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const client2 = disposableStore.add(new UserDataSyncClient(server));
		await client2.setUp(true);
		const content =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",
	"workbench.tree.indent": 20,
	"workbench.colorCustomizations": {
		"editorLineNumber.activeForeground": "#ff0000",
		"[GitHub Sharp]": {
			"statusBarItem.remoteBackground": "#24292E",
			"editorPane.background": "#f3f1f11a"
		}
	},

	"gitBranch.base": "remote-repo/master",

	// Experimental
	"workbench.view.experimental.allowMovingToNewContainer": true,
}`;
		await client2.instantiationService.get(IFileService).writeFile(client2.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource, VSBuffer.fromString(content));
		await client2.sync();

		const fileService = client.instantiationService.get(IFileService);
		const settingsResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
		await fileService.writeFile(settingsResource, VSBuffer.fromString(''));

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.strictEqual(parseSettingsSyncContent(lastSyncUserData!.syncData!.content)?.settings, content);
		assert.strictEqual(parseSettingsSyncContent(remoteUserData.syncData!.content)?.settings, content);
		assert.strictEqual((await fileService.readFile(settingsResource)).value.toString(), content);
	}));

	test('when settings file is created after first sync', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const fileService = client.instantiationService.get(IFileService);

		const settingsResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));
		await fileService.createFile(settingsResource, VSBuffer.fromString('{}'));

		let lastSyncUserData = await testObject.getLastSyncUserData();
		const manifest = await client.getLatestRef(SyncResource.Settings);
		server.reset();
		await testObject.sync(manifest);

		assert.deepStrictEqual(server.requests, [
			{ type: 'POST', url: `${server.url}/v1/resource/${testObject.resource}`, headers: { 'If-Match': lastSyncUserData?.ref } },
		]);

		lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.deepStrictEqual(lastSyncUserData!.ref, remoteUserData.ref);
		assert.deepStrictEqual(lastSyncUserData!.syncData, remoteUserData.syncData);
		assert.strictEqual(parseSettingsSyncContent(lastSyncUserData!.syncData!.content)?.settings, '{}');
	}));

	test('sync for first time to the server', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const expected =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",
	"workbench.tree.indent": 20,
	"workbench.colorCustomizations": {
		"editorLineNumber.activeForeground": "#ff0000",
		"[GitHub Sharp]": {
			"statusBarItem.remoteBackground": "#24292E",
			"editorPane.background": "#f3f1f11a"
		}
	},

	"gitBranch.base": "remote-repo/master",

	// Experimental
	"workbench.view.experimental.allowMovingToNewContainer": true,
}`;

		await updateSettings(expected, client);
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, expected);
	}));

	test('do not sync machine settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Machine
	"settingsSync.machine": "someValue",
	"settingsSync.machineOverridable": "someValue"
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp"
}`);
	}));

	test('do not sync machine settings when spread across file', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"settingsSync.machine": "someValue",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Machine
	"settingsSync.machineOverridable": "someValue"
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp"
}`);
	}));

	test('do not sync machine settings when spread across file - 2', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"settingsSync.machine": "someValue",

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Machine
	"settingsSync.machineOverridable": "someValue",
	"files.simpleDialog.enable": true,
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",
	"files.simpleDialog.enable": true,
}`);
	}));

	test('sync when all settings are machine settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Machine
	"settingsSync.machine": "someValue",
	"settingsSync.machineOverridable": "someValue"
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
}`);
	}));

	test('sync when all settings are machine settings with trailing comma', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Machine
	"settingsSync.machine": "someValue",
	"settingsSync.machineOverridable": "someValue",
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	,
}`);
	}));

	test('local change event is triggered when settings are changed', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const content =
			`{
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,
}`;

		await updateSettings(content, client);
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const promise = Event.toPromise(testObject.onDidChangeLocal);
		await updateSettings(`{
	"files.autoSave": "off",
	"files.simpleDialog.enable": true,
}`, client);
		await promise;
	}));

	test('do not sync ignored settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Editor
	"editor.fontFamily": "Fira Code",

	// Terminal
	"terminal.integrated.shell.osx": "some path",

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	]
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	]
}`);
	}));

	test('do not sync ignored and machine settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Editor
	"editor.fontFamily": "Fira Code",

	// Terminal
	"terminal.integrated.shell.osx": "some path",

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	],

	// Machine
	"settingsSync.machine": "someValue",
}`;
		await updateSettings(settingsContent, client);

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	],
}`);
	}));

	test('sync throws invalid content error', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const expected =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",
	"workbench.tree.indent": 20,
	"workbench.colorCustomizations": {
		"editorLineNumber.activeForeground": "#ff0000",
		"[GitHub Sharp]": {
			"statusBarItem.remoteBackground": "#24292E",
			"editorPane.background": "#f3f1f11a"
		}
	}

	"gitBranch.base": "remote-repo/master",

	// Experimental
	"workbench.view.experimental.allowMovingToNewContainer": true,
}`;

		await updateSettings(expected, client);

		try {
			await testObject.sync(await client.getLatestRef(SyncResource.Settings));
			assert.fail('should fail with invalid content error');
		} catch (e) {
			assert.ok(e instanceof UserDataSyncError);
			assert.deepStrictEqual((<UserDataSyncError>e).code, UserDataSyncErrorCode.LocalInvalidContent);
		}
	}));

	test('sync throws invalid content error - content is an array', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		await updateSettings('[]', client);
		try {
			await testObject.sync(await client.getLatestRef(SyncResource.Settings));
			assert.fail('should fail with invalid content error');
		} catch (e) {
			assert.ok(e instanceof UserDataSyncError);
			assert.deepStrictEqual((<UserDataSyncError>e).code, UserDataSyncErrorCode.LocalInvalidContent);
		}
	}));

	test('sync when there are conflicts', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const client2 = disposableStore.add(new UserDataSyncClient(server));
		await client2.setUp(true);
		await updateSettings(JSON.stringify({
			'a': 1,
			'b': 2,
			'settingsSync.ignoredSettings': ['a']
		}), client2);
		await client2.sync();

		await updateSettings(JSON.stringify({
			'a': 2,
			'b': 1,
			'settingsSync.ignoredSettings': ['a']
		}), client);
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		assert.strictEqual(testObject.status, SyncStatus.HasConflicts);
		assert.strictEqual(testObject.conflicts.conflicts[0].localResource.toString(), testObject.localResource.toString());

		const fileService = client.instantiationService.get(IFileService);
		const mergeContent = (await fileService.readFile(testObject.conflicts.conflicts[0].previewResource)).value.toString();
		assert.strictEqual(mergeContent, '');
	}));

	test('sync profile settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const client2 = disposableStore.add(new UserDataSyncClient(server));
		await client2.setUp(true);
		const profile = await client2.instantiationService.get(IUserDataProfilesService).createNamedProfile('profile1');
		await updateSettings(JSON.stringify({
			'a': 1,
			'b': 2,
		}), client2, profile);
		await client2.sync();

		await client.sync();

		assert.strictEqual(testObject.status, SyncStatus.Idle);

		const syncedProfile = client.instantiationService.get(IUserDataProfilesService).profiles.find(p => p.id === profile.id)!;
		const content = (await client.instantiationService.get(IFileService).readFile(syncedProfile.settingsResource)).value.toString();
		assert.deepStrictEqual(JSON.parse(content), {
			'a': 1,
			'b': 2,
		});
	}));

});

suite('SettingsSync - Manual', () => {

	const server = new UserDataSyncTestServer();
	let client: UserDataSyncClient;
	let testObject: SettingsSynchroniser;

	teardown(async () => {
		await client.instantiationService.get(IUserDataSyncStoreService).clear();
	});

	const disposableStore = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		client = disposableStore.add(new UserDataSyncClient(server));
		await client.setUp(true);
		testObject = client.getSynchronizer(SyncResource.Settings) as SettingsSynchroniser;
	});

	test('do not sync ignored settings', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const settingsContent =
			`{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Editor
	"editor.fontFamily": "Fira Code",

	// Terminal
	"terminal.integrated.shell.osx": "some path",

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	]
}`;
		await updateSettings(settingsContent, client);

		let preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
		assert.strictEqual(testObject.status, SyncStatus.Syncing);
		preview = await testObject.accept(preview!.resourcePreviews[0].previewResource);
		preview = await testObject.apply(false);

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseSettings(content);
		assert.deepStrictEqual(actual, `{
	// Always
	"files.autoSave": "afterDelay",
	"files.simpleDialog.enable": true,

	// Workbench
	"workbench.colorTheme": "GitHub Sharp",

	// Ignored
	"settingsSync.ignoredSettings": [
		"editor.fontFamily",
		"terminal.integrated.shell.osx"
	]
}`);
	}));

});

// The shared test server keeps the URL, type and headers of a request but not its body. This one also keeps the body of every
// settings upload (a POST to `.../resource/settings`, in the default profile or in a collection), so a test can inspect all of them.
class BodyRecordingTestServer extends UserDataSyncTestServer {

	private _settingsPostBodies: string[] = [];
	get settingsPostBodies(): readonly string[] { return this._settingsPostBodies; }
	clearSettingsPostBodies(): void { this._settingsPostBodies = []; }

	override async request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (options.type === 'POST' && options.url?.endsWith(`/resource/${SyncResource.Settings}`)) {
			if (typeof options.data !== 'string') {
				throw new Error(`a settings POST to ${options.url} carries no string body`);
			}
			this._settingsPostBodies.push(options.data);
		}
		return super.request(options, token);
	}
}

const neverSyncedKeys = ['qic.demo.email', 'qic.demo.password'];

// A settings upload body as a client sends it: the ISyncData envelope around the ISettingsSyncContent around the settings text.
function toSettingsPostBody(settings: Record<string, unknown>): string {
	const syncData: ISyncData = { version: 2, machineId: 'client-before-sync-1', content: JSON.stringify({ settings: JSON.stringify(settings, null, '\t') }) };
	return JSON.stringify(syncData);
}

// Every settings upload body must carry neither never-synced key nor any of the sentinel values. The opt-in entry `-<key>` of
// `settingsSync.ignoredSettings` names a key without carrying a setting, so that one form is allowed in the raw text; any other
// occurrence of a key name is a leak, and so is a key as an own property of the parsed settings. Throws on the first leak; the
// message names the body (by position) that carries it. An empty list passes: a caller that expects uploads passes a minimum count.
function assertNoNeverSyncedInPostBodies(bodies: readonly string[], sentinels: readonly string[], message: string): void {
	bodies.forEach((body, index) => {
		const where = `${message}: settings POST body #${index}`;
		for (const sentinel of sentinels) {
			assert.ok(!body.includes(sentinel), `${where} carries sentinel ${sentinel}`);
		}
		let rest = body;
		for (const key of neverSyncedKeys) {
			rest = rest.split(`"-${key}`).join('"');
		}
		for (const key of neverSyncedKeys) {
			assert.ok(!rest.includes(key), `${where} names ${key}`);
		}
		const parsed: Record<string, unknown> = JSON.parse(parseSettings(body));
		for (const key of neverSyncedKeys) {
			assert.ok(!Object.prototype.hasOwnProperty.call(parsed, key), `${where} holds ${key} as a setting`);
		}
	});
}

// The inspection helper itself, with its negative control: it must fail on a credential-bearing upload even when a clean upload
// follows it and the final remote state is clean (what a check of the latest remote content alone cannot see).
suite('SettingsSync - never-synced settings (SYNC-1) - upload body inspection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sentinels = ['SENTINEL-dirty-not-a-real-address', 'SENTINEL-dirty-not-a-real-value'];
	const dirtyPair = { 'qic.demo.email': sentinels[0], 'qic.demo.password': sentinels[1] };
	const optIn = { 'settingsSync.ignoredSettings': ['-qic.demo.email', '-qic.demo.password'] };

	test('a clean upload passes, the opt-in entries included, and no upload passes', () => {
		assertNoNeverSyncedInPostBodies([], sentinels, 'none');
		assertNoNeverSyncedInPostBodies([toSettingsPostBody({ 'a': 1 }), toSettingsPostBody({ 'a': 2, ...optIn })], sentinels, 'clean');
	});

	test('negative control: a credential-bearing upload followed by a clean one fails, whatever the final state', () => {
		const dirtyBody = toSettingsPostBody({ 'a': 1, ...dirtyPair });
		const cleanBody = toSettingsPostBody({ 'a': 1 });
		assert.throws(() => assertNoNeverSyncedInPostBodies([dirtyBody, cleanBody], sentinels, 'two uploads'), /settings POST body #0 /);
		assert.throws(() => assertNoNeverSyncedInPostBodies([cleanBody, dirtyBody, cleanBody], sentinels, 'three uploads'), /settings POST body #1 /);
		assert.doesNotThrow(() => assertNoNeverSyncedInPostBodies([cleanBody], sentinels, 'the clean final state alone'));
	});

	test('each leak form fails on its own: a sentinel value, a key name, a key as a setting', () => {
		assert.throws(() => assertNoNeverSyncedInPostBodies([toSettingsPostBody({ 'a': sentinels[0] })], sentinels, 'sentinel under another key'), /carries sentinel/);
		assert.throws(() => assertNoNeverSyncedInPostBodies([toSettingsPostBody({ 'qic.demo.email': 'x' })], sentinels, 'key with a non-sentinel value'), /names qic.demo.email/);
		assert.throws(() => assertNoNeverSyncedInPostBodies([toSettingsPostBody({ 'a': ['qic.demo.password'] })], sentinels, 'key name as a value'), /names qic.demo.password/);
		assert.throws(() => assertNoNeverSyncedInPostBodies([toSettingsPostBody({ 'a': ['-qic.demo.password', 'qic.demo.password'] })], sentinels, 'opt-in form next to the bare name'), /names qic.demo.password/);
	});

	test('an unparseable body is an error, not a pass', () => {
		assert.throws(() => assertNoNeverSyncedInPostBodies(['not json'], sentinels, 'garbage'), SyntaxError);
	});
});

// QuantLab carry SYNC-1, c1 repair M2: the synchroniser never uploads the never-synced pair, also when the remote already holds
// it (applyResult rebuilds the upload against the remote), and content it writes to the local file keeps the local values.
// c1 repair S5: every settings upload body after any deliberate seeding is inspected, not only the latest remote content.
suite('SettingsSync - never-synced settings (SYNC-1)', () => {

	const server = new BodyRecordingTestServer();
	let client: UserDataSyncClient;
	let testObject: SettingsSynchroniser;

	teardown(async () => {
		await client.instantiationService.get(IUserDataSyncStoreService).clear();
	});

	const disposableStore = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		server.clearSettingsPostBodies();
		client = disposableStore.add(new UserDataSyncClient(server));
		await client.setUp(true);
		testObject = client.getSynchronizer(SyncResource.Settings) as SettingsSynchroniser;
	});

	const remotePair = { 'qic.demo.email': 'SENTINEL-remote-not-a-real-address', 'qic.demo.password': 'SENTINEL-remote-not-a-real-value' };
	const localPair = { 'qic.demo.email': 'SENTINEL-local-not-a-real-address', 'qic.demo.password': 'SENTINEL-local-not-a-real-value' };

	// What a client from before SYNC-1 left on the server. The seeding upload deliberately carries the pair, so it is not one of the
	// bodies the tests inspect: the recording starts again after it.
	async function seedRemote(settings: Record<string, unknown>): Promise<void> {
		await client.instantiationService.get(IUserDataSyncStoreService).writeResource(SyncResource.Settings, toSettingsPostBody(settings), null);
		server.clearSettingsPostBodies();
	}

	const allSentinels = [...Object.values(remotePair), ...Object.values(localPair)];

	// Every settings upload since the setup or the last seeding, not only what the remote holds at the end.
	function assertEveryUploadHoldsNoPair(message: string, minimumUploads: number): void {
		assert.ok(server.settingsPostBodies.length >= minimumUploads, `${message}: expected at least ${minimumUploads} settings uploads, recorded ${server.settingsPostBodies.length}`);
		assertNoNeverSyncedInPostBodies(server.settingsPostBodies, allSentinels, message);
	}

	test('accepting local uploads content without the pair the remote holds', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		await seedRemote({ 'a': 1, ...remotePair });
		await updateSettings(JSON.stringify({ 'b': 2 }), client);

		const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
		await testObject.accept(preview!.resourcePreviews[0].localResource);
		await testObject.apply(false);

		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null);
		assert.deepStrictEqual(JSON.parse(parseSettings(content)), { 'b': 2 });
		assertEveryUploadHoldsNoPair('accept local', 1);
	}));

	test('accepting the remote keeps the local values of the pair, never the remote ones', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		await seedRemote({ 'a': 1, ...remotePair });
		await updateSettings(JSON.stringify({ 'b': 2, ...localPair }), client);

		const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
		await testObject.accept(preview!.resourcePreviews[0].remoteResource);
		await testObject.apply(false);

		const settingsResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
		const local = (await client.instantiationService.get(IFileService).readFile(settingsResource)).value.toString();
		assert.deepStrictEqual(JSON.parse(local), { 'a': 1, ...localPair });
		assertEveryUploadHoldsNoPair('accept remote', 0);
	}));

	// The opt-back-in form of `settingsSync.ignoredSettings`, read by the real ConfigurationService from the local settings file.
	const optBackIn = { 'settingsSync.ignoredSettings': ['-qic.demo.email', '-qic.demo.password'] };

	async function readLocalSettings(): Promise<unknown> {
		const settingsResource = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
		return JSON.parse((await client.instantiationService.get(IFileService).readFile(settingsResource)).value.toString());
	}

	// The opt-in as the configuration service holds it: the user value of `settingsSync.ignoredSettings` read from the local file.
	// Without this the uploaded array alone would not show that the opt-in was in force when the upload was built.
	function assertOptInHeldByConfigurationService(): void {
		const inspected = client.instantiationService.get(IConfigurationService).inspect<string[]>('settingsSync.ignoredSettings');
		assert.deepStrictEqual(inspected.userValue, optBackIn['settingsSync.ignoredSettings'], 'the configuration service must hold the opt-back-in entries');
	}

	// The opt-in entries themselves name the keys, so the uploaded content is checked as parsed settings (own properties) and for the sentinel values.
	async function assertRemoteHoldsNoPair(message: string): Promise<Record<string, unknown>> {
		const { content } = await client.read(testObject.resource);
		assert.ok(content !== null, `${message}: the remote must hold content`);
		const uploaded = parseSettings(content);
		for (const sentinel of [...Object.values(remotePair), ...Object.values(localPair)]) {
			assert.ok(!uploaded.includes(sentinel), `${message}: sentinel ${sentinel} is in the uploaded content`);
		}
		const parsed: Record<string, unknown> = JSON.parse(uploaded);
		assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'qic.demo.email'), `${message}: qic.demo.email is in the uploaded content`);
		assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'qic.demo.password'), `${message}: qic.demo.password is in the uploaded content`);
		return parsed;
	}

	test('user opts both keys back in: first auto sync uploads neither key and the local file keeps them', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const local = { 'a': 1, ...localPair, ...optBackIn };
		await updateSettings(JSON.stringify(local), client);
		assertOptInHeldByConfigurationService();

		await testObject.sync(await client.getLatestRef(SyncResource.Settings));
		assertEveryUploadHoldsNoPair('first sync', 1);

		const uploaded = await assertRemoteHoldsNoPair('first sync');
		assert.strictEqual(uploaded['a'], 1, 'the ordinary setting must reach the remote');
		assert.deepStrictEqual(uploaded['settingsSync.ignoredSettings'], optBackIn['settingsSync.ignoredSettings'], 'the opt-in must have been in force for this sync');
		assert.deepStrictEqual(await readLocalSettings(), local);
	}));

	test('user opts both keys back in: a later sync of an unrelated change uploads neither key and the local file keeps them', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		await updateSettings(JSON.stringify({ 'a': 1, ...localPair, ...optBackIn }), client);
		assertOptInHeldByConfigurationService();
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));
		await assertRemoteHoldsNoPair('first sync');
		assertEveryUploadHoldsNoPair('first sync', 1);

		const changed = { 'a': 2, ...localPair, ...optBackIn };
		await updateSettings(JSON.stringify(changed), client);
		assertOptInHeldByConfigurationService();
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));

		const uploaded = await assertRemoteHoldsNoPair('later sync');
		assert.strictEqual(uploaded['a'], 2, 'the unrelated change must reach the remote');
		assertEveryUploadHoldsNoPair('later sync', 2);
		assert.deepStrictEqual(await readLocalSettings(), changed);
	}));

	test('user opts both keys back in and the remote already holds the pair: accepting local uploads neither key and the local file keeps them', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		await seedRemote({ 'a': 1, ...remotePair });
		const local = { 'b': 2, ...localPair, ...optBackIn };
		await updateSettings(JSON.stringify(local), client);
		assertOptInHeldByConfigurationService();

		const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
		await testObject.accept(preview!.resourcePreviews[0].localResource);
		await testObject.apply(false);

		const uploaded = await assertRemoteHoldsNoPair('accept local');
		assert.strictEqual(uploaded['b'], 2, 'the ordinary setting must reach the remote');
		assertEveryUploadHoldsNoPair('accept local', 1);
		assert.deepStrictEqual(await readLocalSettings(), local);
	}));

});

function parseSettings(content: string): string {
	const syncData: ISyncData = JSON.parse(content);
	const settingsSyncContent: ISettingsSyncContent = JSON.parse(syncData.content);
	return settingsSyncContent.settings;
}

async function updateSettings(content: string, client: UserDataSyncClient, profile?: IUserDataProfile): Promise<void> {
	await client.instantiationService.get(IFileService).writeFile((profile ?? client.instantiationService.get(IUserDataProfilesService).defaultProfile).settingsResource, VSBuffer.fromString(content));
	await client.instantiationService.get(IConfigurationService).reloadConfiguration();
}
