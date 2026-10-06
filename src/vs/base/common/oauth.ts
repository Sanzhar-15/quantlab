/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from './buffer.js';

const WELL_KNOWN_ROUTE = '/.well-known';
export const AUTH_PROTECTED_RESOURCE_METADATA_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/oauth-protected-resource`;
export const AUTH_SERVER_METADATA_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/oauth-authorization-server`;
export const OPENID_CONNECT_DISCOVERY_PATH = `${WELL_KNOWN_ROUTE}/openid-configuration`;
export const AUTH_SCOPE_SEPARATOR = ' ';

//#region types

/**
 * Base OAuth 2.0 error codes as specified in RFC 6749.
 */
export const enum AuthorizationErrorType {
	InvalidRequest = 'invalid_request',
	InvalidClient = 'invalid_client',
	InvalidGrant = 'invalid_grant',
	UnauthorizedClient = 'unauthorized_client',
	UnsupportedGrantType = 'unsupported_grant_type',
	InvalidScope = 'invalid_scope'
}

/**
 * Device authorization grant specific error codes as specified in RFC 8628 section 3.5.
 */
export const enum AuthorizationDeviceCodeErrorType {
	/**
	 * The authorization request is still pending as the end user hasn't completed the user interaction steps.
	 */
	AuthorizationPending = 'authorization_pending',
	/**
	 * A variant of "authorization_pending", polling should continue but interval must be increased by 5 seconds.
	 */
	SlowDown = 'slow_down',
	/**
	 * The authorization request was denied.
	 */
	AccessDenied = 'access_denied',
	/**
	 * The "device_code" has expired and the device authorization session has concluded.
	 */
	ExpiredToken = 'expired_token'
}

/**
 * Dynamic client registration specific error codes as specified in RFC 7591.
 */
export const enum AuthorizationRegistrationErrorType {
	/**
	 * The value of one or more redirection URIs is invalid.
	 */
	InvalidRedirectUri = 'invalid_redirect_uri',
	/**
	 * The value of one of the client metadata fields is invalid and the server has rejected this request.
	 */
	InvalidClientMetadata = 'invalid_client_metadata',
	/**
	 * The software statement presented is invalid.
	 */
	InvalidSoftwareStatement = 'invalid_software_statement',
	/**
	 * The software statement presented is not approved for use by this authorization server.
	 */
	UnapprovedSoftwareStatement = 'unapproved_software_statement'
}

/**
 * Metadata about a protected resource.
 */
export interface IAuthorizationProtectedResourceMetadata {
	/**
	 * REQUIRED. The protected resource's resource identifier URL that uses https scheme and has no fragment components.
	 */
	resource: string;

	/**
	 * OPTIONAL. Human-readable name of the protected resource intended for display to the end user.
	 */
	resource_name?: string;

	/**
	 * OPTIONAL. JSON array containing a list of OAuth authorization server identifiers.
	 */
	authorization_servers?: string[];

	/**
	 * OPTIONAL. URL of the protected resource's JWK Set document.
	 */
	jwks_uri?: string;

	/**
	 * RECOMMENDED. JSON array containing a list of the OAuth 2.0 scope values used in authorization requests.
	 */
	scopes_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of the OAuth 2.0 Bearer Token presentation methods supported.
	 */
	bearer_methods_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of the JWS signing algorithms supported.
	 */
	resource_signing_alg_values_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of the JWE encryption algorithms supported.
	 */
	resource_encryption_alg_values_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of the JWE encryption algorithms supported.
	 */
	resource_encryption_enc_values_supported?: string[];

	/**
	 * OPTIONAL. URL of a page containing human-readable documentation.
	 */
	resource_documentation?: string;

	/**
	 * OPTIONAL. URL that provides the resource's requirements on how clients can use the data.
	 */
	resource_policy_uri?: string;

	/**
	 * OPTIONAL. URL that provides the resource's terms of service.
	 */
	resource_tos_uri?: string;
}

/**
 * Metadata about an OAuth 2.0 Authorization Server.
 */
export interface IAuthorizationServerMetadata {
	/**
	 * REQUIRED. The authorization server's issuer identifier URL that uses https scheme and has no query or fragment components.
	 */
	issuer: string;

	/**
	 * URL of the authorization server's authorization endpoint.
	 * This is REQUIRED unless no grant types are supported that use the authorization endpoint.
	 */
	authorization_endpoint?: string;

	/**
	 * URL of the authorization server's token endpoint.
	 * This is REQUIRED unless only the implicit grant type is supported.
	 */
	token_endpoint?: string;

	/**
	 * OPTIONAL. URL of the authorization server's device code endpoint.
	 */
	device_authorization_endpoint?: string;

	/**
	 * OPTIONAL. URL of the authorization server's JWK Set document containing signing keys.
	 */
	jwks_uri?: string;

	/**
	 * OPTIONAL. URL of the authorization server's OAuth 2.0 Dynamic Client Registration endpoint.
	 */
	registration_endpoint?: string;

	/**
	 * RECOMMENDED. JSON array containing a list of the OAuth 2.0 scope values supported.
	 */
	scopes_supported?: string[];

	/**
	 * REQUIRED. JSON array containing a list of the OAuth 2.0 response_type values supported.
	 */
	response_types_supported: string[];

	/**
	 * OPTIONAL. JSON array containing a list of the OAuth 2.0 response_mode values supported.
	 * Default is ["query", "fragment"].
	 */
	response_modes_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of OAuth 2.0 grant type values supported.
	 * Default is ["authorization_code", "implicit"].
	 */
	grant_types_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of client authentication methods supported by the token endpoint.
	 * Default is "client_secret_basic".
	 */
	token_endpoint_auth_methods_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of JWS signing algorithms supported by the token endpoint.
	 */
	token_endpoint_auth_signing_alg_values_supported?: string[];

	/**
	 * OPTIONAL. URL of a page containing human-readable documentation for developers.
	 */
	service_documentation?: string;

