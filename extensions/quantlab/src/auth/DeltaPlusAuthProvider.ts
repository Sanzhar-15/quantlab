/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab -- Delta Plus identity holder, internal to this extension
// Deliberately NOT a vscode.AuthenticationProvider and never registered as one: a public provider
// hands the account id and label to every installed extension through vscode.authentication
// (getSession / getAccounts), and no extension other than QuantLab may obtain the Delta Plus
// identity (rule 2, EXT-ISO case G3). Inside QuantLab the identity is read through
// ServerApiClient.getUser() and this class's onDidSignIn; nothing is published to other extensions.
// The provider is a CLIENT of the host identity (QL-LOGIN contract section 4):
// it asks the workbench for who is signed in (`_quantlab.hostIdentity.get`) and is told when
// that may have changed (`_quantlab.hostIdentity.didChange`, a tick that carries nothing; the
// provider pulls). It holds no credential, makes no request to the sign-in service and writes
// no secret or Memento key. Sign-in and sign-out belong to the Quantlab terminal view.

import * as vscode from 'vscode';
import { ServerApiClient, ServerUser } from '../core/server/ServerApiClient';

// The two extension-facing commands owned by the workbench service (contract section 3). Neither
// is user-facing, so neither has a package.json entry.
const HOST_IDENTITY_GET_COMMAND = '_quantlab.hostIdentity.get';
const HOST_IDENTITY_DID_CHANGE_COMMAND = '_quantlab.hostIdentity.didChange';

// DELETE-ONLY TOMBSTONE LIST. The login-bearing SecretStorage keys this extension wrote before the
// host identity (LG0-KEYSET, store kind SecretStorage(ext), key_kind CONST). They are deleted once at
// provider start and are never read or written. Remove this list together with the SYNC-1 tombstone
// after the first user-facing release that includes QuantLab. (The census holds no login-bearing
// Memento key for the extension, so there is no globalState.update(key, undefined) here.)
const LEGACY_LOGIN_SECRET_KEYS: readonly string[] = [
	'deltaplus.sessions',
	'deltaplus.migrationV1Done',
	'qic.deltaplusAccessToken',
	'qic.deltaplusRefreshToken',
	'qic.deltaplusTokenExpiresAt',
];

/** The contract's Identity: exactly these two shapes, nothing else. */
interface HostUser {
	readonly id: string;
	readonly email: string;
	readonly name: string | undefined;
}
type HostIdentity =
	| { readonly signedIn: false }
	| { readonly signedIn: true; readonly user: HostUser };

/**
 * The only place the host's answer is trusted. The value crosses a process boundary, so it is
 * untrusted input: anything but the contract's two union members throws.
 */
function parseHostIdentity(raw: unknown): HostIdentity {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('Host identity answer is not an object.');
	}
	const record = raw as Record<string, unknown>;
	const keys = Object.keys(record).sort().join(',');
	if (record.signedIn === false) {
		if (keys !== 'signedIn') {
			throw new Error(`Host identity answer for signedIn:false has unexpected fields: ${keys}.`);
		}
		return { signedIn: false };
	}
	if (record.signedIn === true) {
		if (keys !== 'signedIn,user') {
			throw new Error(`Host identity answer for signedIn:true has unexpected fields: ${keys}.`);
		}
		const user = record.user;
		if (typeof user !== 'object' || user === null || Array.isArray(user)) {
			throw new Error('Host identity answer for signedIn:true has no user object.');
		}
		const u = user as Record<string, unknown>;
		const userKeys = Object.keys(u).sort().join(',');
		// `name` is `string | undefined` in the contract; an undefined property does not survive
		// the command boundary, so its absence is the undefined member.
		if (userKeys !== 'email,id' && userKeys !== 'email,id,name') {
			throw new Error(`Host identity user has unexpected fields: ${userKeys}.`);
		}
		const id = u.id;
		const email = u.email;
		const name = u.name;
		if (typeof id !== 'string' || id === '') {
			throw new Error('Host identity user.id is not a non-empty string.');
		}
		if (typeof email !== 'string' || email === '') {
			throw new Error('Host identity user.email is not a non-empty string.');
		}
		if (name !== undefined && typeof name !== 'string') {
			throw new Error('Host identity user.name is neither a string nor absent.');
		}
		return { signedIn: true, user: { id, email, name } };
	}
	throw new Error('Host identity answer has no boolean signedIn.');
}

