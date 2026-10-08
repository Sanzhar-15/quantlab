/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
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
import { IFileService } from '../../../files/common/files.js';
import { IUserDataProfilesService } from '../../../userDataProfile/common/userDataProfile.js';
import { parseSettingsSyncContent, SettingsSynchroniser } from '../../common/settingsSync.js';
import { IRemoteUserData, ISyncData, IUserDataSyncStoreService, SyncResource, UserDataSyncError, UserDataSyncErrorCode } from '../../common/userDataSync.js';
import { assertNoNeverSynced, assertNoNeverSyncedProperty, assertOrdinaryKept, DEMO_EMAIL, DEMO_PASSWORD, IRawSettings, RawStyle, rawSettings } from './rawNeverSyncedSettings.js';
import { UserDataSyncClient, UserDataSyncTestServer } from './userDataSyncClient.js';

/** The test server, remembering the body of every POST so that a test can read what the synchroniser sent, not only what the server ended up holding. */
class RecordingServer extends UserDataSyncTestServer {

	readonly posts: { url: string; body: string | undefined }[] = [];

	forgetPosts(): void {
		this.posts.length = 0;
	}

	override async request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (options.type === 'POST') {
			this.posts.push({ url: options.url!, body: options.data });
		}
		return super.request(options, token);
	}
}

