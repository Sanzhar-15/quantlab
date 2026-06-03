/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Generate a URI for a webview resource
 */
export function getWebviewUri(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	pathList: string[]
): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathList));
}

/**
 * Generate a nonce for CSP.
 *
 * **FE megaudit L-k (2026-06-03)**: use a CSPRNG (`crypto.randomBytes`) instead of
 * `Math.random`, which is NOT cryptographically secure and is predictable across
 * calls. A CSP nonce gates which inline/script content may execute, so it should be
 * unpredictable (defense-in-depth). `base64url` yields only `[A-Za-z0-9_-]`, all of
 * which are valid in a CSP `'nonce-...'` source and an HTML attribute value -- no
 * `+`/`/`/`=` to escape. 16 random bytes = 128 bits of entropy.
 */
export function getNonce(): string {
	return crypto.randomBytes(16).toString('base64url');
}