	/**
	 * OPTIONAL. Languages and scripts supported for the user interface, as a JSON array of BCP 47 language tags.
	 */
	ui_locales_supported?: string[];

	/**
	 * OPTIONAL. URL that the authorization server provides to read about the authorization server's requirements.
	 */
	op_policy_uri?: string;

	/**
	 * OPTIONAL. URL that the authorization server provides to read about the authorization server's terms of service.
	 */
	op_tos_uri?: string;

	/**
	 * OPTIONAL. URL of the authorization server's OAuth 2.0 revocation endpoint.
	 */
	revocation_endpoint?: string;

	/**
	 * OPTIONAL. JSON array containing a list of client authentication methods supported by the revocation endpoint.
	 */
	revocation_endpoint_auth_methods_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of JWS signing algorithms supported by the revocation endpoint.
	 */
	revocation_endpoint_auth_signing_alg_values_supported?: string[];

	/**
	 * OPTIONAL. URL of the authorization server's OAuth 2.0 introspection endpoint.
	 */
	introspection_endpoint?: string;

	/**
	 * OPTIONAL. JSON array containing a list of client authentication methods supported by the introspection endpoint.
	 */
	introspection_endpoint_auth_methods_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of JWS signing algorithms supported by the introspection endpoint.
	 */
	introspection_endpoint_auth_signing_alg_values_supported?: string[];

	/**
	 * OPTIONAL. JSON array containing a list of PKCE code challenge methods supported.
	 */
	code_challenge_methods_supported?: string[];

	/**
	 * OPTIONAL. Boolean flag indicating whether the authorization server supports the
	 * client_id_metadata document.
	 * ref https://datatracker.ietf.org/doc/html/draft-parecki-oauth-client-id-metadata-document-03
	 */
	client_id_metadata_document_supported?: boolean;
}

/**
 * Request for the dynamic client registration endpoint.
 * @see https://datatracker.ietf.org/doc/html/rfc7591#section-2
 */
export interface IAuthorizationDynamicClientRegistrationRequest {
	/**
	 * OPTIONAL. Array of redirection URI strings for use in redirect-based flows
	 * such as the authorization code and implicit flows.
	 */
	redirect_uris?: string[];

	/**
	 * OPTIONAL. String indicator of the requested authentication method for the token endpoint.
	 * Values: "none", "client_secret_post", "client_secret_basic".
	 * Default is "client_secret_basic".
	 */
	token_endpoint_auth_method?: string;

	/**
	 * OPTIONAL. Array of OAuth 2.0 grant type strings that the client can use at the token endpoint.
	 * Default is ["authorization_code"].
	 */
	grant_types?: string[];

	/**
	 * OPTIONAL. Array of the OAuth 2.0 response type strings that the client can use at the authorization endpoint.
	 * Default is ["code"].
	 */
	response_types?: string[];

	/**
	 * OPTIONAL. Human-readable string name of the client to be presented to the end-user during authorization.
	 */
	client_name?: string;

	/**
	 * OPTIONAL. URL string of a web page providing information about the client.
	 */
	client_uri?: string;

	/**
	 * OPTIONAL. URL string that references a logo for the client.
	 */
	logo_uri?: string;

	/**
	 * OPTIONAL. String containing a space-separated list of scope values that the client can use when requesting access tokens.
	 */
	scope?: string;

	/**
	 * OPTIONAL. Array of strings representing ways to contact people responsible for this client, typically email addresses.
	 */
	contacts?: string[];

	/**
	 * OPTIONAL. URL string that points to a human-readable terms of service document for the client.
	 */
	tos_uri?: string;

	/**
	 * OPTIONAL. URL string that points to a human-readable privacy policy document.
	 */
	policy_uri?: string;

	/**
	 * OPTIONAL. URL string referencing the client's JSON Web Key (JWK) Set document.
	 */
	jwks_uri?: string;

	/**
	 * OPTIONAL. Client's JSON Web Key Set document value.
	 */
	jwks?: object;

	/**
	 * OPTIONAL. A unique identifier string assigned by the client developer or software publisher.
	 */
	software_id?: string;

	/**
	 * OPTIONAL. A version identifier string for the client software.
	 */
	software_version?: string;

	/**
	 * OPTIONAL. A software statement containing client metadata values about the client software as claims.
	 */
	software_statement?: string;

	/**
	 * OPTIONAL. Application type. Usually "native" for OAuth clients.
	 * https://openid.net/specs/openid-connect-registration-1_0.html
	 */
	application_type?: 'native' | 'web' | string;

	/**
	 * OPTIONAL. Additional metadata fields as defined by extensions.
	 */
	[key: string]: unknown;
}

/**
 * Response from the dynamic client registration endpoint.
 */
export interface IAuthorizationDynamicClientRegistrationResponse {
	/**
	 * REQUIRED. The client identifier issued by the authorization server.
	 */
	client_id: string;

	/**
	 * OPTIONAL. The client secret issued by the authorization server.
	 * Not returned for public clients.
	 */
	client_secret?: string;

	/**
	 * OPTIONAL. Time at which the client secret will expire in seconds since the Unix Epoch.
	 */
	client_secret_expires_at?: number;

	/**
	 * OPTIONAL. Client name as provided during registration.
	 */
	client_name?: string;

	/**
	 * OPTIONAL. Client URI as provided during registration.
	 */
	client_uri?: string;

	/**
	 * OPTIONAL. Array of redirection URIs as provided during registration.
	 */
	redirect_uris?: string[];

	/**
	 * OPTIONAL. Array of grant types allowed for the client.
	 */
	grant_types?: string[];

	/**
	 * OPTIONAL. Array of response types allowed for the client.
	 */
	response_types?: string[];

	/**
	 * OPTIONAL. Type of authentication method used by the client.
	 */
	token_endpoint_auth_method?: string;
}

