/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../environment/browser/environmentService.js';
import { IExtensionService } from '../../../extensions/common/extensions.js';
import { IAuthenticationAccessService } from '../../browser/authenticationAccessService.js';
import { AuthenticationService } from '../../browser/authenticationService.js';
import { authProviderIdForDiagnostics, DynamicAuthenticationProviderStorageService } from '../../browser/dynamicAuthenticationProviderStorageService.js';
import { AuthenticationQueryService } from '../../browser/authenticationQueryService.js';
import { AuthenticationUsageService, IAuthenticationUsageService } from '../../browser/authenticationUsageService.js';
import { AuthenticationMcpUsageService, IAuthenticationMcpUsageService } from '../../browser/authenticationMcpUsageService.js';
import { IAuthenticationMcpAccessService } from '../../browser/authenticationMcpAccessService.js';
import { IAuthenticationMcpService } from '../../browser/authenticationMcpService.js';
import { IAuthenticationExtensionsService, IAuthenticationService } from '../../common/authentication.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';

// review QL-G-LOGIN-SECRETS c1 M3 (renderer side): a dynamic provider's id is its issuer string and resource. Markers in the
// issuer's user info, path and query and in the resource's path and query reach no log argument and no rejected error of
// the storage service (session save trace, invalid stored values, a stored-read failure after a change) or of the
// authentication service (dynamic provider creation, calls for a provider that is not registered).

const ISSUER_USERINFO = 'MARK-ISSUER-USERINFO-4d5e';
const ISSUER_PATH = 'MARK-ISSUER-PATH-6f70';
const ISSUER_QUERY = 'MARK-ISSUER-QUERY-8192';
const RESOURCE_PATH = 'MARK-RESOURCE-PATH-a3b4';
const RESOURCE_QUERY = 'MARK-RESOURCE-QUERY-c5d6';
const THROWN = 'MARK-THROWN-ERROR-e7f8';
const MARKERS = [ISSUER_USERINFO, ISSUER_PATH, ISSUER_QUERY, RESOURCE_PATH, RESOURCE_QUERY, THROWN];

/** A failure whose name, message, stack and cause each hold a marker. */
function thrownError(): Error {
	const error = new Error(`refused ${THROWN}`, { cause: new Error(THROWN) });
	error.name = `${THROWN}Error`;
	error.stack = `${THROWN}\n    at ${THROWN}`;
	return error;
}
const ISSUER = `https://user:${ISSUER_USERINFO}@issuer.example/tenant/${ISSUER_PATH}?key=${ISSUER_QUERY}`;
const PROVIDER_ID = `${ISSUER} https://mcp.example.com/${RESOURCE_PATH}?k=${RESOURCE_QUERY}`;
const SESSIONS_KEY = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: PROVIDER_ID, clientId: 'client-1' });

/** Every string reachable from a value; an Error contributes its name, message, stack and its whole cause chain. */
function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
	if (typeof value === 'string') {
		out.push(value);
	} else if (typeof value !== 'object' && typeof value !== 'function' || value === null) {
		out.push(String(value));
	} else if (!seen.has(value)) {
		seen.add(value);
		if (value instanceof Error) {
			out.push(value.name, value.message, value.stack ?? '');
			collectStrings(value.cause, out, seen);
		}
		for (const key of Object.getOwnPropertyNames(value)) {
			collectStrings((value as Record<string, unknown>)[key], out, seen);
		}
	}
	return out;
}

function assertNoMarker(what: string, value: unknown): void {
	for (const text of collectStrings(value)) {
		for (const marker of MARKERS) {
			assert.ok(!text.includes(marker), `${what}: a marker (${marker}) reached it: ${text}`);
		}
	}
}

