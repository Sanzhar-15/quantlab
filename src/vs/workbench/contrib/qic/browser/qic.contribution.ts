/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	QIC_VIEW_CONTAINER_ID,
	QIC_CHAT_VIEW_ID,
	QIC_NEW_CHAT_COMMAND_ID,
	QIC_FOCUS_INPUT_COMMAND_ID,
	QIC_CANCEL_COMMAND_ID,
	QIC_CREATE_CHECKPOINT_COMMAND_ID,
	QIC_RESTORE_CHECKPOINT_COMMAND_ID,
	QIC_SHOW_SETTINGS_COMMAND_ID,
	QIC_TOGGLE_COMPLETION_COMMAND_ID,
	QIC_RETRY_CONNECTION_COMMAND_ID,
	QIC_SET_API_KEY_COMMAND_ID,
	QIC_SIGN_IN_COMMAND_ID,
	QIC_SIGN_OUT_COMMAND_ID,
	QIC_ACCOUNT_INFO_COMMAND_ID,
	QIC_SWITCH_MODE_COMMAND_ID,
	QIC_PANEL_VISIBLE_CONTEXT,
	QIC_SECRET_KEYS,
	QIC_SETTINGS,
	QIC_STORAGE_DIRS,
	QIC_AUTH,
} from '../common/constants.js';
import type { ConnectionMode, DataTier } from '../common/constants.js';
import { IQicService, QicService } from '../common/qicService.js';
import { QicChatViewPane } from './qicPanel.js';
import { IQicChatService, QicChatService } from './qicChatService.js';
import { QicChatAgent } from './qicChatAgent.js';

// QIC component imports — storage & crash safety
import { QicDatabase } from '../common/storage/database.js';
import { StatePersistenceManager } from '../common/storage/statePersistence.js';
import { JournaledAtomicWriter } from '../common/crashSafe/journaledAtomicWriter.js';
import { TransactionSafeCheckpointManager } from '../common/crashSafe/checkpointManager.js';
import { CheckpointValidator } from '../common/crashSafe/checkpointValidity.js';

// QIC component imports — state
import { PersistentAgentStateMachine } from '../common/state/agentStateMachine.js';
import { ConversationState } from '../common/state/conversationState.js';
import { IQicStateService, QicStateService } from '../common/state/qicStateService.js';

// QIC component imports — security
import { OptimizedSecretScanner } from '../common/security/secretScanner.js';
import { ConsentStore } from '../common/security/consentStore.js';
import { EgressBoundaryEnforcer } from '../common/security/egressEnforcer.js';
import { ArgumentAnalyzer } from '../common/security/argumentAnalyzer.js';
import { TerminalSecurityGuard } from '../common/security/terminalGuard.js';
import { HashChainedAuditLogger } from '../common/security/auditLogger.js';
import { FirstRunManager } from '../common/security/firstRunManager.js';

// QIC component imports — gateway & providers
import { Gateway } from '../common/gateway/gateway.js';
import { ModelRegistry } from '../common/gateway/modelRegistry.js';
import { RateLimiter } from '../common/gateway/rateLimiter.js';
import { AnthropicAdapter } from '../common/gateway/providers/anthropicAdapter.js';
import { OpenAIAdapter } from '../common/gateway/providers/openaiAdapter.js';
import { OllamaAdapter } from '../common/gateway/providers/ollamaAdapter.js';
import { QuantlabCloudAdapter } from '../common/gateway/providers/quantlabCloudAdapter.js';
import { DeltaPlusAdapter } from '../common/gateway/providers/deltaplusAdapter.js';
import { CircuitBreaker } from '../common/recovery/circuitBreaker.js';

// QIC component imports — auth
import { QuantlabAuth } from './auth/quantlabAuth.js';
import { QicAuthUriHandler } from './auth/uriHandler.js';

// QIC component imports — context & embeddings
import { SecureEmbeddingService } from '../common/context/secureEmbedding.js';
import { IncrementalIndexer } from '../common/context/incrementalIndexer.js';
import { ContextAssembler } from '../common/context/contextAssembler.js';

// QIC component imports — runtime & orchestration
import { AgentOrchestrator } from '../common/runtime/agentOrchestrator.js';
import { DynamicToolSelector } from '../common/context/dynamicToolSelector.js';
import { ToolRouter } from '../common/runtime/toolRouter.js';
import { LaneRouter } from '../common/runtime/laneRouter.js';
import { StepExecutor } from '../common/runtime/stepExecutor.js';
import { PermissionManager } from '../common/runtime/permissionManager.js';
import type { PermissionStore } from '../common/runtime/permissionManager.js';
import type { PermissionCheckResult } from '../common/canonical/types.js';
import type { ProviderAdapter } from '../common/canonical/interfaces.js';

// QIC component imports — mutation
import { MutationEngine } from '../common/mutation/mutationEngine.js';
import { ConflictDetector } from '../common/mutation/conflictDetector.js';
import { FlexibleMatcher } from '../common/mutation/flexibleMatcher.js';

// QIC component imports — resilience & lifecycle
import { MemoryManager } from '../common/resilience/memoryManager.js';
import { DegradationManager } from '../common/resilience/degradationManager.js';
import { CancellationManager } from '../common/cancellation/cancellationManager.js';
import { TimeoutManager } from '../common/timeout/timeoutManager.js';
import { SessionCache } from '../common/telemetry/sessionCache.js';
import { QualitySignalService } from '../common/telemetry/qualitySignalService.js';
import { TelemetryService } from '../common/telemetry/telemetryService.js';

// QIC component imports — completion
import { CompletionEngine } from '../common/completion/completionEngine.js';
import { QicInlineCompletionProvider } from './qicInlineCompletionProvider.js';

// QIC component imports — tools
import { registerAllTools } from '../common/tools/toolRegistration.js';
import { FileOperationTools } from '../common/tools/fileOps.js';
import { SearchTools } from '../common/tools/searchTools.js';
import { ReferenceTools } from '../common/tools/referenceTools.js';
import { TerminalTools } from '../common/tools/terminalTools.js';
import { NetworkTools } from '../common/tools/networkTools.js';
import { PackageTools } from '../common/tools/packageTools.js';
import { LspTools } from '../common/tools/lspTools.js';
import { NotebookTools } from '../common/tools/notebookTools.js';
import { CheckpointTools } from '../common/tools/checkpointTools.js';
import { GitTools } from '../common/tools/gitTools.js';

// QIC component imports — UI
import { QicUIService } from './uiService.js';

// Phase 5: Diff View imports (05-02)
import { IQicDiffService, QicDiffService } from './qicDiffService.js';
// Phase 5: CodeLens Integration (05-04)
import { QicCodeLensProvider } from './qicCodeLensProvider.js';
// Phase 5: Review Mode (05-05)
import { IQicReviewService, QicReviewService } from './qicReviewMode.js';
// Phase 5: Changes Verification (05-06)
import { IQicChangeVerificationService, QicChangeVerificationService } from './qicChangeVerification.js';

// VS Code services for command execution and inline completions
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { QicStatusBarContribution } from './qicStatusBarItem.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IRequestService } from '../../../../platform/request/common/request.js';

// ---------------------------------------------------------------------------
// 1. Register IQicService singleton (delayed — created on first access)
// AUDIT FIX X-PS1: Service identifier via createDecorator (in qicService.ts)
// ---------------------------------------------------------------------------
registerSingleton(IQicService, QicService, InstantiationType.Delayed);

// ---------------------------------------------------------------------------
// 1a. Register IQicChatService singleton (Chat Agent Bridge)
// Bridges the IChatAgentImplementation.invoke() to the QIC orchestrator
// ---------------------------------------------------------------------------
registerSingleton(IQicChatService, QicChatService, InstantiationType.Delayed);

// ---------------------------------------------------------------------------
// 1b. Register IQicStateService singleton (Phase 1: Foundation)
// This provides the centralized state for the QIC UI
// ---------------------------------------------------------------------------
registerSingleton(IQicStateService, QicStateService, InstantiationType.Eager);

// ---------------------------------------------------------------------------
// 1c. Register IQicDiffService singleton (Phase 5: Diff View)
// This provides diff viewing functionality
// ---------------------------------------------------------------------------
registerSingleton(IQicDiffService, QicDiffService, InstantiationType.Delayed);

// ---------------------------------------------------------------------------
// 1d. Register IQicReviewService singleton (Phase 5: Review Mode)
// This provides review mode for navigating through change sets
// ---------------------------------------------------------------------------
registerSingleton(IQicReviewService, QicReviewService, InstantiationType.Delayed);

// ---------------------------------------------------------------------------
// 1e. Register IQicChangeVerificationService singleton (Phase 5: Verification)
// This provides change verification before applying
// ---------------------------------------------------------------------------
registerSingleton(IQicChangeVerificationService, QicChangeVerificationService, InstantiationType.Delayed);

// ---------------------------------------------------------------------------
// 2. Register QIC view container in the Auxiliary Bar
// ---------------------------------------------------------------------------
const qicViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: QIC_VIEW_CONTAINER_ID,
	title: localize2('qic', "Orion"),
	icon: Codicon.sparkle,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QIC_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: QIC_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

