/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { MarkdownString, isMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { PolicyCategory } from '../../../../base/common/policy.js';
import * as nls from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { McpAccessValue, McpAutoStartValue, mcpAccessConfig, mcpAutoStartConfig, mcpGalleryServiceUrlConfig } from '../../../../platform/mcp/common/mcpManagement.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IWorkbenchAssignmentService } from '../../../services/assignment/common/assignmentService.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IEditorResolverService } from '../../../services/editor/common/editorResolverService.js';
import { allDiscoverySources, mcpDiscoverySection } from '../../mcp/common/mcpConfiguration.js';
import { ChatAgentNameService, ChatAgentService, IChatAgentNameService, IChatAgentService } from '../common/participants/chatAgents.js';
import { CodeMapperService, ICodeMapperService } from '../common/editing/chatCodeMapperService.js';
import '../common/widget/chatColors.js';
import { IChatEditingService } from '../common/editing/chatEditingService.js';
import { IChatLayoutService } from '../common/widget/chatLayoutService.js';
import { ChatModeService, IChatMode, IChatModeService } from '../common/chatModes.js';
import { ChatResponseResourceFileSystemProvider } from '../common/widget/chatResponseResourceFileSystemProvider.js';
import { IChatService } from '../common/chatService/chatService.js';
import { ChatService } from '../common/chatService/chatServiceImpl.js';
import { IChatSessionsService } from '../common/chatSessionsService.js';
import { ChatSlashCommandService, IChatSlashCommandService } from '../common/participants/chatSlashCommands.js';
import { ChatTodoListService, IChatTodoListService } from '../common/tools/chatTodoListService.js';
import { ChatTransferService, IChatTransferService } from '../common/model/chatTransferService.js';
import { IChatVariablesService } from '../common/attachments/chatVariables.js';
import { ChatWidgetHistoryService, IChatWidgetHistoryService } from '../common/widget/chatWidgetHistoryService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../common/constants.js';
import { ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService } from '../common/ignoredFiles.js';
import { ILanguageModelsService, LanguageModelsService } from '../common/languageModels.js';
import { ILanguageModelStatsService, LanguageModelStatsService } from '../common/languageModelStats.js';
import { ILanguageModelToolsConfirmationService } from '../common/tools/languageModelToolsConfirmationService.js';
import { ILanguageModelToolsService } from '../common/tools/languageModelToolsService.js';
import { ChatPromptFilesExtensionPointHandler } from '../common/promptSyntax/chatPromptFilesContribution.js';
import { PromptLanguageFeaturesProvider } from '../common/promptSyntax/promptFileContributions.js';
import { IPromptsService } from '../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../common/promptSyntax/service/promptsServiceImpl.js';
import { LanguageModelToolsExtensionPointHandler } from '../common/tools/languageModelToolsContribution.js';
import { BuiltinToolsContribution } from '../common/tools/builtinTools/tools.js';
import { IVoiceChatService, VoiceChatService } from '../common/voiceChatService.js';
import { registerChatAccessibilityActions } from './actions/chatAccessibilityActions.js';
import { ACTION_ID_NEW_CHAT, CopilotTitleBarMenuRendering, registerChatActions } from './actions/chatActions.js';
import { CodeBlockActionRendering, registerChatCodeBlockActions, registerChatCodeCompareBlockActions } from './actions/chatCodeblockActions.js';
import { ChatContextContributions } from './actions/chatContext.js';
import { registerChatContextActions } from './actions/chatContextActions.js';
import { ContinueChatInSessionActionRendering } from './actions/chatContinueInAction.js';
import { registerChatCopyActions } from './actions/chatCopyActions.js';
import { registerChatDeveloperActions } from './actions/chatDeveloperActions.js';
import { ChatSubmitAction, registerChatExecuteActions } from './actions/chatExecuteActions.js';
import { registerChatFileTreeActions } from './actions/chatFileTreeActions.js';
import { ChatGettingStartedContribution } from './actions/chatGettingStarted.js';
import { registerChatExportActions } from './actions/chatImportExport.js';
import { registerLanguageModelActions } from './actions/chatLanguageModelActions.js';
import { registerMoveActions } from './actions/chatMoveActions.js';
import { registerNewChatActions } from './actions/chatNewActions.js';
import { registerChatPromptNavigationActions } from './actions/chatPromptNavigationActions.js';
import { registerQuickChatActions } from './actions/chatQuickInputActions.js';
import { ChatAgentRecommendation } from './actions/chatAgentRecommendationActions.js';
import { registerChatTitleActions } from './actions/chatTitleActions.js';
import { registerChatElicitationActions } from './actions/chatElicitationActions.js';
import { registerChatToolActions } from './actions/chatToolActions.js';
import { ChatTransferContribution } from './actions/chatTransfer.js';
import './agentSessions/agentSessions.contribution.js';
import { IChatAccessibilityService, IChatCodeBlockContextProviderService, IChatWidgetService, IQuickChatService } from './chat.js';
import { ChatAccessibilityService } from './accessibility/chatAccessibilityService.js';
import './attachments/chatAttachmentModel.js';
import './widget/input/chatStatusWidget.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from './attachments/chatAttachmentResolveService.js';
import { ChatMarkdownAnchorService, IChatMarkdownAnchorService } from './widget/chatContentParts/chatMarkdownAnchorService.js';
import { ChatContextPickService, IChatContextPickService } from './attachments/chatContextPickService.js';
import { ChatEditingEditorAccessibility } from './chatEditing/chatEditingEditorAccessibility.js';
import { registerChatEditorActions } from './chatEditing/chatEditingEditorActions.js';
import { ChatEditingEditorContextKeys } from './chatEditing/chatEditingEditorContextKeys.js';
import { ChatEditingEditorOverlay } from './chatEditing/chatEditingEditorOverlay.js';
import { ChatEditingService } from './chatEditing/chatEditingServiceImpl.js';
import { ChatEditingNotebookFileSystemProviderContrib } from './chatEditing/notebook/chatEditingNotebookFileSystemProvider.js';
import { SimpleBrowserOverlay } from './attachments/simpleBrowserEditorOverlay.js';
import { ChatEditorInput, ChatEditorInputSerializer } from './widgetHosts/editor/chatEditorInput.js';
import { ChatLayoutService } from './widget/chatLayoutService.js';
import './chatManagement/chatManagement.contribution.js';
import { agentSlashCommandToMarkdown, agentToMarkdown } from './widget/chatContentParts/chatMarkdownDecorationsRenderer.js';
import { ChatOutputRendererService, IChatOutputRendererService } from './chatOutputItemRenderer.js';
import { ChatCompatibilityNotifier, ChatExtensionPointHandler } from './chatParticipant.contribution.js';
import { QuickChatService } from './widgetHosts/chatQuick.js';
import { ChatSetupContribution, ChatTeardownContribution } from './chatSetup/chatSetupContributions.js';
import { ChatStatusBarEntry } from './chatStatus/chatStatusEntry.js';
import { ChatVariablesService } from './attachments/chatVariables.js';
import { ChatWidget } from './widget/chatWidget.js';
import { ChatCodeBlockContextProviderService } from './codeBlockContextProviderService.js';
import { ChatDynamicVariableModel } from './attachments/chatDynamicVariables.js';
import { ChatImplicitContextContribution } from './attachments/chatImplicitContext.js';
import './widget/input/editor/chatInputCompletions.js';
import './widget/input/editor/chatInputEditorContrib.js';
import './widget/input/editor/chatInputEditorHover.js';
import { ChatRelatedFilesContribution } from './attachments/chatInputRelatedFilesContrib.js';
import { LanguageModelToolsConfirmationService } from './tools/languageModelToolsConfirmationService.js';
import { LanguageModelToolsService } from './tools/languageModelToolsService.js';
import './promptSyntax/promptCodingAgentActionContribution.js';
import './promptSyntax/promptToolsCodeLensProvider.js';
import { PromptUrlHandler } from './promptSyntax/promptUrlHandler.js';
import { UserToolSetsContributions } from './tools/toolSetsContribution.js';
import { ChatViewsWelcomeHandler } from './viewsWelcome/chatViewsWelcomeHandler.js';
import { ChatWidgetService } from './widget/chatWidgetService.js';
import { ChatWindowNotifier } from './chatWindowNotifier.js';