class RecordingLogService extends NullLogService {
	readonly args: unknown[][] = [];
	override trace(...args: unknown[]): void { this.args.push(args); }
	override debug(...args: unknown[]): void { this.args.push(args); }
	override info(...args: unknown[]): void { this.args.push(args); }
	override warn(...args: unknown[]): void { this.args.push(args); }
	override error(...args: unknown[]): void { this.args.push(args); }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail('expected a rejection');
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

suite('QL-G-LOGIN-SECRETS c1 M3: a dynamic provider\'s identity reaches no renderer diagnostic', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the diagnostic identity: an extension\'s plain id as it is; an issuer-string id opaque, stable, and not derived from its text', () => {
		assert.strictEqual(authProviderIdForDiagnostics('github'), 'github');
		assert.strictEqual(authProviderIdForDiagnostics('__GitHub.copilot-chat_1'), '__GitHub.copilot-chat_1');
		const opaque = authProviderIdForDiagnostics(PROVIDER_ID);
		assert.match(opaque, /^dynamic-auth-provider-\d+$/);
		assert.strictEqual(authProviderIdForDiagnostics(PROVIDER_ID), opaque, 'the same id gets the same opaque id');
		assert.notStrictEqual(authProviderIdForDiagnostics(`${PROVIDER_ID}x`), opaque, 'another id gets another opaque id');
	});