/**
 * Response from the authorization endpoint.
 * Typically returned as query parameters in a redirect.
 */
export interface IAuthorizationAuthorizeResponse {
	/**
	 * REQUIRED. The authorization code generated by the authorization server.
	 */
	code: string;

	/**
	 * REQUIRED. The state value that was sent in the authorization request.
	 * Used to prevent CSRF attacks.
	 */
	state: string;
}

/**
 * Error response from the authorization endpoint.
 */
export interface IAuthorizationAuthorizeErrorResponse {
	/**
	 * REQUIRED. Error code as specified in OAuth 2.0.
	 */
	error: string;

	/**
	 * OPTIONAL. Human-readable description of the error.
	 */
	error_description?: string;

	/**
	 * OPTIONAL. URI to a human-readable web page with more information about the error.
	 */
	error_uri?: string;

	/**
	 * REQUIRED. The state value that was sent in the authorization request.
	 */
	state: string;
}

/**
 * Response from the token endpoint.
 */
export interface IAuthorizationTokenResponse {
	/**
	 * REQUIRED. The access token issued by the authorization server.
	 */
	access_token: string;

	/**
	 * REQUIRED. The type of the token issued. Usually "Bearer".
	 */
	token_type: string;

	/**
	 * RECOMMENDED. The lifetime in seconds of the access token.
	 */
	expires_in?: number;

	/**
	 * OPTIONAL. The refresh token, which can be used to obtain new access tokens.
	 */
	refresh_token?: string;

	/**
	 * OPTIONAL. The scope of the access token as a space-delimited list of strings.
	 */
	scope?: string;

	/**
	 * OPTIONAL. ID Token value associated with the authenticated session for OpenID Connect flows.
	 */
	id_token?: string;
}

/**
 * Error response from the token endpoint.
 */
export interface IAuthorizationTokenErrorResponse {
	/**
	 * REQUIRED. Error code as specified in OAuth 2.0.
	 */
	error: string;

	/**
	 * OPTIONAL. Human-readable description of the error.
	 */
	error_description?: string;

	/**
	 * OPTIONAL. URI to a human-readable web page with more information about the error.
	 */
	error_uri?: string;
}

/**
 * Response from the device authorization endpoint as per RFC 8628 section 3.2.
 */
export interface IAuthorizationDeviceResponse {
	/**
	 * REQUIRED. The device verification code.
	 */
	device_code: string;

	/**
	 * REQUIRED. The end-user verification code.
	 */
	user_code: string;

	/**
	 * REQUIRED. The end-user verification URI on the authorization server.
	 */
	verification_uri: string;

	/**
	 * OPTIONAL. A verification URI that includes the user_code, designed for non-textual transmission.
	 */
	verification_uri_complete?: string;

	/**
	 * REQUIRED. The lifetime in seconds of the device_code and user_code.
	 */
	expires_in: number;

	/**
	 * OPTIONAL. The minimum amount of time in seconds that the client should wait between polling requests.
	 * If no value is provided, clients must use 5 as the default.
	 */
	interval?: number;
}

/**
 * Error response from the token endpoint when using device authorization grant.
 * As defined in RFC 8628 section 3.5.
 */
export interface IAuthorizationErrorResponse {
	/**
	 * REQUIRED. Error code as specified in OAuth 2.0 or in RFC 8628 section 3.5.
	 */
	error: AuthorizationErrorType | string;

	/**
	 * OPTIONAL. Human-readable description of the error.
	 */
	error_description?: string;

	/**
	 * OPTIONAL. URI to a human-readable web page with more information about the error.
	 */
	error_uri?: string;
}

/**
 * Error response from the token endpoint when using device authorization grant.
 * As defined in RFC 8628 section 3.5.
 */
export interface IAuthorizationDeviceTokenErrorResponse extends IAuthorizationErrorResponse {
	/**
	 * REQUIRED. Error code as specified in OAuth 2.0 or in RFC 8628 section 3.5.
	 */
	error: AuthorizationErrorType | AuthorizationDeviceCodeErrorType | string;
}

export interface IAuthorizationRegistrationErrorResponse {
	/**
	 * REQUIRED. Error code as specified in OAuth 2.0 or Dynamic Client Registration.
	 */
	error: AuthorizationRegistrationErrorType | string;

	/**
	 * OPTIONAL. Human-readable description of the error.
	 */
	error_description?: string;
}

export interface IAuthorizationJWTClaims {
	/**
	 * REQUIRED. JWT ID. Unique identifier for the token.
	 */
	jti: string;

	/**
	 * REQUIRED. Subject. Principal about which the token asserts information.
	 */
	sub: string;

	/**
	 * REQUIRED. Issuer. Entity that issued the token.
	 */
	iss: string;

	/**
	 * OPTIONAL. Audience. Recipients that the token is intended for.
	 */
	aud?: string | string[];

	/**
	 * OPTIONAL. Expiration time. Time after which the token is invalid (seconds since Unix epoch).
	 */
	exp?: number;

	/**
	 * OPTIONAL. Not before time. Time before which the token is not valid (seconds since Unix epoch).
	 */
	nbf?: number;

	/**
	 * OPTIONAL. Issued at time when the token was issued (seconds since Unix epoch).
	 */
	iat?: number;

	/**
	 * OPTIONAL. Authorized party. The party to which the token was issued.
	 */
	azp?: string;

	/**
	 * OPTIONAL. Scope values for which the token is valid.
	 */
	scope?: string;

	/**
	 * OPTIONAL. Full name of the user.
	 */
	name?: string;

	/**
	 * OPTIONAL. Given or first name of the user.
	 */
	given_name?: string;

	/**
	 * OPTIONAL. Family name or last name of the user.
	 */
	family_name?: string;

	/**
	 * OPTIONAL. Middle name of the user.
	 */
	middle_name?: string;

	/**
	 * OPTIONAL. Preferred username or email the user wishes to be referred to.
	 */
	preferred_username?: string;