const toolReferenceNameEnumValues: string[] = [];
const toolReferenceNameEnumDescriptions: string[] = [];

// Register configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatSidebar',
	title: nls.localize('interactiveSessionConfigurationTitle', "Chat"),
	type: 'object',
	properties: {
		'chat.commandCenter.enabled': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.commandCenter.enabled', "Controls whether the command center shows a menu for actions to control chat (requires {0}).", '`#window.commandCenter#`'),
			default: true
		},
		[mcpAccessConfig]: {
			type: 'string',
			description: nls.localize('chat.mcp.access', "Controls access to installed Model Context Protocol servers."),
			enum: [
				McpAccessValue.None,
				McpAccessValue.Registry,
				McpAccessValue.All
			],
			enumDescriptions: [
				nls.localize('chat.mcp.access.none', "No access to MCP servers."),
				nls.localize('chat.mcp.access.registry', "Allows access to MCP servers installed from the registry that VS Code is connected to."),
				nls.localize('chat.mcp.access.any', "Allow access to any installed MCP server.")
			],
			default: McpAccessValue.All,
			policy: {
				name: 'ChatMCP',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.99',
				value: (account) => {
					if (account.mcp === false) {
						return McpAccessValue.None;
					}
					if (account.mcpAccess === 'registry_only') {
						return McpAccessValue.Registry;
					}
					return undefined;
				},
				localization: {
					description: {
						key: 'chat.mcp.access',
						value: nls.localize('chat.mcp.access', "Controls access to installed Model Context Protocol servers.")
					},
					enumDescriptions: [
						{
							key: 'chat.mcp.access.none', value: nls.localize('chat.mcp.access.none', "No access to MCP servers."),
						},
						{
							key: 'chat.mcp.access.registry', value: nls.localize('chat.mcp.access.registry', "Allows access to MCP servers installed from the registry that VS Code is connected to."),
						},
						{
							key: 'chat.mcp.access.any', value: nls.localize('chat.mcp.access.any', "Allow access to any installed MCP server.")
						}
					]
				},
			}
		},
		[mcpAutoStartConfig]: {
			type: 'string',
			description: nls.localize('chat.mcp.autostart', "Controls whether MCP servers should be automatically started when the chat messages are submitted."),
			default: McpAutoStartValue.NewAndOutdated,
			enum: [
				McpAutoStartValue.Never,
				McpAutoStartValue.OnlyNew,
				McpAutoStartValue.NewAndOutdated
			],
			enumDescriptions: [
				nls.localize('chat.mcp.autostart.never', "Never automatically start MCP servers."),
				nls.localize('chat.mcp.autostart.onlyNew', "Only automatically start new MCP servers that have never been run."),
				nls.localize('chat.mcp.autostart.newAndOutdated', "Automatically start new and outdated MCP servers that are not yet running.")
			],
			tags: ['experimental'],
		},
		[mcpGalleryServiceUrlConfig]: {
			type: 'string',
			description: nls.localize('mcp.gallery.serviceUrl', "Configure the MCP Gallery service URL to connect to"),
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices', 'advanced'],
			included: false,
			policy: {
				name: 'McpGalleryServiceUrl',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.101',
				value: (account) => account.mcpRegistryUrl,
				localization: {
					description: {
						key: 'mcp.gallery.serviceUrl',
						value: nls.localize('mcp.gallery.serviceUrl', "Configure the MCP Gallery service URL to connect to"),
					}
				}
			},
		},
		'chat.disableAIFeatures': {
			type: 'boolean',
			description: nls.localize('chat.disableAIFeatures', "Disable and hide built-in AI features provided by GitHub Copilot, including chat and inline suggestions."),
			default: false,
			scope: ConfigurationScope.WINDOW
		},
		'chat.allowAnonymousAccess': { // TODO@bpasero remove me eventually
			type: 'boolean',
			description: nls.localize('chat.allowAnonymousAccess', "Controls whether anonymous access is allowed in chat."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		'chat.extensionUnification.enabled': {
			type: 'boolean',
			description: nls.localize('chat.extensionUnification.enabled', "Enables the unification of GitHub Copilot extensions. When enabled, all GitHub Copilot functionality is served from the GitHub Copilot Chat extension. When disabled, the GitHub Copilot and GitHub Copilot Chat extensions operate independently."),
			default: true,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
	}
});
Registry.as<IConfigurationMigrationRegistry>(Extensions.ConfigurationMigration).registerConfigurationMigrations([
	{
		key: 'chat.experimental.detectParticipant.enabled',
		migrateFn: (value, _accessor) => ([
			['chat.experimental.detectParticipant.enabled', { value: undefined }],
			['chat.detectParticipant.enabled', { value: value !== false }]
		])
	},
	{
		key: 'chat.useClaudeSkills',
		migrateFn: (value, _accessor) => ([
			['chat.useClaudeSkills', { value: undefined }],
			['chat.useAgentSkills', { value }]
		])
	},
	{
		key: mcpDiscoverySection,
		migrateFn: (value: unknown) => {
			if (typeof value === 'boolean') {
				return { value: Object.fromEntries(allDiscoverySources.map(k => [k, value])) };
			}

			return { value };
		}
	},
]);

class ChatResolverContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chatResolver';

	private readonly _editorRegistrations = this._register(new DisposableMap<string>());

	constructor(
		@IChatSessionsService chatSessionsService: IChatSessionsService,
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._registerEditor(Schemas.vscodeChatEditor);
		this._registerEditor(Schemas.vscodeLocalChatSession);

		this._register(chatSessionsService.onDidChangeContentProviderSchemes((e) => {
			for (const scheme of e.added) {
				this._registerEditor(scheme);
			}
			for (const scheme of e.removed) {
				this._editorRegistrations.deleteAndDispose(scheme);
			}
		}));

		for (const scheme of chatSessionsService.getContentProviderSchemes()) {
			this._registerEditor(scheme);
		}
	}

	private _registerEditor(scheme: string): void {
	}
}

class ChatAgentSettingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatAgentSetting';

	constructor(
		@IWorkbenchAssignmentService private readonly experimentService: IWorkbenchAssignmentService,
		@IChatEntitlementService private readonly entitlementService: IChatEntitlementService,
	) {
		super();
		this.registerMaxRequestsSetting();
	}


	private registerMaxRequestsSetting(): void {
		let lastNode: IConfigurationNode | undefined;
		const registerMaxRequestsSetting = () => {
			const treatmentId = this.entitlementService.entitlement === ChatEntitlement.Free ?
				'chatAgentMaxRequestsFree' :
				'chatAgentMaxRequestsPro';
			this.experimentService.getTreatment<number>(treatmentId).then((value) => {
				const defaultValue = value ?? (this.entitlementService.entitlement === ChatEntitlement.Free ? 25 : 25);
				const node: IConfigurationNode = {
					id: 'chatSidebar',
					title: nls.localize('interactiveSessionConfigurationTitle', "Chat"),
					type: 'object',
					properties: {
						'chat.agent.maxRequests': {
							type: 'number',
							markdownDescription: nls.localize('chat.agent.maxRequests', "The maximum number of requests to allow per-turn when using an agent. When the limit is reached, will ask to confirm to continue."),
							default: defaultValue,
						},
					}
				};
				configurationRegistry.updateConfigurations({ remove: lastNode ? [lastNode] : [], add: [node] });
				lastNode = node;
			});
		};
		this._register(Event.runAndSubscribe(Event.debounce(this.entitlementService.onDidChangeEntitlement, () => { }, 1000), () => registerMaxRequestsSetting()));
	}
}


