/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QL-DATA / QL-LOGIN: the host API object, by module augmentation (vscode.d.ts is not edited).
// `vscode.quantlabHost` is present ONLY in the built-in quantlab extension's API instance; every other
// extension, and a build without the carrier, sees `undefined`. Contract fixed with HOST. Keep this the
// one declaration of `quantlabHost`: a second `export const quantlabHost` would not merge.

declare module 'vscode' {

	export interface QuantlabHostUser {
		readonly id: string;
		readonly email: string;
		/** Optional in the protocol: absent when the account has none. Nothing fills it in. */
		readonly name?: string;
		/** Required: Go's tier (PLAN-FINAL §3.2 item 1). Not displayed until E2. */
		readonly tier: string;
	}

	export interface QuantlabHostIdentity {
		/** The host's sign-in generation: it changes on every sign-in and sign-out. */
		readonly epoch: number;
		readonly signedIn: boolean;
		readonly user?: QuantlabHostUser;
	}

	/** Codes a host rejection carries (a server error carries the server's code and message). */
	export type QuantlabHostErrorCode = 'identity-changed' | 'no-route' | 'not-signed-in' | 'not-available';

	export interface QuantlabHostStreamState {
		readonly kind: 'open' | 'reconnecting' | 'closed' | 'error';
		readonly message?: string;
	}

	export interface QuantlabHostStream {
		readonly onData: Event<unknown>;
		readonly onState: Event<QuantlabHostStreamState>;
		dispose(): void;
	}

	export interface QuantlabHostApi {
		getIdentity(): Promise<QuantlabHostIdentity>;
		readonly onDidChangeIdentity: Event<QuantlabHostIdentity>;
		/**
		 * Sign out of Delta Plus in every view. The workbench asks the user first (a modal confirm):
		 * resolves true when signed out, false when the user cancelled (nothing was sent). A host
		 * refusal rejects with an Error carrying `code`. The new identity arrives on onDidChangeIdentity.
		 */
		signOut(): Thenable<boolean>;
		/** One named op; resolves with the parsed answer or rejects with a coded error. */
		request(op: string, input: unknown, token?: CancellationToken): Promise<unknown>;
		subscribe(topic: string, params: unknown): QuantlabHostStream;
	}

	export const quantlabHost: QuantlabHostApi | undefined;
}