	/**
	 * OPTIONAL. Email address of the user.
	 */
	email?: string;

	/**
	 * OPTIONAL. True if the user's email has been verified.
	 */
	email_verified?: boolean;

	/**
	 * OPTIONAL. User's profile picture URL.
	 */
	picture?: string;

	/**
	 * OPTIONAL. Authentication time. Time when the user authentication occurred.
	 */
	auth_time?: number;

	/**
	 * OPTIONAL. Authentication context class reference.
	 */
	acr?: string;

	/**
	 * OPTIONAL. Authentication methods references.
	 */
	amr?: string[];

	/**
	 * OPTIONAL. Session ID. String identifier for a session.
	 */
	sid?: string;

	/**
	 * OPTIONAL. Address component.
	 */
	address?: {
		formatted?: string;
		street_address?: string;
		locality?: string;
		region?: string;
		postal_code?: string;
		country?: string;
	};

	/**
	 * OPTIONAL. Groups that the user belongs to.
	 */
	groups?: string[];

	/**
	 * OPTIONAL. Roles assigned to the user.
	 */
	roles?: string[];

	/**
	 * OPTIONAL. Handles optional claims that are not explicitly defined in the standard.
	 */
	[key: string]: unknown;
}

//#endregion

//#region is functions

export function isAuthorizationProtectedResourceMetadata(obj: unknown): obj is IAuthorizationProtectedResourceMetadata {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}

	const metadata = obj as IAuthorizationProtectedResourceMetadata;
	if (!metadata.resource) {
		return false;
	}
	if (metadata.scopes_supported !== undefined && !Array.isArray(metadata.scopes_supported)) {
		return false;
	}
	return true;
}

const urisToCheck: Array<keyof IAuthorizationServerMetadata> = [
	'issuer',
	'authorization_endpoint',
	'token_endpoint',
	'registration_endpoint',
	'jwks_uri'
];
export function isAuthorizationServerMetadata(obj: unknown): obj is IAuthorizationServerMetadata {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const metadata = obj as IAuthorizationServerMetadata;
	if (!metadata.issuer) {
		throw new Error('Authorization server metadata must have an issuer');
	}

	for (const uri of urisToCheck) {
		if (!metadata[uri]) {
			continue;
		}
		if (typeof metadata[uri] !== 'string') {
			throw new Error(`Authorization server metadata '${uri}' must be a string`);
		}
		if (!metadata[uri].startsWith('https://') && !metadata[uri].startsWith('http://')) {
			throw new Error(`Authorization server metadata '${uri}' must start with http:// or https://`);
		}
	}
	return true;
}

export function isAuthorizationDynamicClientRegistrationResponse(obj: unknown): obj is IAuthorizationDynamicClientRegistrationResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationDynamicClientRegistrationResponse;
	return response.client_id !== undefined;
}

export function isAuthorizationAuthorizeResponse(obj: unknown): obj is IAuthorizationAuthorizeResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationAuthorizeResponse;
	return response.code !== undefined && response.state !== undefined;
}

export function isAuthorizationTokenResponse(obj: unknown): obj is IAuthorizationTokenResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationTokenResponse;
	return response.access_token !== undefined && response.token_type !== undefined;
}

export function isAuthorizationDeviceResponse(obj: unknown): obj is IAuthorizationDeviceResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationDeviceResponse;
	return response.device_code !== undefined && response.user_code !== undefined && response.verification_uri !== undefined && response.expires_in !== undefined;
}

export function isAuthorizationErrorResponse(obj: unknown): obj is IAuthorizationErrorResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationErrorResponse;
	return response.error !== undefined;
}

export function isAuthorizationRegistrationErrorResponse(obj: unknown): obj is IAuthorizationRegistrationErrorResponse {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const response = obj as IAuthorizationRegistrationErrorResponse;
	return response.error !== undefined;
}

//#endregion

//#region safe error reporting
// A token, registration, device-code or metadata response holds credentials (client secret, access, refresh and id tokens,
// device code), and so can a status line, a URL or a transport error. None of it may reach a log argument or an Error
// message or cause. The helpers below describe a failure ONLY by the numeric HTTP status, by an OAuth `error` code that is
// on the allowlist below, and by fixed outcome names; operation labels are static strings chosen by the caller. A parse,
// read or transport failure is reported with a NEW error and no cause, because parser messages quote the text they failed
// on and transport messages quote the URL.

/**
 * The OAuth error codes that may be reported: RFC 6749 (sections 4.1.2.1 and 5.2), RFC 8628 (3.5), RFC 7591 (3.2.2) and
 * RFC 6750 (3.1). Any other value, even a short token-like one, may be a credential and is never reported.
 */
const ALLOWED_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set<string>([
	AuthorizationErrorType.InvalidRequest,
	AuthorizationErrorType.InvalidClient,
	AuthorizationErrorType.InvalidGrant,
	AuthorizationErrorType.UnauthorizedClient,
	AuthorizationErrorType.UnsupportedGrantType,
	AuthorizationErrorType.InvalidScope,
	AuthorizationDeviceCodeErrorType.AuthorizationPending,
	AuthorizationDeviceCodeErrorType.SlowDown,
	AuthorizationDeviceCodeErrorType.AccessDenied,
	AuthorizationDeviceCodeErrorType.ExpiredToken,
	AuthorizationRegistrationErrorType.InvalidRedirectUri,
	AuthorizationRegistrationErrorType.InvalidClientMetadata,
	AuthorizationRegistrationErrorType.InvalidSoftwareStatement,
	AuthorizationRegistrationErrorType.UnapprovedSoftwareStatement,
	'unsupported_response_type',
	'server_error',
	'temporarily_unavailable',
	'invalid_token',
	'insufficient_scope'
]);

/**
 * The subset of a fetch Response the safe error helpers read.
 */