/**
 * Workbench contribution to register actions for custom chat modes via events
 */
class ChatAgentActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatAgentActions';

	private readonly _modeActionDisposables = new DisposableMap<string>();

	constructor(
		@IChatModeService private readonly chatModeService: IChatModeService,
	) {
		super();
		this._store.add(this._modeActionDisposables);

		// Register actions for existing custom modes
		const { custom } = this.chatModeService.getModes();
		for (const mode of custom) {
			this._registerModeAction(mode);
		}

		// Listen for custom mode changes by tracking snapshots
		this._register(this.chatModeService.onDidChangeChatModes(() => {
			const { custom } = this.chatModeService.getModes();
			const currentModeIds = new Set<string>();
			const currentModeNames = new Map<string, string>();

			for (const mode of custom) {
				const modeName = mode.name.get();
				if (currentModeNames.has(modeName)) {
					// If there is a name collision, the later one in the list wins
					currentModeIds.delete(currentModeNames.get(modeName)!);
				}

				currentModeNames.set(modeName, mode.id);
				currentModeIds.add(mode.id);
			}

			// Remove modes that no longer exist and those replaced by modes later in the list with same name
			for (const modeId of this._modeActionDisposables.keys()) {
				if (!currentModeIds.has(modeId)) {
					this._modeActionDisposables.deleteAndDispose(modeId);
				}
			}

			// Register new modes
			for (const mode of custom) {
				if (currentModeIds.has(mode.id) && !this._modeActionDisposables.has(mode.id)) {
					this._registerModeAction(mode);
				}
			}
		}));
	}

	private _registerModeAction(mode: IChatMode): void {
	}
}

class ToolReferenceNamesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.toolReferenceNames';

	constructor(
		@ILanguageModelToolsService private readonly _languageModelToolsService: ILanguageModelToolsService,
	) {
		super();
		this._updateToolReferenceNames();
		this._register(this._languageModelToolsService.onDidChangeTools(() => this._updateToolReferenceNames()));
	}

	private _updateToolReferenceNames(): void {
		const tools =
			Array.from(this._languageModelToolsService.getTools())
				.filter((tool): tool is typeof tool & { toolReferenceName: string } => typeof tool.toolReferenceName === 'string')
				.sort((a, b) => a.toolReferenceName.localeCompare(b.toolReferenceName));
		toolReferenceNameEnumValues.length = 0;
		toolReferenceNameEnumDescriptions.length = 0;
		for (const tool of tools) {
			toolReferenceNameEnumValues.push(tool.toolReferenceName);
			toolReferenceNameEnumDescriptions.push(nls.localize(
				'chat.toolReferenceName.description',
				"{0} - {1}",
				tool.toolReferenceName,
				tool.userDescription || tool.displayName
			));
		}
		configurationRegistry.notifyConfigurationSchemaUpdated({
			id: 'chatSidebar',
			properties: {
				[ChatConfiguration.EligibleForAutoApproval]: {}
			}
		});
	}
}

class ChatSlashStaticSlashCommandsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chatSlashStaticSlashCommands';

	constructor(
		@IChatSlashCommandService slashCommandService: IChatSlashCommandService,
		@ICommandService commandService: ICommandService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._store.add(slashCommandService.registerSlashCommand({
			command: 'clear',
			detail: nls.localize('clear', "Start a new chat"),
			sortText: 'z2_clear',
			executeImmediately: true,
			locations: [ChatAgentLocation.Chat]
		}, async () => {
			commandService.executeCommand(ACTION_ID_NEW_CHAT);
		}));
		this._store.add(slashCommandService.registerSlashCommand({
			command: 'help',
			detail: '',
			sortText: 'z1_help',
			executeImmediately: true,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask]
		}, async (prompt, progress, _history, _location, sessionResource) => {
			const defaultAgent = chatAgentService.getDefaultAgent(ChatAgentLocation.Chat);
			const agents = chatAgentService.getAgents();

			// Report prefix
			if (defaultAgent?.metadata.helpTextPrefix) {
				if (isMarkdownString(defaultAgent.metadata.helpTextPrefix)) {
					progress.report({ content: defaultAgent.metadata.helpTextPrefix, kind: 'markdownContent' });
				} else {
					progress.report({ content: new MarkdownString(defaultAgent.metadata.helpTextPrefix), kind: 'markdownContent' });
				}
				progress.report({ content: new MarkdownString('\n\n'), kind: 'markdownContent' });
			}

			// Report agent list
			const agentText = (await Promise.all(agents
				.filter(a => !a.isDefault && !a.isCore)
				.filter(a => a.locations.includes(ChatAgentLocation.Chat))
				.map(async a => {
					const description = a.description ? `- ${a.description}` : '';
					const agentMarkdown = instantiationService.invokeFunction(accessor => agentToMarkdown(a, sessionResource, true, accessor));
					const agentLine = `- ${agentMarkdown} ${description}`;
					const commandText = a.slashCommands.map(c => {
						const description = c.description ? `- ${c.description}` : '';
						return `\t* ${agentSlashCommandToMarkdown(a, c, sessionResource)} ${description}`;
					}).join('\n');

					return (agentLine + '\n' + commandText).trim();
				}))).join('\n');
			progress.report({ content: new MarkdownString(agentText, { isTrusted: { enabledCommands: [ChatSubmitAction.ID] } }), kind: 'markdownContent' });

			// Report help text ending
			if (defaultAgent?.metadata.helpTextPostfix) {
				progress.report({ content: new MarkdownString('\n\n'), kind: 'markdownContent' });
				if (isMarkdownString(defaultAgent.metadata.helpTextPostfix)) {
					progress.report({ content: defaultAgent.metadata.helpTextPostfix, kind: 'markdownContent' });
				} else {
					progress.report({ content: new MarkdownString(defaultAgent.metadata.helpTextPostfix), kind: 'markdownContent' });
				}
			}

			// Without this, the response will be done before it renders and so it will not stream. This ensures that if the response starts
			// rendering during the next 200ms, then it will be streamed. Once it starts streaming, the whole response streams even after
			// it has received all response data has been received.
			await timeout(200);
		}));
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ChatEditorInput.TypeID, ChatEditorInputSerializer);

