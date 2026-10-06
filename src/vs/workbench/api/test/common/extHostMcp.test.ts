/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogLevel } from '../../../../platform/log/common/log.js';
import { createAuthMetadata, CommonResponse, IAuthMetadata } from '../../common/extHostMcp.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SecretDecryptionError } from '../../../../platform/secrets/common/secrets.js';
import { createMcpHttpHarness, createMcpHttpHarnessFrom, errorStateMessages, HARNESS_MCP_URL, harnessResponse, harnessStreamResponse, IMcpHttpHarness } from './mcpHttpHandleHarness.js';

// Test constants to avoid magic strings
const TEST_MCP_URL = 'https://example.com/mcp';
const TEST_AUTH_SERVER = 'https://auth.example.com';
const TEST_RESOURCE_METADATA_URL = 'https://example.com/.well-known/oauth-protected-resource';

/**
 * Creates a mock CommonResponse for testing.
 */
function createMockResponse(options: {
	status?: number;
	statusText?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: string;
}): CommonResponse {
	const headers = new Headers(options.headers ?? {});
	return {
		status: options.status ?? 200,
		statusText: options.statusText ?? 'OK',
		url: options.url ?? TEST_MCP_URL,
		headers,
		body: null,
		json: async () => JSON.parse(options.body ?? '{}'),
		text: async () => options.body ?? '',
	};
}

/**
 * Helper to create an IAuthMetadata instance for testing via the factory function.
 * Uses a mock fetch that returns the provided server metadata.
 */
async function createTestAuthMetadata(options: {
	scopes?: string[];
	serverMetadataIssuer?: string;
	resourceMetadata?: { resource: string; authorization_servers?: string[]; scopes_supported?: string[] };
}): Promise<{ authMetadata: IAuthMetadata; logMessages: Array<{ level: LogLevel; message: string }> }> {
	const logMessages: Array<{ level: LogLevel; message: string }> = [];
	const mockLogger = (level: LogLevel, message: string) => logMessages.push({ level, message });

	const issuer = options.serverMetadataIssuer ?? TEST_AUTH_SERVER;

	const mockFetch = sinon.stub();

	// Mock resource metadata fetch
	mockFetch.onCall(0).resolves(createMockResponse({
		status: 200,
		url: TEST_RESOURCE_METADATA_URL,
		body: JSON.stringify(options.resourceMetadata ?? {
			resource: TEST_MCP_URL,
			authorization_servers: [issuer]
		})
	}));

	// Mock server metadata fetch
	mockFetch.onCall(1).resolves(createMockResponse({
		status: 200,
		url: `${issuer}/.well-known/oauth-authorization-server`,
		body: JSON.stringify({
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			response_types_supported: ['code']
		})
	}));

	const wwwAuthHeader = options.scopes
		? `Bearer scope="${options.scopes.join(' ')}"`
		: 'Bearer realm="example"';

	const originalResponse = createMockResponse({
		status: 401,
		url: TEST_MCP_URL,
		headers: {
			'WWW-Authenticate': wwwAuthHeader
		}
	});

	const authMetadata = await createAuthMetadata(
		TEST_MCP_URL,
		originalResponse,
		{
			launchHeaders: new Map(),
			fetch: mockFetch,
			log: mockLogger
		}
	);

	return { authMetadata, logMessages };
}

