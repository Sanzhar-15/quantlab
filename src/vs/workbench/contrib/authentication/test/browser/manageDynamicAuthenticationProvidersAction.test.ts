/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAuthenticationAccessService } from '../../../../services/authentication/browser/authenticationAccessService.js';
import { AuthenticationService } from '../../../../services/authentication/browser/authenticationService.js';
import { DynamicAuthenticationProviderStorageService } from '../../../../services/authentication/browser/dynamicAuthenticationProviderStorageService.js';
import { AuthenticationSessionsChangeEvent, IAuthenticationProvider, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { RemoveDynamicAuthenticationProvidersAction } from '../../browser/actions/manageDynamicAuthenticationProvidersAction.js';

const LIST_KEY = 'dynamicAuthProviders';
const INVALID_LIST = 'not json {"providerId":';

function registrationKey(providerId: string): string {
	return `dynamicAuthProvider:clientRegistration:${providerId}`;
}

function sessionsKey(providerId: string, clientId: string): string {
	return JSON.stringify({ isDynamicAuthProvider: true, authProviderId: providerId, clientId });
}

// F-AUTHPROV-2: the manage command removes a provider's stored data before it unregisters the provider. A stored list that
// cannot be read (here: changed while the confirmation is open) rejects, named; the provider stays registered and nothing changes.
suite('RemoveDynamicAuthenticationProvidersAction - storage before unregistration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createWorld(onConfirm: () => void, chosen: string[]) {
		const storageService = store.add(new TestStorageService());
		const secrets = store.add(new TestSecretStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		const authenticationService = store.add(new AuthenticationService(
			{} as IExtensionService,
			{ onDidChangeExtensionSessionAccess: Event.None } as unknown as IAuthenticationAccessService,
			{ options: undefined } as unknown as IBrowserWorkbenchEnvironmentService,
			new NullLogService()
		));
		for (const [id, clientId] of [['provider-a', 'client-a'], ['provider-b', 'client-b']]) {
			await dynamicStorage.storeClientRegistration(id, `https://${id}.example.com`, clientId, `${clientId}-secret`, id, 0);
			await dynamicStorage.setSessionsForDynamicAuthProvider(id, clientId, [{ access_token: `${id}-token`, token_type: 'Bearer', created_at: 1 }]);
			const onDidChangeSessions = store.add(new Emitter<AuthenticationSessionsChangeEvent>());
			authenticationService.registerAuthenticationProvider(id, {
				id, label: id, supportsMultipleAccounts: true, authorizationServers: [], onDidChangeSessions: onDidChangeSessions.event,
				getSessions: async () => [], createSession: async () => { throw new Error('not used'); }, removeSession: async () => { },
			} as unknown as IAuthenticationProvider);
		}
		const unregistered: string[] = [];
		store.add(authenticationService.onDidUnregisterAuthenticationProvider(e => unregistered.push(e.id)));
		const services = new Map<unknown, unknown>([
			[IQuickInputService, { pick: async (items: { provider: { providerId: string } }[]) => items.filter(i => chosen.includes(i.provider.providerId)) }],
			[IDynamicAuthenticationProviderStorageService, dynamicStorage],
			[IAuthenticationService, authenticationService],
			[IDialogService, { confirm: async () => { onConfirm(); return { confirmed: true }; } }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		/** Every secret, byte for byte. */
		const snapshotSecrets = async () => JSON.stringify(await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])));
		const corruptList = () => storageService.store(LIST_KEY, INVALID_LIST, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return { accessor, authenticationService, dynamicStorage, storageService, secrets, unregistered, snapshotSecrets, corruptList };
	}

	test('the list corrupted during the confirmation: rejects, named; the provider stays registered; the list bytes and secrets are unchanged', async () => {
		let corruptDuringConfirmation = () => { };
		const world = await createWorld(() => corruptDuringConfirmation(), ['provider-a']);
		const secretsBefore = await world.snapshotSecrets();
		corruptDuringConfirmation = () => world.corruptList();

		await assert.rejects(new RemoveDynamicAuthenticationProvidersAction().run(world.accessor), (e: unknown) => {
			assert.ok(e instanceof Error);
			assert.strictEqual(e.name, 'InvalidStoredProviderListError');
			assert.ok(!e.message.includes(INVALID_LIST), 'the error carries no stored text');
			return true;
		});

		assert.strictEqual(world.storageService.get(LIST_KEY, StorageScope.APPLICATION), INVALID_LIST, 'the list bytes are the corrupted ones, unchanged');
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered('provider-a'), true, 'the chosen provider is still registered');
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered('provider-b'), true);
		assert.deepStrictEqual(world.unregistered, []);
		assert.deepStrictEqual((await world.secrets.keys()).sort(), [
			registrationKey('provider-a'), registrationKey('provider-b'), sessionsKey('provider-a', 'client-a'), sessionsKey('provider-b', 'client-b'),
		].sort(), 'no secret is removed');
		assert.strictEqual(await world.snapshotSecrets(), secretsBefore, 'every secret is byte-identical');
	});

	test('the list corrupted between two chosen removals: the first is removed; the second stays registered with its data', async () => {
		const world = await createWorld(() => { }, ['provider-a', 'provider-b']);
		const removeDynamicProvider = world.dynamicStorage.removeDynamicProvider.bind(world.dynamicStorage);
		let removals = 0;
		world.dynamicStorage.removeDynamicProvider = async (providerId: string) => {
			if (removals++ === 1) {
				world.corruptList();
			}
			return removeDynamicProvider(providerId);
		};

		await assert.rejects(new RemoveDynamicAuthenticationProvidersAction().run(world.accessor), (e: unknown) => e instanceof Error && e.name === 'InvalidStoredProviderListError');

		assert.deepStrictEqual(world.unregistered, ['provider-a']);
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered('provider-b'), true);
		assert.strictEqual(world.storageService.get(LIST_KEY, StorageScope.APPLICATION), INVALID_LIST);
		assert.deepStrictEqual((await world.secrets.keys()).sort(), [registrationKey('provider-b'), sessionsKey('provider-b', 'client-b')].sort());
	});

	test('a normal removal removes exactly the chosen provider: its stored data first, then its registration', async () => {
		const world = await createWorld(() => { }, ['provider-a']);
		const keptKeys = [registrationKey('provider-b'), sessionsKey('provider-b', 'client-b')];
		const keptBefore = await Promise.all(keptKeys.map(key => world.secrets.get(key)));
		const storedAtUnregistration: string[][] = [];
		store.add(world.authenticationService.onDidUnregisterAuthenticationProvider(() => storedAtUnregistration.push(world.dynamicStorage.getInteractedProviders().map(p => p.providerId))));

		await new RemoveDynamicAuthenticationProvidersAction().run(world.accessor);

		assert.deepStrictEqual(world.unregistered, ['provider-a']);
		assert.deepStrictEqual(storedAtUnregistration, [['provider-b']], 'the stored entry is gone before the provider is unregistered');
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered('provider-a'), false);
		assert.strictEqual(world.authenticationService.isAuthenticationProviderRegistered('provider-b'), true);
		assert.deepStrictEqual(world.dynamicStorage.getInteractedProviders().map(p => p.providerId), ['provider-b']);
		assert.deepStrictEqual((await world.secrets.keys()).sort(), keptKeys.slice().sort(), 'only provider-b secrets remain');
		assert.deepStrictEqual(await Promise.all(keptKeys.map(key => world.secrets.get(key))), keptBefore, 'provider-b is byte-identical');
	});

	// review-c2 M1: a first registration whose list commit fails, and whose rollback deletion of the new client registration
	// fails too, leaves the client registration stored with no list entry. The command still finds the provider, and its
	// removal leaves no secret.
	test('a first registration whose commit and rollback both fail: the command finds it, and its removal leaves no secret', async () => {
		class RefusingStorageService extends TestStorageService {
			refuseListStore = false;
			override store(...args: Parameters<TestStorageService['store']>): void {
				if (this.refuseListStore && args[0] === LIST_KEY) {
					throw new Error('store refused');
				}
				super.store(...args);
			}
		}
		class RefusingSecretStorageService extends TestSecretStorageService {
			readonly refuseDelete = new Set<string>();
			override async delete(key: string): Promise<void> {
				if (this.refuseDelete.has(key)) {
					throw new Error('delete refused');
				}
				return super.delete(key);
			}
		}
		const storageService = store.add(new RefusingStorageService());
		const secrets = store.add(new RefusingSecretStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		const authenticationService = store.add(new AuthenticationService(
			{} as IExtensionService,
			{ onDidChangeExtensionSessionAccess: Event.None } as unknown as IAuthenticationAccessService,
			{ options: undefined } as unknown as IBrowserWorkbenchEnvironmentService,
			new NullLogService()
		));
		const offered: string[][] = [];
		const infos: string[] = [];
		const services = new Map<unknown, unknown>([
			[IQuickInputService, { pick: async (items: { provider: { providerId: string } }[]) => { offered.push(items.map(i => i.provider.providerId)); return items; } }],
			[IDynamicAuthenticationProviderStorageService, dynamicStorage],
			[IAuthenticationService, authenticationService],
			[IDialogService, { confirm: async () => ({ confirmed: true }), info: async (message: string) => { infos.push(message); } }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		storageService.refuseListStore = true;
		secrets.refuseDelete.add(registrationKey('provider-c'));

		await assert.rejects(
			dynamicStorage.storeClientRegistration('provider-c', 'https://provider-c.example.com', 'client-c', 'client-c-secret', 'provider-c', 0),
			(e: unknown) => e instanceof Error && e.name === 'DynamicAuthRegistrationRecoveryError'
		);
		assert.deepStrictEqual(await secrets.keys(), [registrationKey('provider-c')], 'the client registration is stored');
		assert.strictEqual(storageService.get(LIST_KEY, StorageScope.APPLICATION), undefined, 'the provider list has no entry');

		storageService.refuseListStore = false;
		secrets.refuseDelete.clear();
		await new RemoveDynamicAuthenticationProvidersAction().run(accessor);

		assert.deepStrictEqual({ offered, infos }, { offered: [['provider-c']], infos: [] }, 'the command offers the provider');
		assert.deepStrictEqual(await secrets.keys(), [], 'its removal leaves no secret');

		// Nothing is left to find.
		await new RemoveDynamicAuthenticationProvidersAction().run(accessor);
		assert.deepStrictEqual(infos, ['No dynamic authentication providers']);
	});
});
