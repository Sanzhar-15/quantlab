/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	TokenAuth,
	generateToken,
	writeTokenFile,
	deleteTokenFile,
	readTokenInfo,
	validateToken,
	extractAuth,
} from '../../core/ipc/TokenAuth';
import { JsonRpcRequest } from '../../core/ipc/types';

suite('TokenAuth', () => {
	const testSessionId = 'test-session-' + Date.now();
	const testDir = path.join(os.homedir(), '.quantlab', 'sessions');
	const testTokenPath = path.join(testDir, `${testSessionId}.token`);
	const testToken = 'test-token-value-12345';

	// Setup: create test token file
	suiteSetup(async () => {
		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(testTokenPath, testToken);
	});

	// Teardown: remove test token file
	suiteTeardown(async () => {
		try {
			await fs.unlink(testTokenPath);
		} catch {
			// Ignore if already deleted
		}
	});

	suite('getToken', () => {
		test('reads token from file', async () => {
			const auth = new TokenAuth(testSessionId);
			const token = await auth.getToken();

			assert.strictEqual(token, testToken);
		});

		test('caches token', async () => {
			const auth = new TokenAuth(testSessionId, 10000); // 10 second cache

			const token1 = await auth.getToken();
			// Modify the file (shouldn't matter due to cache)
			const modified = testToken + '-modified';
			await fs.writeFile(testTokenPath, modified);

			const token2 = await auth.getToken();

			// Should still get cached value
			assert.strictEqual(token2, token1);

			// Restore original
			await fs.writeFile(testTokenPath, testToken);
		});

		test('throws on missing token file', async () => {
			const auth = new TokenAuth('nonexistent-session');

			try {
				await auth.getToken();
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Token file not found'));
			}
		});

		test('throws on empty token file', async () => {
			const emptySessionId = 'empty-session-' + Date.now();
			const emptyTokenPath = path.join(testDir, `${emptySessionId}.token`);
			await fs.writeFile(emptyTokenPath, '   '); // Whitespace only

			const auth = new TokenAuth(emptySessionId);

			try {
				await auth.getToken();
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('empty'));
			} finally {
				await fs.unlink(emptyTokenPath);
			}
		});
	});

	suite('hasToken', () => {
		test('returns true when token exists', async () => {
			const auth = new TokenAuth(testSessionId);
			const has = await auth.hasToken();

			assert.strictEqual(has, true);
		});

		test('returns false when token does not exist', async () => {
			const auth = new TokenAuth('nonexistent-session');
			const has = await auth.hasToken();

			assert.strictEqual(has, false);
		});
	});

	suite('authenticate', () => {
		test('adds auth to request with object params', async () => {
			const auth = new TokenAuth(testSessionId);
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test.method',
				params: { foo: 'bar' },
				id: 'req-1',
			};

			const authenticated = await auth.authenticate(request);

			assert.strictEqual(authenticated.jsonrpc, '2.0');
			assert.strictEqual(authenticated.method, 'test.method');
			assert.strictEqual(authenticated.id, 'req-1');

			const params = authenticated.params as any;
			assert.strictEqual(params.foo, 'bar');
			assert.strictEqual(params._auth.token, testToken);
			assert.strictEqual(params._auth.sessionId, testSessionId);
		});

		test('adds auth to request with no params', async () => {
			const auth = new TokenAuth(testSessionId);
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test.method',
				id: 'req-1',
			};

			const authenticated = await auth.authenticate(request);
			const params = authenticated.params as any;

			assert.ok(params._auth);
			assert.strictEqual(params._auth.token, testToken);
		});

		test('adds auth to request with primitive params', async () => {
			const auth = new TokenAuth(testSessionId);
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test.method',
				params: 'string-param',
				id: 'req-1',
			};

			const authenticated = await auth.authenticate(request);
			const params = authenticated.params as any;

			assert.strictEqual(params.value, 'string-param');
			assert.ok(params._auth);
		});
	});

	suite('clearCache', () => {
		test('clears cached token', async () => {
			const auth = new TokenAuth(testSessionId, 10000);

			// Read once to cache
			await auth.getToken();

			// Modify file
			const newToken = 'new-token-value';
			await fs.writeFile(testTokenPath, newToken);

			// Clear cache
			auth.clearCache();

			// Should read new value
			const token = await auth.getToken();
			assert.strictEqual(token, newToken);

			// Restore
			await fs.writeFile(testTokenPath, testToken);
		});
	});

	suite('getSessionId', () => {
		test('returns session ID', () => {
			const auth = new TokenAuth(testSessionId);
			assert.strictEqual(auth.getSessionId(), testSessionId);
		});
	});
});