// QuantLab F-SYNC-STRIP-1 (M1): through the REAL SettingsSynchroniser, no settings POST body holds a never-synced key or
// any of its values, however many times the raw JSONC of the local file (and of a remote left by an older client) writes it.
suite('SettingsSync - never-synced settings written more than once (STRIP-1)', () => {

	const server = new RecordingServer();
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
		server.forgetPosts();
	});

	const settingsResource = () => client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;

	async function writeLocal(content: string): Promise<void> {
		await client.instantiationService.get(IFileService).writeFile(settingsResource(), VSBuffer.fromString(content));
		await client.instantiationService.get(IConfigurationService).reloadConfiguration();
	}

	async function readLocal(): Promise<string> {
		return (await client.instantiationService.get(IFileService).readFile(settingsResource())).value.toString();
	}

	// What a client from before the strip left on the server: the raw text is wrapped, not rebuilt.
	async function seedRemote(settings: string): Promise<void> {
		const syncData: ISyncData = { version: 2, machineId: 'client-before-the-strip', content: JSON.stringify({ settings }) };
		await client.instantiationService.get(IUserDataSyncStoreService).writeResource(SyncResource.Settings, JSON.stringify(syncData), null);
		server.forgetPosts();
	}

	/** Every settings POST body of the flow, and what the server holds after it, holds neither key nor any sentinel. */
	async function assertEverythingSentIsClean(sentinels: readonly string[], ordinary: Readonly<Record<string, number>>): Promise<void> {
		const posts = server.posts.filter(post => post.url.endsWith('/resource/settings'));
		assert.ok(posts.length > 0, 'the flow must upload settings');
		for (const [index, post] of posts.entries()) {
			assert.strictEqual(typeof post.body, 'string', `settings POST ${index} has no body`);
			const body = post.body!;
			assertNoNeverSynced(body, sentinels, `settings POST ${index} body`);
			const settings = parseSettingsSyncContent((<ISyncData>JSON.parse(body)).content).settings;
			assertNoNeverSynced(settings, sentinels, `settings POST ${index} settings`);
			assertNoNeverSyncedProperty(settings, `settings POST ${index}`);
			assertOrdinaryKept(settings, ordinary, `settings POST ${index}`);
		}
		const { content } = await client.read(SyncResource.Settings);
		assert.ok(content !== null);
		assertNoNeverSynced(content, sentinels, 'the content the server holds');
	}

	interface ICombination {
		readonly name: string;
		readonly keys: readonly string[];
		readonly occurrences: number;
		readonly style: RawStyle;
	}

	const combinations: ICombination[] = [];
	for (const { name, keys } of [
		{ name: 'email', keys: [DEMO_EMAIL] },
		{ name: 'password', keys: [DEMO_PASSWORD] },
		{ name: 'both keys', keys: [DEMO_EMAIL, DEMO_PASSWORD] },
	]) {
		for (const occurrences of [1, 4, 12]) {
			combinations.push({ name: `${name} x${occurrences} plain`, keys, occurrences, style: 'plain' });
		}
	}
	for (const style of ['comments', 'trailing-comma', 'compact', 'escaped-key'] as const) {
		combinations.push({ name: `both keys x4 ${style}`, keys: [DEMO_EMAIL, DEMO_PASSWORD], occurrences: 4, style });
	}

	for (const { name, keys, occurrences, style } of combinations) {

		const local = (): IRawSettings => rawSettings(keys, occurrences, style, 'SENTINEL', 'local');
		const remote = (): IRawSettings => rawSettings(keys, occurrences, style, 'REMOTE-SENTINEL', 'remote');

		test(`first upload: ${name}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const fixture = local();
			await writeLocal(fixture.text);

			await testObject.sync(await client.getLatestRef(SyncResource.Settings));

			await assertEverythingSentIsClean(fixture.sentinels, fixture.ordinary);
			assert.strictEqual(await readLocal(), fixture.text, 'the local file keeps its text');
		}));

		test(`accept local, no remote yet: ${name}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const fixture = local();
			await writeLocal(fixture.text);

			const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
			await testObject.accept(preview!.resourcePreviews[0].localResource);
			await testObject.apply(false);

			await assertEverythingSentIsClean(fixture.sentinels, fixture.ordinary);
			assert.strictEqual(await readLocal(), fixture.text, 'the local file keeps its text');
		}));

		// A remote left by an older client makes the synchroniser merge, and the merge inserts the other side's ordinary
		// settings with addSetting, whose placement around comments and commas is not the subject here: the flows that
		// start from a remote run on the plain layout only.
		if (style === 'plain') {

			test(`accept local over a remote that holds the keys too: ${name}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
				const fixture = local();
				const other = remote();
				await seedRemote(other.text);
				await writeLocal(fixture.text);

				const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
				await testObject.accept(preview!.resourcePreviews[0].localResource);
				await testObject.apply(false);

				await assertEverythingSentIsClean([...fixture.sentinels, ...other.sentinels], fixture.ordinary);
				assert.strictEqual(await readLocal(), fixture.text, 'the local file keeps its text');
			}));

			// The merge compares the ordinary settings of both sides in order, and treats any difference as a conflict a user has to
			// resolve, so a sync() that merges uploads nothing (it waits in HasConflicts). To merge without conflict the remote
			// holds the same ordinary settings as the local file, in the same order, and differs by the keys it holds.
			test(`merge with a remote that holds the keys too: ${name}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
				const fixture = local();
				const other = rawSettings(keys, occurrences, style, 'REMOTE-SENTINEL', 'local');
				assert.deepStrictEqual(other.ordinary, fixture.ordinary);
				await seedRemote(other.text);
				await writeLocal(fixture.text);

				await testObject.sync(await client.getLatestRef(SyncResource.Settings));

				await assertEverythingSentIsClean([...fixture.sentinels, ...other.sentinels], fixture.ordinary);
				// the local file keeps every value it had and never takes one of the remote's
				const written = await readLocal();
				assert.strictEqual(written, fixture.text, 'the local file keeps its text');
				for (const sentinel of other.sentinels) {
					assert.ok(!written.includes(sentinel), `the local file took the remote's ${sentinel}`);
				}
			}));
		}

		test(`accept an edited preview that writes the keys several times: ${name}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const fixture = local();
			await writeLocal(fixture.text);

			const preview = await testObject.sync(await client.getLatestRef(SyncResource.Settings), true);
			await testObject.accept(preview!.resourcePreviews[0].previewResource, fixture.text);
			await testObject.apply(false);

			await assertEverythingSentIsClean(fixture.sentinels, fixture.ordinary);
			// the local file keeps the local value (the last one the parser reads) of every key
			const written = await readLocal();
			assert.ok(written.includes(fixture.sentinels[fixture.sentinels.length - 1]), 'the local file lost its last value');
		}));
	}

	// merge() now throws on content that does not parse; a local file being typed must still announce a local change (and the
	// sync then reports LocalInvalidContent), never end in a rejected local-change check.
	test('a local file that does not parse is a local change, and the sync reports it as invalid content', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const fixture = rawSettings([DEMO_EMAIL, DEMO_PASSWORD], 4, 'plain', 'SENTINEL', 'local');
		await writeLocal(fixture.text);
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));
		server.forgetPosts();

		const changed = Event.toPromise(testObject.onDidChangeLocal);
		await writeLocal(`{\n\t"files.autoSave": "off",\n\t"${DEMO_PASSWORD}": "SENTINEL-TYPING`);
		await changed;

		await assert.rejects(testObject.sync(await client.getLatestRef(SyncResource.Settings)), (error: unknown) => error instanceof UserDataSyncError && error.code === UserDataSyncErrorCode.LocalInvalidContent);
		assert.deepStrictEqual(server.posts.filter(post => post.url.endsWith('/resource/settings')), [], 'nothing is uploaded from a file that does not parse');
	}));

	// QuantLab F-SYNC-STRIP-2 (L4, B5): hasRemoteChanged checks a local file that exists for syntax errors, and treats an absent
	// file and an empty one as two explicit cases, each read as `{}` the way upstream reads them. Neither is passed through the
	// parse check as a substituted '{}': the check is never run on them (the `localContent || '{}'` form ran it on '{}').
	interface ISynchroniserInternals {
		hasRemoteChanged(lastSyncUserData: IRemoteUserData): Promise<boolean>;
		hasErrors(content: string, isArray: boolean): boolean;
	}

	/** After a sync of one ordinary setting, the last sync data, and a record of every content `hasErrors` is asked about from now on. */
	async function syncedOnceAndWatchHasErrors(): Promise<{ internals: ISynchroniserInternals; lastSyncUserData: IRemoteUserData; checked: string[] }> {
		await writeLocal('{\n\t"files.autoSave": "off"\n}');
		await testObject.sync(await client.getLatestRef(SyncResource.Settings));
		const lastSyncUserData = await testObject.getLastSyncUserData();
		assert.ok(lastSyncUserData);
		const internals = testObject as unknown as ISynchroniserInternals;
		const original = internals.hasErrors.bind(testObject);
		const checked: string[] = [];
		internals.hasErrors = (content, isArray) => {
			checked.push(content);
			return original(content, isArray);
		};
		return { internals, lastSyncUserData, checked };
	}

	test('hasRemoteChanged, the local file is absent: a local change, and nothing is parse-checked', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const { internals, lastSyncUserData, checked } = await syncedOnceAndWatchHasErrors();
		await client.instantiationService.get(IFileService).del(settingsResource());

		assert.strictEqual(await internals.hasRemoteChanged(lastSyncUserData), true);
		assert.deepStrictEqual(checked, [], 'an absent file is not parse-checked (as a substituted {} or otherwise)');
	}));

	test('hasRemoteChanged, the local file is empty: a local change, and nothing is parse-checked', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const { internals, lastSyncUserData, checked } = await syncedOnceAndWatchHasErrors();
		await writeLocal('');

		assert.strictEqual(await internals.hasRemoteChanged(lastSyncUserData), true);
		assert.deepStrictEqual(checked, [], 'empty content is not parse-checked');
	}));

	test('hasRemoteChanged, the local file holds only whitespace: read as empty, and nothing is parse-checked', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const { internals, lastSyncUserData, checked } = await syncedOnceAndWatchHasErrors();
		await writeLocal('  \n\t \n');

		assert.strictEqual(await internals.hasRemoteChanged(lastSyncUserData), true);
		assert.deepStrictEqual(checked, [], 'whitespace-only content is not parse-checked');
	}));

	test('hasRemoteChanged, the local file exists and is unchanged: no change, and its own trimmed content is what is parse-checked', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const { internals, lastSyncUserData, checked } = await syncedOnceAndWatchHasErrors();
		const content = await readLocal();

		assert.strictEqual(await internals.hasRemoteChanged(lastSyncUserData), false);
		assert.ok(checked.length >= 1, 'content that exists is parse-checked');
		assert.ok(checked.every(entry => entry === content.trim()), `only the file's own content is checked, not a substitute: ${JSON.stringify(checked)}`);
	}));

	test('hasRemoteChanged, the local file exists and does not parse: a local change', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const { internals, lastSyncUserData, checked } = await syncedOnceAndWatchHasErrors();
		const broken = '{\n\t"files.autoSave": "off",\n\t"qic.demo.password": "SENTINEL-TYPING';
		await writeLocal(broken);

		assert.strictEqual(await internals.hasRemoteChanged(lastSyncUserData), true);
		assert.ok(checked.length >= 1 && checked.every(entry => entry === broken), JSON.stringify(checked));
	}));
});
