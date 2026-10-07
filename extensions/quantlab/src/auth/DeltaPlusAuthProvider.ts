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
// The provider is a CLIENT of the host identity (QL-LOGIN contract section 4; rule 2): it reads
// who is signed in from `vscode.quantlabHost`, the API object the fork gives ONLY to this built-in
// extension -- a pull of getIdentity() at start, then every identity onDidChangeIdentity delivers.
// There is no command: a command would hand the identity to any extension. The provider holds no
// credential, makes no request to the sign-in service and writes no secret or Memento key.
// Sign-in and sign-out belong to the Quantlab terminal view.

import * as vscode from 'vscode';
import { ServerApiClient, ServerUser } from '../core/server/ServerApiClient';

/** Every identity read fails with this when `vscode.quantlabHost` is absent (a build without the carrier). */
export const HOST_IDENTITY_UNAVAILABLE = 'Host identity API is not available in this build';

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

/** The contract's Identity (quantlabHost.d.ts): exactly these two shapes, nothing else. */
interface HostUser {
	readonly id: string;
	readonly email: string;
	readonly name?: string;
	readonly tier: string;
}
type HostIdentity =
	| { readonly epoch: number; readonly signedIn: false }
	| { readonly epoch: number; readonly signedIn: true; readonly user: HostUser };

const HOST_USER_KEYS: readonly string[] = ['email', 'id', 'name', 'tier'];

/** The host's sign-in generation: an integer >= 1. The message never echoes the value. */
function parseEpoch(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new Error('Host identity epoch is not an integer >= 1.');
	}
	return value;
}

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
		if (keys !== 'epoch,signedIn') {
			throw new Error(`Host identity answer for signedIn:false has unexpected fields: ${keys}.`);
		}
		return { epoch: parseEpoch(record.epoch), signedIn: false };
	}
	if (record.signedIn === true) {
		if (keys !== 'epoch,signedIn,user') {
			throw new Error(`Host identity answer for signedIn:true has unexpected fields: ${keys}.`);
		}
		const user = record.user;
		if (typeof user !== 'object' || user === null || Array.isArray(user)) {
			throw new Error('Host identity answer for signedIn:true has no user object.');
		}
		const u = user as Record<string, unknown>;
		// Only `name` is optional in the contract: an absent key is the absent member. `tier` is required.
		const unexpected = Object.keys(u).filter(key => !HOST_USER_KEYS.includes(key)).sort();
		if (unexpected.length > 0) {
			throw new Error(`Host identity user has unexpected fields: ${unexpected.join(',')}.`);
		}
		const id = u.id;
		const email = u.email;
		const name = u.name;
		const tier = u.tier;
		if (typeof id !== 'string' || id === '') {
			throw new Error('Host identity user.id is not a non-empty string.');
		}
		if (typeof email !== 'string' || email === '') {
			throw new Error('Host identity user.email is not a non-empty string.');
		}
		if (name !== undefined && typeof name !== 'string') {
			throw new Error('Host identity user.name is neither a string nor absent.');
		}
		if (typeof tier !== 'string' || tier === '') {
			throw new Error('Host identity user.tier is not a non-empty string.');
		}
		const parsedUser: { id: string; email: string; name?: string; tier: string } = { id, email, tier };
		if (name !== undefined) {
			parsedUser.name = name;
		}
		return { epoch: parseEpoch(record.epoch), signedIn: true, user: parsedUser };
	}
	throw new Error('Host identity answer has no boolean signedIn.');
}

export class DeltaPlusAuthProvider implements vscode.Disposable {
	// Fires when a user becomes signed in: from signed out, or a different user id. Internal to
	// QuantLab (no listener today: QL-DATA removed the WebSocket that reconnected on it); it carries
	// nothing, readers ask ServerApiClient.getUser().
	private readonly _signInEmitter = new vscode.EventEmitter<void>();
	readonly onDidSignIn = this._signInEmitter.event;

	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _output: vscode.OutputChannel;

	// The host API, resolved once (as the data transport resolves it). `undefined` in a build without
	// the carrier: then every identity read fails with HOST_IDENTITY_UNAVAILABLE.
	private readonly _host: vscode.QuantlabHostApi | undefined;