// ---------------------------------------------------------------------------
// 3. Register the QIC chat view inside the container
// ---------------------------------------------------------------------------
const qicChatViewDescriptor: IViewDescriptor = {
	id: QIC_CHAT_VIEW_ID,
	containerIcon: qicViewContainer.icon,
	containerTitle: qicViewContainer.title.value,
	singleViewPaneContainerTitle: qicViewContainer.title.value,
	name: localize2('qicChat', "Chat"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: QIC_VIEW_CONTAINER_ID,
		title: qicViewContainer.title.value,
		mnemonicTitle: localize2('miToggleQIC', "&&Orion").value,
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
		},
		order: 0,
	},
	ctorDescriptor: new SyncDescriptor(QicChatViewPane),
};
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([qicChatViewDescriptor], qicViewContainer);

// ---------------------------------------------------------------------------
// 4. Register QIC configuration settings
// AUDIT FIX XI-SV7: API keys use SecretStorage, NOT configuration settings
// ---------------------------------------------------------------------------
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'qic',
	title: localize('qicConfiguration', "Orion"),
	properties: {
		[QIC_SETTINGS.PROVIDER_DEFAULT]: {
			type: 'string',
			default: 'anthropic',
			enum: ['anthropic', 'openai', 'ollama'],
			description: localize('qic.provider.default', "Default LLM provider for QIC."),
		},
		[QIC_SETTINGS.PROVIDER_OLLAMA_URL]: {
			type: 'string',
			default: 'http://localhost:11434',
			description: localize('qic.provider.ollamaUrl', "URL for the Ollama provider."),
		},
		[QIC_SETTINGS.COMPLETION_ENABLED]: {
			type: 'boolean',
			default: true,
			description: localize('qic.completion.enabled', "Enable QIC inline completions."),
		},
		[QIC_SETTINGS.COMPLETION_DEBOUNCE_MS]: {
			type: 'number',
			default: 300,
			description: localize('qic.completion.debounceMs', "Debounce delay in milliseconds for inline completions."),
		},
		[QIC_SETTINGS.PYTHON_PATH]: {
			type: 'string',
			default: 'python3',
			description: localize('qic.pythonPath', "Path to Python executable for quant features."),
		},
		[QIC_SETTINGS.TELEMETRY_ENABLED]: {
			type: 'boolean',
			default: false,
			description: localize('qic.telemetry.enabled', "Enable privacy-respecting telemetry. Deprecated: use qic.dataTier instead."),
			deprecationMessage: localize('qic.telemetry.deprecated', "Deprecated in favor of qic.dataTier."),
		},
		[QIC_SETTINGS.CONNECTION_MODE]: {
			type: 'string',
			default: 'server',
			enum: ['server', 'cloud', 'byok', 'local'],
			enumDescriptions: [
				localize('qic.connectionMode.server', "Delta Plus Server — uses your server login, no API key needed (Recommended)"),
				localize('qic.connectionMode.cloud', "Quantlab Cloud — zero-config, managed infrastructure"),
				localize('qic.connectionMode.byok', "Bring Your Own Key — direct connections to Anthropic/OpenAI"),
				localize('qic.connectionMode.local', "Local only — Ollama for offline/air-gapped environments"),
			],
			description: localize('qic.connectionMode', "How QIC connects to AI models."),
		},
		[QIC_SETTINGS.SERVER_BASE_URL]: {
			type: 'string',
			default: 'https://api.deltaplus.io',
			description: localize('qic.server.baseUrl', "URL for the Delta Plus Server."),
		},
		[QIC_SETTINGS.CLOUD_BASE_URL]: {
			type: 'string',
			default: 'https://api.quantlab.dev',
			description: localize('qic.cloud.baseUrl', "URL for the Quantlab Cloud API. Only used in cloud mode."),
		},
		[QIC_SETTINGS.CLOUD_DEV_MODE]: {
			type: 'boolean',
			default: false,
			description: localize('qic.cloud.devMode', "Enable development mode for cloud (allows HTTP localhost)."),
		},
		[QIC_SETTINGS.DATA_TIER]: {
			type: 'string',
			default: 'private',
			enum: ['private', 'anonymous-metrics', 'data-contributor'],
			enumDescriptions: [
				localize('qic.dataTier.private', "Private — no telemetry data sent"),
				localize('qic.dataTier.anonymous', "Anonymous Metrics — latency, accept/reject rates, lane usage (no code content)"),
				localize('qic.dataTier.contributor', "Data Contributor — full interaction data including code (for model improvement)"),
			],
			description: localize('qic.dataTier', "Controls what data QIC shares with Quantlab."),
		},
		[QIC_SETTINGS.LANE_OVERRIDES]: {
			type: 'object',
			default: {},
			description: localize('qic.laneOverrides', "Override the connection path for specific lanes. Maps lane names to provider IDs."),
		},
		[QIC_SETTINGS.CLOUD_ENABLED]: {
			type: 'boolean',
			default: false,
			description: localize('qic.cloud.enabled', "Enable Quantlab Cloud connection path. Off during development, flipped to true at GA."),
		},
		// Removed: qic.experimental.newHeader — no longer relevant after migration to native ChatWidget
	},
});

// ---------------------------------------------------------------------------
// 5. Register commands (AUDIT FIX VIII-PC6: all 9 commands)
// ---------------------------------------------------------------------------

// New Chat (AUDIT FIX IX-CC1: Ctrl+Alt+N, NOT Ctrl+Shift+N)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_NEW_CHAT_COMMAND_ID,
			title: localize2('qic.newChat', "Orion: New Chat"),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.has(QIC_PANEL_VISIBLE_CONTEXT),
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const qicChatService = accessor.get(IQicChatService);
		await viewsService.openView(QIC_CHAT_VIEW_ID, true);
		await qicChatService.startNewConversation();
	}
});

// Cancel (Escape in QIC context)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_CANCEL_COMMAND_ID,
			title: localize2('qic.cancel', "Orion: Cancel"),
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.WorkbenchContrib + 1,
				when: ContextKeyExpr.has(QIC_PANEL_VISIBLE_CONTEXT),
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const qicChatService = accessor.get(IQicChatService);
		qicChatService.cancelCurrentRequest();
	}
});

// Focus Input (Ctrl+L when QIC visible)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_FOCUS_INPUT_COMMAND_ID,
			title: localize2('qic.focusInput', "Orion: Focus Input"),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.has(QIC_PANEL_VISIBLE_CONTEXT),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(QIC_CHAT_VIEW_ID, true);
	}
});

// Create Checkpoint (AUDIT FIX VIII-PC6)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_CREATE_CHECKPOINT_COMMAND_ID,
			title: localize2('qic.createCheckpoint', "Orion: Create Checkpoint"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const qicService = accessor.get(IQicService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();
		if (!runtime) {
			notificationService.warn(localize('qic.notReady', "Orion is not ready yet."));
			return;
		}
		try {
			const workspaceContextService = accessor.get(IWorkspaceContextService);
			const folders = workspaceContextService.getWorkspace().folders;
			const workspacePath = folders.length > 0 ? folders[0].uri.fsPath : '';
			// Checkpoint all workspace files under tracked paths
			const checkpointId = await runtime.checkpointManager.createCheckpoint([workspacePath]);
			notificationService.info(localize('qic.checkpointCreated', "Orion: Checkpoint created ({0}).", checkpointId.slice(0, 8)));
		} catch (err) {
			notificationService.error(localize('qic.checkpointFailed', "Orion: Failed to create checkpoint."));
		}
	}
});

// Restore Checkpoint (AUDIT FIX VIII-PC6)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_RESTORE_CHECKPOINT_COMMAND_ID,
			title: localize2('qic.restoreCheckpoint', "Orion: Restore Checkpoint"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const qicService = accessor.get(IQicService);
		const notificationService = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);
		const runtime = qicService.getRuntime();
		if (!runtime) {
			notificationService.warn(localize('qic.notReady', "Orion is not ready yet."));
			return;
		}
		try {
			const checkpoints = await runtime.checkpointManager.listCheckpoints();
			if (checkpoints.length === 0) {
				notificationService.info(localize('qic.noCheckpoints', "Orion: No checkpoints available."));
				return;
			}
			const pick = await quickInput.pick(
				checkpoints.map(cp => ({
					label: cp.id.slice(0, 8),
					description: `${cp.createdAt} — ${cp.fileCount} files`,
					id: cp.id,
				})),
				{ placeHolder: localize('qic.selectCheckpoint', "Select a checkpoint to restore") },
			);
			if (pick && 'id' in pick) {
				await runtime.checkpointManager.restoreCheckpoint(pick.id as string);
				notificationService.info(localize('qic.checkpointRestored', "Orion: Checkpoint restored."));
			}
		} catch (err) {
			notificationService.error(localize('qic.restoreFailed', "Orion: Failed to restore checkpoint."));
		}
	}
});

// Show Settings (AUDIT FIX VIII-PC6)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SHOW_SETTINGS_COMMAND_ID,
			title: localize2('qic.showSettings', "Orion: Show Settings"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('workbench.action.openSettings', 'qic');
	}
});

// Toggle Completion (AUDIT FIX VIII-PC6)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_TOGGLE_COMPLETION_COMMAND_ID,
			title: localize2('qic.toggleCompletion', "Orion: Toggle Inline Completions"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		const config = accessor.get(IConfigurationService);
		const current = config.getValue<boolean>(QIC_SETTINGS.COMPLETION_ENABLED);
		config.updateValue(QIC_SETTINGS.COMPLETION_ENABLED, !current);
	}
});