export interface IOAuthTextResponse {
	readonly status: number;
	text(): Promise<string>;
}

/**
 * Returns the OAuth `error` code of a parsed response body only when it is on the allowlist, otherwise undefined.
 */
export function getSafeOAuthErrorCode(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null) {
		return undefined;
	}
	const errorCode = (body as { error?: unknown }).error;
	return typeof errorCode === 'string' && ALLOWED_OAUTH_ERROR_CODES.has(errorCode) ? errorCode : undefined;
}

/**
 * Describes a parsed body for a message: an allowlisted error code, or a fixed outcome that never repeats the value.
 */
function describeOAuthBody(body: unknown): string {
	const errorCode = getSafeOAuthErrorCode(body);
	if (errorCode) {
		return errorCode;
	}
	const hasError = typeof body === 'object' && body !== null && (body as { error?: unknown }).error !== undefined;
	return hasError ? 'unrecognised error code' : 'no error code in body';
}

/**
 * The numeric HTTP status. The reason phrase is server supplied text and is never used.
 */
function describeOAuthHttpStatus(response: Pick<IOAuthTextResponse, 'status'>): string {
	return typeof response.status === 'number' && Number.isInteger(response.status) ? String(response.status) : 'unknown status';
}

/**
 * What reading the body of a failed response gave. Each outcome is named in the failure message, so a missing error code is
 * never silent.
 */
export type OAuthBodyOutcome =
	| { readonly kind: 'json'; readonly body: unknown }
	| { readonly kind: 'not-json' }
	| { readonly kind: 'unreadable' };

/**
 * Builds the message of an HTTP failure from a static operation label, the numeric status and the outcome of reading the
 * body: an allowlisted OAuth error code, or the name of what went wrong. No body text and no URL is included.
 */
export function formatOAuthHttpFailure(operation: string, response: Pick<IOAuthTextResponse, 'status'>, outcome: OAuthBodyOutcome): string {
	let detail: string;
	switch (outcome.kind) {
		case 'json': detail = describeOAuthBody(outcome.body); break;
		case 'not-json': detail = 'body not JSON'; break;
		case 'unreadable': detail = 'body unreadable'; break;
	}
	return `${operation} failed: ${describeOAuthHttpStatus(response)} (${detail})`;
}

/**
 * Creates the error for a request that did not complete (a rejected fetch). Whatever the transport said is dropped: its
 * message can quote the URL, which can hold credentials. No cause is kept.
 */
export function createOAuthTransportError(operation: string): Error {
	return new Error(`${operation} failed: the request could not be completed`);
}

/**
 * Reads a response body as text and parses it as JSON. When the body cannot be read or parsed this throws a new error that
 * names the operation, the numeric status and which of the two went wrong: it carries no cause and no parser message.
 */
export async function readOAuthJsonResponse(response: IOAuthTextResponse, operation: string): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		throw new Error(`${operation} failed: the response body could not be read (${describeOAuthHttpStatus(response)})`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${operation} failed: the response body is not valid JSON (${describeOAuthHttpStatus(response)})`);
	}
}

/**
 * Reads the body of a response that is already known to be a failure. The result names the outcome instead of hiding it:
 * parsed JSON, text that is not JSON, or a body that could not be read. No part of the body or of a parser message is kept
 * outside of a parsed `json` outcome.
 */
export async function readOAuthErrorBody(response: IOAuthTextResponse): Promise<OAuthBodyOutcome> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { kind: 'unreadable' };
	}
	try {
		return { kind: 'json', body: JSON.parse(text) };
	} catch {
		return { kind: 'not-json' };
	}
}

/**
 * Creates the error for a non-ok response: numeric status plus the allowlisted OAuth error code, or the named outcome of
 * reading the body.
 */
export async function createOAuthHttpError(operation: string, response: IOAuthTextResponse): Promise<Error> {
	return new Error(formatOAuthHttpFailure(operation, response, await readOAuthErrorBody(response)));
}

/**
 * Creates the error for a response that parsed but does not have the expected shape: static description, numeric status and
 * an allowlisted error code or fixed outcome.
 */
export function createOAuthInvalidResponseError(description: string, response: Pick<IOAuthTextResponse, 'status'>, body: unknown): Error {
	return new Error(`Invalid ${description} response: ${describeOAuthHttpStatus(response)} (${describeOAuthBody(body)})`);
}

/**
 * Describes a URL for a diagnostic as origin and path only. User info, query and fragment can hold credentials and are
 * dropped. A value that is not a URL is reported as such, never echoed.
 */
export function describeUrlForDiagnostics(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return '<not a valid URL>';
	}
}

//#endregion

export function getDefaultMetadataForUrl(authorizationServer: URL): IAuthorizationServerMetadata {
	return {
		issuer: authorizationServer.toString(),
		authorization_endpoint: new URL('/authorize', authorizationServer).toString(),
		token_endpoint: new URL('/token', authorizationServer).toString(),
		registration_endpoint: new URL('/register', authorizationServer).toString(),
		// Default values for Dynamic OpenID Providers
		// https://openid.net/specs/openid-connect-discovery-1_0.html
		response_types_supported: ['code', 'id_token', 'id_token token'],
	};
}

/**
 * The grant types that we support
 */
const grantTypesSupported = ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'];

/**
 * Default port for the authorization flow. We try to use this port so that
 * the redirect URI does not change when running on localhost. This is useful
 * for servers that only allow exact matches on the redirect URI. The spec
 * says that the port should not matter, but some servers do not follow
 * the spec and require an exact match.
 */
export const DEFAULT_AUTH_FLOW_PORT = 33418;
export async function fetchDynamicRegistration(serverMetadata: IAuthorizationServerMetadata, clientName: string, scopes?: string[]): Promise<IAuthorizationDynamicClientRegistrationResponse> {
	if (!serverMetadata.registration_endpoint) {
		throw new Error('Server does not support dynamic registration');
	}

	const requestBody: IAuthorizationDynamicClientRegistrationRequest = {
		client_name: clientName,
		client_uri: 'https://code.visualstudio.com',
		grant_types: serverMetadata.grant_types_supported
			? serverMetadata.grant_types_supported.filter(gt => grantTypesSupported.includes(gt))
			: grantTypesSupported,
		response_types: ['code'],
		redirect_uris: [
			'https://insiders.vscode.dev/redirect',
			'https://vscode.dev/redirect',
			'http://127.0.0.1/',
			// Added these for any server that might do
			// only exact match on the redirect URI even
			// though the spec says it should not care
			// about the port.
			`http://127.0.0.1:${DEFAULT_AUTH_FLOW_PORT}/`
		],
		scope: scopes?.join(AUTH_SCOPE_SEPARATOR),
		token_endpoint_auth_method: 'none',
		application_type: 'native'
	};

	let response: Response;
	try {
		response = await fetch(serverMetadata.registration_endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(requestBody)
		});
	} catch {
		// The transport error quotes the endpoint URL, which can hold credentials: report a new error without it
		throw createOAuthTransportError('Dynamic client registration');
	}

	if (!response.ok) {
		throw await createOAuthHttpError('Dynamic client registration', response);
	}

	const registration = await readOAuthJsonResponse(response, 'Dynamic client registration');
	if (isAuthorizationDynamicClientRegistrationResponse(registration)) {
		return registration;
	}
	throw createOAuthInvalidResponseError('dynamic client registration', response, registration);
}

