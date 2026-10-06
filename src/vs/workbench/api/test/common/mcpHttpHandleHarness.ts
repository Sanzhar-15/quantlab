/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService, NullLogService } from '../../../../platform/log/common/log.js';
import { McpConnectionState, McpServerTransportHTTP, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
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
	/** The Authorization header of each POST to the MCP endpoint, in order (undefined: sent without one). */
	readonly posts: (string | undefined)[];
	/** The options of each token request, in order. */
	readonly tokenRequests: (IMcpAuthenticationOptions | undefined)[];
	readonly states: McpConnectionState[];
}

/**
 * An HTTP MCP handle whose transport answers each POST to the MCP endpoint with the next of `postStatuses` (a 401 carries a
 * Bearer challenge; a POST beyond the list gets the last status). Every other URL (the OAuth metadata lookups) answers 404,
 * so the default metadata is used.
 */
export function createMcpHttpHarness(postStatuses: number[], getToken: (authDetails: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined) => Promise<string | undefined>): IMcpHttpHarness {
	const posts: (string | undefined)[] = [];
	const tokenRequests: (IMcpAuthenticationOptions | undefined)[] = [];
	const states: McpConnectionState[] = [];
	const proxy: Partial<MainThreadMcpShape> = {
		$onDidChangeState: (_id, state) => { states.push(state); },
		$onDidPublishLog: () => { },
		$onDidReceiveMessage: () => { },
		$getTokenFromServerMetadata: (_id, authDetails, options) => {
			tokenRequests.push(options);
			return getToken(authDetails, options);
		},
		$getTokenForProviderId: () => Promise.reject(new Error('not used by this harness')),
	};
	const launch: McpServerTransportHTTP = { type: McpServerTransportType.HTTP, uri: URI.parse(HARNESS_MCP_URL), headers: [] };
	const handle = new TestMcpHTTPHandle(launch, proxy as MainThreadMcpShape, new NullLogService(), async (url, init) => {
		if (url !== HARNESS_MCP_URL || init?.method !== 'POST') {
			return harnessResponse(404, url);
		}
		posts.push(init.headers['Authorization']);
		// A POST beyond the script is recorded (the tests assert the exact list) and rejected like the last scripted one.
		const status = posts.length <= postStatuses.length ? postStatuses[posts.length - 1] : postStatuses[postStatuses.length - 1];
		return harnessResponse(status, url, status === 401 ? { 'WWW-Authenticate': 'Bearer realm="example"' } : {});
	});
	return { handle, posts, tokenRequests, states };
}

export function errorStateMessages(states: McpConnectionState[]): string[] {
	return states.flatMap(s => s.state === McpConnectionState.Kind.Error ? [s.message] : []);
}