// Retry Connection (AUDIT FIX VIII-PC6: for degradation recovery)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_RETRY_CONNECTION_COMMAND_ID,
			title: localize2('qic.retryConnection', "Orion: Retry Connection"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const qicService = accessor.get(IQicService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();
		if (!runtime) {
			notificationService.warn(localize('qic.notReady', "Orion is not ready yet."));
			return;
		}
		try {
			const health = await runtime.gateway.getProviderHealth();
			const available = [...health.values()].filter(h => h.status !== 'unavailable').length;
			notificationService.info(
				localize('qic.connectionRetried', "Orion: Connection check complete. {0}/{1} providers available.",
					available, health.size)
			);
		} catch (err) {
			notificationService.error(localize('qic.retryFailed', "Orion: Connection retry failed."));
		}
	}
});

// Set API Key (AUDIT FIX XI-SV7: SecretStorage, not settings)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SET_API_KEY_COMMAND_ID,
			title: localize2('qic.setApiKey', "Orion: Set API Key"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// Get all services upfront before any async operations
		const quickInput = accessor.get(IQuickInputService);
		const secretStorage = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);

		const provider = await quickInput.pick(
			[{ label: 'Anthropic' }, { label: 'OpenAI' }],
			{ placeHolder: localize('qic.selectProvider', "Select provider") },
		);
		if (!provider) { return; }

		const key = await quickInput.input({
			prompt: localize('qic.enterApiKey', "Enter {0} API Key", provider.label),
			password: true,
		});
		if (key) {
			const storageKey = provider.label === 'Anthropic'
				? QIC_SECRET_KEYS.ANTHROPIC_API_KEY
				: QIC_SECRET_KEYS.OPENAI_API_KEY;
			await secretStorage.set(storageKey, key);

			notificationService.info(
				localize('qic.apiKeySet', "API key saved. Reload the window (Ctrl+Shift+P → Reload Window) to activate the {0} provider.", provider.label)
			);
		}
	}
});

// Sign In (OAuth PKCE flow)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SIGN_IN_COMMAND_ID,
			title: localize2('qic.signIn', "Orion: Sign In to Quantlab Cloud"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// Get all services upfront before any async operations
		const secretStorage = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		const configService = accessor.get(IConfigurationService);
		const qicService = accessor.get(IQicService);
		const openerService = accessor.get(IOpenerService);

		// Check if already signed in
		const existing = await secretStorage.get(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);
		if (existing) {
			notificationService.info(localize('qic.alreadySignedIn', "Orion: Already signed in to Quantlab Cloud."));
			return;
		}

		// Get the global URI handler (registered at activation)
		const uriHandler = qicService.getAuthUriHandler();
		if (!uriHandler) {
			notificationService.error(localize('qic.notReady', "Orion is not ready yet."));
			return;
		}

		const baseUrl = configService.getValue<string>(QIC_SETTINGS.CLOUD_BASE_URL) ?? 'https://api.quantlab.dev';
		const auth = new QuantlabAuth({
			authorizeUrl: `${baseUrl}/v1/auth/authorize`,
			tokenUrl: `${baseUrl}/v1/auth/token`,
			clientId: QIC_AUTH.CLIENT_ID,
			redirectUri: QIC_AUTH.REDIRECT_URI,
			scopes: [...QIC_AUTH.SCOPES],
			audience: QIC_AUTH.AUDIENCE,
		});

		try {
			const { authUrl, state: _state } = await auth.startAuthFlow();

			// Set up callback handler using the global URI handler
			const tokenPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error('Authentication timed out'));
				}, 300_000); // 5 minute timeout
				uriHandler.onAuthCode((code, cbState) => {
					clearTimeout(timeout);
					resolve({ code, state: cbState });
				});
				uriHandler.onError((error) => {
					clearTimeout(timeout);
					reject(new Error(error));
				});
			});

			// Open browser for authentication
			await openerService.open(URI.parse(authUrl), { openExternal: true });

			notificationService.info(localize('qic.signInBrowser', "Orion: Complete sign-in in your browser..."));

			// Wait for callback
			const { code, state: returnedState } = await tokenPromise;
			const tokens = await auth.exchangeCode(code, returnedState);

			// Store tokens + expiry
			await secretStorage.set(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN, tokens.accessToken);
			if (tokens.refreshToken) {
				await secretStorage.set(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN, tokens.refreshToken);
			}
			if (tokens.expiresIn) {
				const expiresAt = Date.now() + (tokens.expiresIn * 1000);
				await secretStorage.set(QIC_SECRET_KEYS.CLOUD_TOKEN_EXPIRES_AT, String(expiresAt));
			}

			notificationService.info(localize('qic.signInSuccess', "Orion: Signed in to Quantlab Cloud. Reload the window to activate."));
		} catch (err) {
			notificationService.error(
				localize('qic.signInFailed', "Orion: Sign-in failed — {0}", err instanceof Error ? err.message : String(err))
			);
		}
	}
});

// Sign Out
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SIGN_OUT_COMMAND_ID,
			title: localize2('qic.signOut', "Orion: Sign Out of Quantlab Cloud"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const secretStorage = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		const configService = accessor.get(IConfigurationService);
		const dialogService = accessor.get(IDialogService);

		const accessToken = await secretStorage.get(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);
		if (!accessToken) {
			notificationService.info(localize('qic.notSignedIn', "Orion: Not signed in to Quantlab Cloud."));
			return;
		}

		const { confirmed } = await dialogService.confirm({
			message: localize('qic.signOut.confirm', "Sign out of Quantlab Cloud?"),
			detail: localize('qic.signOut.detail', "This will revoke your tokens and disconnect from Quantlab Cloud."),
			primaryButton: localize('qic.signOut.button', "Sign Out"),
		});
		if (!confirmed) { return; }

		// Revoke tokens server-side (best-effort)
		const baseUrl = configService.getValue<string>(QIC_SETTINGS.CLOUD_BASE_URL) ?? 'https://api.quantlab.dev';
		const refreshToken = await secretStorage.get(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN);
		const auth = new QuantlabAuth({
			authorizeUrl: `${baseUrl}/v1/auth/authorize`,
			tokenUrl: `${baseUrl}/v1/auth/token`,
			clientId: QIC_AUTH.CLIENT_ID,
			redirectUri: QIC_AUTH.REDIRECT_URI,
			scopes: [...QIC_AUTH.SCOPES],
			audience: QIC_AUTH.AUDIENCE,
		});
		await auth.revokeTokens(accessToken, refreshToken ?? '');

		// Clear local tokens + expiry
		await secretStorage.delete(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);
		await secretStorage.delete(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN);
		await secretStorage.delete(QIC_SECRET_KEYS.CLOUD_TOKEN_EXPIRES_AT);

		notificationService.info(localize('qic.signedOut', "Orion: Signed out. Reload the window to apply."));
	}
});

// Account Info
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_ACCOUNT_INFO_COMMAND_ID,
			title: localize2('qic.accountInfo', "Orion: Account Info"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const secretStorage = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		const configService = accessor.get(IConfigurationService);

		const accessToken = await secretStorage.get(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);
		const connectionMode = configService.getValue<string>(QIC_SETTINGS.CONNECTION_MODE) ?? 'cloud';

		if (!accessToken) {
			notificationService.info(
				localize('qic.accountInfo.notSignedIn',
					"Orion: Not signed in. Connection mode: {0}. Run 'Orion: Sign In' to connect to Quantlab Cloud.",
					connectionMode)
			);
			return;
		}

		// Decode JWT payload (no verification — just for display)
		try {
			const parts = accessToken.split('.');
			if (parts.length === 3) {
				const payload = JSON.parse(atob(parts[1])) as { sub?: string; email?: string; exp?: number; scope?: string };
				const expiry = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : 'unknown';
				notificationService.info(
					localize('qic.accountInfo.details',
						"Orion Account: {0}\nMode: {1}\nExpires: {2}\nScopes: {3}",
						payload.email ?? payload.sub ?? 'unknown',
						connectionMode,
						expiry,
						payload.scope ?? 'unknown')
				);
			} else {
				notificationService.info(
					localize('qic.accountInfo.signed', "Orion: Signed in to Quantlab Cloud. Mode: {0}.", connectionMode)
				);
			}
		} catch {
			notificationService.info(
				localize('qic.accountInfo.signed', "Orion: Signed in to Quantlab Cloud. Mode: {0}.", connectionMode)
			);
		}
	}
});

// Switch Connection Mode
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SWITCH_MODE_COMMAND_ID,
			title: localize2('qic.switchMode', "Orion: Switch Connection Mode"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configService = accessor.get(IConfigurationService);

		const current = configService.getValue<string>(QIC_SETTINGS.CONNECTION_MODE) ?? 'cloud';

		const items = [
			{ label: 'server', description: 'Delta Plus Server — uses your server login, no API key needed', picked: current === 'server' },
			{ label: 'cloud', description: 'Quantlab Cloud — zero-config, managed infrastructure', picked: current === 'cloud' },
			{ label: 'byok', description: 'Bring Your Own Key — direct to Anthropic/OpenAI', picked: current === 'byok' },
			{ label: 'local', description: 'Local only — Ollama for offline environments', picked: current === 'local' },
		];

		const pick = await quickInput.pick(items, {
			placeHolder: localize('qic.switchMode.placeholder', "Select connection mode (current: {0})", current),
		});

		if (pick && 'label' in pick && pick.label !== current) {
			await configService.updateValue(QIC_SETTINGS.CONNECTION_MODE, pick.label);
			// The hot-swap listener will prompt for reload
		}
	}
});