	// Each test checks for markers first, then the fixed text that replaced them.
	function createStorage() {
		const logService = new RecordingLogService();
		const secrets = new TestSecretStorageService();
		const service = store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), secrets, logService));
		return { logService, secrets, service };
	}

	test('storage service: the session save trace carries no marker', async () => {
		const { logService, service } = createStorage();
		await service.storeClientRegistration(PROVIDER_ID, ISSUER, 'client-1', undefined, 'issuer.example', 0);
		await service.setSessionsForDynamicAuthProvider(PROVIDER_ID, 'client-1', [{ access_token: 'at', token_type: 'Bearer', created_at: 1 }]);
		assertNoMarker('the storage service log', logService.args);
		assert.ok(logService.args.some(args => args[0] === `Set 1 session(s) for ${authProviderIdForDiagnostics(PROVIDER_ID)} in secret storage`), JSON.stringify(logService.args));
	});

	test('storage service: an invalid stored session list rejects with an error that carries no marker', async () => {
		const { logService, secrets, service } = createStorage();
		await secrets.set(SESSIONS_KEY, JSON.stringify([null]));
		await settle();
		const error = await rejection(service.getSessionsForDynamicAuthProvider(PROVIDER_ID, 'client-1'));
		assertNoMarker('an invalid stored session list', error);
		assertNoMarker('the storage service log', logService.args);
		assert.strictEqual((error as Error).name, 'InvalidStoredSecretError');
	});

	test('storage service: a stored session list that cannot be read after a change is logged without a marker', async () => {
		const { logService, secrets } = createStorage();
		await secrets.set(SESSIONS_KEY, '{ not json');
		await settle();
		assertNoMarker('the storage service log', logService.args);
		assert.ok(logService.args.some(args => args[0] === `Could not read the stored sessions of ${authProviderIdForDiagnostics(PROVIDER_ID)} after a change (InvalidStoredSecretError); they are kept.`), JSON.stringify(logService.args));
	});

	test('storage service: an invalid stored client registration rejects with an error that carries no marker', async () => {
		const { logService, secrets, service } = createStorage();
		await secrets.set(`dynamicAuthProvider:clientRegistration:${PROVIDER_ID}`, JSON.stringify({ clientId: 1 }));
		const error = await rejection(service.getClientRegistration(PROVIDER_ID));
		assertNoMarker('an invalid stored client registration', error);
		assertNoMarker('the storage service log', logService.args);
		assert.strictEqual((error as Error).name, 'InvalidStoredSecretError');
	});

	function createAuthenticationService() {
		const logService = new RecordingLogService();
		const service = store.add(new AuthenticationService(
			{ activateByEvent: async () => { } } as unknown as IExtensionService,
			{ onDidChangeExtensionSessionAccess: Event.None } as unknown as IAuthenticationAccessService,
			{ options: undefined } as unknown as IBrowserWorkbenchEnvironmentService,
			logService,
		));
		return { logService, service };
	}

	test('authentication service: a dynamic provider that is not registered after creation is logged without a marker', async () => {
		const { logService, service } = createAuthenticationService();
		store.add(service.registerAuthenticationProviderHostDelegate({ priority: 0, create: async () => PROVIDER_ID }));
		const created = await service.createDynamicAuthenticationProvider(URI.parse(ISSUER), { issuer: ISSUER, response_types_supported: ['code'] }, undefined);
		assertNoMarker('the authentication service log', logService.args);
		assert.strictEqual(created, undefined);
		assert.ok(logService.args.some(args => args[0] === `Failed to create dynamic authentication provider: ${authProviderIdForDiagnostics(PROVIDER_ID)}`), JSON.stringify(logService.args));
	});

	test('authentication service: a call for a provider that is not registered rejects without a marker', async () => {
		const { logService, service } = createAuthenticationService();
		for (const call of [
			() => Promise.resolve().then(() => service.getProvider(PROVIDER_ID)),
			() => service.removeSession(PROVIDER_ID, 'session'),
		]) {
			const error = await rejection(call());
			assertNoMarker('the rejected error', error);
			assert.ok(error instanceof Error && error.message.includes(authProviderIdForDiagnostics(PROVIDER_ID)), `${error}`);
		}
		assertNoMarker('the authentication service log', logService.args);
	});

	// confirm-contested M3 class: a provider id or a caught value printed by the other authentication services.
	/** An authentication service whose one provider is the dynamic provider and whose account read fails with a marked error. */
	function failingAuthenticationService(onDidRegister: Emitter<{ id: string; label: string }>): IAuthenticationService {
		return {
			getProviderIds: () => [PROVIDER_ID],
			getAccounts: async () => { throw thrownError(); },
			onDidRegisterAuthenticationProvider: onDidRegister.event,
		} as unknown as IAuthenticationService;
	}

	test('query service: a failed clear of a dynamic provider\'s data is logged without the provider id or the thrown error', async () => {
		const logService = new RecordingLogService();
		const onDidRegister = store.add(new Emitter<{ id: string; label: string }>());
		const service = store.add(new AuthenticationQueryService(
			failingAuthenticationService(onDidRegister),
			{} as IAuthenticationUsageService,
			{} as IAuthenticationMcpUsageService,
			{ onDidChangeExtensionSessionAccess: Event.None } as unknown as IAuthenticationAccessService,
			{ onDidChangeMcpSessionAccess: Event.None } as unknown as IAuthenticationMcpAccessService,
			{ onDidChangeAccountPreference: Event.None } as unknown as IAuthenticationExtensionsService,
			{ onDidChangeAccountPreference: Event.None } as unknown as IAuthenticationMcpService,
			logService,
		));
		await service.clearAllData('CLEAR_ALL_AUTH_DATA');
		assertNoMarker('the query service log', logService.args);
		assert.ok(logService.args.some(args => args.length === 1 && args[0] === `Error clearing data for provider ${authProviderIdForDiagnostics(PROVIDER_ID)}: the accounts could not be read (details not logged)`), JSON.stringify(logService.args));
	});

	test('usage services: a failed account read while filling the usage cache is logged without the provider id or the thrown error', async () => {
		const logService = new RecordingLogService();
		const onDidRegister = store.add(new Emitter<{ id: string; label: string }>());
		const authenticationService = failingAuthenticationService(onDidRegister);
		const product = { trustedExtensionAuthAccess: undefined } as unknown as IProductService;
		const usage = store.add(new AuthenticationUsageService(store.add(new TestStorageService()), authenticationService, logService, product));
		const mcpUsage = store.add(new AuthenticationMcpUsageService(store.add(new TestStorageService()), authenticationService, logService, product));
		await usage.initializeExtensionUsageCache();
		await mcpUsage.initializeUsageCache();
		assertNoMarker('the usage services log', logService.args);
		const expected = `Could not read the accounts of provider ${authProviderIdForDiagnostics(PROVIDER_ID)} for the usage cache (details not logged)`;
		assert.strictEqual(logService.args.filter(args => args.length === 1 && args[0] === expected).length, 2, JSON.stringify(logService.args));
	});
});
