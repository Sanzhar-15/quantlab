/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../nls.js';
import type * as vscode from 'vscode';
import { URL } from 'url';
import { ExtHostAuthentication, DynamicAuthClientRejectedError, DynamicAuthProvider, DynamicAuthProviderTokensChange, IExtHostAuthentication, scopeCountText } from '../common/extHostAuthentication.js';
import { IExtHostRpcService } from '../common/extHostRpcService.js';
import { IExtHostInitDataService } from '../common/extHostInitDataService.js';
import { IExtHostWindow } from '../common/extHostWindow.js';
import { IExtHostUrlsService } from '../common/extHostUrls.js';
import { ILoggerService, ILogService } from '../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../common/extHost.protocol.js';
import { IAuthorizationServerMetadata, IAuthorizationProtectedResourceMetadata, IAuthorizationTokenResponse, isAuthorizationDeviceResponse, AuthorizationErrorType, AuthorizationDeviceCodeErrorType, createOAuthHttpError, createOAuthInvalidResponseError, createOAuthTransportError, describeOAuthFailure, formatOAuthHttpFailure, getSafeOAuthErrorCode, isValidAuthorizationTokenResponse, OAuthSafeError, readOAuthJsonResponse } from '../../../base/common/oauth.js';
import { Emitter } from '../../../base/common/event.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { IExtHostProgress } from '../common/extHostProgress.js';
import { IProgressStep } from '../../../platform/progress/common/progress.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { LoopbackAuthServer } from './loopbackServer.js';

export class NodeDynamicAuthProvider extends DynamicAuthProvider {

	constructor(
		extHostWindow: IExtHostWindow,
		extHostUrls: IExtHostUrlsService,
		initData: IExtHostInitDataService,
		extHostProgress: IExtHostProgress,
		loggerService: ILoggerService,
		proxy: MainThreadAuthenticationShape,
		authorizationServer: URI,
		serverMetadata: IAuthorizationServerMetadata,
		resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		clientId: string,
		clientSecret: string | undefined,
		onDidDynamicAuthProviderTokensChange: Emitter<DynamicAuthProviderTokensChange>,
		initialTokens: any[]
	) {
		super(
			extHostWindow,
			extHostUrls,
			initData,
			extHostProgress,
			loggerService,
			proxy,
			authorizationServer,
			serverMetadata,
			resourceMetadata,
			clientId,
			clientSecret,
			onDidDynamicAuthProviderTokensChange,
			initialTokens
		);

		// Prepend Node-specific flows to the existing flows
		if (!initData.remote.isRemote && serverMetadata.authorization_endpoint) {
			// If we are not in a remote environment, we can use the loopback server for authentication
			this._createFlows.unshift({
				label: nls.localize('loopback', "Loopback Server"),
				handler: (scopes, progress, token) => this._createWithLoopbackServer(scopes, progress, token)
			});
		}

		// Add device code flow to the end since it's not as streamlined
		if (serverMetadata.device_authorization_endpoint) {
			this._createFlows.push({
				label: nls.localize('device code', "Device Code"),
				handler: (scopes, progress, token) => this._createWithDeviceCode(scopes, progress, token)
			});
		}
	}