// ---------------------------------------------------------------------------
// Phase 5: Diff View Commands (05-02)
// ---------------------------------------------------------------------------

// Show Diff command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.showDiff',
			title: localize2('qic.showDiff', "Orion: Show Diff"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, changeId?: string): Promise<void> {
		if (!changeId) return;

		const { IQicDiffService } = await import('./qicDiffService.js');
		const diffService = accessor.get(IQicDiffService);
		await diffService.showDiff(changeId);
	}
});

// Apply from Diff command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.applyFromDiff',
			title: localize2('qic.applyFromDiff', "Orion: Apply This Change"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				when: ContextKeyExpr.equals('qic.inDiffView', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { IQicDiffService } = await import('./qicDiffService.js');
		const diffService = accessor.get(IQicDiffService);
		const stateService = accessor.get(IQicStateService);

		const changeId = diffService.getCurrentDiffChangeId();
		if (!changeId) return;

		// Apply the change
		try {
			stateService.applyChange?.(changeId);
			await diffService.closeDiff();
		} catch (error) {
			accessor.get(INotificationService).error(`Failed to apply change: ${(error as Error).message}`);
		}
	}
});

// Reject from Diff command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.rejectFromDiff',
			title: localize2('qic.rejectFromDiff', "Orion: Reject This Change"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
				when: ContextKeyExpr.equals('qic.inDiffView', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { IQicDiffService } = await import('./qicDiffService.js');
		const diffService = accessor.get(IQicDiffService);
		const stateService = accessor.get(IQicStateService);

		const changeId = diffService.getCurrentDiffChangeId();
		if (!changeId) return;

		// Reject the change
		stateService.rejectChange?.(changeId);
		await diffService.closeDiff();
	}
});

// ---------------------------------------------------------------------------
// Phase 5: CodeLens Bulk Action Commands (05-04)
// ---------------------------------------------------------------------------

// Accept All Changes in a change set
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.acceptAllChanges',
			title: localize2('qic.acceptAllChanges', "Orion: Accept All Changes"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, changeSetId?: string): Promise<void> {
		if (!changeSetId) return;

		const qicService = accessor.get(IQicService);
		const stateService = accessor.get(IQicStateService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();

		// Get the change set from state
		const state = stateService.state as any;
		const pendingChanges = state.conversation?.pendingChanges;
		const changeSet = pendingChanges?.id === changeSetId ? pendingChanges : null;

		if (!changeSet) {
			notificationService.warn(localize('qic.changeSetNotFound', "Orion: Change set not found"));
			return;
		}

		// Apply all pending changes
		const pendingChangesToApply = changeSet.changes?.filter((c: any) => c.status === 'pending') || [];
		let successCount = 0;
		let failCount = 0;

		for (const change of pendingChangesToApply) {
			try {
				if (runtime?.changeManager?.applyChange) {
					await runtime.changeManager.applyChange(change.id);
				}
				stateService.applyChange?.(change.id);
				successCount++;
			} catch (error) {
				failCount++;
			}
		}

		if (failCount === 0) {
			notificationService.info(localize('qic.allChangesApplied', "Orion: Applied {0} changes", successCount));
		} else {
			notificationService.warn(localize('qic.someChangesFailed', "Orion: Applied {0} changes, {1} failed", successCount, failCount));
		}
	}
});

// Reject All Changes in a change set
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.rejectAllChanges',
			title: localize2('qic.rejectAllChanges', "Orion: Reject All Changes"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, changeSetId?: string): Promise<void> {
		if (!changeSetId) return;

		const qicService = accessor.get(IQicService);
		const stateService = accessor.get(IQicStateService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();

		// Get the change set from state
		const state = stateService.state as any;
		const pendingChanges = state.conversation?.pendingChanges;
		const changeSet = pendingChanges?.id === changeSetId ? pendingChanges : null;

		if (!changeSet) {
			notificationService.warn(localize('qic.changeSetNotFound', "Orion: Change set not found"));
			return;
		}

		// Reject all pending changes
		const pendingChangesToReject = changeSet.changes?.filter((c: any) => c.status === 'pending') || [];
		let rejectCount = 0;

		for (const change of pendingChangesToReject) {
			if (runtime?.changeManager?.rejectChange) {
				runtime.changeManager.rejectChange(change.id);
			}
			stateService.rejectChange?.(change.id);
			rejectCount++;
		}

		notificationService.info(localize('qic.allChangesRejected', "Orion: Rejected {0} changes", rejectCount));
	}
});

// ---------------------------------------------------------------------------
// Phase 5: Review Mode Commands (05-05)
// ---------------------------------------------------------------------------

// Start Review Mode
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.startReview',
			title: localize2('qic.startReview', "Orion: Start Review Mode"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, changeSetId?: string): Promise<void> {
		const reviewService = accessor.get(IQicReviewService);
		const stateService = accessor.get(IQicStateService);
		const notificationService = accessor.get(INotificationService);

		// If no changeSetId provided, use current pending changes
		if (!changeSetId) {
			const state = stateService.state as any;
			changeSetId = state.conversation?.pendingChanges?.id;
		}

		if (!changeSetId) {
			notificationService.warn(localize('qic.noChangesToReview', "Orion: No changes to review"));
			return;
		}

		try {
			await reviewService.startReview(changeSetId);
			const progress = reviewService.getProgress();
			if (progress) {
				notificationService.info(
					localize('qic.reviewStarted', "Orion: Review mode started ({0} changes)", progress.totalCount)
				);
			}
		} catch (error) {
			notificationService.error(`Failed to start review: ${(error as Error).message}`);
		}
	}
});

// Exit Review Mode
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.exitReview',
			title: localize2('qic.exitReview', "Orion: Exit Review Mode"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				when: ContextKeyExpr.equals('qic.inReviewMode', true),
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const reviewService = accessor.get(IQicReviewService);
		reviewService.exitReview();
	}
});

// Review Mode: Next Change
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.reviewNext',
			title: localize2('qic.reviewNext', "Orion: Next Change"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.KeyN,
				when: ContextKeyExpr.equals('qic.inReviewMode', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const reviewService = accessor.get(IQicReviewService);
		await reviewService.nextChange();
	}
});

// Review Mode: Previous Change
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.reviewPrevious',
			title: localize2('qic.reviewPrevious', "Orion: Previous Change"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.KeyP,
				when: ContextKeyExpr.equals('qic.inReviewMode', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const reviewService = accessor.get(IQicReviewService);
		await reviewService.previousChange();
	}
});

// Review Mode: Accept and Next
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.reviewAcceptNext',
			title: localize2('qic.reviewAcceptNext', "Orion: Accept and Next"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.KeyY,
				when: ContextKeyExpr.equals('qic.inReviewMode', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const reviewService = accessor.get(IQicReviewService);
		await reviewService.acceptAndNext();
	}
});

// Review Mode: Reject and Next
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.reviewRejectNext',
			title: localize2('qic.reviewRejectNext', "Orion: Reject and Next"),
			category: localize2('qic.category', 'Orion'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.KeyD,
				when: ContextKeyExpr.equals('qic.inReviewMode', true),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const reviewService = accessor.get(IQicReviewService);
		await reviewService.rejectAndNext();
	}
});

// ---------------------------------------------------------------------------
// QicInlineCompletionAdapter — bridges QicInlineCompletionProvider to VS Code's
// InlineCompletionsProvider interface used by ILanguageFeaturesService.
// ---------------------------------------------------------------------------

class QicInlineCompletionAdapter {
	readonly groupId = QicInlineCompletionProvider.groupId;
	readonly yieldsToGroupIds = QicInlineCompletionProvider.yieldsToGroupIds;

	constructor(private readonly inner: QicInlineCompletionProvider) {}

	async provideInlineCompletions(
		model: any, position: any, _context: any, token: any,
	): Promise<{ items: { insertText: string }[] }> {
		const ac = new AbortController();
		const listener = token.onCancellationRequested(() => ac.abort());
		try {
			const items = await this.inner.provideInlineCompletions(
				model.getValue(), model.getOffsetAt(position),
				model.getLanguageId(), model.uri.fsPath, ac.signal,
			);
			return { items: items.map((i) => ({ insertText: i.insertText })) };
		} catch {
			return { items: [] };
		} finally {
			listener.dispose();
		}
	}

	handleItemDidShow(): void {
		// Item was shown to user — already tracked in provideInlineCompletions
	}

	handlePartialAccept(): void {
		// Partial accept — confirmation requires document change correlation (Phase 5b)
		// For now, we track "shown" but defer accept/reject determination
		const completion = this.inner.getLastCompletion();
		if (completion) {
			this.inner.confirmAcceptance(completion);
		}
	}

	freeInlineCompletions(): void {
		// Called when completions are dismissed/freed (both accept AND reject cases)
		// Cannot distinguish here — delegate to provider for cleanup
		this.inner.freeInlineCompletions([]);
	}
}

