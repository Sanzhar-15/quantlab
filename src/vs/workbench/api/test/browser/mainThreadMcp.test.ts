/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { McpServerDefinition } from '../../../contrib/mcp/common/mcpTypes.js';
import { DynamicAuthenticationProviderStorageService } from '../../../services/authentication/browser/dynamicAuthenticationProviderStorageService.js';
import { TestStorageService } from '../../../test/common/workbenchTestServices.js';
import { MainThreadMcp } from '../../browser/mainThreadMcp.js';
import { IMcpAuthenticationDetails, IMcpAuthenticationOptions } from '../../common/extHost.protocol.js';
import { createMcpHttpHarness, errorStateMessages } from '../common/mcpHttpHandleHarness.js';

const PROVIDER_ID = 'https://auth.example.com';

// F-SECRETS-3: an MCP authentication failure never removes the stored client registration or sessions.
suite('MainThreadMcp - stored dynamic registrations are kept', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createMainThread() {
		const storageService = store.add(new TestStorageService());
		const secrets = store.add(new TestSecretStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		await dynamicStorage.storeClientRegistration(PROVIDER_ID, PROVIDER_ID, 'client-1', 'client-secret-1', 'Example');
		await dynamicStorage.setSessionsForDynamicAuthProvider(PROVIDER_ID, 'client-1', [{ access_token: 'stored-token', token_type: 'Bearer', created_at: 1 }]);
		const unregistered: string[] = [];
		const created: string[] = [];
		// The receiver of the production $getTokenFromServerMetadata: only the members that method reads.
		const mainThread = {
			_serverDefinitions: new Map([[1, { id: 'server-1', label: 'Server' } as McpServerDefinition]]),
			_authenticationService: {
				getOrActivateProviderIdForServer: async () => PROVIDER_ID,
				isDynamicAuthenticationProvider: () => true,
				unregisterAuthenticationProvider: (id: string) => { unregistered.push(id); },
				createDynamicAuthenticationProvider: async () => { created.push(PROVIDER_ID); return { id: PROVIDER_ID }; },
			},
			_dynamicAuthenticationProviderStorageService: dynamicStorage,
			_getSessionForProvider: async () => 'stored-token',
		};
		const getToken = (authDetails: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined) =>
			MainThreadMcp.prototype.$getTokenFromServerMetadata.call(mainThread as unknown as MainThreadMcp, 1, authDetails, options);
		const snapshot = async () => JSON.stringify({
			providers: storageService.get('dynamicAuthProviders', StorageScope.APPLICATION),
			secrets: await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])),
		});
		return { getToken, snapshot, unregistered, created };
	}

	const authDetails: IMcpAuthenticationDetails = {
		authorizationServer: URI.parse(PROVIDER_ID).toJSON(),
		authorizationServerMetadata: { issuer: PROVIDER_ID, response_types_supported: ['code'] },
		resourceMetadata: undefined,
		scopes: undefined,
	};

	test('a request to force a new registration rejects and removes nothing', async () => {
		const { getToken, snapshot, unregistered, created } = await createMainThread();
		const before = await snapshot();

		await assert.rejects(getToken(authDetails, { forceNewRegistration: true }), /never forced automatically/);

		assert.strictEqual(await snapshot(), before, 'the stored registration and sessions are byte-identical');
		assert.deepStrictEqual(unregistered, []);
		assert.deepStrictEqual(created, []);
	});

	test('end to end: a 401 to the stored authorization keeps the stored registration and sessions, and the server state names it', async () => {
		const { getToken, snapshot, unregistered, created } = await createMainThread();
		const before = await snapshot();
		const harness = createMcpHttpHarness([401, 401], getToken, '');
		store.add(harness.handle);

		await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

		assert.strictEqual(await snapshot(), before, 'the stored registration and sessions are byte-identical');
		assert.deepStrictEqual(unregistered, []);
		assert.deepStrictEqual(created, []);
		assert.deepStrictEqual(harness.posts, [undefined, 'Bearer stored-token']);
		const errors = errorStateMessages(harness.states);
		assert.ok(errors.length === 1 && errors[0].includes('McpAuthorizationRejectedError'), errors.join('\n'));
	});
});
