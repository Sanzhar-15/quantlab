/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, markAsSingleton, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ChatEntitlement, ChatEntitlementContext, ChatEntitlementRequests, ChatEntitlementService, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { EnablementState, IWorkbenchExtensionEnablementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IExtension, IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { ChatViewContainerId } from '../chat.js';
import { chatViewsWelcomeRegistry } from '../viewsWelcome/chatViewsWelcome.js';
import { ChatSetupController } from './chatSetupController.js';
import { AINewSymbolNamesProvider, ChatCodeActionsProvider, SetupAgent } from './chatSetupProviders.js';

const defaultChat = {
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	manageOveragesUrl: product.defaultChatAgent?.manageOverageUrl ?? '',
	upgradePlanUrl: product.defaultChatAgent?.upgradePlanUrl ?? '',
	completionsRefreshTokenCommand: product.defaultChatAgent?.completionsRefreshTokenCommand ?? '',
	chatRefreshTokenCommand: product.defaultChatAgent?.chatRefreshTokenCommand ?? '',
};

export class ChatSetupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatSetup';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService chatEntitlementService: ChatEntitlementService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();

		const context = chatEntitlementService.context?.value;
		const requests = chatEntitlementService.requests?.value;
		if (!context || !requests) {
			return; // disabled
		}

		const controller = new Lazy(() => this._register(this.instantiationService.createInstance(ChatSetupController, context, requests)));

		this.registerSetupAgents(context, controller);
		this.registerActions(context, requests, controller);
		this.checkExtensionInstallation(context);
	}

	private registerSetupAgents(context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): void {
		const defaultAgentDisposables = markAsSingleton(new MutableDisposable()); // prevents flicker on window reload
		const vscodeAgentDisposables = markAsSingleton(new MutableDisposable());

		const renameProviderDisposables = markAsSingleton(new MutableDisposable());
		const codeActionsProviderDisposables = markAsSingleton(new MutableDisposable());

		const updateRegistration = () => {

			// Agent + Tools
			{
				if (!context.state.hidden && !context.state.disabled) {

					// Default Agents (always, even if installed to allow for speedy requests right on startup)
					if (!defaultAgentDisposables.value) {
						const disposables = defaultAgentDisposables.value = new DisposableStore();

						// Panel Agents
						const panelAgentDisposables = disposables.add(new DisposableStore());
						for (const mode of [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent]) {
							const { agent, disposable } = SetupAgent.registerDefaultAgents(this.instantiationService, ChatAgentLocation.Chat, mode, context, controller);
							panelAgentDisposables.add(disposable);
							panelAgentDisposables.add(agent.onUnresolvableError(() => {
								const panelAgentHasGuidance = chatViewsWelcomeRegistry.get().some(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
								if (panelAgentHasGuidance) {
									// An unresolvable error from our agent registrations means that
									// Chat is unhealthy for some reason. We clear our panel
									// registration to give Chat a chance to show a custom message
									// to the user from the views and stop pretending as if there was
									// a functional agent.
									this.logService.error('[chat setup] Unresolvable error from Chat agent registration, clearing registration.');
									panelAgentDisposables.dispose();
								}
							}));
						}

						// Inline Agents
						disposables.add(SetupAgent.registerDefaultAgents(this.instantiationService, ChatAgentLocation.Terminal, undefined, context, controller).disposable);
						disposables.add(SetupAgent.registerDefaultAgents(this.instantiationService, ChatAgentLocation.Notebook, undefined, context, controller).disposable);
						disposables.add(SetupAgent.registerDefaultAgents(this.instantiationService, ChatAgentLocation.EditorInline, undefined, context, controller).disposable);
					}

					// Built-In Agent + Tool (unless installed, signed-in and enabled)
					if ((!context.state.installed || context.state.entitlement === ChatEntitlement.Unknown || context.state.entitlement === ChatEntitlement.Unresolved) && !vscodeAgentDisposables.value) {
						const disposables = vscodeAgentDisposables.value = new DisposableStore();
						disposables.add(SetupAgent.registerBuiltInAgents(this.instantiationService, context, controller));
					}
				} else {
					defaultAgentDisposables.clear();
					vscodeAgentDisposables.clear();
				}

				if (context.state.installed && !context.state.disabled) {
					vscodeAgentDisposables.clear(); // we need to do this to prevent showing duplicate agent/tool entries in the list
				}
			}

			// Rename Provider
			{
				if (!context.state.installed && !context.state.hidden && !context.state.disabled) {
					if (!renameProviderDisposables.value) {
						renameProviderDisposables.value = AINewSymbolNamesProvider.registerProvider(this.instantiationService, context, controller);
					}
				} else {
					renameProviderDisposables.clear();
				}
			}

			// Code Actions Provider
			{
				if (!context.state.installed && !context.state.hidden && !context.state.disabled) {
					if (!codeActionsProviderDisposables.value) {
						codeActionsProviderDisposables.value = ChatCodeActionsProvider.registerProvider(this.instantiationService);
					}
				} else {
					codeActionsProviderDisposables.clear();
				}
			}
		};

		this._register(Event.runAndSubscribe(context.onDidChange, () => updateRegistration()));
	}

	private registerActions(context: ChatEntitlementContext, requests: ChatEntitlementRequests, controller: Lazy<ChatSetupController>): void {

		//#region Global Chat Setup Actions

		//#endregion

		//#region Editor Context Menu

		function registerGenerateCodeCommand(coreCommand: 'chat.internal.explain' | 'chat.internal.fix' | 'chat.internal.review' | 'chat.internal.generateDocs' | 'chat.internal.generateTests', actualCommand: string): void {
		}
		registerGenerateCodeCommand('chat.internal.explain', 'github.copilot.chat.explain');
		registerGenerateCodeCommand('chat.internal.fix', 'github.copilot.chat.fix');
		registerGenerateCodeCommand('chat.internal.review', 'github.copilot.chat.review');
		registerGenerateCodeCommand('chat.internal.generateDocs', 'github.copilot.chat.generateDocs');
		registerGenerateCodeCommand('chat.internal.generateTests', 'github.copilot.chat.generateTests');
	}

	private async checkExtensionInstallation(context: ChatEntitlementContext): Promise<void> {

		// When developing extensions, await registration and then check
		if (this.environmentService.isExtensionDevelopment) {
			await this.extensionService.whenInstalledExtensionsRegistered();
			if (this.extensionService.extensions.find(ext => ExtensionIdentifier.equals(ext.identifier, defaultChat.chatExtensionId))) {
				context.update({ installed: true, disabled: false, untrusted: false });
				return;
			}
		}

		// Await extensions to be ready to be queried
		await this.extensionsWorkbenchService.queryLocal();

		// Listen to extensions change and process extensions once
		this._register(Event.runAndSubscribe<IExtension | undefined>(this.extensionsWorkbenchService.onChange, e => {
			if (e && !ExtensionIdentifier.equals(e.identifier.id, defaultChat.chatExtensionId)) {
				return; // unrelated event
			}

			const defaultChatExtension = this.extensionsWorkbenchService.local.find(value => ExtensionIdentifier.equals(value.identifier.id, defaultChat.chatExtensionId));
			const installed = !!defaultChatExtension?.local;

			let disabled: boolean;
			let untrusted = false;
			if (installed) {
				disabled = !this.extensionEnablementService.isEnabled(defaultChatExtension.local);
				if (disabled) {
					const state = this.extensionEnablementService.getEnablementState(defaultChatExtension.local);
					if (state === EnablementState.DisabledByTrustRequirement) {
						disabled = false; // not disabled by user choice but
						untrusted = true; // by missing workspace trust
					}
				}
			} else {
				disabled = false;
			}

			context.update({ installed, disabled, untrusted });
		}));
	}
}