	// The identity last applied, epoch included. `undefined` until the first pull or change event is
	// applied; until then ServerApiClient holds no user, so every reader sees signed out.
	private _identity: HostIdentity | undefined;
	// Sequencing: a pull takes a ticket when it starts; a change event takes one when it arrives and
	// is applied at once. A pull's answer is applied only if nothing with a later ticket has been, so
	// a slow pull never overwrites a later pull or a change event that arrived while it was in flight.
	private _ticketsIssued = 0;
	private _lastAppliedTicket = 0;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _serverClient: ServerApiClient
	) {
		this._output = vscode.window.createOutputChannel('Quantlab Sign-in');
		this._disposables.push(this._output);
		this._host = vscode.quantlabHost;
		if (this._host === undefined) {
			// Nothing to subscribe to. The pull at activation (initializeFromHost) fails with this
			// error, and its caller shows and logs it.
			this._output.appendLine(`[${new Date().toISOString()}] ${HOST_IDENTITY_UNAVAILABLE}: every identity read fails with this error`);
		} else {
			this._disposables.push(this._host.onDidChangeIdentity(identity => this._onHostIdentityChanged(identity)));
		}
	}

	dispose(): void {
		this._signInEmitter.dispose();
		this._disposables.forEach(d => d.dispose());
	}

	// -- Public helpers ----------------------------------------------------------

	/**
	 * Pull the sign-in state from the host (pull-at-start rule: an identity change delivered before
	 * this provider subscribed is not replayed). Returns whether a user is signed in. An absent host
	 * API, a rejected pull or a malformed answer THROWS; the caller shows and logs it.
	 */
	async initializeFromHost(): Promise<boolean> {
		await this._purgeLegacyLoginKeys();
		await this._pull();
		if (this._identity === undefined) {
			throw new Error('The host identity pull completed but no identity was applied.');
		}
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
		if (this._host === undefined) {
			throw new Error(HOST_IDENTITY_UNAVAILABLE);
		}
		const ticket = ++this._ticketsIssued;
		const identity = parseHostIdentity(await this._host.getIdentity());
		if (ticket < this._lastAppliedTicket) {
			return; // a later pull or a change event has already been applied
		}
		this._lastAppliedTicket = ticket;
		this._apply(identity);
	}

	/**
	 * A change event carries the identity itself: it is applied at once and outranks every pull
	 * still in flight. One that cannot be applied is shown AND logged, and the state the provider
	 * already holds is left as it was -- never read as "signed out".
	 */
	private _onHostIdentityChanged(raw: vscode.QuantlabHostIdentity): void {
		try {
			const identity = parseHostIdentity(raw);
			this._lastAppliedTicket = ++this._ticketsIssued;
			this._apply(identity);
		} catch (err) {
			this._report('Could not apply the sign-in change from the host', err);
		}
	}

	private _apply(next: HostIdentity): void {
		const previous = this._identity;
		this._identity = next;

		// The client first, so a listener of onDidSignIn reads the new user from it. Sign-out and
		// same-user field changes reach readers through the client's onAuthStateChange.
		this._serverClient.setHostIdentity(next.signedIn ? this._toServerUser(next.user) : undefined);

		if (next.signedIn && (previous === undefined || !previous.signedIn || previous.user.id !== next.user.id)) {
			this._signInEmitter.fire();
		}
	}

	private _report(message: string, err: unknown): void {
		const detail = err instanceof Error ? err.message : String(err);
		this._output.appendLine(`[${new Date().toISOString()}] ${message}: ${detail}`);
		void vscode.window.showErrorMessage(`${message}: ${detail}`);
	}

	private _toServerUser(user: HostUser): ServerUser {
		// allow-any-unicode-next-line
		// AUTH-TIER (PLAN-FINAL §3.2 item 1): the contract carries Go's tier, but no tier text is shown until the server's tier is real on the app's token path (E2); so the tier is not copied into the ServerUser that every display reads.
		// The name is optional: absent stays absent (no key), never a stand-in.
		const serverUser: ServerUser = { id: user.id, email: user.email };
		if (user.name !== undefined) {
			serverUser.name = user.name;
		}
		return serverUser;
	}
}