	private async _createWithLoopbackServer(scopes: string[], progress: vscode.Progress<IProgressStep>, token: vscode.CancellationToken): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.authorization_endpoint) {
			throw new Error('Authorization Endpoint required');
		}
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		// Generate PKCE code verifier (random string) and code challenge (SHA-256 hash of verifier)
		const codeVerifier = this.generateRandomString(64);
		const codeChallenge = await this.generateCodeChallenge(codeVerifier);

		// Generate a random state value to prevent CSRF
		const nonce = this.generateRandomString(32);
		const callbackUri = URI.parse(`${this._initData.environment.appUriScheme}://dynamicauthprovider/${this.authorizationServer.authority}/redirect?nonce=${nonce}`);
		let appUri: URI;
		try {
			appUri = await this._extHostUrls.createAppUri(callbackUri);
		} catch {
			// The error comes from another process: report a new error without its text
			throw new OAuthSafeError('Failed to create external URI');
		}

		// Prepare the authorization request URL
		const authorizationUrl = new URL(this._serverMetadata.authorization_endpoint);
		authorizationUrl.searchParams.append('client_id', this._clientId);
		authorizationUrl.searchParams.append('response_type', 'code');
		authorizationUrl.searchParams.append('code_challenge', codeChallenge);
		authorizationUrl.searchParams.append('code_challenge_method', 'S256');
		const scopeString = scopes.join(' ');
		if (scopeString) {
			authorizationUrl.searchParams.append('scope', scopeString);
		}
		if (this._resourceMetadata?.resource) {
			// If a resource is specified, include it in the request
			authorizationUrl.searchParams.append('resource', this._resourceMetadata.resource);
		}

		// Create and start the loopback server
		const server = new LoopbackAuthServer(
			this._logger,
			appUri,
			this._initData.environment.appName
		);
		try {
			await server.start();
		} catch {
			// The listen error is not part of the credential boundary but is not trusted either: report a new error
			throw new OAuthSafeError('Failed to start loopback server');
		}

		// Update the authorization URL with the actual redirect URI
		authorizationUrl.searchParams.set('redirect_uri', server.redirectUri);
		authorizationUrl.searchParams.set('state', server.state);

		const promise = server.waitForOAuthResponse();
		// Set up a Uri Handler but it's just to redirect not to handle the code
		// The promise is observed as soon as it exists. The loopback server, not this call, supplies the code, so the flow does
		// not need the result: a rejection is logged with fixed text and is neither rethrown nor left unhandled (its text and
		// causes come from another process and are not trusted).
		void this._proxy.$waitForUriHandler(appUri).then(undefined, (uriHandlerError: unknown) => {
			if (isCancellationError(uriHandlerError)) {
				this._logger.trace('The URI handler wait was cancelled.');
			} else {
				this._logger.warn('The URI handler wait failed; the loopback redirect is not affected.');
			}
		});

		try {
			// Open the browser for user authorization
			this._logger.info(`Opening authorization URL for ${scopeCountText(scopes)}`);
			let opened: boolean;
			try {
				opened = await this._extHostWindow.openUri(authorizationUrl.toString(), {});
			} catch (openError) {
				if (isCancellationError(openError)) {
					// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
					throw new CancellationError();
				}
				// The error comes from another process and can quote the authorization URL: report a new error without its text
				throw new OAuthSafeError('Failed to open the authorization URL');
			}
			if (!opened) {
				throw new CancellationError();
			}
			progress.report({
				message: nls.localize('completeAuth', "Complete the authentication in the browser window that has opened."),
			});

			// Wait for the authorization code via the loopback server
			let code: string | undefined;
			try {
				const response = await raceCancellationError(promise, token);
				code = response.code;
			} catch (err) {
				if (isCancellationError(err)) {
					this._logger.info('Authorization code request was cancelled by the user.');
					throw err;
				}
				const detail = describeOAuthFailure(err, 'the redirect failed unexpectedly');
				this._logger.error(`Failed to receive authorization code: ${detail}`);
				throw new OAuthSafeError(`Failed to receive authorization code: ${detail}`);
			}
			this._logger.info(`Authorization code received for ${scopeCountText(scopes)}`);

			// Exchange the authorization code for tokens
			const tokenResponse = await this.exchangeCodeForToken(code, codeVerifier, server.redirectUri);
			return tokenResponse;
		} finally {
			// Clean up the server
			setTimeout(() => {
				void server.stop();
			}, 5000);
		}
	}

	private async _createWithDeviceCode(scopes: string[], progress: vscode.Progress<IProgressStep>, token: vscode.CancellationToken): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}
		if (!this._serverMetadata.device_authorization_endpoint) {
			throw new Error('Device authorization endpoint not available in server metadata');
		}

		const deviceAuthUrl = this._serverMetadata.device_authorization_endpoint;
		const scopeString = scopes.join(' ');
		this._logger.info(`Starting device code flow for ${scopeCountText(scopes)}`);

		// Step 1: Request device and user codes
		const deviceCodeRequest = new URLSearchParams();
		deviceCodeRequest.append('client_id', this._clientId);
		if (scopeString) {
			deviceCodeRequest.append('scope', scopeString);
		}
		if (this._resourceMetadata?.resource) {
			// If a resource is specified, include it in the request
			deviceCodeRequest.append('resource', this._resourceMetadata.resource);
		}

		let deviceCodeResponse: Response;
		try {
			deviceCodeResponse = await fetch(deviceAuthUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json'
				},
				body: deviceCodeRequest.toString()
			});
		} catch {
			// The transport error quotes the endpoint URL, which can hold credentials: report a new error without it
			const error = createOAuthTransportError('Device code request');
			this._logger.error(describeOAuthFailure(error, 'the request failed unexpectedly'));
			throw error;
		}

		if (!deviceCodeResponse.ok && await this._isInvalidClientResponse(deviceCodeResponse)) {
			this._logger.warn(`Client ID (${this._clientId}) was rejected as invalid; the stored client registration is kept.`);
			throw new DynamicAuthClientRejectedError(this._errorLabel);
		}
		if (!deviceCodeResponse.ok) {
			// Status and a vetted OAuth error code only: the body can hold the device code
			throw await createOAuthHttpError('Device code request', deviceCodeResponse);
		}

		const deviceCodeResult = await readOAuthJsonResponse(deviceCodeResponse, 'Device code request');
		if (!isAuthorizationDeviceResponse(deviceCodeResult)) {
			const error = createOAuthInvalidResponseError('device code', deviceCodeResponse, deviceCodeResult);
			this._logger.error(describeOAuthFailure(error, 'the request failed unexpectedly'));
			throw error;
		}
		const deviceCodeData = deviceCodeResult;
		// The user code is shown to the user in the modal below, not logged: it is a live authentication code
		this._logger.info('Device code received.');

		// Step 2: Show the device code modal
		let userConfirmed: boolean;
		try {
			userConfirmed = await this._proxy.$showDeviceCodeModal(
				deviceCodeData.user_code,
				deviceCodeData.verification_uri
			);
		} catch (modalError) {
			if (isCancellationError(modalError)) {
				// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
				throw new CancellationError();
			}
			// The error comes from another process and can quote the device code: report a new error without its text
			throw new OAuthSafeError('Failed to show the device code');
		}

		if (!userConfirmed) {
			throw new CancellationError();
		}

		// Step 3: Poll for token
		progress.report({
			message: nls.localize('waitingForAuth', "Open [{0}]({0}) in a new tab and paste your one-time code: {1}", deviceCodeData.verification_uri, deviceCodeData.user_code)
		});

		const pollInterval = (deviceCodeData.interval || 5) * 1000; // Convert to milliseconds
		const expiresAt = Date.now() + (deviceCodeData.expires_in * 1000);

		while (Date.now() < expiresAt) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			// Wait for the specified interval
			await new Promise(resolve => setTimeout(resolve, pollInterval));

			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			// Poll the token endpoint
			const tokenRequest = new URLSearchParams();
			tokenRequest.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
			tokenRequest.append('device_code', deviceCodeData.device_code);
			tokenRequest.append('client_id', this._clientId);

			// Add resource indicator if available (RFC 8707)
			if (this._resourceMetadata?.resource) {
				tokenRequest.append('resource', this._resourceMetadata.resource);
			}

			try {
				let tokenResponse: Response;
				try {
					tokenResponse = await fetch(this._serverMetadata.token_endpoint, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							'Accept': 'application/json'
						},
						body: tokenRequest.toString()
					});
				} catch {
					// The transport error quotes the endpoint URL, which can hold credentials: report a new error without it
					throw createOAuthTransportError('Device code token request');
				}

				if (tokenResponse.ok) {
					const tokenData = await readOAuthJsonResponse(tokenResponse, 'Device code token request');
					if (!isValidAuthorizationTokenResponse(tokenData)) {
						const error = createOAuthInvalidResponseError('device code token', tokenResponse, tokenData);
						this._logger.error(describeOAuthFailure(error, 'the request failed unexpectedly'));
						throw error;
					}
					this._logger.info(`Device code flow completed successfully for ${scopeCountText(scopes)}`);
					return tokenData;
				} else {
					// A failure body is read as text and parsed without keeping any parser message; a malformed one
					// throws a new error naming the HTTP status only
					const errorBody = await readOAuthJsonResponse(tokenResponse, 'Device code token request');
					const errorCode = getSafeOAuthErrorCode(errorBody);

					// Handle known error cases
					if (errorCode === AuthorizationDeviceCodeErrorType.AuthorizationPending) {
						// User hasn't completed authorization yet, continue polling
						continue;
					} else if (errorCode === AuthorizationDeviceCodeErrorType.SlowDown) {
						// Server is asking us to slow down
						await new Promise(resolve => setTimeout(resolve, pollInterval));
						continue;
					} else if (errorCode === AuthorizationDeviceCodeErrorType.ExpiredToken) {
						throw new OAuthSafeError('Device code expired. Please try again.');
					} else if (errorCode === AuthorizationDeviceCodeErrorType.AccessDenied) {
						throw new CancellationError();
					} else if (errorCode === AuthorizationErrorType.InvalidClient) {
						this._logger.warn(`Client ID (${this._clientId}) was rejected as invalid; the stored client registration is kept.`);
						throw new DynamicAuthClientRejectedError(this._errorLabel);
					} else {
						throw new OAuthSafeError(formatOAuthHttpFailure('Token request', tokenResponse, { kind: 'json', body: errorBody }));
					}
				}
			} catch (error) {
				if (isCancellationError(error) || error instanceof DynamicAuthClientRejectedError) {
					throw error;
				}
				throw new OAuthSafeError(`Error polling for token: ${describeOAuthFailure(error, 'the polling failed unexpectedly')}`);
			}
		}

		throw new OAuthSafeError('Device code flow timed out. Please try again.');
	}
}

export class NodeExtHostAuthentication extends ExtHostAuthentication implements IExtHostAuthentication {

	protected override readonly _dynamicAuthProviderCtor = NodeDynamicAuthProvider;

	constructor(
		extHostRpc: IExtHostRpcService,
		initData: IExtHostInitDataService,
		extHostWindow: IExtHostWindow,
		extHostUrls: IExtHostUrlsService,
		extHostProgress: IExtHostProgress,
		extHostLoggerService: ILoggerService,
		extHostLogService: ILogService
	) {
		super(extHostRpc, initData, extHostWindow, extHostUrls, extHostProgress, extHostLoggerService, extHostLogService);
	}
}