// ---------------------------------------------------------------------------
// InMemoryPermissionStore — simple in-memory implementation of PermissionStore
// ---------------------------------------------------------------------------

class InMemoryPermissionStore implements PermissionStore {
	private readonly store = new Map<string, PermissionCheckResult>();

	get(toolName: string, sessionId: string): PermissionCheckResult | null {
		return this.store.get(`${sessionId}:${toolName}`) ?? null;
	}

	set(toolName: string, sessionId: string, result: PermissionCheckResult): void {
		this.store.set(`${sessionId}:${toolName}`, result);
	}
}

// ---------------------------------------------------------------------------
// 6. QIC Activation — Phase A (sync) + Phase B (async)
// AUDIT FIX IV-AO3: Split to avoid 60s activation timeout
// AUDIT FIX XII-AR4: All components in DisposableStore
// ---------------------------------------------------------------------------

class QicActivation extends Disposable {

	static readonly ID = 'workbench.contrib.qic.activation';

	private readonly _disposableStore = this._register(new DisposableStore());

	// Cloud connection state (populated in Step 6, consumed in Step 8)
	private _cloudCircuitBreaker: CircuitBreaker | undefined;
	private _cloudAdapter: QuantlabCloudAdapter | undefined;
	private _deltaplusAdapter: DeltaPlusAdapter | undefined;
	private _hasByokProvider = false;
	private _hasLocalProvider = false;
	private _telemetryService: TelemetryService | undefined;

	// Global URI handler for OAuth callbacks (registered once at activation)
	private readonly _authUriHandler: QicAuthUriHandler;

	constructor(
		@IQicService private readonly qicService: IQicService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IProductService private readonly productService: IProductService,
		@ICommandService private readonly commandService: ICommandService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IURLService private readonly urlService: IURLService,
		@IRequestService private readonly requestService: IRequestService,
		@IQicStateService private readonly stateService: IQicStateService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super();

		// Register QIC as a native chat participant
		this._register(this.instantiationService.createInstance(QicChatAgent));

		// Register global URI handler for OAuth callbacks (Fix: HIGH-5 from audit)
		this._authUriHandler = new QicAuthUriHandler();
		this._register(this.urlService.registerHandler(this._authUriHandler));
		this.qicService.setAuthUriHandler(this._authUriHandler);

		// Phase A (synchronous): Context keys are bound by QicChatViewPane (panelVisibleKey).

		// Phase B (async): Heavy initialization
		this.activateAsync().catch(err => {
			this.handleActivationFailure(err instanceof Error ? err : new Error(String(err)));
		});
	}

