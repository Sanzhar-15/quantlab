/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DataService } from '../core/engine/DataService';
import { ServerApiClient } from '../core/server/ServerApiClient';

// QL-LOGIN+DATA c1 SHOULD 7: a host refusal injected at the transport (vscode.quantlabHost.request) reaches the
// callers of DataService.getOHLCVFromServer UNCHANGED, so the code (and the status of a server error) is still
// readable. DataService wraps only errors that are not host refusals.
//
// Planted negative control: delete the `isHostRefusal(error)` branch in getOHLCVFromServer's catch. Every refusal
// then arrives as a fresh `Error: Failed to fetch data from server: ...` with no code and no status, and the
// 'is the injected error itself' assertions fail for identity-changed, cancelled and server.

function setHost(host: unknown): void {
	(vscode as unknown as { quantlabHost?: unknown }).quantlabHost = host;
}

function clearHost(): void {
	delete (vscode as unknown as { quantlabHost?: unknown }).quantlabHost;
}

/** A refusal as the ext-host bridge builds it: the answer's message, `.code`, and `.status` when the host gave one. */
function refusal(code: string, message: string, status?: number): Error & { code: string; status?: number } {
	const error: Error & { code: string; status?: number } = Object.assign(new Error(message), { code });
	if (status !== undefined) {
		error.status = status;
	}
	return error;
}

suite('DataService: host refusals reach the caller unchanged (QL-DATA ERR)', () => {
	let rejection: unknown;
	let hostCalls = 0;

	setup(() => {
		_resetShimState();
		hostCalls = 0;
		rejection = undefined;
		setHost({
			request: async (): Promise<unknown> => {
				hostCalls++;
				throw rejection;
			},
		});
		ServerApiClient.resetInstance();
		DataService.resetInstance();
	});

	teardown(() => {
		ServerApiClient.resetInstance();
		DataService.resetInstance();
		clearHost();
	});

	const cases: [string, Error & { code: string; status?: number }][] = [
		['identity-changed', refusal('identity-changed', 'review identity changed')],
		['cancelled', refusal('cancelled', 'cancelled')],
		['server with a status', refusal('server', 'bad gateway', 502)],
	];

	for (const [name, injected] of cases) {
		test(`'${name}' injected at the transport: the DataService caller reads the same code and status`, async () => {
			rejection = injected;
			await assert.rejects(
				() => DataService.getInstance().getOHLCVFromServer('TEST', '1D'),
				(error: Error & { code?: unknown; status?: unknown }) => {
					assert.strictEqual(error, injected, 'the host refusal itself, not a replacement');
					assert.strictEqual(error.code, injected.code);
					assert.strictEqual(error.status, injected.status);
					return true;
				}
			);
			assert.strictEqual(hostCalls, 1, 'the refusal is not retried');
		});
	}

	test('the crypto single-fetch path passes a refusal on unchanged too', async () => {
		rejection = refusal('server', 'upstream down', 503);
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromServer('BTC', '1D', undefined, undefined, 'crypto'),
			(error: Error & { code?: unknown; status?: unknown }) => error === rejection && error.code === 'server' && error.status === 503
		);
	});

	test('an error that is not a host refusal is still wrapped with the server-fetch context', async () => {
		rejection = new Error('Unexpected /v1/bars response shape: null');
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromServer('TEST', '1D'),
			(error: Error) => error !== rejection && /^Failed to fetch data from server: Unexpected \/v1\/bars response shape: null$/.test(error.message)
		);
	});

	test('a cancellation before the call keeps its existing Cancelled error and makes no host call', async () => {
		const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() { /* none */ } }) };
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromServer('TEST', '1D', undefined, token as unknown as vscode.CancellationToken),
			/^Error: Cancelled$/
		);
		assert.strictEqual(hostCalls, 0);
	});
});
