/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { transformErrorForSerialization } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILoggerService, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { MainThreadAuthentication } from '../../browser/mainThreadAuthentication.js';
import { ExtHostAuthenticationShape, MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { DynamicAuthProvider, ExtHostAuthentication } from '../../common/extHostAuthentication.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { IAuthenticationAccessService } from '../../../services/authentication/browser/authenticationAccessService.js';
import { AuthenticationService } from '../../../services/authentication/browser/authenticationService.js';
import { DynamicAuthenticationProviderStorageService } from '../../../services/authentication/browser/dynamicAuthenticationProviderStorageService.js';
import { IAuthenticationExtensionsService } from '../../../services/authentication/common/authentication.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IExtHostContext } from '../../../services/extensions/common/extHostCustomers.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { TestStorageService } from '../../../test/common/workbenchTestServices.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IAuthenticationUsageService } from '../../../services/authentication/browser/authenticationUsageService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

const AUTH_SERVER = 'https://auth.example.com';
const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/register`;
const PROVIDER_ID = URI.parse(AUTH_SERVER).toString(true);
const LIST_KEY = 'dynamicAuthProviders';
const REGISTRATION_KEY = `dynamicAuthProvider:clientRegistration:${PROVIDER_ID}`;
const SESSIONS_KEY = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: PROVIDER_ID, clientId: 'client-1' });
const INVALID_LIST = 'not json {"providerId":';

const serverMetadata: IAuthorizationServerMetadata = {
	issuer: AUTH_SERVER,
	response_types_supported: ['code'],
	authorization_endpoint: `${AUTH_SERVER}/authorize`,
	token_endpoint: `${AUTH_SERVER}/token`,
	registration_endpoint: REGISTRATION_ENDPOINT,
};

const storedToken: IAuthorizationTokenResponse & { created_at: number } = { access_token: 'at-1', token_type: 'Bearer', scope: 'read', created_at: 1 };

/** Every DynamicAuthProvider the extension host creates, so a provisional one can be checked for disposal. */
let createdProviders: RecordingDynamicAuthProvider[] = [];

class RecordingDynamicAuthProvider extends DynamicAuthProvider {
	disposeCount = 0;
	constructor(...args: ConstructorParameters<typeof DynamicAuthProvider>) {
		super(...args);
		createdProviders.push(this);
	}
	get disposed(): boolean {
		return this.disposeCount > 0;
	}
	override dispose(): void {
		this.disposeCount++;
		super.dispose();
	}
}

class TestExtHostAuthentication extends ExtHostAuthentication {
	protected override readonly _dynamicAuthProviderCtor = RecordingDynamicAuthProvider;
}

/**
 * An RPC proxy to `target()`: every call is asynchronous, and a rejection crosses the boundary as the RPC protocol carries
 * it (a new error with the name and message only), so no test depends on an error instance crossing the boundary.
 */
function rpcProxy<T extends object>(target: () => T, overrides: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>> = {}): T {
	return new Proxy({}, {
		get: (_, name) => {
			if (typeof name !== 'string') {
				return undefined;
			}
			return async (...args: unknown[]) => {
				await Promise.resolve();
				const override = overrides[name];
				const method = override ?? (target() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
				try {
					return await method.apply(override ? undefined : target(), args);
				} catch (e) {
					const serialized = transformErrorForSerialization(e);
					const revived = new Error(serialized.message);
					revived.name = serialized.name;
					throw revived;
				}
			};
		}
	}) as T;
}

function isInvalidListError(e: unknown): boolean {
	assert.ok(e instanceof Error, `expected an error, got ${e}`);
	assert.strictEqual(e.name, 'InvalidStoredProviderListError');
	assert.ok(!e.message.includes(INVALID_LIST), 'the error carries no stored text');
	return true;
}

// F-AUTHPROV-2: a dynamic provider is validated and saved before it is published in either registry. A failed read or save of
// the provider list leaves runtime state as it was.
suite('Dynamic authentication providers - persistence before publication', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fetchStub: sinon.SinonStub;
	setup(() => {
		createdProviders = [];
		fetchStub = sinon.stub(globalThis, 'fetch');
		fetchStub.callsFake(async (input: string | URL | Request) => {
			if (String(input) === REGISTRATION_ENDPOINT) {
				return new Response(JSON.stringify({ client_id: 'client-2', client_secret: 'secret-2' }), { status: 201 });
			}
			return new Response('', { status: 404 });
		});
	});
	teardown(() => {
		fetchStub.restore();
	});

	/** The real main thread, authentication service, storage service and extension host, connected by {@link rpcProxy}. */
	function createWorld() {
		const storageService = store.add(new TestStorageService());
		const secrets = store.add(new TestSecretStorageService());
		const logService = new NullLogService();
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, logService));
		const authenticationService = store.add(new AuthenticationService(
			{} as IExtensionService,
			{ onDidChangeExtensionSessionAccess: Event.None } as unknown as IAuthenticationAccessService,
			{ options: undefined } as unknown as IBrowserWorkbenchEnvironmentService,
			logService
		));
		const calls = { registrationPrompts: 0, forwardedSessionEvents: 0 };
		const mainOverrides = {
			$promptForClientRegistration: async () => { calls.registrationPrompts++; return { clientId: 'client-typed' }; },
			$sendDidChangeSessions: async () => { calls.forwardedSessionEvents++; },
		};
		let extHost: TestExtHostAuthentication | undefined;
		const extHostContext = {
			extensionHostKind: ExtensionHostKind.LocalProcess,
			getProxy: () => rpcProxy<ExtHostAuthenticationShape>(() => extHost!),
		} as unknown as IExtHostContext;
		const mainThread: MainThreadAuthentication = store.add(new MainThreadAuthentication(
			extHostContext,
			{} as IProductService,
			authenticationService,
			{ onDidChangeAccountPreference: Event.None } as unknown as IAuthenticationExtensionsService,
			{} as IAuthenticationAccessService,
			{} as IAuthenticationUsageService,
			{} as IDialogService,
			{} as INotificationService,
			{} as IExtensionService,
			{ publicLog2: () => { } } as unknown as ITelemetryService,
			{} as IOpenerService,
			logService,
			{} as IURLService,
			dynamicStorage,
			{} as IClipboardService,
			{} as IQuickInputService,
		));
		extHost = new TestExtHostAuthentication(
			{ getProxy: () => rpcProxy<MainThreadAuthenticationShape>(() => mainThread as unknown as MainThreadAuthenticationShape, mainOverrides) } as unknown as IExtHostRpcService,
			{ environment: { appName: 'Test', appUriScheme: 'test' } } as unknown as IExtHostInitDataService,
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{} as IExtHostProgress,
			{ createLogger: () => new NullLogger() } as unknown as ILoggerService,
			logService,
		);
		const registeredEvents: string[] = [];
		store.add(authenticationService.onDidRegisterAuthenticationProvider(e => registeredEvents.push(e.id)));
		/** The stored provider list and every secret, byte for byte. */
		const snapshot = async () => JSON.stringify({
			list: storageService.get(LIST_KEY, StorageScope.APPLICATION),
			secrets: await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])),
		});
		/** A stored client registration, so the main thread reads no list before it asks the extension host to register. */
		const seedStoredClient = async () => {
			await secrets.set(REGISTRATION_KEY, JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' }));
			await secrets.set(SESSIONS_KEY, JSON.stringify([storedToken]));
		};
		const corruptList = () => storageService.store(LIST_KEY, INVALID_LIST, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const create = () => authenticationService.createDynamicAuthenticationProvider(URI.parse(AUTH_SERVER), serverMetadata, undefined);
		/** Unregisters on both sides, so each test leaves nothing registered. */
		const cleanUp = async () => {
			await extHost!.$onDidUnregisterAuthenticationProvider(PROVIDER_ID);
			await mainThread.$unregisterAuthenticationProvider(PROVIDER_ID);
		};
		return { extHost, mainThread, authenticationService, dynamicStorage, storageService, secrets, calls, registeredEvents, snapshot, seedStoredClient, corruptList, create, cleanUp };
	}

	test('registration with an invalid stored list rejects, named, and publishes nothing on either side; storage is unchanged', async () => {
		const world = createWorld();
		await world.seedStoredClient();
		world.corruptList();
		const before = await world.snapshot();

		await assert.rejects(world.create(), isInvalidListError);

		// Main thread: not registered, not classified as dynamic, no registration event.
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered(PROVIDER_ID), false);
		assert.strictEqual(world.authenticationService.isDynamicAuthenticationProvider(PROVIDER_ID), false);
		assert.deepStrictEqual(world.authenticationService.getProviderIds(), []);
		assert.deepStrictEqual(world.registeredEvents, []);
		// Extension host: not installed, and the provisional provider is disposed.
		await assert.rejects(world.extHost.$getSessions(PROVIDER_ID, undefined, {}), /Unable to find authentication provider/);
		assert.strictEqual(createdProviders.length, 1);
		assert.strictEqual(createdProviders[0].disposed, true, 'the provisional provider is disposed');
		// Storage: the list, the client registration and the sessions are byte-identical.
		assert.strictEqual(await world.snapshot(), before);
	});

	test('a rejected re-registration leaves the registered provider in place on both sides', async () => {
		const world = createWorld();
		await world.seedStoredClient();
		const registered = await world.create();
		assert.ok(registered);
		world.corruptList();
		const before = await world.snapshot();
		const registeredEvents = world.registeredEvents.length;

		await assert.rejects(world.create(), isInvalidListError);

		assert.strictEqual(world.authenticationService.getProvider(PROVIDER_ID), registered, 'the main thread keeps the registered provider');
		assert.strictEqual(world.authenticationService.isDynamicAuthenticationProvider(PROVIDER_ID), true);
		assert.strictEqual(world.registeredEvents.length, registeredEvents, 'no registration event');
		assert.strictEqual(createdProviders.length, 2);
		assert.strictEqual(createdProviders[0].disposed, false, 'the registered provider is kept');
		assert.strictEqual(createdProviders[1].disposed, true, 'the provisional provider is disposed');
		const sessions = await world.extHost.$getSessions(PROVIDER_ID, undefined, {});
		assert.deepStrictEqual(sessions.map(s => s.accessToken), ['at-1'], 'the extension host still serves the registered provider');
		assert.strictEqual(await world.snapshot(), before);
		await world.cleanUp();
	});

	test('a successful registration is saved, then published on both sides and classified as dynamic', async () => {
		const world = createWorld();
		await world.seedStoredClient();

		const provider = await world.create();

		assert.ok(provider);
		assert.strictEqual(provider.id, PROVIDER_ID);
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered(PROVIDER_ID), true);
		assert.strictEqual(world.authenticationService.isDynamicAuthenticationProvider(PROVIDER_ID), true);
		assert.deepStrictEqual(world.registeredEvents, [PROVIDER_ID]);
		assert.deepStrictEqual(world.dynamicStorage.getInteractedProviders().map(p => [p.providerId, p.clientId]), [[PROVIDER_ID, 'client-1']]);
		assert.deepStrictEqual(await world.dynamicStorage.getClientRegistration(PROVIDER_ID), { clientId: 'client-1', clientSecret: 'secret-1' });
		const sessions = await world.extHost.$getSessions(PROVIDER_ID, undefined, {});
		assert.deepStrictEqual(sessions.map(s => s.accessToken), ['at-1']);
		assert.strictEqual(createdProviders.length, 1);
		assert.strictEqual(createdProviders[0].disposed, false);
		await world.cleanUp();
		assert.strictEqual(createdProviders[0].disposed, true, 'unregistering disposes it');
	});

	// review-c1 S7: a successful re-registration disposes the provider it replaces; a rejected one keeps it (test above).
	test('a successful re-registration disposes the replaced provider once; only the current one forwards session events', async () => {
		const world = createWorld();
		await world.seedStoredClient();
		await world.create();
		await world.create();
		assert.strictEqual(createdProviders.length, 2);
		assert.strictEqual(createdProviders[0].disposeCount, 1, 'the replaced provider is disposed');
		assert.strictEqual(createdProviders[1].disposeCount, 0, 'the current provider is installed');

		await world.extHost.$onDidChangeDynamicAuthProviderTokens(PROVIDER_ID, 'client-1', [{ ...storedToken, access_token: 'at-2' }]);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(world.calls.forwardedSessionEvents, 1, 'one session event, from the current provider only');
		const sessions = await world.extHost.$getSessions(PROVIDER_ID, undefined, {});
		assert.deepStrictEqual(sessions.map(s => s.accessToken), ['at-2']);

		await world.cleanUp();
		assert.deepStrictEqual(createdProviders.map(p => p.disposeCount), [1, 1], 'each is disposed exactly once');
	});
});