	private async activateAsync(): Promise<void> {
		// Resolve workspace path
		const folders = this.workspaceContextService.getWorkspace().folders;
		const workspacePath = folders.length > 0 ? folders[0].uri.fsPath : '';

		// Resolve storage base path: {workspaceStorageHome}/{workspaceId}/qic
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		const storageBase = URI.joinPath(this.environmentService.workspaceStorageHome, workspaceId, 'qic');

		// Shared references populated by each step
		let journalDir: string;
		let db: QicDatabase;
		let statePersistence: StatePersistenceManager;
		let agentState: PersistentAgentStateMachine;
		let conversationState: ConversationState;
		let secretScanner: OptimizedSecretScanner;
		let consentStore: ConsentStore;
		let egressEnforcer: EgressBoundaryEnforcer;
		let auditLogger: HashChainedAuditLogger;
		let terminalGuard: TerminalSecurityGuard;
		let gateway: Gateway;
		let modelRegistry: ModelRegistry;
		let indexer: IncrementalIndexer;
		let contextAssembler: ContextAssembler;
		let uiService: QicUIService;
		let degradationManager: DegradationManager;
		let orchestrator: AgentOrchestrator;
		let checkpointManager: TransactionSafeCheckpointManager;
		let qualitySignalService: QualitySignalService;

		// Register connection config change listener unconditionally — before the try block
		// so it cannot be skipped by any thrown exception in any initialization step.
		this._disposableStore.add(
			this.configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('qic.connectionMode') ||
					e.affectsConfiguration('qic.server.baseUrl') ||
					e.affectsConfiguration('qic.cloud.baseUrl') ||
					e.affectsConfiguration('qic.cloud.devMode') ||
					e.affectsConfiguration('qic.cloud.enabled')) {
					this.logService.info('[QIC] Connection configuration changed — reload required');
					this.notificationService.prompt(
						2, // Severity.Info
						localize('qic.configChanged', "Orion connection settings changed. Reload the window to apply."),
						[{
							label: localize('qic.reloadWindow', "Reload Window"),
							run: () => {
								void this.commandService.executeCommand('workbench.action.reloadWindow');
							},
						}],
					);
				}
			})
		);

		try {
			// Step 0: Create workspace storage directories (AUDIT FIX VIII-PC5)
			await this.step('directories', async () => {
				for (const dir of QIC_STORAGE_DIRS) {
					const dirUri = URI.joinPath(storageBase, dir);
					try {
						await this.fileService.createFolder(dirUri);
					} catch {
						// Directory may already exist — that's fine
					}
				}
				// Also create the journal directory
				const journalUri = URI.joinPath(storageBase, 'journal');
				try {
					await this.fileService.createFolder(journalUri);
				} catch {
					// Already exists
				}
			});

			journalDir = URI.joinPath(storageBase, 'journal').fsPath;

			// Step 1: Crash recovery (non-fatal — fs may be unavailable in sandbox)
			try {
				await this.step('crash-recovery', async () => {
					const recoveryResult = await JournaledAtomicWriter.recoverFromCrash(journalDir);
					if (recoveryResult.recovered) {
						this.logService.info(
							`[QIC] Crash recovery: ${recoveryResult.journalsProcessed} journals processed, ` +
							`${recoveryResult.operationsRolledForward} operations rolled forward`
						);
						this.notificationService.info(
							localize('qic.crashRecovery', "Orion: Recovered {0} incomplete operations from previous session.",
								recoveryResult.operationsRolledForward)
						);
					}
					if (recoveryResult.errors.length > 0) {
						for (const err of recoveryResult.errors) {
							this.logService.warn(`[QIC] Recovery error: ${err}`);
						}
					}
				});
			} catch (err) {
				this.logService.warn('[QIC] Crash recovery unavailable (sandboxed renderer) — skipping.', err);
				this.qicService.addCompletedStep('crash-recovery'); // Mark as completed so error reporting is accurate
			}

			// Step 2: Database initialization (AUDIT FIX XII-AR1)
			await this.step('database', async () => {
				const dbPath = URI.joinPath(storageBase, 'qic.db').fsPath;
				db = new QicDatabase(dbPath);
				await db.initialize();
				if (db.isInMemory) {
					this.logService.warn('[QIC] Native SQLite unavailable (sandboxed renderer) — using in-memory storage. Data will not persist across sessions.');
				}
				statePersistence = new StatePersistenceManager(db);
			});

			// Step 3: State machine recovery (AUDIT FIX XII-AR8)
			await this.step('state-recovery', async () => {
				const sessionId = globalThis.crypto.randomUUID();
				conversationState = new ConversationState(sessionId);
				const recovered = await PersistentAgentStateMachine.recover(statePersistence, sessionId);
				if (recovered) {
					agentState = recovered.machine;
					this.logService.info(`[QIC] Recovered agent state from "${recovered.recoveredFrom}"`);
				} else {
					agentState = new PersistentAgentStateMachine(statePersistence, sessionId);
				}
			});

			// Step 4: Security initialization
			await this.step('security', async () => {
				secretScanner = new OptimizedSecretScanner();
				consentStore = new ConsentStore();
				auditLogger = new HashChainedAuditLogger(secretScanner);
				egressEnforcer = new EgressBoundaryEnforcer(consentStore, secretScanner, auditLogger);
				const argumentAnalyzer = new ArgumentAnalyzer();
				terminalGuard = new TerminalSecurityGuard(argumentAnalyzer);
				auditLogger.setDatabase(db);
				consentStore.setDatabase(db);
			});

			// Step 5: First-run consent (AUDIT FIX X-PS4: use IDialogService)
			await this.step('first-run', async () => {
				const firstRunManager = new FirstRunManager(consentStore);
				const firstRunResult = await firstRunManager.checkAndPrompt();
				if (firstRunResult.isFirstRun) {
					// Show consent dialog — user must explicitly enable AI features
					const dialogResult = await this.dialogService.confirm({
						message: localize('qic.firstRun.title', "Welcome to Orion"),
						detail: localize('qic.firstRun.detail',
							"Orion sends code context to AI providers for completions and chat.\n\nDo you want to enable AI features? You can change this later in Orion settings."),
						primaryButton: localize('qic.firstRun.enable', "Enable AI Features"),
					});
					if (dialogResult.confirmed) {
						await consentStore.grantConsent('llm', 'workspace');
						await consentStore.grantConsent('embedding', 'workspace');
						await consentStore.markFirstRunComplete();
						this.logService.info('[QIC] First-run consent granted — AI features enabled');
					} else {
						this.qicService.setState('degraded');
						this.qicService.addDegradedFeature('llm');
						this.logService.warn('[QIC] First-run consent declined — LLM features degraded');
						return;
					}
				} else if (!firstRunResult.canProceed) {
					this.qicService.setState('degraded');
					this.qicService.addDegradedFeature('llm');
					this.logService.warn('[QIC] Required consent not granted — LLM features degraded');
					return;
				}
			});

			// If LLM is degraded from first-run, skip remaining gateway/runtime steps
			if (this.qicService.getDegradedFeatures().includes('llm')) {
				this.qicService.setState('degraded');
				return;
			}

			// Step 6: Gateway initialization (connection mode branching)
			await this.step('gateway', async () => {
				// Precondition: Steps 4 (security) and 5 (consent) must have completed.
				// This is guaranteed by the sequential await chain, but we assert explicitly
				// so any future parallelization refactor fails loudly rather than passing
				// undefined into the Gateway constructor without a TypeScript error.
				if (secretScanner === undefined || consentStore === undefined || egressEnforcer === undefined) {
					throw new Error('[QIC] Internal invariant violated: security step must complete before gateway step');
				}

				const connectionMode = this.configurationService.getValue<ConnectionMode>(QIC_SETTINGS.CONNECTION_MODE) ?? 'cloud';
				const cloudEnabled = this.configurationService.getValue<boolean>(QIC_SETTINGS.CLOUD_ENABLED) ?? false;
				const ollamaUrl = this.configurationService.getValue<string>(QIC_SETTINGS.PROVIDER_OLLAMA_URL) ?? 'http://localhost:11434';
				const laneOverrides = this.configurationService.getValue<Record<string, string>>(QIC_SETTINGS.LANE_OVERRIDES) ?? {};
				const providers = new Map<string, ProviderAdapter>();

				// Validate lane overrides (warn about invalid entries)
				const validLanes = new Set(['completion', 'chat-ask', 'chat-gather', 'chat-plan', 'chat-act', 'repair', 'fast-apply', 'summarize']);
				for (const [lane, _provider] of Object.entries(laneOverrides)) {
					if (!validLanes.has(lane)) {
						this.logService.warn(`[QIC] Unknown lane in overrides: ${lane}`);
					}
				}

				// --- Cloud adapter (gated behind feature flag + not local mode) ---
				if (cloudEnabled && connectionMode !== 'local') {
					const cloudUrl = this.configurationService.getValue<string>(QIC_SETTINGS.CLOUD_BASE_URL) ?? 'https://api.quantlab.dev';
					const devMode = this.configurationService.getValue<boolean>(QIC_SETTINGS.CLOUD_DEV_MODE) ?? false;

					// Dev mode: auto-use dev token for localhost (no auth setup needed)
					const isLocalhost = cloudUrl.includes('localhost') || cloudUrl.includes('127.0.0.1');
					const useDevToken = devMode && isLocalhost;

					const accessToken = useDevToken
						? 'dev-token'
						: await this.secretStorageService.get(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN);

					if (accessToken) {
						if (useDevToken) {
							this.logService.info('[QIC] Dev mode: using dev-token for localhost server');
						}
						try {
							// Retrieve stored token expiry
							const storedExpiry = useDevToken ? undefined : await this.secretStorageService.get(QIC_SECRET_KEYS.CLOUD_TOKEN_EXPIRES_AT);
							const tokenExpiresAt = storedExpiry ? parseInt(storedExpiry, 10) : undefined;

							const cloudAdapter = new QuantlabCloudAdapter({
								baseUrl: cloudUrl,
								accessToken,
								refreshToken: useDevToken ? undefined : await this.secretStorageService.get(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN) ?? undefined,
								clientId: QIC_AUTH.CLIENT_ID,
								devMode,
								extensionVersion: this.productService.version ?? '0.0.0',
								tokenExpiresAt,
								onTokenRefresh: useDevToken ? undefined : async (newAccess, newRefresh) => {
									await this.secretStorageService.set(QIC_SECRET_KEYS.CLOUD_ACCESS_TOKEN, newAccess);
									if (newRefresh) {
										await this.secretStorageService.set(QIC_SECRET_KEYS.CLOUD_REFRESH_TOKEN, newRefresh);
									}
								},
							});
							providers.set('quantlab-cloud', cloudAdapter);
							this._cloudAdapter = cloudAdapter;
						} catch (err) {
							this.logService.warn('[QIC] Failed to initialize Quantlab Cloud:', err);
						}
					}
				}

				// --- Delta Plus Server adapter (server mode) ---
				if (connectionMode === 'server' || connectionMode !== 'local') {
					const serverUrl = this.configurationService.getValue<string>(QIC_SETTINGS.SERVER_BASE_URL) ?? 'https://api.deltaplus.io';

					// The extension's ServerApiClient.login() persists tokens asynchronously.
					// In server mode, wait briefly for the token to appear (race condition fix).
					let dpAccessToken = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN);
					if (!dpAccessToken && connectionMode === 'server') {
						// Wait briefly for extension layer to persist token
						for (let attempt = 0; attempt < 5 && !dpAccessToken; attempt++) {
							await new Promise(r => setTimeout(r, 500));
							dpAccessToken = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN);
						}
						// Token still absent — adapter will be late-registered via onDidChangeSecret
						// when the user signs in through the QuantLab auth provider.
						if (!dpAccessToken) {
							this.logService.info('[QIC] Delta Plus token not available at startup — adapter will register when user signs in');
						}
					}

					if (dpAccessToken) {
						try {
							const dpRefreshToken = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_REFRESH_TOKEN) ?? undefined;
							const storedExpiry = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_TOKEN_EXPIRES_AT);
							const tokenExpiresAt = storedExpiry ? parseInt(storedExpiry, 10) : undefined;

							const deltaplusAdapter = new DeltaPlusAdapter({
								baseUrl: serverUrl,
								accessToken: dpAccessToken,
								refreshToken: dpRefreshToken,
								tokenExpiresAt,
								onTokenRefresh: async (newAccess, newRefresh) => {
									await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN, newAccess);
									if (newRefresh) {
										await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_REFRESH_TOKEN, newRefresh);
									}
									const newExp = this.decodeJwtExp(newAccess);
									if (newExp) {
										await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_TOKEN_EXPIRES_AT, String(newExp));
									}
								},
								loginFallback: async () => {
									this.logService.warn('[QIC] Delta Plus token refresh failed — user must re-authenticate');
									throw new Error('Delta Plus session expired. Please sign in again via the account menu.');
								},
							}, this.requestService);

							// Register immediately — blocking startup on a 5-second health check is
							// user-visible latency. Actual failures surface via the circuit breaker;
							// the background check here is diagnostic and notification only.
							providers.set('deltaplus', deltaplusAdapter);
							this._deltaplusAdapter = deltaplusAdapter;
							this.logService.info('[QIC] Delta Plus adapter registered (background health check starting)');
							void deltaplusAdapter.getHealth().then(health => {
								this.logService.info(`[QIC] Delta Plus health: ${health.status}${health.latencyMs !== undefined ? ', latency: ' + String(health.latencyMs) + 'ms' : ''}`);
								if (health.status === 'unavailable' && connectionMode === 'server') {
									this.notificationService.info(
										localize('qic.serverConnect',
											"Orion: Delta Plus Server not currently reachable. Requests will retry when it recovers.")
									);
								}
							}).catch(err => {
								this.logService.warn('[QIC] Delta Plus background health check error:', err);
							});
						} catch (err) {
							this.logService.warn('[QIC] Failed to initialize Delta Plus adapter:', err);
						}
					}
				}

				// --- BYOK adapters (always initialized if keys exist, for fallback) ---
				if (connectionMode !== 'local') {
					let anthropicKey: string | undefined;
					let openaiKey: string | undefined;

					try {
						anthropicKey = await this.secretStorageService.get(QIC_SECRET_KEYS.ANTHROPIC_API_KEY);
						openaiKey = await this.secretStorageService.get(QIC_SECRET_KEYS.OPENAI_API_KEY);
						this.logService.info(`[QIC] Secret storage lookup: anthropic=${anthropicKey ? 'found (' + anthropicKey.substring(0, 10) + '...)' : 'not found'}, openai=${openaiKey ? 'found' : 'not found'}`);
					} catch (storageErr) {
						this.logService.error('[QIC] Failed to retrieve API keys from secret storage:', storageErr);
						this.notificationService.warn(
							localize('qic.secretStorageError', "Orion: Could not retrieve stored API keys. Cloud or Ollama may still work.")
						);
					}

					if (anthropicKey && anthropicKey.trim()) {
						try {
							providers.set('anthropic', new AnthropicAdapter({ apiKey: anthropicKey }, this.requestService));
						} catch (err) {
							this.logService.warn('[QIC] Failed to initialize Anthropic provider:', err);
							this.notificationService.warn(
								localize('qic.anthropicInitFailed', "Orion: Anthropic API key may be invalid. Run 'Orion: Set API Key' to update it.")
							);
						}
					}
					if (openaiKey && openaiKey.trim()) {
						try {
							providers.set('openai', new OpenAIAdapter({ apiKey: openaiKey }, this.requestService));
						} catch (err) {
							this.logService.warn('[QIC] Failed to initialize OpenAI provider:', err);
							this.notificationService.warn(
								localize('qic.openaiInitFailed', "Orion: OpenAI API key may be invalid. Run 'Orion: Set API Key' to update it.")
							);
						}
					}
				}

				// --- Local adapter (always available) ---
				// Pass requestService to bypass CSP restrictions in the renderer
				try {
					providers.set('ollama', new OllamaAdapter({ baseUrl: ollamaUrl }, this.requestService));
				} catch (err) {
					this.logService.warn('[QIC] Failed to initialize Ollama provider:', err);
				}

				// --- Build infrastructure (must precede DegradationManager hookup) ---
				const rateLimiter = new RateLimiter();
				const circuitBreakers = new Map<string, CircuitBreaker>(
					[...providers.keys()].map(id => [id, new CircuitBreaker()])
				);

				// Bug B: Event-driven retry — when Delta Plus token is written or refreshed
				// (ServerApiClient.persistTokens() writes to the same SecretStorage key),
				// late-register the adapter if it was absent at startup.
				// providers and circuitBreakers are shared by reference with Gateway and
				// ModelRegistry — mutating the Map is all that's needed.
				this._disposableStore.add(
					this.secretStorageService.onDidChangeSecret(async (changedKey: string) => {
						if (changedKey !== QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN) { return; }
						const currentMode = this.configurationService.getValue<ConnectionMode>(QIC_SETTINGS.CONNECTION_MODE);
						if (currentMode !== 'server') { return; }
						const newToken = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN);
						if (!newToken) { return; }
						if (providers.has('deltaplus')) {
							// Adapter already live — push the fresh token into its in-memory config.
							const liveRefresh = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_REFRESH_TOKEN) ?? undefined;
							const liveExpiry = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_TOKEN_EXPIRES_AT);
							const liveExpiryMs = liveExpiry ? parseInt(liveExpiry, 10) : undefined;
							this._deltaplusAdapter?.updateTokens(newToken, liveRefresh, liveExpiryMs);
							this.logService.info('[QIC] Delta Plus adapter tokens updated from SecretStorage');
							return;
						}
						// Server came online after startup failed — late-register the provider.
						this.logService.info('[QIC] Delta Plus token appeared after startup — registering provider');
						try {
							const lateServerUrl = this.configurationService.getValue<string>(QIC_SETTINGS.SERVER_BASE_URL) ?? 'https://api.deltaplus.io';
							const newRefresh = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_REFRESH_TOKEN) ?? undefined;
							const storedExpiry = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_TOKEN_EXPIRES_AT);
							const newExpiry = storedExpiry ? parseInt(storedExpiry, 10) : undefined;
							const lateAdapter = new DeltaPlusAdapter({
								baseUrl: lateServerUrl,
								accessToken: newToken,
								refreshToken: newRefresh,
								tokenExpiresAt: newExpiry,
								onTokenRefresh: async (newAccess, newRefreshToken) => {
									await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN, newAccess);
									if (newRefreshToken) {
										await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_REFRESH_TOKEN, newRefreshToken);
									}
									const newExp = this.decodeJwtExp(newAccess);
									if (newExp) {
										await this.secretStorageService.set(QIC_SECRET_KEYS.DELTAPLUS_TOKEN_EXPIRES_AT, String(newExp));
									}
								},
								loginFallback: async () => {
									this.logService.warn('[QIC] Delta Plus token refresh failed (late adapter) — user must re-authenticate');
									throw new Error('Delta Plus session expired. Please sign in again via the account menu.');
								},
							}, this.requestService);
							providers.set('deltaplus', lateAdapter);
							this._deltaplusAdapter = lateAdapter;
							circuitBreakers.set('deltaplus', new CircuitBreaker());
							this.logService.info('[QIC] Delta Plus provider registered after server reconnect');
							this.notificationService.info(
								localize('qic.dpReconnected', "Orion: Delta Plus Server is now connected.")
							);
						} catch (err) {
							this.logService.warn('[QIC] Delta Plus late-registration failed:', err);
						}
					})
				);

				// Validate lane override providers exist
				for (const [lane, providerId] of Object.entries(laneOverrides)) {
					if (!providers.has(providerId)) {
						this.logService.warn(`[QIC] Lane override for '${lane}' references unknown provider: ${providerId}`);
					}
				}

				modelRegistry = new ModelRegistry(providers, undefined, laneOverrides);

				// --- DegradationManager hookup (deferred: wired in Step 8 after DegradationManager creation) ---
				// Store circuit breakers ref for Step 8 wiring
				this._cloudCircuitBreaker = providers.has('quantlab-cloud') ? circuitBreakers.get('quantlab-cloud') : undefined;
				this._hasByokProvider = providers.has('anthropic') || providers.has('openai');
				this._hasLocalProvider = providers.has('ollama');

				// --- Provider diagnostics ---
				this.logService.info(`[QIC] Gateway initialized: ${providers.size} provider(s) — [${[...providers.keys()].join(', ')}]`);
				this.logService.info(`[QIC] Connection mode: ${connectionMode}, cloud enabled: ${cloudEnabled}`);

				// --- User guidance ---
				if (providers.size === 0) {
					this.notificationService.warn(
						localize('qic.noProviders',
							"Orion: No AI providers configured. Connect to the Delta Plus server, sign in to Quantlab Cloud, or configure API keys.")
					);
				} else if (!providers.has('deltaplus') && connectionMode === 'server') {
					this.notificationService.info(
						localize('qic.serverConnect',
							"Orion: Delta Plus Server not connected. Ensure the server is running and you are logged in, or switch connection mode.")
					);
				} else if (!providers.has('quantlab-cloud') && connectionMode === 'cloud') {
					this.notificationService.info(
						localize('qic.cloudSignIn',
							"Orion: Quantlab Cloud not configured. Run 'Orion: Sign In' from the Command Palette, or switch to BYOK mode.")
					);
				} else if (providers.size === 1 && providers.has('ollama')) {
					this.logService.warn('[QIC] No API keys configured — only local Ollama available');
					this.notificationService.info(
						localize('qic.noApiKeys',
							"Orion: No API keys configured. Using local Ollama only. To add Anthropic or OpenAI, run 'Orion: Set API Key' from the Command Palette (Ctrl+Shift+P).")
					);
				}


				// --- DataTier sync (with backwards compat for legacy TELEMETRY_ENABLED) ---
				let dataTier = this.configurationService.getValue<DataTier>(QIC_SETTINGS.DATA_TIER) ?? 'private';
				// Backwards compat: if legacy telemetry.enabled is true and dataTier wasn't explicitly changed
				const legacyTelemetry = this.configurationService.getValue<boolean>(QIC_SETTINGS.TELEMETRY_ENABLED);
				if (legacyTelemetry && dataTier === 'private') {
					dataTier = 'anonymous-metrics';
					this.logService.info('[QIC] Legacy telemetry.enabled=true mapped to dataTier=anonymous-metrics');
				}
				await consentStore.syncDataTier(dataTier);
				this._disposableStore.add(
					this.configurationService.onDidChangeConfiguration(e => {
						if (e.affectsConfiguration('qic.dataTier')) {
							const newTier = this.configurationService.getValue<DataTier>(QIC_SETTINGS.DATA_TIER) ?? 'private';
							void consentStore.syncDataTier(newTier);
						}
					})
				);

				// --- Build gateway ---
				gateway = new Gateway(providers, rateLimiter, circuitBreakers, egressEnforcer, secretScanner, modelRegistry);
			});

			// Step 7: Context engine
			await this.step('context', async () => {
				const embeddingService = new SecureEmbeddingService(gateway);
				indexer = new IncrementalIndexer(db, embeddingService);
				contextAssembler = new ContextAssembler(indexer, this.fileService, workspacePath, this.markerService);
			});

			// Step 8: Agent runtime
			await this.step('runtime', async () => {
				// Supporting components
				const memoryManager = new MemoryManager();
				degradationManager = new DegradationManager(memoryManager, gateway);

				// DegradationManager <-> cloud circuit breaker hookup (HIGH-13)
				if (this._cloudCircuitBreaker) {
					this._cloudCircuitBreaker.onStateChange((state: 'open' | 'closed' | 'half-open') => {
						if (state === 'open') {
							if (this._hasByokProvider) {
								degradationManager.setLevel(1);       // ReducedQuality
							} else if (this._hasLocalProvider) {
								degradationManager.setLevel(3);       // LocalOnly
							} else {
								degradationManager.setLevel(4);       // Emergency
							}
						} else if (state === 'closed') {
							degradationManager.setLevel(0);           // Normal
						}
					});
				}

				const cancellationManager = new CancellationManager();
				const timeoutManager = new TimeoutManager();
				const laneRouter = new LaneRouter();

				// Mutation engine
				const atomicWriter = new JournaledAtomicWriter(journalDir);
				const conflictDetector = new ConflictDetector();
				const flexibleMatcher = new FlexibleMatcher();
				const mutationEngine = new MutationEngine(atomicWriter, conflictDetector, flexibleMatcher);

				// UI service
				uiService = new QicUIService();

				// Permission + tool routing
				const permissionStore = new InMemoryPermissionStore();
				const permissionManager = new PermissionManager(permissionStore, uiService);
				const toolRouter = new ToolRouter(permissionManager, auditLogger);
				const stepExecutor = new StepExecutor(toolRouter);

				// Quality signal instrumentation (Phase 5 prerequisite — local-only)
				// Note: Moved before orchestrator to pass as dependency
				qualitySignalService = new QualitySignalService();
				qualitySignalService.setDatabase(db);

				// Dynamic tool selector (token-budget-aware tool filtering)
				const dynamicToolSelector = new DynamicToolSelector();

				// Orchestrator (BYOK Optimization: pass configurationService for response style)
				orchestrator = new AgentOrchestrator(
					agentState, conversationState, laneRouter, contextAssembler,
					gateway, toolRouter, stepExecutor, mutationEngine,
					uiService, cancellationManager, timeoutManager, secretScanner,
					workspacePath, modelRegistry, qualitySignalService, this.configurationService,
					dynamicToolSelector
				);

				// Checkpoint
				const checkpointDir = URI.joinPath(storageBase, 'checkpoints').fsPath;
				const checkpointValidator = new CheckpointValidator(workspacePath);
				checkpointManager = new TransactionSafeCheckpointManager(
					atomicWriter, checkpointValidator, secretScanner, checkpointDir
				);

				// Wire checkpoint manager to mutation engine for revert support
				mutationEngine.setCheckpointManager(checkpointManager);

				// Register all 22 tools
				registerAllTools(toolRouter, {
					fileOps: new FileOperationTools(workspacePath, secretScanner, this.fileService),
					search: new SearchTools(indexer, workspacePath, this.fileService),
					reference: new ReferenceTools(this.languageFeaturesService, this.textModelService, workspacePath),
					terminal: new TerminalTools(terminalGuard, workspacePath),
					network: new NetworkTools(egressEnforcer, secretScanner),
					packages: new PackageTools(terminalGuard, workspacePath),
					lsp: new LspTools(),
					notebook: new NotebookTools(null, null, workspacePath, this.fileService),
					checkpoint: new CheckpointTools(checkpointManager),
					git: new GitTools(workspacePath),
				});

				// Store runtime on QicService for ViewPane wiring and command access
				this.qicService.setRuntime({ orchestrator, uiService, degradationManager, checkpointManager, gateway, qualitySignalService, consentStore });
			});

			// Step 8b: Status bar registration + cloud wiring
			{
				const statusBar = new QicStatusBarContribution();
				const connectionMode = this.configurationService.getValue<ConnectionMode>(QIC_SETTINGS.CONNECTION_MODE) ?? 'cloud';
				statusBar.setConnectionMode(connectionMode);

				const statusBarEntry = this.statusbarService.addEntry(
					{
						name: 'Orion',
						text: statusBar.getDisplayText(),
						tooltip: statusBar.getTooltipText(),
						ariaLabel: 'Orion Status',
						command: QIC_VIEW_CONTAINER_ID,
					},
					'qic.statusbar',
					StatusbarAlignment.RIGHT,
					100,
				);
				this._disposableStore.add(statusBarEntry);

				// Wire DegradationManager → status bar
				statusBar.onDidChange(() => {
					statusBarEntry.update({
						name: 'Orion',
						text: statusBar.getDisplayText(),
						tooltip: statusBar.getTooltipText(),
						ariaLabel: 'Orion Status',
						command: QIC_VIEW_CONTAINER_ID,
					});
				});

				degradationManager!.onDegradationChange((level: number) => {
					statusBar.updateFromDegradation(level);
				});

				// Wire cloud adapter routing → status bar model name
				if (this._cloudAdapter) {
					this._disposableStore.add(
						this._cloudAdapter.onRouting(info => {
							statusBar.setModelName(info.actualModel);
						})
					);

					// Wire quota listener → UI notifications
					this._disposableStore.add(
						this._cloudAdapter.onQuotaUpdated(quotaInfo => {
							if (quotaInfo.warning) {
								this.notificationService.info(
									localize('qic.quotaWarning', "Orion: {0} Resets {1}.", quotaInfo.warning, quotaInfo.resetAt ?? 'soon')
								);
							}
						})
					);
				}

				// Telemetry service setup (cloud transport + periodic flush)
				// consentStore + egressEnforcer guaranteed assigned by Step 4 (security)
				this._telemetryService = new TelemetryService(consentStore!, egressEnforcer!);
				const dataTier = this.configurationService.getValue<DataTier>(QIC_SETTINGS.DATA_TIER) ?? 'private';
				this._telemetryService.setDataTier(dataTier);
				this._disposableStore.add(
					this.configurationService.onDidChangeConfiguration(e => {
						if (e.affectsConfiguration('qic.dataTier')) {
							const newTier = this.configurationService.getValue<DataTier>(QIC_SETTINGS.DATA_TIER) ?? 'private';
							this._telemetryService?.setDataTier(newTier);
						}
					})
				);
				if (this._cloudAdapter) {
					const adapter = this._cloudAdapter;
					this._telemetryService.setCloudTransport(
						this.configurationService.getValue<string>(QIC_SETTINGS.CLOUD_BASE_URL) ?? 'https://api.quantlab.dev',
						() => adapter['config'].accessToken,
					);
				}
				this._telemetryService.startPeriodicFlush();
			}

			// Step 8c: Enhanced startup lifecycle (non-blocking diagnostics)
			if (this._cloudAdapter) {
				const adapter = this._cloudAdapter;
				// Health check
				adapter.getHealth().then(health => {
					this.logService.info(`[QIC] Cloud health: ${health.status}, latency: ${health.latencyMs}ms`);
				}).catch(err => {
					this.logService.warn('[QIC] Cloud health check failed:', err);
				});

				// Check subscription
				adapter.getSubscription().then(sub => {
					this.logService.info(`[QIC] Subscription: plan=${sub.plan}, status=${sub.status}`);
					if (sub.status !== 'active' && sub.status !== 'trialing') {
						this.notificationService.info(
							localize('qic.subscriptionInactive', "Orion: Your Quantlab subscription is {0}. Some features may be limited.", sub.status)
						);
					}
				}).catch(err => {
					this.logService.warn('[QIC] Subscription check failed:', err);
				});

				// Get regions
				adapter.getRegions().then(regions => {
					this.logService.info(`[QIC] Available regions: ${regions.filter(r => r.available).map(r => r.id).join(', ')}`);
				}).catch(err => {
					this.logService.warn('[QIC] Region check failed:', err);
				});
			}

			// Step 9: Completion engine + inline provider registration
			await this.step('completion', async () => {
				const sessionCache = new SessionCache();
				const completionEngine = new CompletionEngine(
					gateway, contextAssembler, modelRegistry,
					degradationManager, consentStore, sessionCache
				);

				const qicProvider = new QicInlineCompletionProvider(completionEngine, qualitySignalService);
				const adapter = new QicInlineCompletionAdapter(qicProvider);
				this._disposableStore.add(
					this.languageFeaturesService.inlineCompletionsProvider.register('*', adapter as any)
				);

				// Phase 5 (05-04): Register CodeLens provider for diff views
				const codeLensProvider = new QicCodeLensProvider(this.languageFeaturesService, this.stateService);
				this._disposableStore.add(codeLensProvider);
			});

			// Step 10: Background indexing (non-blocking)
			this.step('indexing', async () => {
				await indexer.indexWorkspace(workspacePath);
			}).catch(() => {
				this.qicService.addDegradedFeature('code-search');
				this.notificationService.warn(
					localize('qic.indexingFailed', "Orion: Code search unavailable — indexing failed")
				);
			});

			this.qicService.setState('ready');
		} catch (error) {
			this.handleActivationFailure(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * AUDIT FIX I-4: Handle partial activation failure.
	 * Transition to degraded mode instead of crashing.
	 */
	private handleActivationFailure(error: Error): void {
		const failedStep = this._currentStep || 'unknown';
		this.logService.error(`[QIC] Activation failed at step "${failedStep}":`, error);

		this.qicService.setState('degraded');
		this.notificationService.warn(
			localize('qic.activationFailed', "Orion: Partial activation (failed at {0}). Some features unavailable.", failedStep)
		);
	}

	private _currentStep = '';

	/**
	 * Decode the `exp` claim from a JWT without verification.
	 * Returns epoch ms or undefined.
	 */
	private decodeJwtExp(token: string): number | undefined {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) { return undefined; }
			const payload = JSON.parse(atob(parts[1])) as { exp?: number };
			if (typeof payload.exp === 'number') {
				return payload.exp * 1000;
			}
		} catch {
			// Not a valid JWT
		}
		return undefined;
	}

	private async step(name: string, fn: () => Promise<void>): Promise<void> {
		this._currentStep = name;
		try {
			await fn();
			this.qicService.addCompletedStep(name);
		} catch (error) {
			this.logService.error(`[QIC] Activation step "${name}" failed:`, error);
			throw error;
		}
	}

	override dispose(): void {
		// Flush telemetry (best-effort)
		this._telemetryService?.flush().catch(() => { /* best-effort */ });
		this._telemetryService?.stopPeriodicFlush();

		// Dispose cloud adapter (clears proactive refresh timer + cancels active requests)
		this._cloudAdapter?.dispose();

		// Dispose Delta Plus adapter
		this._deltaplusAdapter?.dispose();

		// Persist last known token expiry (best-effort)
		if (this._cloudAdapter) {
			const expiresAt = (this._cloudAdapter as any).config?.tokenExpiresAt;
			if (expiresAt) {
				void this.secretStorageService.set(QIC_SECRET_KEYS.CLOUD_TOKEN_EXPIRES_AT, String(expiresAt));
			}
		}

		super.dispose();
	}
}

registerWorkbenchContribution2(QicActivation.ID, QicActivation, WorkbenchPhase.AfterRestored);