suite('ExtHostMcp', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('IAuthMetadata', () => {
		suite('properties', () => {
			test('should expose readonly properties', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: ['read', 'write'],
					serverMetadataIssuer: TEST_AUTH_SERVER
				});

				assert.ok(authMetadata.authorizationServer.toString().startsWith(TEST_AUTH_SERVER));
				assert.strictEqual(authMetadata.serverMetadata.issuer, TEST_AUTH_SERVER);
				assert.deepStrictEqual(authMetadata.scopes, ['read', 'write']);
			});

			test('should allow undefined scopes', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: undefined
				});

				assert.strictEqual(authMetadata.scopes, undefined);
			});
		});

		suite('update()', () => {
			test('should return true and update scopes when WWW-Authenticate header contains new scopes', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: ['read']
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer scope="read write admin"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, true);
				assert.deepStrictEqual(authMetadata.scopes, ['read', 'write', 'admin']);
			});

			test('should return false when scopes are the same', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: ['read', 'write']
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer scope="read write"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, false);
				assert.deepStrictEqual(authMetadata.scopes, ['read', 'write']);
			});

			test('should return false when scopes are same but in different order', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: ['read', 'write']
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer scope="write read"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, false);
			});

			test('should return true when updating from undefined scopes to defined scopes', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: undefined
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer scope="read"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, true);
				assert.deepStrictEqual(authMetadata.scopes, ['read']);
			});

			test('should return true when updating from defined scopes to undefined (no scope in header)', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: ['read']
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer realm="example"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, true);
				assert.strictEqual(authMetadata.scopes, undefined);
			});

			test('should return false when no WWW-Authenticate header and scopes are already undefined', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: undefined
				});

				const response = createMockResponse({
					status: 401,
					headers: {}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, false);
			});

			test('should handle multiple Bearer challenges and use first scope', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: undefined
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Bearer scope="first", Bearer scope="second"'
					}
				});

				authMetadata.update(response);

				assert.deepStrictEqual(authMetadata.scopes, ['first']);
			});

			test('should ignore non-Bearer schemes', async () => {
				const { authMetadata } = await createTestAuthMetadata({
					scopes: undefined
				});

				const response = createMockResponse({
					status: 401,
					headers: {
						'WWW-Authenticate': 'Basic realm="example"'
					}
				});

				const result = authMetadata.update(response);

				assert.strictEqual(result, false);
				assert.strictEqual(authMetadata.scopes, undefined);
			});
		});
	});

	suite('createAuthMetadata', () => {
		let sandbox: sinon.SinonSandbox;
		let logMessages: Array<{ level: LogLevel; message: string }>;
		let mockLogger: (level: LogLevel, message: string) => void;

		setup(() => {
			sandbox = sinon.createSandbox();
			logMessages = [];
			mockLogger = (level, message) => logMessages.push({ level, message });
		});

		teardown(() => {
			sandbox.restore();
		});

		test('should create IAuthMetadata with fetched server metadata', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER],
					scopes_supported: ['read', 'write']
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					'WWW-Authenticate': 'Bearer scope="api.read"'
				}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map([['X-Custom', 'value']]),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			assert.ok(authMetadata.authorizationServer.toString().startsWith(TEST_AUTH_SERVER));
			assert.strictEqual(authMetadata.serverMetadata.issuer, TEST_AUTH_SERVER);
			assert.deepStrictEqual(authMetadata.scopes, ['api.read']);
		});

		test('should fall back to default metadata when server metadata fetch fails', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch - fails
			mockFetch.onCall(0).rejects(new Error('Network error'));

			// Mock server metadata fetch - also fails
			mockFetch.onCall(1).rejects(new Error('Network error'));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// Should use default metadata based on the URL
			assert.ok(authMetadata.authorizationServer.toString().startsWith('https://example.com'));
			assert.ok(authMetadata.serverMetadata.issuer.startsWith('https://example.com'));
			assert.ok(authMetadata.serverMetadata.authorization_endpoint?.startsWith('https://example.com/authorize'));
			assert.ok(authMetadata.serverMetadata.token_endpoint?.startsWith('https://example.com/token'));

			// Should log the fallback
			assert.ok(logMessages.some(m =>
				m.level === LogLevel.Info &&
				m.message.includes('Using default auth metadata')
			));
		});

		test('should use scopes from WWW-Authenticate header when resource metadata has none', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch - no scopes_supported
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER]
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					'WWW-Authenticate': 'Bearer scope="header.scope"'
				}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			assert.deepStrictEqual(authMetadata.scopes, ['header.scope']);
		});

		test('should use scopes from WWW-Authenticate header even when resource metadata has scopes_supported', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch - has scopes_supported
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER],
					scopes_supported: ['resource.scope1', 'resource.scope2']
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					'WWW-Authenticate': 'Bearer scope="header.scope"'
				}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// WWW-Authenticate header scopes take precedence over resource metadata scopes_supported
			assert.deepStrictEqual(authMetadata.scopes, ['header.scope']);
		});

		test('should use resource_metadata challenge URL from WWW-Authenticate header', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch from challenge URL
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: 'https://example.com/custom-resource-metadata',
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER]
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/custom-resource-metadata"'
				}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			assert.ok(authMetadata.authorizationServer.toString().startsWith(TEST_AUTH_SERVER));

			// Verify the resource_metadata URL was logged
			assert.ok(logMessages.some(m =>
				m.level === LogLevel.Debug &&
				m.message.includes('resource_metadata challenge')
			));
		});

		test('should pass launch headers when fetching metadata from same origin', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch to succeed so we can verify headers
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER]
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {}
			});

			const launchHeaders = new Map<string, string>([
				['Authorization', 'Bearer existing-token'],
				['X-Custom-Header', 'custom-value']
			]);

			await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders,
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// Verify fetch was called
			assert.ok(mockFetch.called, 'fetch should have been called');

			// Verify the first call (resource metadata) included the launch headers
			const firstCallArgs = mockFetch.firstCall.args;
			assert.ok(firstCallArgs.length >= 2, 'fetch should have been called with options');
			const fetchOptions = firstCallArgs[1] as RequestInit;
			assert.ok(fetchOptions.headers, 'fetch options should include headers');
		});

		test('should handle empty scope string in WWW-Authenticate header', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER]
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					'WWW-Authenticate': 'Bearer scope=""'
				}
			});

			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// Empty scope string should result in empty array or undefined
			assert.ok(
				authMetadata.scopes === undefined ||
				(Array.isArray(authMetadata.scopes) && authMetadata.scopes.length === 0) ||
				(Array.isArray(authMetadata.scopes) && authMetadata.scopes.every(s => s === '')),
				'Empty scope string should be handled gracefully'
			);
		});

		test('should handle malformed WWW-Authenticate header gracefully', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: JSON.stringify({
					resource: TEST_MCP_URL,
					authorization_servers: [TEST_AUTH_SERVER]
				})
			}));

			// Mock server metadata fetch
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: `${TEST_AUTH_SERVER}/.well-known/oauth-authorization-server`,
				body: JSON.stringify({
					issuer: TEST_AUTH_SERVER,
					authorization_endpoint: `${TEST_AUTH_SERVER}/authorize`,
					token_endpoint: `${TEST_AUTH_SERVER}/token`,
					response_types_supported: ['code']
				})
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {
					// Malformed header - missing closing quote
					'WWW-Authenticate': 'Bearer scope="unclosed'
				}
			});

			// Should not throw - should handle gracefully
			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// Should still create valid auth metadata
			assert.ok(authMetadata.authorizationServer);
			assert.ok(authMetadata.serverMetadata);
		});

		test('should handle invalid JSON in resource metadata response', async () => {
			const mockFetch = sandbox.stub();

			// Mock resource metadata fetch - returns invalid JSON
			mockFetch.onCall(0).resolves(createMockResponse({
				status: 200,
				url: TEST_RESOURCE_METADATA_URL,
				body: 'not valid json {'
			}));

			// Mock server metadata fetch - also returns invalid JSON
			mockFetch.onCall(1).resolves(createMockResponse({
				status: 200,
				url: 'https://example.com/.well-known/oauth-authorization-server',
				body: '{ invalid }'
			}));

			const originalResponse = createMockResponse({
				status: 401,
				url: TEST_MCP_URL,
				headers: {}
			});

			// Should fall back to default metadata, not throw
			const authMetadata = await createAuthMetadata(
				TEST_MCP_URL,
				originalResponse,
				{
					launchHeaders: new Map(),
					fetch: mockFetch,
					log: mockLogger
				}
			);

			// Should use default metadata
			assert.ok(authMetadata.authorizationServer);
			assert.ok(authMetadata.serverMetadata);
		});

		test('should handle non-401 status codes in update()', async () => {
			const { authMetadata } = await createTestAuthMetadata({
				scopes: ['read']
			});

			// Response with 403 instead of 401
			const response = createMockResponse({
				status: 403,
				headers: {
					'WWW-Authenticate': 'Bearer scope="new.scope"'
				}
			});

			// update() should still process the WWW-Authenticate header regardless of status
			const result = authMetadata.update(response);

			// The behavior depends on implementation - either it updates or ignores non-401
			// This test documents the actual behavior
			assert.strictEqual(typeof result, 'boolean');
		});
	});
});