export class ChatTeardownContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatTeardown';

	static readonly CHAT_DISABLED_CONFIGURATION_KEY = 'chat.disableAIFeatures';

	constructor(
		@IChatEntitlementService chatEntitlementService: ChatEntitlementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
		super();

		const context = chatEntitlementService.context?.value;
		if (!context) {
			return; // disabled
		}

		this.registerListeners();

		this.handleChatDisabled(false);
	}

	private handleChatDisabled(fromEvent: boolean): void {
		const chatDisabled = this.configurationService.inspect(ChatTeardownContribution.CHAT_DISABLED_CONFIGURATION_KEY);
		if (chatDisabled.value === true) {
			this.maybeEnableOrDisableExtension(typeof chatDisabled.workspaceValue === 'boolean' ? EnablementState.DisabledWorkspace : EnablementState.DisabledGlobally);
			if (fromEvent) {
				this.maybeHideAuxiliaryBar();
			}
		} else if (chatDisabled.value === false && fromEvent /* do not enable extensions unless its an explicit settings change */) {
			this.maybeEnableOrDisableExtension(typeof chatDisabled.workspaceValue === 'boolean' ? EnablementState.EnabledWorkspace : EnablementState.EnabledGlobally);
		}
	}

	private async registerListeners(): Promise<void> {

		// Configuration changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(ChatTeardownContribution.CHAT_DISABLED_CONFIGURATION_KEY)) {
				return;
			}

			this.handleChatDisabled(true);
		}));

		// Extension installation
		await this.extensionsWorkbenchService.queryLocal();
		this._register(this.extensionsWorkbenchService.onChange(e => {
			if (e && !ExtensionIdentifier.equals(e.identifier.id, defaultChat.chatExtensionId)) {
				return; // unrelated event
			}

			const defaultChatExtension = this.extensionsWorkbenchService.local.find(value => ExtensionIdentifier.equals(value.identifier.id, defaultChat.chatExtensionId));
			if (defaultChatExtension?.local && this.extensionEnablementService.isEnabled(defaultChatExtension.local)) {
				this.configurationService.updateValue(ChatTeardownContribution.CHAT_DISABLED_CONFIGURATION_KEY, false);
			}
		}));
	}

	private async maybeEnableOrDisableExtension(state: EnablementState.EnabledGlobally | EnablementState.EnabledWorkspace | EnablementState.DisabledGlobally | EnablementState.DisabledWorkspace): Promise<void> {
		const defaultChatExtension = this.extensionsWorkbenchService.local.find(value => ExtensionIdentifier.equals(value.identifier.id, defaultChat.chatExtensionId));
		if (!defaultChatExtension) {
			return;
		}

		await this.extensionsWorkbenchService.setEnablement([defaultChatExtension], state);
		await this.extensionsWorkbenchService.updateRunningExtensions(state === EnablementState.EnabledGlobally || state === EnablementState.EnabledWorkspace ? localize('restartExtensionHost.reason.enable', "Enabling AI features") : localize('restartExtensionHost.reason.disable', "Disabling AI features"));
	}

	private maybeHideAuxiliaryBar(): void {
		const activeContainers = this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar).filter(
			container => this.viewDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0
		);
		if (
			(activeContainers.length === 0) ||  													// chat view is already gone but we know it was there before
			(activeContainers.length === 1 && activeContainers.at(0)?.id === ChatViewContainerId) 	// chat view is the only view which is going to go away
		) {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART); // hide if there are no views in the secondary sidebar
		}
	}
}

//#endregion

export function refreshTokens(commandService: ICommandService): void {
	// ugly, but we need to signal to the extension that entitlements changed
	commandService.executeCommand(defaultChat.completionsRefreshTokenCommand);
	commandService.executeCommand(defaultChat.chatRefreshTokenCommand);
}
