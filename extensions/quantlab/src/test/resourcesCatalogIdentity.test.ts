/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ResourcesCatalogService } from '../panels/resources/ResourcesCatalogService';
import { ServerApiClient } from '../core/server/ServerApiClient';
import { ResourcesCatalogResponse } from '../types/resources';

// QL-DATA DT-3 (window ruling): the resources catalog lives in memory only.
// No globalState copy is kept or served (the old key is deleted once, unread),
// a failed fetch rejects with its error, and every identity change
// (ServerApiClient.onAuthStateChange) drops the previous identity's catalog.
// Signed out, the catalog is the local built-in tools, chosen from the identity
// state with no fetch; they are never a stand-in for a failed signed-in fetch.

const LEGACY_KEY = 'quantlab.resourcesCatalog';

function catalogResponse(version: string): ResourcesCatalogResponse {
	return {
		version,
		generated_at: '2026-10-05T00:00:00Z',
		sections: {
			statistics: { label: 'Statistics', description: '', categories: [] },
			strategy: { label: 'Strategy', description: '', categories: [] }
		},
		workflows: []
	} as unknown as ResourcesCatalogResponse;
}

interface Harness {
	service: ResourcesCatalogService;
	authChanged: vscode.EventEmitter<boolean>;
	fetches: (string | undefined)[];
	updates: [string, unknown][];
	setSignedIn(signedIn: boolean): void;
	reads: string[];
	setFetch(fn: () => Promise<ResourcesCatalogResponse | null>): void;
}

suite('DT-3: resources catalog is memory-only and identity-scoped', () => {
	const originalGetInstance = ServerApiClient.getInstance;
	let harness: Harness;

	setup(() => {
		_resetShimState();
		const authChanged = new vscode.EventEmitter<boolean>();
		const fetches: (string | undefined)[] = [];
		let fetchImpl: () => Promise<ResourcesCatalogResponse | null> = async () => catalogResponse('v1');
		let signedIn = true;
		const fake = {
			onAuthStateChange: authChanged.event,
			isAuthenticated: () => signedIn,
			getResourcesCatalog: (cachedVersion?: string) => {
				fetches.push(cachedVersion);
				return fetchImpl();
			}
		} as unknown as ServerApiClient;
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fake;

		const updates: [string, unknown][] = [];
		const reads: string[] = [];
		const memento = {
			get: (key: string) => { reads.push(key); return undefined; },
			update: (key: string, value: unknown) => { updates.push([key, value]); return Promise.resolve(); },
			keys: () => []
		};
		// The private constructor is reached directly so each test gets a fresh
		// instance (initialize() keeps a process-wide singleton).
		const Ctor = ResourcesCatalogService as unknown as new (context: vscode.ExtensionContext) => ResourcesCatalogService;
		const service = new Ctor({ globalState: memento } as unknown as vscode.ExtensionContext);
		harness = {
			service, authChanged, fetches, updates, reads,
			setFetch: fn => { fetchImpl = fn; },
			setSignedIn: value => { signedIn = value; }
		};
	});

	teardown(() => {
		harness.service.dispose();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
		_resetShimState();
	});

	test('construction deletes the old stored-catalog key once and reads nothing', () => {
		// NEGATIVE CONTROL: remove the purgeStoredCatalog call from the constructor
		// (or bring back loadFromStorage's globalState.get) -> updates is empty
		// (or reads is non-empty) -> RED.
		assert.deepStrictEqual(harness.updates, [[LEGACY_KEY, undefined]]);
		assert.deepStrictEqual(harness.reads, []);
	});

	test('a failed fetch rejects with its error; no stored or offline-only catalog is served', async () => {
		// NEGATIVE CONTROL: restore the old doFetch fall-through (storage copy,
		// then buildOfflineOnlyCatalog) when the fetch throws -> getCatalog(true)
		// resolves with a substitute catalog -> RED.
		await harness.service.getCatalog();
		harness.setFetch(async () => { throw new Error('quantlab-host-data:upstream:503: catalog down'); });
		await assert.rejects(() => harness.service.getCatalog(true), /upstream:503/);
	});

	test('an identity change drops the in-memory catalog', async () => {
		// NEGATIVE CONTROL: remove the onAuthStateChange subscription (or make
		// dropForIdentityChange keep this.catalog) -> the third getCatalog is
		// served from memory -> 1 fetch -> RED.
		await harness.service.getCatalog();
		await harness.service.getCatalog();
		assert.strictEqual(harness.fetches.length, 1, 'second read served from memory within the TTL');
		harness.authChanged.fire(true); // a change of user while signed in
		await harness.service.getCatalog();
		assert.strictEqual(harness.fetches.length, 2, 'the new identity fetches its own catalog');
		assert.strictEqual(harness.fetches[1], undefined, 'no cached version of the previous identity is sent');
	});

	test('a fetch in flight across an identity change is dropped, not stored', async () => {
		// NEGATIVE CONTROL: remove the identityGeneration check in doFetch -> the
		// old identity's answer resolves and is kept -> the first assertion fails -> RED.
		let release: (value: ResourcesCatalogResponse) => void = () => undefined;
		harness.setFetch(() => new Promise<ResourcesCatalogResponse>(resolve => { release = resolve; }));
		const inFlight = harness.service.getCatalog();
		harness.authChanged.fire(true); // a change of user while the fetch is pending
		release(catalogResponse('old-identity'));
		await assert.rejects(() => inFlight, /identity changed/);
		harness.setFetch(async () => catalogResponse('v2'));
		const next = await harness.service.getCatalog();
		assert.ok(next);
		assert.strictEqual(next.version, 'v2');
	});

	test('signed out -> the built-in tools with no fetch; signed in + failing fetch -> rejects, no built-ins', async () => {
		// NEGATIVE CONTROL (either half): drop the isAuthenticated() branch in
		// getCatalog -> signed out makes a fetch (fetches.length 1) -> RED; or
		// serve buildBuiltInCatalog() when the signed-in fetch throws -> the
		// second getCatalog resolves with version 'offline' -> RED.
		harness.setSignedIn(false);
		const signedOut = await harness.service.getCatalog();
		assert.ok(signedOut);
		assert.strictEqual(signedOut.version, 'offline', 'signed out: the built-in catalog');
		assert.ok(signedOut.statistics.length + signedOut.strategy.length > 0, 'built-in tools present');
		assert.strictEqual(harness.fetches.length, 0, 'signed out: no fetch is made');

		harness.setSignedIn(true);
		harness.authChanged.fire(true);
		harness.setFetch(async () => { throw new Error('quantlab-host-data:upstream:502: catalog down'); });
		await assert.rejects(() => harness.service.getCatalog(), /upstream:502/);
		assert.strictEqual(harness.fetches.length, 1, 'signed in: the server is asked');
	});
});
