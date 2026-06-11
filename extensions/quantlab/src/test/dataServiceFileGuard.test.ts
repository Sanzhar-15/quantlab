/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, Uri, _setWorkspaceFolders, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../core/engine/DataService';

// H12 regression: getOHLCVFromFile used to call validateWorkspacePath (which
// runs fs.realpathSync.native) BEFORE the existsSync guard, so a missing file
// surfaced as a raw "ENOENT: no such file or directory" system error instead
// of the intended friendly "File not found: <path>" message.
suite('DataService getOHLCVFromFile missing-file guard (H12)', () => {
	setup(() => {
		_resetShimState();
		DataService.resetInstance();
	});

	teardown(() => {
		_resetShimState();
		DataService.resetInstance();
	});

	test('missing file rejects with the friendly message, not raw ENOENT (no workspace)', async () => {
		const missing = path.join(os.tmpdir(), `quantlab-h12-missing-${Date.now()}.csv`);
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromFile(missing),
			(error: unknown) => {
				assert.ok(error instanceof Error, 'must reject with an Error');
				assert.ok(
					error.message.startsWith('File not found:'),
					`expected friendly "File not found:" message, got: ${error.message}`
				);
				assert.ok(!error.message.includes('ENOENT'), `raw ENOENT leaked: ${error.message}`);
				return true;
			}
		);
	});

	test('missing file rejects with the friendly message when a workspace IS open', async () => {
		const wsRoot = os.tmpdir();
		_setWorkspaceFolders([{ uri: Uri.file(wsRoot), name: 'ws' }]);

		const missing = path.join(wsRoot, `quantlab-h12-missing-${Date.now()}.csv`);
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromFile(missing),
			(error: unknown) => {
				assert.ok(error instanceof Error, 'must reject with an Error');
				assert.ok(
					error.message.startsWith('File not found:'),
					`expected friendly "File not found:" message, got: ${error.message}`
				);
				return true;
			}
		);
	});
});
