/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService, LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { McpConnectionState, McpServerTransportHTTP, McpServerTransportHTTPAuthentication, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IMcpAuthenticationDetails, IMcpAuthenticationOptions, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, McpHTTPHandle } from '../../common/extHostMcp.js';

export const HARNESS_MCP_URL = 'https://mcp.example.com/mcp';

export function harnessResponse(status: number, url: string, headers: Record<string, string> = {}, body = ''): CommonResponse {
	return {
		status,
		statusText: String(status),
		url,
		headers: new Headers(headers),
		body: null,
		json: async () => JSON.parse(body),
		text: async () => body,
	};
}

/**
 * A streamed response: `text` (if any), then an error (if given) or the end. With `headers`, for example an SSE content type.
 */
export function harnessStreamResponse(status: number, url: string, headers: Record<string, string>, text: string, error: Error | undefined): CommonResponse {
	// The text is read first; the error or the end comes on the next read (erroring at once would drop queued text).
	let sentText = !text;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sentText) {
				sentText = true;
				controller.enqueue(new TextEncoder().encode(text));
			} else if (error) {
				controller.error(error);
			} else {
				controller.close();
			}
		}
	});
	return {
		status,
		statusText: String(status),
		url,
		headers: new Headers(headers),
		body,
		json: async () => { throw new Error('not used'); },
		text: async () => { throw new Error('not used'); },
	};
}

/** Publishes trace lines too, so the request/response trace lines are covered. */
class TraceLogService extends NullLogService {
	override getLevel(): LogLevel { return LogLevel.Trace; }
}

class TestMcpHTTPHandle extends McpHTTPHandle {
	constructor(
		launch: McpServerTransportHTTP,
		proxy: MainThreadMcpShape,
		logService: ILogService,
		private readonly _respond: (url: string, init: CommonRequestInit | undefined) => Promise<CommonResponse>,
	) {
		super(1, launch, proxy, logService);
	}

	protected override _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
		return this._respond(url, init);
	}
}

export interface IMcpHttpHarness {
	readonly handle: McpHTTPHandle;
	/** The Authorization header (any casing) of each POST to the MCP endpoint, in order (undefined: sent without one). */
	readonly posts: (string | undefined)[];
	/** Every request the transport answered, in order. */
	readonly requests: { method: string | undefined; url: string; authorization: string | undefined }[];
	/** The options of each token request from server metadata, in order. */
	readonly tokenRequests: (IMcpAuthenticationOptions | undefined)[];
	readonly states: McpConnectionState[];
	/** Every log line the handle published. */
	readonly logs: string[];
}

export interface IMcpHttpHarnessSetup {
	/** Answers every request of the handle (the OAuth metadata lookups included). */
	readonly transport: (url: string, init: CommonRequestInit | undefined) => Promise<CommonResponse>;
	readonly getToken: (authDetails: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined) => Promise<string | undefined>;
	readonly getTokenForProvider: (providerId: string, scopes: string[]) => Promise<string | undefined>;
	readonly authentication: McpServerTransportHTTPAuthentication | undefined;
	/** The configured headers of the server (its launch headers), sent with every request. */
	readonly launchHeaders: [string, string][];
}

/**
 * The Authorization header a request carries, its name matched in any casing (HTTP header names are case-insensitive);
 * several keys are joined as one header would be. Undefined: sent without one. Independent of the handle's own lookup.
 */
export function requestAuthorization(headers: Record<string, string> | undefined): string | undefined {
	if (!headers) {
		return undefined; // a request without options carries no header
	}
	const values = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'authorization').map(([, value]) => value);
	return values.length ? values.join(', ') : undefined;
}

export function createMcpHttpHarnessFrom(setup: IMcpHttpHarnessSetup): IMcpHttpHarness {
	return createMcpHttpHarnessAt(HARNESS_MCP_URL, setup);
}

/**
 * As {@link createMcpHttpHarnessFrom}, with the server's configured URL given (for example one with user info or a query).
 * `posts` lists the POSTs to exactly that URL.
 */
export function createMcpHttpHarnessAt(mcpUrl: string, setup: IMcpHttpHarnessSetup): IMcpHttpHarness {
	const posts: (string | undefined)[] = [];
	const requests: { method: string | undefined; url: string; authorization: string | undefined }[] = [];
	const tokenRequests: (IMcpAuthenticationOptions | undefined)[] = [];
	const states: McpConnectionState[] = [];
	const logs: string[] = [];
	const proxy: Partial<MainThreadMcpShape> = {
		$onDidChangeState: (_id, state) => { states.push(state); },
		$onDidPublishLog: (_id, _level, log) => { logs.push(log); },
		$onDidReceiveMessage: () => { },
		$getTokenFromServerMetadata: (_id, authDetails, options) => {
			tokenRequests.push(options);
			return setup.getToken(authDetails, options);
		},
		$getTokenForProviderId: (_id, providerId, scopes) => setup.getTokenForProvider(providerId, scopes),
	};
	const launch: McpServerTransportHTTP = { type: McpServerTransportType.HTTP, uri: URI.parse(mcpUrl), headers: setup.launchHeaders, authentication: setup.authentication };
	const handle = new TestMcpHTTPHandle(launch, proxy as MainThreadMcpShape, new TraceLogService(), (url, init) => {
		requests.push({ method: init?.method, url, authorization: requestAuthorization(init?.headers) });
		if (url === mcpUrl && init?.method === 'POST') {
			posts.push(requestAuthorization(init.headers));
		}
		return setup.transport(url, init);
	});
	return { handle, posts, requests, tokenRequests, states, logs };
}

/**
 * An HTTP MCP handle whose transport answers each POST to the MCP endpoint with the next of `postStatuses` (a 401 carries a
 * Bearer challenge; a POST beyond the list gets the last status). Every other URL (the OAuth metadata lookups) answers 404,
 * so the default metadata is used.
 */
export function createMcpHttpHarness(postStatuses: number[], getToken: (authDetails: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined) => Promise<string | undefined>, postBody: string): IMcpHttpHarness {
	let postCount = 0;
	return createMcpHttpHarnessFrom({
		getToken,
		getTokenForProvider: () => Promise.reject(new Error('not used by this harness')),
		authentication: undefined,
		launchHeaders: [],
		transport: async (url, init) => {
			if (url !== HARNESS_MCP_URL || init?.method !== 'POST') {
				return harnessResponse(404, url);
			}
			postCount++;
			// A POST beyond the script is rejected like the last scripted one (the tests assert the exact list).
			const status = postCount <= postStatuses.length ? postStatuses[postCount - 1] : postStatuses[postStatuses.length - 1];
			return harnessResponse(status, url, status === 401 ? { 'WWW-Authenticate': 'Bearer realm="example"' } : {}, postBody);
		},
	});
}

export function errorStateMessages(states: McpConnectionState[]): string[] {
	return states.flatMap(s => s.state === McpConnectionState.Kind.Error ? [s.message] : []);
}