export interface IAuthenticationChallenge {
	scheme: string;
	params: Record<string, string>;
}

export function parseWWWAuthenticateHeader(wwwAuthenticateHeaderValue: string): IAuthenticationChallenge[] {
	const challenges: IAuthenticationChallenge[] = [];

	// According to RFC 7235, multiple challenges are separated by commas
	// But parameters within a challenge can also be separated by commas
	// We need to identify scheme names to know where challenges start

	// First, split by commas while respecting quoted strings
	const tokens: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < wwwAuthenticateHeaderValue.length; i++) {
		const char = wwwAuthenticateHeaderValue[i];

		if (char === '"') {
			inQuotes = !inQuotes;
			current += char;
		} else if (char === ',' && !inQuotes) {
			if (current.trim()) {
				tokens.push(current.trim());
			}
			current = '';
		} else {
			current += char;
		}
	}

	if (current.trim()) {
		tokens.push(current.trim());
	}

	// Now process tokens to identify challenges
	// A challenge starts with a scheme name (a token that doesn't contain '=' and is followed by parameters or is standalone)
	let currentChallenge: { scheme: string; params: Record<string, string> } | undefined;

	for (const token of tokens) {
		const hasEquals = token.includes('=');

		if (!hasEquals) {
			// This token doesn't have '=', so it's likely a scheme name
			if (currentChallenge) {
				challenges.push(currentChallenge);
			}
			currentChallenge = { scheme: token.trim(), params: {} };
		} else {
			// This token has '=', it could be:
			// 1. A parameter for the current challenge
			// 2. A new challenge that starts with "Scheme param=value"

			const spaceIndex = token.indexOf(' ');
			if (spaceIndex > 0) {
				const beforeSpace = token.substring(0, spaceIndex);
				const afterSpace = token.substring(spaceIndex + 1);

				// Check if what's before the space looks like a scheme name (no '=')
				if (!beforeSpace.includes('=') && afterSpace.includes('=')) {
					// This is a new challenge starting with "Scheme param=value"
					if (currentChallenge) {
						challenges.push(currentChallenge);
					}
					currentChallenge = { scheme: beforeSpace.trim(), params: {} };

					// Parse the parameter part
					const equalIndex = afterSpace.indexOf('=');
					if (equalIndex > 0) {
						const key = afterSpace.substring(0, equalIndex).trim();
						const value = afterSpace.substring(equalIndex + 1).trim().replace(/^"|"$/g, '');
						if (key && value !== undefined) {
							currentChallenge.params[key] = value;
						}
					}
					continue;
				}
			}

			// This is a parameter for the current challenge
			if (currentChallenge) {
				const equalIndex = token.indexOf('=');
				if (equalIndex > 0) {
					const key = token.substring(0, equalIndex).trim();
					const value = token.substring(equalIndex + 1).trim().replace(/^"|"$/g, '');
					if (key && value !== undefined) {
						currentChallenge.params[key] = value;
					}
				}
			}
		}
	}

	// Don't forget the last challenge
	if (currentChallenge) {
		challenges.push(currentChallenge);
	}

	return challenges;
}

export function getClaimsFromJWT(token: string): IAuthorizationJWTClaims {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid JWT token format: token must have three parts separated by dots');
	}

	const [header, payload, _signature] = parts;

	// Parser messages quote the text they fail on (a token fragment), so every failure here is a fixed message with no cause
	let decodedHeader: unknown;
	try {
		decodedHeader = JSON.parse(decodeBase64(header).toString());
	} catch {
		throw new Error('Failed to parse JWT token: the header is not valid base64 JSON');
	}
	if (typeof decodedHeader !== 'object') {
		throw new Error('Failed to parse JWT token: Invalid JWT token format: header is not a JSON object');
	}

	let decodedPayload: unknown;
	try {
		decodedPayload = JSON.parse(decodeBase64(payload).toString());
	} catch {
		throw new Error('Failed to parse JWT token: the payload is not valid base64 JSON');
	}
	if (typeof decodedPayload !== 'object') {
		throw new Error('Failed to parse JWT token: Invalid JWT token format: payload is not a JSON object');
	}

	return decodedPayload as IAuthorizationJWTClaims;
}

