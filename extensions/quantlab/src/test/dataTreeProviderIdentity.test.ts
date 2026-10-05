/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';

// DataTreeProvider needs the tree-view surface the minimal shim doesn't carry
// (same in-place augmentation as dataTreeProvider.test.ts; the shim file is
// owned by another workstream).
const shim = vscode as unknown as Record<string, unknown>;
if (shim.TreeItemCollapsibleState === undefined) {
	shim.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
}
if (shim.ThemeIcon === undefined) {
	shim.ThemeIcon = class {
		constructor(readonly id: string) { }
	};
}
if (shim.TreeItem === undefined) {
	shim.TreeItem = class {
		constructor(readonly label: string, readonly collapsibleState?: number) { }
	};
}

import { DataTreeProvider } from '../panels/data/DataTreeProvider';
import { GlobalState } from '../core/state/GlobalState';
import { WatchlistManager } from '../panels/data/WatchlistManager';
import { ServerApiClient, ServerUser } from '../core/server/ServerApiClient';

// QL-DATA DT-3 (window ruling): the tree's server-derived caches (equity and
// crypto symbols, ETFs, indices) belong to ONE identity. They are dropped on
// sign-in, sign-out AND a change of user while signed in -- not on a change of
// the same user's display fields.

suite('DataTreeProvider drops its server caches on every change of identity', () => {
	const originalGetInstance = ServerApiClient.getInstance;
	const authChanged = new vscode.EventEmitter<boolean>();
	let currentUser: ServerUser | undefined;
	let provider: DataTreeProvider;
	let resets = 0;

	const noEvent = (_listener: unknown): vscode.Disposable => new vscode.Disposable(() => { });

	setup(() => {
		currentUser = undefined;
		resets = 0;
		const fake = {
			onAuthStateChange: authChanged.event,
			getUser: () => currentUser,
			getSymbols: async () => []
		} as unknown as ServerApiClient;
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fake;
		provider = new DataTreeProvider(
			{ getDataSource: () => undefined, onDidChangeDataSource: noEvent } as unknown as GlobalState,
			{ onDidChange: noEvent, getWatchlists: () => [] } as unknown as WatchlistManager
		);
		// Count resets; the instance property shadows the prototype method the
		// auth handler calls through `this`.
		(provider as unknown as { resetServerCaches(): void }).resetServerCaches = () => { resets++; };
	});

	teardown(() => {
		provider.dispose();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
	});

	function identity(user: ServerUser | undefined): void {
		currentUser = user;
		authChanged.fire(user !== undefined);
	}

	test('sign-in, a change of user, sign-out each reset once; a display-field change does not', () => {
		// NEGATIVE CONTROL: restore the signed-in/out flip comparison
		// (`if (signedIn === this.lastAuthSignedIn) return;`) -> the switch from
		// user A to user B (true -> true) does not reset -> resets is still 1 at
		// the third assertion -> RED.
		identity({ id: 'user-a', email: 'a@example.com' });
		assert.strictEqual(resets, 1, 'sign-in resets');
		identity({ id: 'user-a', email: 'a@example.com', name: 'A' });
		assert.strictEqual(resets, 1, 'a display-field change of the same user does not reset');
		identity({ id: 'user-b', email: 'b@example.com' });
		assert.strictEqual(resets, 2, 'a change of user while signed in resets');
		identity(undefined);
		assert.strictEqual(resets, 3, 'sign-out resets');
		identity(undefined);
		assert.strictEqual(resets, 3, 'a repeated signed-out state does not reset');
	});
});
