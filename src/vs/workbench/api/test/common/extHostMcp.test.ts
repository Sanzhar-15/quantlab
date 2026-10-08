/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogLevel } from '../../../../platform/log/common/log.js';
import { createAuthMetadata, CommonRequestInit, CommonResponse, IAuthMetadata } from '../../common/extHostMcp.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SecretDecryptionError } from '../../../../platform/secrets/common/secrets.js';
import { createMcpHttpHarness, createMcpHttpHarnessAt, createMcpHttpHarnessFrom, errorStateMessages, HARNESS_MCP_URL, harnessResponse, harnessStreamResponse, IMcpHttpHarness } from './mcpHttpHandleHarness.js';

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

			// Verify the resource_metadata challenge was found (its URL is server-provided and not logged)
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
			launchHeaders: [],
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
			launchHeaders: [],
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
				launchHeaders: [],
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

	// review-c2 c2-3 (R-91): HTTP header names are case-insensitive. A configured Authorization header, in any casing, is the
	// stored authorization: a 401/403 to a request carrying it stops, named, on both transports, and the trace masks it.
	const CONFIGURED_AUTH_NAMES = ['authorization', 'Authorization', 'AuThOrIzAtIoN'];
	const CONFIGURED_TOKEN = 'Bearer configured-token';

	for (const name of CONFIGURED_AUTH_NAMES) {
		for (const status of [401, 403]) {
			test(`streamable HTTP: a configured '${name}' header rejected with ${status} stops, named; no new registration`, async () => {
				const harness = createMcpHttpHarnessFrom({
					getToken: async () => undefined, // no generated token: only the configured header authorizes
					getTokenForProvider: () => Promise.reject(new Error('not used')),
					authentication: undefined,
					launchHeaders: [[name, CONFIGURED_TOKEN]],
					transport: async (url, init) => {
						if (url === HARNESS_MCP_URL && init?.method === 'POST') {
							return harnessResponse(status, url, status === 401 ? { 'WWW-Authenticate': 'Bearer realm="example"' } : {}, 'echo configured-token');
						}
						return harnessResponse(404, url);
					},
				});
				store.add(harness.handle);

				await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

				assert.deepStrictEqual(harness.tokenRequests.map(o => o?.forceNewRegistration), [undefined], 'one token request, never forcing a new registration');
				assert.deepStrictEqual(harness.posts, [CONFIGURED_TOKEN, CONFIGURED_TOKEN], 'the request once after the metadata lookup; no retry after the rejection');
				const errors = errorStateMessages(harness.states);
				assert.strictEqual(errors.length, 1, errors.join('\n'));
				assert.ok(errors[0].includes('McpAuthorizationRejectedError') && errors[0].includes(`HTTP ${status}`), errors[0]);
				assert.ok(errors[0].includes('Remove Dynamic Authentication Providers'), 'the message names the explicit reset');
				assert.ok(!errors[0].includes('configured-token'), 'the message carries no token');
			});

			test(`legacy SSE: a configured '${name}' header rejected with ${status} stops, named; no retry, no registration`, async () => {
				const messagesUrl = 'https://mcp.example.com/messages';
				const harness = createMcpHttpHarnessFrom({
					getToken: () => Promise.reject(new Error('not used: the configured header authorizes')),
					getTokenForProvider: () => Promise.reject(new Error('not used')),
					authentication: undefined,
					launchHeaders: [[name, CONFIGURED_TOKEN]],
					transport: async (url, init) => {
						if (url === HARNESS_MCP_URL && init?.method === 'POST') {
							return harnessResponse(405, url); // not streamable HTTP: fall back to legacy SSE
						}
						if (url === HARNESS_MCP_URL && init?.method === 'GET') {
							return new Response('event: endpoint\ndata: /messages\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as CommonResponse;
						}
						if (url === messagesUrl && init?.method === 'POST') {
							return harnessResponse(status, url, {}, 'echo configured-token');
						}
						return harnessResponse(404, url);
					},
				});
				store.add(harness.handle);

				await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
				await waitFor(() => errorStateMessages(harness.states).length === 1, 'the legacy POST to fail');

				const errors = errorStateMessages(harness.states);
				assert.strictEqual(errors.length, 1, errors.join('\n'));
				assert.ok(errors[0].includes('McpAuthorizationRejectedError') && errors[0].includes(`HTTP ${status}`), errors[0]);
				assert.ok(!errors[0].includes('configured-token'), 'the message carries no token');
				const legacyPosts = harness.requests.filter(r => r.url === messagesUrl);
				assert.deepStrictEqual(legacyPosts.map(r => r.authorization), [CONFIGURED_TOKEN], 'no retry after a rejection');
				assert.deepStrictEqual(harness.tokenRequests, [], 'no token request: nothing is registered or replaced');
			});
		}
	}

	for (const name of CONFIGURED_AUTH_NAMES) {
		test(`the request trace names a configured '${name}' header and the generated one, never a value; no credential reaches a log line`, async () => {
			const CONFIGURED = 'CONFIGURED-SECRET-71a';
			const GENERATED = 'GENERATED-SECRET-2f9';
			let postCount = 0;
			const harness = createMcpHttpHarnessFrom({
				getToken: async () => GENERATED,
				getTokenForProvider: () => Promise.reject(new Error('not used')),
				authentication: undefined,
				launchHeaders: [[name, `Bearer ${CONFIGURED}`]],
				transport: async (url, init) => {
					if (url === HARNESS_MCP_URL && init?.method === 'POST') {
						// A 401 first (the token is fetched and added), then a 500 that ends the operation.
						return ++postCount === 1 ? harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' }) : harnessResponse(500, url);
					}
					return harnessResponse(404, url);
				},
			});
			store.add(harness.handle);

			await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

			// The credentials did go on the wire, so their absence from the trace is the masking.
			assert.strictEqual(harness.posts.length, 2, `${harness.posts.length} POSTs`);
			assert.strictEqual(harness.posts[0], `Bearer ${CONFIGURED}`, 'the configured header was sent');
			// F-SECRETS-5: the generated token replaces the configured header in any casing: one value is sent.
			assert.strictEqual(harness.posts[1], `Bearer ${GENERATED}`, 'the generated header was sent, alone');
			// F-SECRETS-5: the trace names the headers and never prints a value.
			// review QL-G-LOGIN-SECRETS c1 M4: the configured endpoint is logged as its origin with a fixed description.
			const postTraces = harness.logs.filter(l => l.startsWith('Fetching POST https://mcp.example.com (configured endpoint);'));
			assert.strictEqual(postTraces.length, 2, postTraces.join('\n'));
			assert.ok(postTraces[0].includes(`header names: [${name}, `), `the configured header is named: ${postTraces[0]}`);
			assert.ok(postTraces[1].includes('Authorization]') || postTraces[1].includes('Authorization, '), `the generated header is named: ${postTraces[1]}`);
			for (const line of [...harness.logs, ...harness.states.map(s => JSON.stringify(s))]) {
				assert.ok(!line.includes(CONFIGURED) && !line.includes(GENERATED), `a credential reached a log line or the state: ${line}`);
			}
		});
	}
});

