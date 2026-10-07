/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isRemoteAuthorityProtocolUrl } from '../../electron-main/remoteProtocolUrl.js';

suite('remoteProtocolUrl', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a link asking for a remote authority is refused', () => {
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://vscode-remote/wsl+ubuntu/mnt/c/dev/monaco')), true);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://vscode-remote/ssh-remote+host/home/user:10:2')), true);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://VSCODE-REMOTE/wsl+ubuntu/x')), true);
	});

	test('other protocol links are not refused', () => {
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://file/Users/me/project')), false);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://publisher.extension/path')), false);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://vscode-remote')), false);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab://file/Users/me/vscode-remote')), false);
		assert.strictEqual(isRemoteAuthorityProtocolUrl(URI.parse('quantlab:workspace?x')), false);
	});
});