/**
 * Checks if two scope lists are equivalent, regardless of order.
 * This is useful for comparing OAuth scopes where the order should not matter.
 *
 * @param scopes1 First list of scopes to compare (can be undefined)
 * @param scopes2 Second list of scopes to compare (can be undefined)
 * @returns true if the scope lists contain the same scopes (order-independent), false otherwise
 *
 * @example
 * ```typescript
 * scopesMatch(['read', 'write'], ['write', 'read']) // Returns: true
 * scopesMatch(['read'], ['write']) // Returns: false
 * scopesMatch(undefined, undefined) // Returns: true
 * scopesMatch(['read'], undefined) // Returns: false
 * ```
 */
export function scopesMatch(scopes1: readonly string[] | undefined, scopes2: readonly string[] | undefined): boolean {
	if (scopes1 === scopes2) {
		return true;
	}
	if (!scopes1 || !scopes2) {
		return false;
	}
	if (scopes1.length !== scopes2.length) {
		return false;
	}

	// Sort both arrays for comparison to handle different orderings
	const sortedScopes1 = [...scopes1].sort();
	const sortedScopes2 = [...scopes2].sort();

	return sortedScopes1.every((scope, index) => scope === sortedScopes2[index]);
}

interface CommonResponse {
	status: number;
	statusText: string;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

interface IFetcher {
	(input: string, init: { method: string; headers: Record<string, string> }): Promise<CommonResponse>;
}

export interface IFetchResourceMetadataOptions {
	/**
	 * Headers to include only when the resource metadata URL has the same origin as the target resource
	 */
	sameOriginHeaders?: Record<string, string>;
	/**
	 * Optional custom fetch implementation (defaults to global fetch)
	 */
	fetch?: IFetcher;
}

/**
 * Fetches and validates OAuth 2.0 protected resource metadata from the given URL.
 *
 * @param targetResource The target resource URL to compare origins with (e.g., the MCP server URL)
 * @param resourceMetadataUrl Optional URL to fetch the resource metadata from. If not provided, will try well-known URIs.
 * @param options Configuration options for the fetch operation
 * @returns Promise that resolves to an object containing the validated resource metadata and any errors encountered during discovery
 * @throws Error if the fetch fails, returns non-200 status, or the response is invalid on all attempted URLs
 */
export async function fetchResourceMetadata(
	targetResource: string,
	resourceMetadataUrl: string | undefined,
	options: IFetchResourceMetadataOptions = {}
): Promise<{ metadata: IAuthorizationProtectedResourceMetadata; errors: Error[] }> {
	const {
		sameOriginHeaders = {},
		fetch: fetchImpl = fetch
	} = options;

	const targetResourceUrlObj = new URL(targetResource);

	const fetchPrm = async (prmUrl: string, validateUrl: string) => {
		// Determine if we should include same-origin headers
		let headers: Record<string, string> = {
			'Accept': 'application/json'
		};

		let resourceMetadataUrlObj: URL;
		try {
			resourceMetadataUrlObj = new URL(prmUrl);
		} catch {
			// The URL error carries the rejected input: report a new error without it
			throw new Error('Failed to fetch resource metadata: the resource metadata URL is not a valid URL');
		}
		if (resourceMetadataUrlObj.origin === targetResourceUrlObj.origin) {
			headers = {
				...headers,
				...sameOriginHeaders
			};
		}

		// Metadata errors reach logs and can follow a request that carried same-origin credentials: they name the URL without
		// user info or query, the numeric status, and never the response body, the reason phrase or a transport message
		const prmUrlForDiagnostics = describeUrlForDiagnostics(prmUrl);
		let response: CommonResponse;
		try {
			response = await fetchImpl(prmUrl, { method: 'GET', headers });
		} catch {
			// The transport error quotes the URL, which can hold credentials: report a new error without it
			throw new Error(`Failed to fetch resource metadata from ${prmUrlForDiagnostics}: the request could not be completed`);
		}
		if (response.status !== 200) {
			throw new Error(`Failed to fetch resource metadata from ${prmUrlForDiagnostics}: ${response.status}`);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			// The parser message quotes the body: report a new error without it
			throw new Error(`Failed to fetch resource metadata from ${prmUrlForDiagnostics}: the response body is not valid JSON`);
		}
		if (isAuthorizationProtectedResourceMetadata(body)) {
			// Validate that the resource matches the target resource
			// Use URL constructor for normalization - it handles hostname case and trailing slashes
			let prmValue: string;
			try {
				prmValue = new URL(body.resource).toString();
			} catch {
				// The URL error carries the rejected input: report a new error without it
				throw new Error(`Invalid resource metadata from ${prmUrlForDiagnostics}: the 'resource' property is not a valid URL`);
			}
			const expectedResource = new URL(validateUrl).toString();
			if (prmValue !== expectedResource) {
				// The 'resource' value is server supplied text and is not repeated; the expected value is ours
				throw new Error(`Protected Resource Metadata 'resource' property value does not match expected value "${describeUrlForDiagnostics(expectedResource)}" for URL ${prmUrlForDiagnostics}. Per RFC 9728, these MUST match. See https://datatracker.ietf.org/doc/html/rfc9728#PRConfigurationValidation`);
			}
			return body;
		} else {
			throw new Error(`Invalid resource metadata from ${prmUrlForDiagnostics}. Expected to follow shape of https://datatracker.ietf.org/doc/html/rfc9728#name-protected-resource-metadata (Hints: is scopes_supported an array? Is resource a string?).`);
		}
	};

	const errors: Error[] = [];
	if (resourceMetadataUrl) {
		try {
			const metadata = await fetchPrm(resourceMetadataUrl, targetResource);
			return { metadata, errors };
		} catch (e) {
			// safe-error: fetchPrm throws only fixed-message errors (static text, numeric status, the URL as origin and path)
			errors.push(e instanceof Error ? e : new Error('Resource metadata request failed with a value that is not an Error'));
		}
	}

	// Try well-known URIs starting with path-appended, then root
	const hasPathComponent = targetResourceUrlObj.pathname !== '/';
	const rootUrl = `${targetResourceUrlObj.origin}${AUTH_PROTECTED_RESOURCE_METADATA_DISCOVERY_PATH}`;

	if (hasPathComponent) {
		const pathAppendedUrl = `${rootUrl}${targetResourceUrlObj.pathname}`;
		try {
			const metadata = await fetchPrm(pathAppendedUrl, targetResource);
			return { metadata, errors };
		} catch (e) {
			// safe-error: fetchPrm throws only fixed-message errors (static text, numeric status, the URL as origin and path)
			errors.push(e instanceof Error ? e : new Error('Resource metadata request failed with a value that is not an Error'));
		}
	}

	// Finally, try root discovery
	try {
		const metadata = await fetchPrm(rootUrl, targetResourceUrlObj.origin);
		return { metadata, errors };
	} catch (e) {
		// safe-error: fetchPrm throws only fixed-message errors (static text, numeric status, the URL as origin and path)
		errors.push(e instanceof Error ? e : new Error('Resource metadata request failed with a value that is not an Error'));
	}

	// If we've tried all methods and none worked, throw the error(s)
	if (errors.length === 1) {
		throw errors[0];
	} else {
		throw new AggregateError(errors, 'Failed to fetch resource metadata from all attempted URLs');
	}
}

export interface IFetchAuthorizationServerMetadataOptions {
	/**
	 * Headers to include in the requests
	 */
	additionalHeaders?: Record<string, string>;
	/**
	 * Optional custom fetch implementation (defaults to global fetch)
	 */
	fetch?: IFetcher;
}

/** Helper to try parsing the response as authorization server metadata */
async function tryParseAuthServerMetadata(response: CommonResponse): Promise<IAuthorizationServerMetadata | undefined> {
	if (response.status !== 200) {
		return undefined;
	}
	try {
		const body = await response.json();
		if (isAuthorizationServerMetadata(body)) {
			return body;
		}
	} catch {
		// Failed to parse as JSON or not valid metadata
	}
	return undefined;
}

/**
 * Fetches and validates OAuth 2.0 authorization server metadata from the given authorization server URL.
 *
 * This function tries multiple discovery endpoints in the following order:
 * 1. OAuth 2.0 Authorization Server Metadata with path insertion (RFC 8414)
 * 2. OpenID Connect Discovery with path insertion
 * 3. OpenID Connect Discovery with path addition
 *
 * Path insertion: For issuer URLs with path components (e.g., https://example.com/tenant),
 * the well-known path is inserted after the origin and before the path:
 * https://example.com/.well-known/oauth-authorization-server/tenant
 *
 * Path addition: The well-known path is simply appended to the existing path:
 * https://example.com/tenant/.well-known/openid-configuration
 *
 * @param authorizationServer The authorization server URL (issuer identifier)
 * @param options Configuration options for the fetch operation
 * @returns Promise that resolves to the validated authorization server metadata
 * @throws Error if all discovery attempts fail or the response is invalid
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 */
export async function fetchAuthorizationServerMetadata(
	authorizationServer: string,
	options: IFetchAuthorizationServerMetadataOptions = {}
): Promise<IAuthorizationServerMetadata> {
	const {
		additionalHeaders = {},
		fetch: fetchImpl = fetch
	} = options;

	const authorizationServerUrl = new URL(authorizationServer);
	const extraPath = authorizationServerUrl.pathname === '/' ? '' : authorizationServerUrl.pathname;

	const errors: Error[] = [];

	const doFetch = async (url: string): Promise<IAuthorizationServerMetadata | undefined> => {
		try {
			const rawResponse = await fetchImpl(url, {
				method: 'GET',
				headers: {
					...additionalHeaders,
					'Accept': 'application/json'
				}
			});
			const metadata = await tryParseAuthServerMetadata(rawResponse);
			if (metadata) {
				return metadata;
			}
			// No metadata found, collect error from response
			errors.push(new Error(`Failed to fetch authorization server metadata from ${describeUrlForDiagnostics(url)}: ${rawResponse.status}`));
			return undefined;
		} catch {
			// Collect the fetch failure. The transport error quotes the URL, which can hold credentials: it is replaced
			errors.push(new Error(`Failed to fetch authorization server metadata from ${describeUrlForDiagnostics(url)}: the request could not be completed`));
			return undefined;
		}
	};

	// For the oauth server metadata discovery path, we _INSERT_
	// the well known path after the origin and before the path.
	// https://datatracker.ietf.org/doc/html/rfc8414#section-3
	const pathToFetch = new URL(AUTH_SERVER_METADATA_DISCOVERY_PATH, authorizationServer).toString() + extraPath;
	let metadata = await doFetch(pathToFetch);
	if (metadata) {
		return metadata;
	}

	// Try fetching the OpenID Connect Discovery with path insertion.
	// For issuer URLs with path components, this inserts the well-known path
	// after the origin and before the path.
	const openidPathInsertionUrl = new URL(OPENID_CONNECT_DISCOVERY_PATH, authorizationServer).toString() + extraPath;
	metadata = await doFetch(openidPathInsertionUrl);
	if (metadata) {
		return metadata;
	}

	// Try fetching the other discovery URL. For the openid metadata discovery
	// path, we _ADD_ the well known path after the existing path.
	// https://datatracker.ietf.org/doc/html/rfc8414#section-3
	const openidPathAdditionUrl = authorizationServer.endsWith('/')
		? authorizationServer + OPENID_CONNECT_DISCOVERY_PATH.substring(1) // Remove leading slash if authServer ends with slash
		: authorizationServer + OPENID_CONNECT_DISCOVERY_PATH;
	metadata = await doFetch(openidPathAdditionUrl);
	if (metadata) {
		return metadata;
	}

	// If we've tried all URLs and none worked, throw the error(s)
	if (errors.length === 1) {
		throw errors[0];
	} else {
		throw new AggregateError(errors, 'Failed to fetch authorization server metadata from all attempted URLs');
	}
}