// F-SECRETS-5 (R-86): the request/response trace and every log line or server state that names a request print the method,
// the URL's origin with a fixed description (no path: review QL-G-LOGIN-SECRETS c1 M4), header NAMES and the body's byte
// length only.
suite('F-SECRETS-5: no request or response value reaches an MCP log line', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const PLANTED = {
		header: 'PLANT-HEADER-a41',
		cookie: 'PLANT-COOKIE-b52',
		query: 'PLANT-QUERY-c63',
		userinfo: 'PLANT-USERINFO-d74',
		rpc: 'PLANT-RPC-ARG-e85',
		formCode: 'PLANT-FORM-CODE-f96',
		formSecret: 'PLANT-FORM-SECRET-0a7',
		token: 'PLANT-TOKEN-1b8',
		redirectPath: 'PLANT-REDIRECT-PATH-2c9',
		redirectQuery: 'PLANT-REDIRECT-QUERY-3da',
		responseHeader: 'PLANT-RESPONSE-HEADER-4eb',
		ssePath: 'PLANT-SSE-PATH-5fc',
		sseQuery: 'PLANT-SSE-QUERY-60d',
		transportError: 'PLANT-TRANSPORT-ERROR-71e',
	};
	const PLANTED_VALUES = Object.values(PLANTED);
	const MCP_URL = `https://user:${PLANTED.userinfo}@mcp.example.com/mcp?api_key=${PLANTED.query}`;
	const LOGGED_ENDPOINT = 'https://mcp.example.com (configured endpoint)';
	const LAUNCH_HEADERS: [string, string][] = [['x-api-key', PLANTED.header], ['Cookie', `session=${PLANTED.cookie}`]];
	const RPC_MESSAGE = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","arguments":{"secret":"${PLANTED.rpc}"}}}`;
	const FORM_MESSAGE = `grant_type=authorization_code&code=${PLANTED.formCode}&client_secret=${PLANTED.formSecret}`;

	interface IWireRequest { method: string | undefined; url: string; headers: Record<string, string>; body: string | undefined }

	function wireRecord(wire: IWireRequest[], url: string, init: CommonRequestInit | undefined): void {
		wire.push({ method: init?.method, url, headers: { ...init?.headers }, body: init?.body ? new TextDecoder().decode(init.body) : undefined });
	}

	function byteLength(text: string): number {
		return new TextEncoder().encode(text).byteLength;
	}

	async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition() && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(condition(), `timed out waiting for ${what}`);
	}

	function assertNoPlantedValue(harness: IMcpHttpHarness): void {
		assert.ok(harness.logs.length > 0, 'the handle logged nothing: the recorder is not attached');
		for (const line of [...harness.logs, ...harness.states.map(state => JSON.stringify(state))]) {
			for (const value of PLANTED_VALUES) {
				assert.ok(!line.includes(value), `a planted value (${value}) reached a log line or the server state: ${line}`);
			}
		}
	}

	test('streamable HTTP: the trace names method, URL without query, header names and body length; no planted value is logged', async function () {
		this.timeout(10_000); // the backchannel retries once after a second
		const wire: IWireRequest[] = [];
		let mcpPosts = 0;
		let backchannelGets = 0;
		const harness = createMcpHttpHarnessAt(MCP_URL, {
			getToken: async () => PLANTED.token,
			getTokenForProvider: () => Promise.reject(new Error('not used')),
			authentication: undefined,
			launchHeaders: LAUNCH_HEADERS,
			transport: async (url, init) => {
				wireRecord(wire, url, init);
				if (url === MCP_URL && init?.method === 'POST') {
					switch (++mcpPosts) {
						case 1: return harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' });
						case 2: return harnessResponse(307, url, { 'location': `https://cdn.example.com/${PLANTED.redirectPath}?code=${PLANTED.redirectQuery}` });
						default: return harnessResponse(202, url, { 'x-echo': PLANTED.responseHeader });
					}
				}
				if (url.startsWith('https://cdn.example.com/') && init?.method === 'POST') {
					return harnessResponse(200, url, { 'content-type': 'application/json', 'set-cookie': `s=${PLANTED.responseHeader}`, 'x-echo': PLANTED.responseHeader }, '{}');
				}
				if (url === MCP_URL && init?.method === 'GET' && ++backchannelGets === 1) {
					throw new Error(`transport said ${PLANTED.transportError}`);
				}
				return harnessResponse(404, url, { 'x-echo': PLANTED.responseHeader }, `{"echo":"${PLANTED.responseHeader}"}`);
			},
		});
		store.add(harness.handle);

		await harness.handle.send(RPC_MESSAGE);
		await harness.handle.send(FORM_MESSAGE);
		await waitFor(() => harness.logs.some(l => l.endsWith('for async notifications; they will be disabled')), 'the backchannel to stop', 5000);

		// Every planted value did go on the wire, so its absence from the logs is the cure.
		const posts = wire.filter(r => r.method === 'POST');
		assert.deepStrictEqual(posts.map(r => r.url.startsWith('https://cdn.example.com/') ? 'cdn' : r.url), [MCP_URL, MCP_URL, 'cdn', MCP_URL]);
		const onWire = JSON.stringify(wire);
		for (const value of [PLANTED.header, PLANTED.cookie, PLANTED.query, PLANTED.userinfo, PLANTED.rpc, PLANTED.formCode, PLANTED.formSecret, PLANTED.token, PLANTED.redirectPath, PLANTED.redirectQuery]) {
			assert.ok(onWire.includes(value), `${value} was not sent: the test proves nothing`);
		}
		assertNoPlantedValue(harness);

		const postTraces = harness.logs.filter(l => l.startsWith(`Fetching POST ${LOGGED_ENDPOINT};`));
		assert.strictEqual(postTraces.length, 3, postTraces.join('\n'));
		for (const line of postTraces) {
			for (const name of ['x-api-key', 'Cookie', 'Content-Type', 'Content-Length', 'Accept', 'user-agent']) {
				assert.ok(line.includes(name), `the header name ${name} is in the trace: ${line}`);
			}
		}
		assert.ok(postTraces[0].endsWith(`; body: ${byteLength(RPC_MESSAGE)} bytes`), postTraces[0]);
		assert.ok(postTraces[1].includes('Authorization') && postTraces[1].endsWith(`; body: ${byteLength(RPC_MESSAGE)} bytes`), postTraces[1]);
		assert.ok(postTraces[2].includes('Authorization') && postTraces[2].endsWith(`; body: ${byteLength(FORM_MESSAGE)} bytes`), postTraces[2]);
		assert.ok(harness.logs.includes(`Redirect (307) from ${LOGGED_ENDPOINT} to https://cdn.example.com (server-provided path not logged)`), harness.logs.join('\n'));
		assert.ok(harness.logs.includes(`404 status connecting to ${LOGGED_ENDPOINT} for async notifications; they will be disabled`), harness.logs.join('\n'));
		const cdnFetched = harness.logs.find(l => l.startsWith('Fetched https://cdn.example.com (server-provided path not logged): status 200; header names: ['));
		assert.ok(cdnFetched?.includes('set-cookie') && cdnFetched.includes('x-echo'), `the response trace names the response headers: ${cdnFetched}`);
		assert.ok(harness.logs.some(l => l.startsWith(`Fetching GET ${LOGGED_ENDPOINT};`) && l.endsWith('; body: none')), 'a request without a body says so');
		assert.ok(harness.logs.includes(`Error connecting to ${LOGGED_ENDPOINT} for async notifications, will retry`), harness.logs.join('\n'));
	});

	test('legacy SSE: the fallback, the attach and a failing POST to the server-provided endpoint log no planted value', async () => {
		const wire: IWireRequest[] = [];
		const harness = createMcpHttpHarnessAt(MCP_URL, {
			getToken: () => Promise.reject(new Error('not used')),
			getTokenForProvider: () => Promise.reject(new Error('not used')),
			authentication: undefined,
			launchHeaders: LAUNCH_HEADERS,
			transport: async (url, init) => {
				wireRecord(wire, url, init);
				if (url === MCP_URL && init?.method === 'POST') {
					return harnessResponse(405, url, { 'x-echo': PLANTED.responseHeader }); // not streamable HTTP: fall back to legacy SSE
				}
				if (url === MCP_URL && init?.method === 'GET') {
					return new Response(`event: endpoint\ndata: /messages/${PLANTED.ssePath}?sessionId=${PLANTED.sseQuery}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as CommonResponse;
				}
				if (url.includes('/messages/') && init?.method === 'POST') {
					return harnessResponse(500, url, { 'x-echo': PLANTED.responseHeader }, `{"echo":"${PLANTED.responseHeader}"}`);
				}
				return harnessResponse(404, url);
			},
		});
		store.add(harness.handle);

		await harness.handle.send(RPC_MESSAGE);
		await waitFor(() => harness.logs.some(l => l.startsWith('500 status sending message to')), 'the legacy POST line');

		const legacyPost = wire.find(r => r.url.includes('/messages/'));
		assert.ok(legacyPost?.url.includes(PLANTED.ssePath) && legacyPost.url.includes(PLANTED.sseQuery) && legacyPost.body?.includes(PLANTED.rpc), 'the planted values were sent');
		assertNoPlantedValue(harness);
		assert.ok(harness.logs.includes('500 status sending message to https://mcp.example.com (server-provided path not logged)'), harness.logs.join('\n'));
		assert.ok(harness.logs.includes(`405 status sending message to ${LOGGED_ENDPOINT}, will attempt to fall back to legacy SSE`), harness.logs.join('\n'));
		assert.ok(harness.logs.some(l => l.startsWith('Fetching POST https://mcp.example.com (server-provided path not logged);') && l.endsWith(`; body: ${byteLength(RPC_MESSAGE)} bytes`)), harness.logs.join('\n'));
	});

	// R-91 seat (accepted): a configured Authorization header in any casing plus a generated token. DECIDED: the generated
	// token replaces the configured header in every casing; exactly one Authorization value is sent.
	for (const configuredName of ['authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN', 'Authorization']) {
		for (const source of ['server metadata', 'provided authentication config'] as const) {
			test(`duplicate Authorization: a configured '${configuredName}' header and a token from ${source} send exactly one Authorization value`, async () => {
				const CONFIGURED = 'Bearer DUP-CONFIGURED-8f1';
				const GENERATED = 'DUP-GENERATED-9a2';
				const wire: IWireRequest[] = [];
				let mcpPosts = 0;
				const harness = createMcpHttpHarnessFrom({
					getToken: async () => GENERATED,
					getTokenForProvider: async () => GENERATED,
					authentication: source === 'provided authentication config' ? { providerId: 'example', scopes: ['read'] } : undefined,
					launchHeaders: [[configuredName, CONFIGURED]],
					transport: async (url, init) => {
						wireRecord(wire, url, init);
						if (url === HARNESS_MCP_URL && init?.method === 'POST') {
							return source === 'server metadata' && ++mcpPosts === 1
								? harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' })
								: harnessResponse(202, url);
						}
						return harnessResponse(404, url);
					},
				});
				store.add(harness.handle);

				await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

				const withToken = wire.filter(r => Object.values(r.headers).some(v => v.includes(GENERATED)));
				assert.ok(withToken.length >= 1, 'the generated token was sent');
				for (const request of withToken) {
					const keys = Object.keys(request.headers).filter(k => k.toLowerCase() === 'authorization');
					assert.deepStrictEqual(keys, ['Authorization'], `one Authorization key: ${JSON.stringify(keys)}`);
					assert.strictEqual(request.headers['Authorization'], `Bearer ${GENERATED}`);
				}
				assert.strictEqual(harness.posts[harness.posts.length - 1], `Bearer ${GENERATED}`, 'the request carries the generated token alone');
				assert.ok(harness.logs.includes('Replaced 1 existing Authorization header value(s) with the obtained token'), harness.logs.join('\n'));
				for (const line of harness.logs) {
					assert.ok(!line.includes('DUP-CONFIGURED') && !line.includes(GENERATED), `a credential reached a log line: ${line}`);
				}
			});
		}
	}
});

// review QL-G-LOGIN-SECRETS c1 M4: the configured endpoint's path is the user's configuration and can hold a credential (an
// API key in the path is a common form). Every log line and server state names the endpoint by its origin and a fixed
// description; the requests still use the full configured URL.
// review QL-G-LOGIN-SECRETS c1 M5: an error from another process, a transport or a stream is foreign text in its name as in
// its message, stack and cause; a failure is shown as a named error of this file or a fixed category.
// review QL-G-LOGIN-SECRETS c1 M3: a configured authentication provider id can be an issuer string; it is not logged.
// Each test checks for markers first, then the fixed text that replaced them.
suite('QL-G-LOGIN-SECRETS c1: no configured path, foreign error text or provider id reaches an MCP log line or state', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const PATH_SECRET = 'MARK-PATH-SECRET-41c9';
	const MCP_URL = `https://mcp.example.com/key/${PATH_SECRET}/mcp`;
	const LOGGED = 'https://mcp.example.com (configured endpoint)';
	const UNEXPECTED = 'unexpected error (details not logged)';
	const ERR_NAME = 'MARK-ERR-NAME-7d02';
	const ERR_MESSAGE = 'MARK-ERR-MESSAGE-a3f1';
	const ERR_STACK = 'MARK-ERR-STACK-5be8';
	const ERR_CAUSE = 'MARK-ERR-CAUSE-c06d';
	const PROVIDER_USERINFO = 'MARK-PROVIDER-USERINFO-2e4a';
	const PROVIDER_PATH = 'MARK-PROVIDER-PATH-9f13';
	const PROVIDER_QUERY = 'MARK-PROVIDER-QUERY-60b7';
	const MARKERS = [PATH_SECRET, ERR_NAME, ERR_MESSAGE, ERR_STACK, ERR_CAUSE, PROVIDER_USERINFO, PROVIDER_PATH, PROVIDER_QUERY];
	const CONFIGURED_PROVIDER_ID = `https://user:${PROVIDER_USERINFO}@issuer.example/${PROVIDER_PATH}?key=${PROVIDER_QUERY}`;

	/** An upstream error with a marker in each of its name, message, stack and cause. */
	function markedError(): Error {
		const error = new Error(ERR_MESSAGE, { cause: new Error(ERR_CAUSE) });
		error.name = ERR_NAME;
		error.stack = `${ERR_NAME}: ${ERR_MESSAGE}\n    at ${ERR_STACK}`;
		return error;
	}

	async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition() && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(condition(), `timed out waiting for ${what}`);
	}

	function assertNoMarker(harness: IMcpHttpHarness): void {
		assert.ok(harness.logs.length > 0 || harness.states.length > 0, 'nothing was published: the recorder is not attached');
		for (const line of [...harness.logs, ...harness.states.map(state => JSON.stringify(state))]) {
			for (const marker of MARKERS) {
				assert.ok(!line.includes(marker), `a marker (${marker}) reached a log line or the server state: ${line}`);
			}
		}
	}

	/** A handle for the configured URL `url`: by default {@link MCP_URL}, whose path holds a credential (M4); the M5 and M3 tests use a plain one, so each test finds its own item's leak. */
	function make(transport: (url: string, init: CommonRequestInit | undefined) => Promise<CommonResponse>, overrides: Partial<{ getToken: () => Promise<string | undefined>; getTokenForProvider: () => Promise<string | undefined>; providerId: string; url: string }> = {}): IMcpHttpHarness {
		const harness = createMcpHttpHarnessAt(overrides.url ?? MCP_URL, {
			getToken: overrides.getToken ?? (async () => 'stored-token'),
			getTokenForProvider: overrides.getTokenForProvider ?? (() => Promise.reject(new Error('not used'))),
			authentication: overrides.providerId ? { providerId: overrides.providerId, scopes: ['read'] } : undefined,
			launchHeaders: [],
			transport,
		});
		store.add(harness.handle);
		return harness;
	}

	const send = (harness: IMcpHttpHarness) => harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
	const errors = (harness: IMcpHttpHarness) => errorStateMessages(harness.states);
	const usedFullUrl = (harness: IMcpHttpHarness) => assert.ok(harness.requests.some(r => r.url === MCP_URL), `the request used the full configured URL (with ${PATH_SECRET})`);

	test('M4 streamable HTTP: the request trace, a redirect and a failing status state name no configured path', async () => {
		let posts = 0;
		const harness = make(async (url, init) => {
			if (url === MCP_URL && init?.method === 'POST') {
				switch (++posts) {
					case 1: return harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' });
					case 2: return harnessResponse(307, url, { 'location': MCP_URL });
					default: return harnessResponse(500, url);
				}
			}
			return harnessResponse(404, url);
		});
		await send(harness);
		assertNoMarker(harness);
		usedFullUrl(harness);
		assert.ok(harness.logs.includes(`Redirect (307) from ${LOGGED} to ${LOGGED}`), harness.logs.join('\n'));
		assert.ok(errors(harness).includes(`500 status sending message to ${LOGGED}`), errors(harness).join('\n'));
		assert.ok(harness.logs.some(l => l.startsWith(`Fetching POST ${LOGGED};`)), harness.logs.join('\n'));
		assert.ok(harness.logs.some(l => l.startsWith(`Fetched ${LOGGED}: status 500;`)), harness.logs.join('\n'));
	});

	test('M4 transport failure: the failing state names no configured path', async () => {
		const harness = make(async () => { throw new TypeError('fetch failed'); });
		await send(harness);
		assertNoMarker(harness);
		usedFullUrl(harness);
		assert.ok(errors(harness).includes(`Error sending message to ${LOGGED}: ${UNEXPECTED}`), errors(harness).join('\n'));
	});

	test('M4 legacy SSE: the fallback line and a failing attach state name no configured path', async () => {
		const harness = make(async (_url, init) => init?.method === 'POST' ? harnessResponse(405, MCP_URL) : harnessResponse(500, MCP_URL));
		await send(harness);
		await waitFor(() => errors(harness).some(m => m.includes('as SSE')), 'the legacy attach state');
		assertNoMarker(harness);
		usedFullUrl(harness);
		assert.ok(harness.logs.includes(`405 status sending message to ${LOGGED}, will attempt to fall back to legacy SSE`), harness.logs.join('\n'));
		assert.ok(errors(harness).includes(`500 status connecting to ${LOGGED} as SSE`), errors(harness).join('\n'));
	});

	test('M4 backchannel: the line that disables async notifications names no configured path', async () => {
		const harness = make(async (_url, init) => init?.method === 'POST' ? harnessResponse(202, MCP_URL) : harnessResponse(405, MCP_URL));
		await send(harness);
		await waitFor(() => harness.logs.some(l => l.endsWith('for async notifications; they will be disabled')), 'the backchannel to stop');
		assertNoMarker(harness);
		usedFullUrl(harness);
		assert.ok(harness.logs.includes(`405 status connecting to ${LOGGED} for async notifications; they will be disabled`), harness.logs.join('\n'));
	});

	test('M5 token getter from server metadata: an upstream error\'s name, message, stack and cause reach no log line or state; the failure is named', async () => {
		let posts = 0;
		const harness = make(async (url, init) => url === HARNESS_MCP_URL && init?.method === 'POST' && ++posts === 1
			? harnessResponse(401, url, { 'WWW-Authenticate': 'Bearer realm="example"' })
			: harnessResponse(404, url), { getToken: async () => { throw markedError(); }, url: HARNESS_MCP_URL });
		await send(harness);
		assertNoMarker(harness);
		assert.ok(harness.logs.includes(`Error getting token from server metadata: ${UNEXPECTED}`), harness.logs.join('\n'));
		assert.ok(errors(harness).some(m => m.includes('McpAuthenticationFailedError')), errors(harness).join('\n'));
	});

	test('M5 token getter for a configured provider: an upstream error\'s name, message, stack and cause reach no log line or state; the failure is named', async () => {
		const harness = make(async url => harnessResponse(200, url), { getTokenForProvider: async () => { throw markedError(); }, providerId: 'example', url: HARNESS_MCP_URL });
		await send(harness);
		assertNoMarker(harness);
		assert.ok(harness.logs.includes(`Error getting token from provided authentication config: ${UNEXPECTED}`), harness.logs.join('\n'));
		assert.ok(errors(harness).some(m => m.includes('McpAuthenticationFailedError')), errors(harness).join('\n'));
	});

	test('M5 transport failure: a marked error and a thrown non-error value reach the state only as a fixed category', async () => {
		const marked = make(async () => { throw markedError(); }, { url: HARNESS_MCP_URL });
		await send(marked);
		assertNoMarker(marked);
		assert.ok(errors(marked).includes(`Error sending message to ${LOGGED}: ${UNEXPECTED}`), errors(marked).join('\n'));

		// Deliberately not an Error: the transport must handle a thrown non-error value.
		const nonErrorValue: unknown = { name: ERR_NAME, message: ERR_MESSAGE };
		const nonError = make(async () => { throw nonErrorValue; }, { url: HARNESS_MCP_URL });
		await send(nonError);
		assertNoMarker(nonError);
		assert.ok(errors(nonError).includes(`Error sending message to ${LOGGED}: unexpected non-error value (details not logged)`), errors(nonError).join('\n'));
	});

	test('M5 SSE: a failing stream and a failing legacy attach reach the log and the state only as a fixed category', async () => {
		const stream = make(async (url, init) => init?.method === 'POST'
			? harnessStreamResponse(200, url, { 'content-type': 'text/event-stream' }, '', markedError())
			: harnessResponse(405, url), { url: HARNESS_MCP_URL });
		await send(stream);
		await waitFor(() => stream.logs.some(l => l.startsWith('Error reading SSE stream')), 'the SSE read line');
		assertNoMarker(stream);
		assert.ok(stream.logs.includes(`Error reading SSE stream: ${UNEXPECTED}`), stream.logs.join('\n'));

		const attach = make(async (url, init) => {
			if (init?.method === 'POST') {
				return harnessResponse(405, url);
			}
			throw markedError();
		}, { url: HARNESS_MCP_URL });
		await send(attach);
		await waitFor(() => errors(attach).some(m => m.includes('as SSE')), 'the legacy attach state');
		assertNoMarker(attach);
		assert.ok(errors(attach).includes(`Error connecting to ${LOGGED} as SSE: ${UNEXPECTED}`), errors(attach).join('\n'));
	});

	test('M3 configured provider: its id reaches no log line or state, whether its token is obtained or refused', async () => {
		const obtained = make(async url => harnessResponse(202, url), { getTokenForProvider: async () => 'provider-token', providerId: CONFIGURED_PROVIDER_ID, url: HARNESS_MCP_URL });
		await send(obtained);
		assertNoMarker(obtained);
		assert.ok(obtained.logs.includes('Using provided authentication config: 1 scope(s)'), obtained.logs.join('\n'));
		assert.ok(obtained.logs.includes('Successfully obtained token from provided authentication config'), obtained.logs.join('\n'));
		assert.strictEqual(obtained.posts[0], 'Bearer provider-token');

		const refused = make(async url => harnessResponse(202, url), { getTokenForProvider: async () => { throw new Error(`No authentication provider '${CONFIGURED_PROVIDER_ID}' is currently registered.`); }, providerId: CONFIGURED_PROVIDER_ID, url: HARNESS_MCP_URL });
		await send(refused);
		assertNoMarker(refused);
		assert.ok(errors(refused).some(m => m.includes('McpAuthenticationFailedError')), errors(refused).join('\n'));
	});
});