registerWorkbenchContribution2(ChatResolverContribution.ID, ChatResolverContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ChatSlashStaticSlashCommandsContribution.ID, ChatSlashStaticSlashCommandsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatExtensionPointHandler.ID, ChatExtensionPointHandler, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(LanguageModelToolsExtensionPointHandler.ID, LanguageModelToolsExtensionPointHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatPromptFilesExtensionPointHandler.ID, ChatPromptFilesExtensionPointHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatCompatibilityNotifier.ID, ChatCompatibilityNotifier, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(CopilotTitleBarMenuRendering.ID, CopilotTitleBarMenuRendering, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(CodeBlockActionRendering.ID, CodeBlockActionRendering, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ContinueChatInSessionActionRendering.ID, ContinueChatInSessionActionRendering, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatImplicitContextContribution.ID, ChatImplicitContextContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatRelatedFilesContribution.ID, ChatRelatedFilesContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatViewsWelcomeHandler.ID, ChatViewsWelcomeHandler, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ChatGettingStartedContribution.ID, ChatGettingStartedContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatSetupContribution.ID, ChatSetupContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatTeardownContribution.ID, ChatTeardownContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatStatusBarEntry.ID, ChatStatusBarEntry, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(BuiltinToolsContribution.ID, BuiltinToolsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatAgentSettingContribution.ID, ChatAgentSettingContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatAgentActionsContribution.ID, ChatAgentActionsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ToolReferenceNamesContribution.ID, ToolReferenceNamesContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatAgentRecommendation.ID, ChatAgentRecommendation, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatEditingEditorAccessibility.ID, ChatEditingEditorAccessibility, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatEditingEditorOverlay.ID, ChatEditingEditorOverlay, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SimpleBrowserOverlay.ID, SimpleBrowserOverlay, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatEditingEditorContextKeys.ID, ChatEditingEditorContextKeys, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatTransferContribution.ID, ChatTransferContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatContextContributions.ID, ChatContextContributions, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatResponseResourceFileSystemProvider.ID, ChatResponseResourceFileSystemProvider, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(PromptUrlHandler.ID, PromptUrlHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatEditingNotebookFileSystemProviderContrib.ID, ChatEditingNotebookFileSystemProviderContrib, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(UserToolSetsContributions.ID, UserToolSetsContributions, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(PromptLanguageFeaturesProvider.ID, PromptLanguageFeaturesProvider, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatWindowNotifier.ID, ChatWindowNotifier, WorkbenchPhase.AfterRestored);

registerChatActions();
registerChatAccessibilityActions();
registerChatCopyActions();
registerChatCodeBlockActions();
registerChatCodeCompareBlockActions();
registerChatFileTreeActions();
registerChatPromptNavigationActions();
registerChatTitleActions();
registerChatExecuteActions();
registerQuickChatActions();
registerChatExportActions();
registerMoveActions();
registerNewChatActions();
registerChatContextActions();
registerChatDeveloperActions();
registerChatEditorActions();
registerChatElicitationActions();
registerChatToolActions();
registerLanguageModelActions();


registerSingleton(IChatTransferService, ChatTransferService, InstantiationType.Delayed);
registerSingleton(IChatService, ChatService, InstantiationType.Delayed);
registerSingleton(IChatWidgetService, ChatWidgetService, InstantiationType.Delayed);
registerSingleton(IQuickChatService, QuickChatService, InstantiationType.Delayed);
registerSingleton(IChatAccessibilityService, ChatAccessibilityService, InstantiationType.Delayed);
registerSingleton(IChatWidgetHistoryService, ChatWidgetHistoryService, InstantiationType.Delayed);
registerSingleton(ILanguageModelsService, LanguageModelsService, InstantiationType.Delayed);
registerSingleton(ILanguageModelStatsService, LanguageModelStatsService, InstantiationType.Delayed);
registerSingleton(IChatSlashCommandService, ChatSlashCommandService, InstantiationType.Delayed);
registerSingleton(IChatAgentService, ChatAgentService, InstantiationType.Delayed);
registerSingleton(IChatAgentNameService, ChatAgentNameService, InstantiationType.Delayed);
registerSingleton(IChatVariablesService, ChatVariablesService, InstantiationType.Delayed);
registerSingleton(ILanguageModelToolsService, LanguageModelToolsService, InstantiationType.Delayed);
registerSingleton(ILanguageModelToolsConfirmationService, LanguageModelToolsConfirmationService, InstantiationType.Delayed);
registerSingleton(IVoiceChatService, VoiceChatService, InstantiationType.Delayed);
registerSingleton(IChatCodeBlockContextProviderService, ChatCodeBlockContextProviderService, InstantiationType.Delayed);
registerSingleton(ICodeMapperService, CodeMapperService, InstantiationType.Delayed);
registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerSingleton(IChatMarkdownAnchorService, ChatMarkdownAnchorService, InstantiationType.Delayed);
registerSingleton(ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService, InstantiationType.Delayed);
registerSingleton(IPromptsService, PromptsService, InstantiationType.Delayed);
registerSingleton(IChatContextPickService, ChatContextPickService, InstantiationType.Delayed);
registerSingleton(IChatModeService, ChatModeService, InstantiationType.Delayed);
registerSingleton(IChatAttachmentResolveService, ChatAttachmentResolveService, InstantiationType.Delayed);
registerSingleton(IChatTodoListService, ChatTodoListService, InstantiationType.Delayed);
registerSingleton(IChatOutputRendererService, ChatOutputRendererService, InstantiationType.Delayed);
registerSingleton(IChatLayoutService, ChatLayoutService, InstantiationType.Delayed);

ChatWidget.CONTRIBS.push(ChatDynamicVariableModel);
