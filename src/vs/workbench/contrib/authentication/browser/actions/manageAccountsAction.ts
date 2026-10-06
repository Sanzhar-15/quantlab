/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Lazy } from '../../../../../base/common/lazy.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { AuthenticationSessionInfo, getCurrentAuthenticationSessionInfo } from '../../../../services/authentication/browser/authenticationService.js';
import { IAuthenticationProvider, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { runAtBoundary } from '../../../../services/authentication/common/storedSecretBoundary.js';

export class ManageAccountsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.manageAccounts',
			title: localize2('manageAccounts', "Manage Accounts"),
			category: localize2('accounts', "Accounts"),
			f1: true
		});
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		return instantiationService.createInstance(ManageAccountsActionImpl).run();
	}
}

interface AccountQuickPickItem extends IQuickPickItem {
	providerId: string;
	canUseMcp: boolean;
	canSignOut: () => Promise<boolean>;
}

interface AccountActionQuickPickItem extends IQuickPickItem {
	action: () => void;
}

/** Exported for tests only. */
export class ManageAccountsActionImpl {
	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	public async run() {
		const placeHolder = localize('pickAccount', "Select an account to manage");

		const accounts = await this.listAccounts();
		if (!accounts.length) {
			await this.quickInputService.pick([{ label: localize('noActiveAccounts', "There are no active accounts.") }], { placeHolder });
			return;
		}

		const account = await this.quickInputService.pick(accounts, { placeHolder, matchOnDescription: true });
		if (!account) {
			return;
		}

		await this.showAccountActions(account);
	}

	private async listAccounts(): Promise<AccountQuickPickItem[]> {
		const activeSession = new Lazy(() => getCurrentAuthenticationSessionInfo(this.secretStorageService, this.productService));
		const accounts: AccountQuickPickItem[] = [];
		for (const providerId of this.authenticationService.getProviderIds()) {
			const provider = this.authenticationService.getProvider(providerId);
			for (const { label, id } of await this.authenticationService.getAccounts(providerId)) {
				accounts.push({
					label,
					description: provider.label,
					providerId,
					canUseMcp: !!provider.authorizationServers?.length,
					canSignOut: async () => this.canSignOut(provider, id, await activeSession.value)
				});
			}
		}
		return accounts;
	}

	private async canSignOut(provider: IAuthenticationProvider, accountId: string, session?: AuthenticationSessionInfo): Promise<boolean> {
		if (session && !session.canSignOut && session.providerId === provider.id) {
			const sessions = await this.authenticationService.getSessions(provider.id);
			return !sessions.some(o => o.id === session.id && o.account.id === accountId);
		}
		return true;
	}

	private async showAccountActions(account: AccountQuickPickItem): Promise<void> {
		const { providerId, label: accountLabel, canUseMcp, canSignOut } = account;

		// Decided before any UI exists: a stored session that cannot be read rejects here, and is never read as "may sign out".
		const mayShowSignOut = await canSignOut();

		const store = new DisposableStore();
		const quickPick = store.add(this.quickInputService.createQuickPick<AccountActionQuickPickItem>());

		quickPick.title = localize('manageAccount', "Manage '{0}'", accountLabel);
		quickPick.placeholder = localize('selectAction', "Select an action");
		quickPick.buttons = [this.quickInputService.backButton];

		const items: AccountActionQuickPickItem[] = [{
			label: localize('manageTrustedExtensions', "Manage Trusted Extensions"),
			action: () => this.commandService.executeCommand('_manageTrustedExtensionsForAccount', { providerId, accountLabel })
		}];

		if (canUseMcp) {
			items.push({
				label: localize('manageTrustedMCPServers', "Manage Trusted MCP Servers"),
				action: () => this.commandService.executeCommand('_manageTrustedMCPServersForAccount', { providerId, accountLabel })
			});
		}

		if (mayShowSignOut) {
			items.push({
				label: localize('signOut', "Sign Out"),
				action: () => this.commandService.executeCommand('_signOutOfAccount', { providerId, accountLabel })
			});
		}

		quickPick.items = items;

		store.add(quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (selected) {
				quickPick.hide();
				selected.action();
			}
		}));

		store.add(quickPick.onDidTriggerButton((button) => {
			if (button === this.quickInputService.backButton) {
				// Nobody awaits the back button: a failure (for example a stored session that cannot be read) is shown, not dropped.
				void runAtBoundary(() => this.run(), error => {
					this.logService.error('Could not list the accounts to manage.', error);
					this.notificationService.error(localize('manageAccountsFailed', "Could not list the accounts to manage. See the log for details."));
				});
			}
		}));

		store.add(quickPick.onDidHide(() => store.dispose()));

		quickPick.show();
	}
}
