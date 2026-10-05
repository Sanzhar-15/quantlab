/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * QL-DATA: the extension's ONE door to market data. It wraps `vscode.quantlabHost` (present only in the
 * built-in quantlab extension's API instance; typed by ./quantlabHost.d.ts) and is the only place in the
 * extension that names it for data. No backend origin, http(s)/WebSocket client or token lives in the
 * extension: the host owns the connection, the identity and the route for every op.
 *
 * Errors: a host rejection (it carries its code: 'identity-changed' | 'no-route' | 'not-signed-in' |
 * 'not-available', or a server error) is passed on unchanged -- never caught, retried or turned into an
 * empty value. When the host API is absent (a build without the carrier), every call fails with
 * HOST_DATA_UNAVAILABLE.
 */

export const HOST_DATA_UNAVAILABLE = 'Host data API is not available in this build';

export type HostDataStreamState = vscode.QuantlabHostStreamState;
export type HostDataStream = vscode.QuantlabHostStream;
export type HostDataErrorCode = vscode.QuantlabHostErrorCode;

/**
 * True when `error` is a host rejection carrying `code`. Classify by the host's code, never by the
 * message text (a server message may say anything).
 */
export function isHostDataError(error: unknown, code: HostDataErrorCode): error is { readonly code: HostDataErrorCode } {
	return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

export interface HostDataTransport {
	/** False when `vscode.quantlabHost` is absent: then request() rejects and subscribe() throws HOST_DATA_UNAVAILABLE. */
	readonly available: boolean;
	request(op: string, input: unknown, token?: vscode.CancellationToken): Promise<unknown>;
	subscribe(topic: string, params: unknown): HostDataStream;
}

/** Resolves the host API once; call it once per client (ServerApiClient's constructor). */
export function createHostDataTransport(): HostDataTransport {
	const host = vscode.quantlabHost;
	if (host === undefined) {
		return {
			available: false,
			request: (): Promise<unknown> => Promise.reject(new Error(HOST_DATA_UNAVAILABLE)),
			subscribe: (): HostDataStream => { throw new Error(HOST_DATA_UNAVAILABLE); },
		};
	}
	return {
		available: true,
		request: (op, input, token) => host.request(op, input, token),
		subscribe: (topic, params) => host.subscribe(topic, params),
	};
}