suite('generateToken', () => {
	test('generates hex string of correct length', () => {
		const token = generateToken(16);

		// 16 bytes = 32 hex characters
		assert.strictEqual(token.length, 32);
		assert.match(token, /^[a-f0-9]+$/);
	});

	test('generates unique tokens', () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 100; i++) {
			tokens.add(generateToken());
		}

		assert.strictEqual(tokens.size, 100);
	});

	test('uses default length of 32 bytes', () => {
		const token = generateToken();
		assert.strictEqual(token.length, 64); // 32 bytes = 64 hex chars
	});
});

suite('writeTokenFile', () => {
	const testSessionId = 'write-test-' + Date.now();
	const testDir = path.join(os.homedir(), '.quantlab', 'sessions');

	suiteTeardown(async () => {
		try {
			await fs.unlink(path.join(testDir, `${testSessionId}.token`));
		} catch {
			// Ignore
		}
	});

	test('writes token file with secure permissions', async () => {
		const token = 'test-token-write';
		await writeTokenFile(testSessionId, token);

		const tokenPath = path.join(testDir, `${testSessionId}.token`);
		const content = await fs.readFile(tokenPath, 'utf-8');
		const stats = await fs.stat(tokenPath);

		assert.strictEqual(content, token);
		// Check permissions (0o600 = owner read/write only)
		assert.strictEqual(stats.mode & 0o777, 0o600);
	});
});

suite('deleteTokenFile', () => {
	test('deletes existing token file', async () => {
		const sessionId = 'delete-test-' + Date.now();
		await writeTokenFile(sessionId, 'test-token');

		await deleteTokenFile(sessionId);

		const tokenPath = path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.token`);
		try {
			await fs.access(tokenPath);
			assert.fail('File should not exist');
		} catch (error) {
			assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
		}
	});

	test('does not throw on nonexistent file', async () => {
		// Should not throw
		await deleteTokenFile('nonexistent-session-' + Date.now());
	});
});

suite('readTokenInfo', () => {
	const testSessionId = 'info-test-' + Date.now();

	suiteSetup(async () => {
		await writeTokenFile(testSessionId, 'info-test-token');
	});

	suiteTeardown(async () => {
		await deleteTokenFile(testSessionId);
	});

	test('reads token info', async () => {
		const info = await readTokenInfo(testSessionId);

		assert.ok(info);
		assert.strictEqual(info.token, 'info-test-token');
		assert.strictEqual(info.sessionId, testSessionId);
		assert.ok(info.createdAt > 0);
	});

	test('returns null for nonexistent session', async () => {
		const info = await readTokenInfo('nonexistent-' + Date.now());
		assert.strictEqual(info, null);
	});
});

suite('validateToken', () => {
	test('returns true for matching tokens', () => {
		const token = 'secret-token-value';
		assert.strictEqual(validateToken(token, token), true);
	});

	test('returns false for mismatched tokens', () => {
		assert.strictEqual(validateToken('token1', 'token2'), false);
	});

	test('returns false for different length tokens', () => {
		assert.strictEqual(validateToken('short', 'longer-token'), false);
	});

	test('is timing-safe', () => {
		// This test verifies the function exists and works
		// True timing-safety would require more sophisticated testing
		const token = 'a'.repeat(64);
		const similar = 'a'.repeat(63) + 'b';

		assert.strictEqual(validateToken(token, similar), false);
	});
});

suite('extractAuth', () => {
	test('extracts auth from valid params', () => {
		const params = {
			foo: 'bar',
			_auth: {
				token: 'secret-token',
				sessionId: 'session-123',
			},
		};

		const auth = extractAuth(params);

		assert.ok(auth);
		assert.strictEqual(auth.token, 'secret-token');
		assert.strictEqual(auth.sessionId, 'session-123');
	});

	test('returns null for missing _auth', () => {
		const params = { foo: 'bar' };
		assert.strictEqual(extractAuth(params), null);
	});

	test('returns null for null params', () => {
		assert.strictEqual(extractAuth(null), null);
	});

	test('returns null for non-object params', () => {
		assert.strictEqual(extractAuth('string'), null);
		assert.strictEqual(extractAuth(123), null);
	});

	test('returns null for invalid _auth structure', () => {
		assert.strictEqual(extractAuth({ _auth: 'not-an-object' }), null);
		assert.strictEqual(extractAuth({ _auth: { token: 123 } }), null);
		assert.strictEqual(extractAuth({ _auth: { token: 'ok' } }), null); // Missing sessionId
	});
});
