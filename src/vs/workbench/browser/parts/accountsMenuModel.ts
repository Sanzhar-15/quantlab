/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/log.js';
import { AuthenticationSessionInfo } from '../../services/authentication/browser/authenticationService.js';
import { AuthenticationSessionAccount, IAuthenticationService } from '../../services/authentication/common/authentication.js';

export type AccountsMenuAccount = AuthenticationSessionAccount & { canSignOut: boolean };

/**
 * The accounts the Accounts menu lists, and the providers it could not read.
 *
 * It is DOM free so that it is testable apart from the menu (F-SECRETS-1 review c1, MUST-4):
 * - The session the embedder stored (it says whether the user may sign out) is read from the secret store; a read that
 *   cannot decrypt or parse rejects. A rejection is not remembered: the next use reads the secret store again.
 * - An account update is staged: nothing of the provider is installed until the read succeeded, so a failed read leaves no
 *   empty account list behind.
 * - A provider whose update failed is marked problematic, which the menu shows as unavailable and retries.
 * - An unreadable embedder session is never treated as an absent one: the account is not added, so no sign-out
 *   permission is decided from it.
 */
export class AccountsMenuModel {

	readonly groupedAccounts: Map<string, AccountsMenuAccount[]> = new Map();
	readonly problematicProviders: Set<string> = new Set();

	private _sessionFromEmbedder: Promise<AuthenticationSessionInfo | undefined> | undefined;

	constructor(
		private readonly _authenticationService: Pick<IAuthenticationService, 'getSessions'>,
		private readonly _readSessionFromEmbedder: () => Promise<AuthenticationSessionInfo | undefined>,
		private readonly _logService: ILogService
	) { }

	/** The embedder's session, read once while it reads; a rejected read is forgotten, so the next call reads again. */
	private _getSessionFromEmbedder(): Promise<AuthenticationSessionInfo | undefined> {
		if (this._sessionFromEmbedder) {
			return this._sessionFromEmbedder;
		}
		const pending = this._readSessionFromEmbedder();
		this._sessionFromEmbedder = pending;
		// The caller still receives the rejection; this only forgets it.
		pending.then(undefined, () => {
			if (this._sessionFromEmbedder === pending) {
				this._sessionFromEmbedder = undefined;
			}
		});
		return pending;
	}

	removeProvider(providerId: string): void {
		this.groupedAccounts.delete(providerId);
		this.problematicProviders.delete(providerId);
	}

	async addOrUpdateAccount(providerId: string, account: AuthenticationSessionAccount): Promise<void> {
		// Everything that can fail is awaited before the provider's account list is touched.
		const sessionFromEmbedder = await this._getSessionFromEmbedder();
		let canSignOut = true;
		if (
			sessionFromEmbedder												// if we have a session from the embedder
			&& !sessionFromEmbedder.canSignOut								// and that session says we can't sign out
			&& (await this._authenticationService.getSessions(providerId))	// and that session is associated with the account we are adding/updating
				.some(s =>
					s.id === sessionFromEmbedder.id
					&& s.account.id === account.id
				)
		) {
			canSignOut = false;
		}

		let accounts = this.groupedAccounts.get(providerId);
		if (!accounts) {
			accounts = [];
			this.groupedAccounts.set(providerId, accounts);
		}

		const existingAccount = accounts.find(a => a.label === account.label);
		if (existingAccount) {
			// if we have an existing account and we discover that we
			// can't sign out of it, update the account to mark it as "can't sign out"
			if (!canSignOut) {
				existingAccount.canSignOut = canSignOut;
			}
		} else {
			accounts.push({ ...account, canSignOut });
		}
	}

	removeAccount(providerId: string, account: AuthenticationSessionAccount): void {
		const accounts = this.groupedAccounts.get(providerId);
		if (!accounts) {
			return;
		}

		const index = accounts.findIndex(a => a.id === account.id);
		if (index === -1) {
			return;
		}

		accounts.splice(index, 1);
		if (accounts.length === 0) {
			this.groupedAccounts.delete(providerId);
		}
	}

	/**
	 * addOrUpdateAccount for a boundary nobody awaits (a session change, the retry of a provider): a failure is logged and
	 * the provider is marked problematic, so that the menu shows it as unavailable and reads again at the next showing.
	 * The account is not added, and no sign-out permission is decided from an unreadable embedder session.
	 * @returns whether the account was added or updated.
	 */
	async addOrUpdateAccountReportingFailure(providerId: string, account: AuthenticationSessionAccount): Promise<boolean> {
		try {
			await this.addOrUpdateAccount(providerId, account);
		} catch (e) {
			this._logService.error(e);
			this.problematicProviders.add(providerId);
			return false;
		}
		return true;
	}

	async addAccountsFromProvider(providerId: string): Promise<void> {
		try {
			const sessions = await this._authenticationService.getSessions(providerId);
			this.problematicProviders.delete(providerId);

			for (const session of sessions) {
				if (!await this.addOrUpdateAccountReportingFailure(providerId, session.account)) {
					// The provider is unavailable until the next showing: the other accounts would hit the same read.
					break;
				}
			}
		} catch (e) {
			this._logService.error(e);
			this.problematicProviders.add(providerId);
		}
	}
}