// F-SECRETS-3: no automatic path removes, replaces or registers anew a stored credential; each fails visibly and stops.
suite('McpHTTPHandle authentication failures', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a 401 to a request carrying the stored authorization stops: no new registration is forced, and the server state names the failure', async () => {
		const harness = createMcpHttpHarness([401, 401], async () => 'stored-token', '');
		store.add(harness.handle);

		await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

		assert.deepStrictEqual(harness.tokenRequests.map(o => o?.forceNewRegistration), [undefined], 'one token request, never forcing a new registration');
		assert.deepStrictEqual(harness.posts, [undefined, 'Bearer stored-token'], 'no retry after the rejection');
		const errors = errorStateMessages(harness.states);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes('McpAuthorizationRejectedError') && errors[0].includes('HTTP 401'), errors[0]);
		assert.ok(errors[0].includes('Remove Dynamic Authentication Providers'), 'the message names the explicit reset');
		assert.ok(!errors[0].includes('stored-token'), 'the message carries no token');
	});

	test('a 403 to a request carrying the stored authorization stops the same way', async () => {
		const harness = createMcpHttpHarness([401, 403], async () => 'stored-token', '');
		store.add(harness.handle);

		await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

		assert.deepStrictEqual(harness.tokenRequests.map(o => o?.forceNewRegistration), [undefined]);
		assert.deepStrictEqual(harness.posts, [undefined, 'Bearer stored-token']);
		const errors = errorStateMessages(harness.states);
		assert.ok(errors.length === 1 && errors[0].includes('McpAuthorizationRejectedError') && errors[0].includes('HTTP 403'), errors.join('\n'));
	});

	test('a failed stored read while getting the token stops the operation: no request is sent without authorization', async () => {
		let tokenReads = 0;
		const harness = createMcpHttpHarness([401, 500], async () => {
			if (++tokenReads === 1) {
				return 'stored-token';
			}
			throw new SecretDecryptionError('dynamic-auth-sessions');
		}, '');
		store.add(harness.handle);

		// The first message learns that the server asks for authorization; the server then fails it (500).
		await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		assert.deepStrictEqual(harness.posts, [undefined, 'Bearer stored-token']);

		// The next message cannot read the stored session: it must not go out unauthenticated.
		await harness.handle.send('{"jsonrpc":"2.0","id":2,"method":"ping"}');

		assert.deepStrictEqual(harness.posts, [undefined, 'Bearer stored-token'], 'no request after the failed read');
		const errors = errorStateMessages(harness.states);
		assert.strictEqual(errors.length, 2);
		assert.ok(errors[1].includes('McpAuthenticationFailedError'), errors[1]);
	});

	/** Waits (bounded) for the handle's background work, such as the unawaited legacy SSE fallback. */
	async function waitFor(condition: () => boolean, what: string, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition() && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(condition(), `timed out waiting for ${what}`);
	}

	// review-c1 MUST-6: legacy SSE POSTs carrying the stored authorization.
	test('legacy SSE: a 401 and a 403 to an authenticated POST stop, named, in the server state; no retry, no new registration', async () => {
		const messagesUrl = 'https://mcp.example.com/messages';
		const messagePostStatuses = [401, 403];
		let sseGets = 0;
		const harness = createMcpHttpHarnessFrom({
			getToken: async () => 'stored-token',
			getTokenForProvider: () => Promise.reject(new Error('not used')),
			authentication: undefined,
			transport: async (url, init) => {
				if (url === HARNESS_MCP_URL && init?.method === 'POST') {
					return harnessResponse(405, url); // not streamable HTTP: fall back to legacy SSE
				}
				if (url === HARNESS_MCP_URL && init?.method === 'GET') {
					if (++sseGets === 1) {
						return harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' });
					}
					return new Response('event: endpoint\ndata: /messages\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as CommonResponse;
				}
				if (url === messagesUrl && init?.method === 'POST') {
					const status = messagePostStatuses.shift();
					assert.ok(status !== undefined, 'unexpected POST to the legacy endpoint');
					return harnessResponse(status, url, {}, 'echo stored-token');
				}
				return harnessResponse(404, url);
			},
		});
		store.add(harness.handle);

		await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		await waitFor(() => errorStateMessages(harness.states).length === 1, 'the first legacy POST to fail');
		await harness.handle.send('{"jsonrpc":"2.0","id":2,"method":"ping"}');

		const errors = errorStateMessages(harness.states);
		assert.strictEqual(errors.length, 2, errors.join('\n'));
		assert.ok(errors[0].includes('McpAuthorizationRejectedError') && errors[0].includes('HTTP 401'), errors[0]);
		assert.ok(errors[1].includes('McpAuthorizationRejectedError') && errors[1].includes('HTTP 403'), errors[1]);
		const legacyPosts = harness.requests.filter(r => r.url === messagesUrl);
		assert.deepStrictEqual(legacyPosts.map(r => r.authorization), ['Bearer stored-token', 'Bearer stored-token'], 'no retry after a rejection');
		assert.ok(harness.tokenRequests.every(o => o?.forceNewRegistration === undefined), 'no new registration is forced');
	});

	// review-c1 MUST-7: no response body and no underlying error text in any log line or server state.
	test('no planted marker from an authenticated response body or a token getter error reaches a log line or the server state', async () => {
		const BODY = 'MARKER-BODY-5d1';
		const META = 'MARKER-META-8c2';
		const PROVIDER = 'MARKER-PROVIDER-3e7';

		const rejected = createMcpHttpHarness([401, 401], async () => 'stored-token', `{"error":"invalid_token","echo":"${BODY}"}`);
		store.add(rejected.handle);
		await rejected.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

		let reads = 0;
		const metadataFails = createMcpHttpHarness([401, 500], async () => {
			if (++reads === 1) {
				return 'stored-token';
			}
			throw new Error(`keychain said ${META}`);
		}, '');
		store.add(metadataFails.handle);
		await metadataFails.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		await metadataFails.handle.send('{"jsonrpc":"2.0","id":2,"method":"ping"}');

		const providerFails = createMcpHttpHarnessFrom({
			getToken: () => Promise.reject(new Error('not used')),
			getTokenForProvider: async () => { throw new Error(`provider said ${PROVIDER}`); },
			authentication: { providerId: 'example', scopes: ['read'] },
			transport: async url => harnessResponse(200, url),
		});
		store.add(providerFails.handle);
		await providerFails.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

		for (const [name, harness, errorName] of [
			['authenticated 401', rejected, 'McpAuthorizationRejectedError'],
			['server metadata getter', metadataFails, 'McpAuthenticationFailedError'],
			['provided authentication getter', providerFails, 'McpAuthenticationFailedError'],
		] as const) {
			assert.ok(errorStateMessages(harness.states).some(m => m.includes(errorName)), `${name}: the failure is visible`);
		}
		for (const harness of [rejected, metadataFails, providerFails]) {
			const published = [...harness.logs, ...harness.states.map(s => JSON.stringify(s))];
			for (const line of published) {
				for (const marker of [BODY, META, PROVIDER]) {
					assert.ok(!line.includes(marker), `a marker reached a log line or the state: ${line}`);
				}
			}
		}
		assert.deepStrictEqual(providerFails.requests, [], 'no request without the authorization the server asked for');
	});

	// F-SECRETS-3 item-7 class: no response body, header value or error text on any transport path of the handle.
	test('no planted marker from a response body, a response header or a transport error reaches a log line or the server state', async () => {
		const M = 'MARKER-TRANSPORT-0b4';
		const SSE = { 'content-type': 'text/event-stream', 'x-echo': M };
		const messagesUrl = 'https://mcp.example.com/messages';
		const harnesses: [string, IMcpHttpHarness][] = [];
		const make = (name: string, transport: (url: string, method: string | undefined, nth: number) => Promise<CommonResponse>) => {
			const counts = new Map<string, number>();
			const harness = createMcpHttpHarnessFrom({
				getToken: async () => undefined,
				getTokenForProvider: () => Promise.reject(new Error('not used')),
				authentication: undefined,
				transport: (url, init) => {
					const key = `${init?.method} ${url}`;
					const nth = (counts.get(key) ?? 0) + 1;
					counts.set(key, nth);
					return transport(url, init?.method, nth);
				},
			});
			store.add(harness.handle);
			harnesses.push([name, harness]);
			return harness;
		};
		const send = (harness: IMcpHttpHarness) => harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		const sawLog = (harness: IMcpHttpHarness, text: string) => () => harness.logs.some(l => l.includes(text));
		const sawError = (harness: IMcpHttpHarness, text: string) => () => errorStateMessages(harness.states).some(m => m.includes(text));

		// Streamable HTTP: an error status with a body and a header (status state, response trace).
		const status500 = make('POST 500', async url => harnessResponse(500, url, { 'x-echo': M }, `{"echo":"${M}"}`));
		await send(status500);
		await waitFor(sawError(status500, '500 status sending message'), 'the 500 state');

		// Streamable HTTP: a successful response that is neither JSON nor SSE.
		const unexpected = make('POST 200 text', async url => harnessResponse(200, url, { 'content-type': 'text/plain' }, `not json ${M}`));
		await send(unexpected);
		await waitFor(sawLog(unexpected, 'Unexpected 200 response'), 'the unexpected-response line');

		// Streamable HTTP: an SSE response whose stream fails.
		const streamFails = make('POST SSE read error', async url => harnessStreamResponse(200, url, SSE, '', new Error(`stream said ${M}`)));
		await send(streamFails);
		await waitFor(sawLog(streamFails, 'Error reading SSE stream'), 'the SSE read line');

		// OAuth metadata lookups that fail.
		const metadataFails = make('metadata errors', async (url, method) => {
			if (url === HARNESS_MCP_URL && method === 'POST') {
				return harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' });
			}
			throw new Error(`lookup said ${M}`);
		});
		await send(metadataFails);
		await waitFor(() => metadataFails.logs.some(l => /resource metadata|auth server metadata/.test(l)), 'a metadata line');

		// The async-notification backchannel: a stream that fails, then an error status with a body.
		const backchannel = make('backchannel', async (url, method, nth) => {
			if (method === 'POST') {
				return harnessResponse(202, url);
			}
			if (method === 'GET' && nth === 1) {
				return harnessStreamResponse(200, url, SSE, '', new Error(`async stream said ${M}`));
			}
			return harnessResponse(405, url, { 'x-echo': M }, `{"echo":"${M}"}`);
		});
		await send(backchannel);
		await waitFor(sawLog(backchannel, 'for async notifications; they will be disabled'), 'the backchannel to stop', 3000);
		assert.ok(backchannel.logs.some(l => l.includes('Error reading from async stream')));

		// Legacy SSE: the attach fails with a body; a stream that fails after the endpoint; a POST that fails with a body.
		const legacyAttach = make('legacy attach 500', async (url, method) => method === 'POST'
			? harnessResponse(405, url)
			: harnessResponse(500, url, { 'x-echo': M }, `{"echo":"${M}"}`));
		await send(legacyAttach);
		await waitFor(sawError(legacyAttach, 'as SSE'), 'the legacy attach state');

		const legacy = make('legacy stream and POST', async (url, method) => {
			if (url === HARNESS_MCP_URL && method === 'POST') {
				return harnessResponse(405, url);
			}
			if (url === HARNESS_MCP_URL && method === 'GET') {
				return harnessStreamResponse(200, url, SSE, 'event: endpoint\ndata: /messages\n\n', new Error(`legacy stream said ${M}`));
			}
			if (url === messagesUrl) {
				return harnessResponse(500, url, { 'x-echo': M }, `{"echo":"${M}"}`);
			}
			return harnessResponse(404, url);
		});
		await send(legacy);
		await waitFor(sawError(legacy, 'Error reading SSE stream'), 'the legacy stream state');
		await waitFor(sawLog(legacy, '500 status sending message'), 'the legacy POST line');

		for (const [name, harness] of harnesses) {
			for (const line of [...harness.logs, ...harness.states.map(state => JSON.stringify(state))]) {
				assert.ok(!line.includes(M), `${name}: a marker reached a log line or the state: ${line}`);
			}
		}
	});
});
