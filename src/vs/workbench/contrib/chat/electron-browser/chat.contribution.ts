/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ILifecycleService, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';
import { IChatWidgetService } from '../browser/chat.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { ChatConfiguration } from '../common/constants.js';
import { IChatService } from '../common/chatService/chatService.js';
import { KeywordActivationContribution } from './actions/voiceChatActions.js';
import { NativeBuiltinToolsContribution } from './builtInTools/tools.js';

class ChatSuspendThrottlingHandler extends Disposable {

	static readonly ID = 'workbench.contrib.chatSuspendThrottlingHandler';

	constructor(
		@INativeHostService nativeHostService: INativeHostService,
		@IChatService chatService: IChatService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super();

		if (!configurationService.getValue<boolean>(ChatConfiguration.SuspendThrottling)) {
			return;
		}

		this._register(autorun(reader => {
			const running = chatService.requestInProgressObs.read(reader);

			// When a chat request is in progress, we must ensure that background
			// throttling is not applied so that the chat session can continue
			// even when the window is not in focus.
			nativeHostService.setBackgroundThrottling(!running);
		}));
	}
}

class ChatLifecycleHandler extends Disposable {

	static readonly ID = 'workbench.contrib.chatLifecycleHandler';

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IChatService private readonly chatService: IChatService,
		@IDialogService private readonly dialogService: IDialogService,
		@IChatWidgetService private readonly widgetService: IChatWidgetService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
	) {
		super();

		this._register(lifecycleService.onBeforeShutdown(e => {
			e.veto(this.shouldVetoShutdown(e.reason), 'veto.chat');
		}));

		this._register(extensionService.onWillStop(e => {
			e.veto(this.chatService.requestInProgressObs.get(), localize('chatRequestInProgress', "A chat request is in progress."));
		}));
	}

	private shouldVetoShutdown(reason: ShutdownReason): boolean | Promise<boolean> {
		const running = this.chatService.requestInProgressObs.read(undefined);
		if (!running) {
			return false;
		}

		if (ChatContextKeys.skipChatRequestInProgressMessage.getValue(this.contextKeyService) === true) {
			return false;
		}

		return this.doShouldVetoShutdown(reason);
	}

	private async doShouldVetoShutdown(reason: ShutdownReason): Promise<boolean> {

		this.widgetService.revealWidget();

		let message: string;
		let detail: string;
		switch (reason) {
			case ShutdownReason.CLOSE:
				message = localize('closeTheWindow.message', "A chat request is in progress. Are you sure you want to close the window?");
				detail = localize('closeTheWindow.detail', "The chat request will stop if you close the window.");
				break;
			case ShutdownReason.LOAD:
				message = localize('changeWorkspace.message', "A chat request is in progress. Are you sure you want to change the workspace?");
				detail = localize('changeWorkspace.detail', "The chat request will stop if you change the workspace.");
				break;
			case ShutdownReason.RELOAD:
				message = localize('reloadTheWindow.message', "A chat request is in progress. Are you sure you want to reload the window?");
				detail = localize('reloadTheWindow.detail', "The chat request will stop if you reload the window.");
				break;
			default:
				message = isMacintosh ? localize('quit.message', "A chat request is in progress. Are you sure you want to quit?") : localize('exit.message', "A chat request is in progress. Are you sure you want to exit?");
				detail = isMacintosh ? localize('quit.detail', "The chat request will stop if you quit.") : localize('exit.detail', "The chat request will stop if you exit.");
				break;
		}

		const result = await this.dialogService.confirm({ message, detail });

		return !result.confirmed;
	}
}


registerWorkbenchContribution2(KeywordActivationContribution.ID, KeywordActivationContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(NativeBuiltinToolsContribution.ID, NativeBuiltinToolsContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatSuspendThrottlingHandler.ID, ChatSuspendThrottlingHandler, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatLifecycleHandler.ID, ChatLifecycleHandler, WorkbenchPhase.AfterRestored);
