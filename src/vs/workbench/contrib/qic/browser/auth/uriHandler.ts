/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../../base/common/uri.js';
import type { IURLHandler, IOpenURLOptions } from '../../../../../platform/url/common/url.js';

type AuthCallback = (code: string, state: string) => void;
type ErrorCallback = (error: string) => void;

/**
 * VS Code URI handler for OAuth2 callback.
 * Implements IURLHandler for registration with IURLService.
 * Handles vscode://quantlab.qic/auth/callback?code=...&state=...
 */
export class QicAuthUriHandler implements IURLHandler {
	private _onAuthCode: AuthCallback | null = null;
	private _onError: ErrorCallback | null = null;

	/**
	 * Register callbacks for auth flow completion.
	 */
	onAuthCode(callback: AuthCallback): void {
		this._onAuthCode = callback;
	}

	onError(callback: ErrorCallback): void {
		this._onError = callback;
	}

	/**
	 * Handle incoming URI from VS Code's URL service.
	 * Implements IURLHandler.handleURL().
	 * Expected format: vscode://quantlab.qic/auth/callback?code=<code>&state=<state>
	 *
	 * @returns true if this handler processed the URI, false otherwise
	 */
	async handleURL(uri: URI, _options?: IOpenURLOptions): Promise<boolean> {
		// Only handle our specific callback path
		if (uri.authority !== 'quantlab.qic' || uri.path !== '/auth/callback') {
			return false;
		}

		const query = new URLSearchParams(uri.query);
		const code = query.get('code');
		const state = query.get('state');
		const error = query.get('error');

		if (error) {
			const description = query.get('error_description') ?? error;
			this._onError?.(description);
			return true;
		}

		if (!code || !state) {
			this._onError?.('Missing code or state in auth callback');
			return true;
		}

		this._onAuthCode?.(code, state);
		return true;
	}

	/**
	 * Legacy method for backward compatibility with tests.
	 * @deprecated Use handleURL instead
	 */
	handleUri(uri: URI): void {
		void this.handleURL(uri);
	}

	dispose(): void {
		this._onAuthCode = null;
		this._onError = null;
	}
}