export class DeltaPlusAuthProvider implements vscode.Disposable {
	// Fires when a user becomes signed in: from signed out, or a different user id. Internal to
	// QuantLab (extension.ts reconnects the WebSocket on it); it carries nothing, readers ask
	// ServerApiClient.getUser().
	private readonly _signInEmitter = new vscode.EventEmitter<void>();
	readonly onDidSignIn = this._signInEmitter.event;

	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _output: vscode.OutputChannel;

	// Until the first pull completes the provider reports signed out; the pull at activation
	// (initializeFromHost) is what replaces it.
	private _identity: HostIdentity = { signedIn: false };
	// Pull sequencing: each pull takes a ticket when it starts; an answer is applied only if no
	// newer pull's answer has been applied, so a slow older pull never overwrites newer state.
	private _pullsStarted = 0;
	private _lastAppliedPull = 0;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _serverClient: ServerApiClient
	) {
		this._output = vscode.window.createOutputChannel('Quantlab Sign-in');
		this._disposables.push(
			this._output,
			// The tick carries nothing: pull. A failed pull is shown AND logged, and the state
			// the provider already holds is left as it was -- never read as "signed out".
			vscode.commands.registerCommand(HOST_IDENTITY_DID_CHANGE_COMMAND, async () => {
				try {
					await this._pull();
				} catch (err) {
					this._report('Could not read the sign-in state from the host', err);
				}
			})
		);
	}

	dispose(): void {
		this._signInEmitter.dispose();
		this._disposables.forEach(d => d.dispose());
	}

	// -- Public helpers ----------------------------------------------------------

	/**
	 * Pull the sign-in state from the host (pull-at-start rule: a tick sent before this provider
	 * registered its command is not replayed). Returns whether a user is signed in. A rejected
	 * pull or a malformed answer THROWS; the caller shows and logs it.
	 */
	async initializeFromHost(): Promise<boolean> {
		await this._purgeLegacyLoginKeys();
		await this._pull();
		return this._identity.signedIn;
	}

	// -- Private helpers ---------------------------------------------------------

	/**
	 * Delete-only purge of the legacy login keys, once, before the first pull. No value is read.
	 * One log line per key (the key name only). A rejected deletion is shown and logged, not
	 * retried and not swallowed; the remaining keys are still attempted so each outcome is visible.
	 */
	private async _purgeLegacyLoginKeys(): Promise<void> {
		for (const key of LEGACY_LOGIN_SECRET_KEYS) {
			try {
				await this._context.secrets.delete(key);
				this._output.appendLine(`[${new Date().toISOString()}] legacy login key deleted: ${key}`);
			} catch (err) {
				this._report(`Could not delete the legacy login key ${key}`, err);
			}
		}
	}

	private async _pull(): Promise<void> {
		const ticket = ++this._pullsStarted;
		const raw = await vscode.commands.executeCommand<unknown>(HOST_IDENTITY_GET_COMMAND);
		const identity = parseHostIdentity(raw);
		if (ticket < this._lastAppliedPull) {
			return; // a pull that started later has already been applied
		}
		this._lastAppliedPull = ticket;
		this._apply(identity);
	}

	private _apply(next: HostIdentity): void {
		const previous = this._identity;
		this._identity = next;

		// The client first: listeners of onDidSignIn reconnect the WebSocket, which needs the user
		// to be set. Sign-out and same-user field changes reach readers through the client's
		// onAuthStateChange.
		this._serverClient.setHostIdentity(next.signedIn ? this._toServerUser(next.user) : undefined);

		if (next.signedIn && (!previous.signedIn || previous.user.id !== next.user.id)) {
			this._signInEmitter.fire();
		}
	}

	private _report(message: string, err: unknown): void {
		const detail = err instanceof Error ? err.message : String(err);
		this._output.appendLine(`[${new Date().toISOString()}] ${message}: ${detail}`);
		void vscode.window.showErrorMessage(`${message}: ${detail}`);
	}

	private _toServerUser(user: HostUser): ServerUser {
		// AUTH-TIER: the host identity carries no tier yet; the carry AUTH-TIER adds it here.
		return { id: user.id, email: user.email, name: user.name };
	}
}
