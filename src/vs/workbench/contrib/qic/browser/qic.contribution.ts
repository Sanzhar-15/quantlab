/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
	QIC_SIGN_IN_COMMAND_ID,
	QIC_SIGN_OUT_COMMAND_ID,
	QIC_ACCOUNT_INFO_COMMAND_ID,
	QIC_PANEL_VISIBLE_CONTEXT,
	QIC_SETTINGS,
	QIC_STORAGE_DIRS,
	type ConnectionMode,
	type DataTier,
} from '../common/constants.js';
import { IQicService, QicService } from '../common/qicService.js';

// Structural view of the persisted conversation state used by the change-set actions.
interface PendingChangesState {
	conversation?: {
		pendingChanges?: {
			id?: string;
			changes?: Array<{ id: string; status?: string }>;
		};
	};
}
import { QicChatViewPane } from './qicPanel.js';
import { IQicChatService, QicChatService } from './qicChatService.js';
import { QicChatAgent } from './qicChatAgent.js';

// QIC component imports -- storage & crash safety
import { QicDatabase } from '../common/storage/database.js';
import { StatePersistenceManager } from '../common/storage/statePersistence.js';
import { JournaledAtomicWriter } from '../common/crashSafe/journaledAtomicWriter.js';
import { TransactionSafeCheckpointManager } from '../common/crashSafe/checkpointManager.js';
import { CheckpointValidator } from '../common/crashSafe/checkpointValidity.js';

// QIC component imports -- state
import { PersistentAgentStateMachine } from '../common/state/agentStateMachine.js';
import { ConversationState } from '../common/state/conversationState.js';
import { IQicStateService, QicStateService } from '../common/state/qicStateService.js';

// QIC component imports -- security
import { OptimizedSecretScanner } from '../common/security/secretScanner.js';
import { ConsentStore } from '../common/security/consentStore.js';
import { EgressBoundaryEnforcer } from '../common/security/egressEnforcer.js';
import { ArgumentAnalyzer } from '../common/security/argumentAnalyzer.js';
import { TerminalSecurityGuard } from '../common/security/terminalGuard.js';
import { HashChainedAuditLogger } from '../common/security/auditLogger.js';
import { FirstRunManager } from '../common/security/firstRunManager.js';

// QIC component imports -- gateway & providers
import { Gateway } from '../common/gateway/gateway.js';
import { ModelRegistry } from '../common/gateway/modelRegistry.js';
import { RateLimiter } from '../common/gateway/rateLimiter.js';
import { DeltaPlusAdapter } from '../common/gateway/providers/deltaplusAdapter.js';
import { CircuitBreaker } from '../common/recovery/circuitBreaker.js';

// QIC component imports -- auth
import { IQuantlabHostIdentityService, QuantlabHostError } from '../../../services/quantlabHostIdentity/common/quantlabHostIdentity.js';

// QIC component imports -- context & embeddings
import { SecureEmbeddingService } from '../common/context/secureEmbedding.js';
import { IncrementalIndexer } from '../common/context/incrementalIndexer.js';
import { ContextAssembler } from '../common/context/contextAssembler.js';

// QIC component imports -- runtime & orchestration
import { AgentOrchestrator } from '../common/runtime/agentOrchestrator.js';
import { DynamicToolSelector } from '../common/context/dynamicToolSelector.js';
import { ToolRouter } from '../common/runtime/toolRouter.js';
import { LaneRouter } from '../common/runtime/laneRouter.js';
import { StepExecutor } from '../common/runtime/stepExecutor.js';
import { PermissionManager, type PermissionStore } from '../common/runtime/permissionManager.js';
import type { PermissionCheckResult } from '../common/canonical/types.js';
import type { ProviderAdapter } from '../common/canonical/interfaces.js';

// QIC component imports -- mutation
import { MutationEngine } from '../common/mutation/mutationEngine.js';
import { ConflictDetector } from '../common/mutation/conflictDetector.js';
import { FlexibleMatcher } from '../common/mutation/flexibleMatcher.js';

// QIC component imports -- resilience & lifecycle
import { MemoryManager } from '../common/resilience/memoryManager.js';
import { DegradationManager } from '../common/resilience/degradationManager.js';
import { CancellationManager } from '../common/cancellation/cancellationManager.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Position } from '../../../../editor/common/core/position.js';
import { TimeoutManager } from '../common/timeout/timeoutManager.js';
import { SessionCache } from '../common/telemetry/sessionCache.js';
import { QualitySignalService } from '../common/telemetry/qualitySignalService.js';
import { TelemetryService } from '../common/telemetry/telemetryService.js';

// QIC component imports -- completion
import { CompletionEngine } from '../common/completion/completionEngine.js';
import { QicInlineCompletionProvider } from './qicInlineCompletionProvider.js';

// QIC component imports -- tools
import { registerAllTools } from '../common/tools/toolRegistration.js';
import { FileOperationTools } from '../common/tools/fileOps.js';
import { SearchTools } from '../common/tools/searchTools.js';
import { ReferenceTools } from '../common/tools/referenceTools.js';
import { TerminalTools } from '../common/tools/terminalTools.js';
import { PackageTools } from '../common/tools/packageTools.js';
import { LspTools } from '../common/tools/lspTools.js';
import { NotebookTools } from '../common/tools/notebookTools.js';
import { CheckpointTools } from '../common/tools/checkpointTools.js';
import { GitTools } from '../common/tools/gitTools.js';

// QIC component imports -- UI
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
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { QicStatusBarContribution } from './qicStatusBarItem.js';

// ---------------------------------------------------------------------------
// 1. Register IQicService singleton (delayed -- created on first access)
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
			enum: ['server'],
			enumDescriptions: [
				localize('qic.connectionMode.server', "Delta Plus Server -- uses your sign-in at the Quantlab terminal view, through the host"),
			],
			description: localize('qic.connectionMode', "How QIC connects to AI models. The only mode is the Delta Plus Server through the host."),
		},
		[QIC_SETTINGS.DATA_TIER]: {
			type: 'string',
			default: 'private',
			enum: ['private', 'anonymous-metrics', 'data-contributor'],
			enumDescriptions: [
				localize('qic.dataTier.private', "Private -- no telemetry data sent"),
				localize('qic.dataTier.anonymous', "Anonymous Metrics -- latency, accept/reject rates, lane usage (no code content)"),
				localize('qic.dataTier.contributor', "Data Contributor -- full interaction data including code (for model improvement)"),
			],
			description: localize('qic.dataTier', "Controls what data QIC shares with Quantlab."),
		},
		[QIC_SETTINGS.LANE_OVERRIDES]: {
			type: 'object',
			default: {},
			description: localize('qic.laneOverrides', "Override the connection path for specific lanes. Maps lane names to provider IDs."),
		},
		// Removed: qic.experimental.newHeader -- no longer relevant after migration to native ChatWidget
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

// Open Orion with a prompt and submit it (programmatic entry point for
// "Fix with Orion" style actions from other parts of the product).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'qic.openWithPrompt',
			title: localize2('qic.openWithPrompt', "Orion: Open With Prompt"),
			f1: false,
		});
	}
	async run(accessor: ServicesAccessor, prompt?: unknown): Promise<void> {
		if (typeof prompt !== 'string' || !prompt.trim()) {
			throw new Error('qic.openWithPrompt requires a non-empty prompt string.');
		}
		const viewsService = accessor.get(IViewsService);
		const view = await viewsService.openView(QIC_CHAT_VIEW_ID, true);
		if (!(view instanceof QicChatViewPane)) {
			throw new Error('Orion chat view is not available.');
		}
		await view.submitPrompt(prompt);
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
					description: `${cp.createdAt} -- ${cp.fileCount} files`,
					id: cp.id,
				})),
				{ placeHolder: localize('qic.selectCheckpoint', "Select a checkpoint to restore") },
			);
			if (pick && Object.prototype.hasOwnProperty.call(pick, 'id')) {
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

// Sign In -- the Quantlab terminal view owns sign-in (QL-LOGIN); QIC holds no login of its own
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SIGN_IN_COMMAND_ID,
			title: localize2('qic.signIn', "Orion: Sign In"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(INotificationService).info(
			localize('qic.signInAtTerminal', "Orion: Sign in from the Quantlab terminal view. QIC has no sign-in of its own.")
		);
	}
});

// Sign Out -- the Quantlab terminal view owns sign-out (QL-LOGIN)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_SIGN_OUT_COMMAND_ID,
			title: localize2('qic.signOut', "Orion: Sign Out"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// The host's sign-out (every view); the service asks the user first. Stores empty on the host's `changed` tick.
		const hostIdentity = accessor.get(IQuantlabHostIdentityService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		try {
			await hostIdentity.signOut();
		} catch (error) {
			logService.error('[QIC] Sign Out: the host did not sign out:', error);
			if (error instanceof QuantlabHostError) {
				notificationService.error(
					localize('qic.signOut.refused', "Orion: Sign out failed ({0}): {1}", error.code, error.message)
				);
			} else {
				notificationService.error(
					localize('qic.signOut.failed', "Orion: Sign out failed, the host gave no answer: {0}", error instanceof Error ? error.message : String(error))
				);
			}
		}
	}
});

// Account Info -- asks the host identity (no token is read or decoded here)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QIC_ACCOUNT_INFO_COMMAND_ID,
			title: localize2('qic.accountInfo', "Orion: Account Info"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const hostIdentity = accessor.get(IQuantlabHostIdentityService);
		const notificationService = accessor.get(INotificationService);
		const configService = accessor.get(IConfigurationService);
		const logService = accessor.get(ILogService);

		const connectionMode = configService.getValue<string>(QIC_SETTINGS.CONNECTION_MODE);

		try {
			const identity = await hostIdentity.getIdentity();
			if (!identity.signedIn) {
				notificationService.info(
					localize('qic.accountInfo.notSignedIn',
						"Orion: Not signed in. Connection mode: {0}. Sign in from the Quantlab terminal view.",
						connectionMode)
				);
				return;
			}
			notificationService.info(
				localize('qic.accountInfo.details',
					"Orion Account: {0}\nMode: {1}",
					identity.user.name ? `${identity.user.name} <${identity.user.email}>` : identity.user.email,
					connectionMode)
			);
		} catch (error) {
			logService.error('[QIC] Account Info: could not read the host sign-in state:', error);
			notificationService.error(
				localize('qic.accountInfo.failed', "Orion: Could not read the sign-in state from the host: {0}", error instanceof Error ? error.message : String(error))
			);
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
		if (!changeId) { return; }

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
		if (!changeId) { return; }

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
		if (!changeId) { return; }

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
		if (!changeSetId) { return; }

		const qicService = accessor.get(IQicService);
		const stateService = accessor.get(IQicStateService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();

		// Get the change set from state
		const state = stateService.state as unknown as PendingChangesState;
		const pendingChanges = state.conversation?.pendingChanges;
		const changeSet = pendingChanges?.id === changeSetId ? pendingChanges : null;

		if (!changeSet) {
			notificationService.warn(localize('qic.changeSetNotFound', "Orion: Change set not found"));
			return;
		}

		// Apply all pending changes
		const pendingChangesToApply = changeSet.changes?.filter(c => c.status === 'pending') || [];
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
		if (!changeSetId) { return; }

		const qicService = accessor.get(IQicService);
		const stateService = accessor.get(IQicStateService);
		const notificationService = accessor.get(INotificationService);
		const runtime = qicService.getRuntime();

		// Get the change set from state
		const state = stateService.state as unknown as PendingChangesState;
		const pendingChanges = state.conversation?.pendingChanges;
		const changeSet = pendingChanges?.id === changeSetId ? pendingChanges : null;

		if (!changeSet) {
			notificationService.warn(localize('qic.changeSetNotFound', "Orion: Change set not found"));
			return;
		}

		// Reject all pending changes
		const pendingChangesToReject = changeSet.changes?.filter(c => c.status === 'pending') || [];
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
			const state = stateService.state as unknown as PendingChangesState;
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
// QicInlineCompletionAdapter -- bridges QicInlineCompletionProvider to VS Code's
// InlineCompletionsProvider interface used by ILanguageFeaturesService.
// ---------------------------------------------------------------------------

class QicInlineCompletionAdapter {
	readonly groupId = QicInlineCompletionProvider.groupId;
	readonly yieldsToGroupIds = QicInlineCompletionProvider.yieldsToGroupIds;

	constructor(private readonly inner: QicInlineCompletionProvider) { }

	async provideInlineCompletions(
		model: ITextModel, position: Position, _context: unknown, token: CancellationToken,
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
		// Item was shown to user -- already tracked in provideInlineCompletions
	}

	handlePartialAccept(): void {
		// Partial accept -- confirmation requires document change correlation (Phase 5b)
		// For now, we track "shown" but defer accept/reject determination
		const completion = this.inner.getLastCompletion();
		if (completion) {
			this.inner.confirmAcceptance(completion);
		}
	}

	freeInlineCompletions(): void {
		// Called when completions are dismissed/freed (both accept AND reject cases)
		// Cannot distinguish here -- delegate to provider for cleanup
		this.inner.freeInlineCompletions([]);
	}
}

// ---------------------------------------------------------------------------
// InMemoryPermissionStore -- simple in-memory implementation of PermissionStore
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

/**
 * The one connection mode is `server` (the Delta Plus Server through the host). Cloud, BYOK and local
 * were retired: a value left in a user's settings is a visible error, never read as `server`.
 */
function readConnectionMode(configurationService: IConfigurationService): ConnectionMode {
	const mode = configurationService.getValue<unknown>(QIC_SETTINGS.CONNECTION_MODE);
	if (mode !== 'server') {
		throw new Error(`[QIC] qic.connectionMode is '${String(mode)}', but the only connection mode is 'server' (cloud, byok and local were retired). Remove the setting or set it to 'server'.`);
	}
	return mode;
}

// ---------------------------------------------------------------------------
// 6. QIC Activation -- Phase A (sync) + Phase B (async)
// AUDIT FIX IV-AO3: Split to avoid 60s activation timeout
// AUDIT FIX XII-AR4: All components in DisposableStore
// ---------------------------------------------------------------------------

class QicActivation extends Disposable {

	static readonly ID = 'workbench.contrib.qic.activation';

	private readonly _disposableStore = this._register(new DisposableStore());

	// Delta Plus adapter (registered in Step 6 iff the host identity says signed in)
	private _deltaplusAdapter: DeltaPlusAdapter | undefined;
	// Latest-pull-wins guard for host identity ticks
	private _identityPull = 0;
	private _telemetryService: TelemetryService | undefined;

	constructor(
		@IQicService private readonly qicService: IQicService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ICommandService private readonly commandService: ICommandService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IQuantlabHostIdentityService private readonly hostIdentityService: IQuantlabHostIdentityService,
		@IQicStateService private readonly stateService: IQicStateService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super();

		// Register QIC as a native chat participant
		this._register(this.instantiationService.createInstance(QicChatAgent));

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

		// Register connection config change listener unconditionally -- before the try block
		// so it cannot be skipped by any thrown exception in any initialization step.
		this._disposableStore.add(
			this.configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('qic.connectionMode')) {
					this.logService.info('[QIC] Connection configuration changed -- reload required');
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
						// Directory may already exist -- that's fine
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

			// Step 1: Crash recovery (non-fatal -- fs may be unavailable in sandbox)
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
				this.logService.warn('[QIC] Crash recovery unavailable (sandboxed renderer) -- skipping.', err);
				this.qicService.addCompletedStep('crash-recovery'); // Mark as completed so error reporting is accurate
			}

			// Step 2: Database initialization (AUDIT FIX XII-AR1)
			await this.step('database', async () => {
				const dbPath = URI.joinPath(storageBase, 'qic.db').fsPath;
				db = new QicDatabase(dbPath);
				await db.initialize();
				if (db.isInMemory) {
					this.logService.warn('[QIC] Native SQLite unavailable (sandboxed renderer) -- using in-memory storage. Data will not persist across sessions.');
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
					// Show consent dialog -- user must explicitly enable AI features
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
						this.logService.info('[QIC] First-run consent granted -- AI features enabled');
					} else {
						this.qicService.setState('degraded');
						this.qicService.addDegradedFeature('llm');
						this.logService.warn('[QIC] First-run consent declined -- LLM features degraded');
						return;
					}
				} else if (!firstRunResult.canProceed) {
					this.qicService.setState('degraded');
					this.qicService.addDegradedFeature('llm');
					this.logService.warn('[QIC] Required consent not granted -- LLM features degraded');
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

				const connectionMode = readConnectionMode(this.configurationService);
				const laneOverrides = this.configurationService.getValue<Record<string, string>>(QIC_SETTINGS.LANE_OVERRIDES) ?? {};
				const providers = new Map<string, ProviderAdapter>();

				// Validate lane overrides (warn about invalid entries)
				const validLanes = new Set(['completion', 'chat-ask', 'chat-gather', 'chat-plan', 'chat-act', 'repair', 'fast-apply', 'summarize']);
				for (const [lane, _provider] of Object.entries(laneOverrides)) {
					if (!validLanes.has(lane)) {
						this.logService.warn(`[QIC] Unknown lane in overrides: ${lane}`);
					}
				}

				// --- Delta Plus Server adapter: QIC's one backend path, through the host's workbench service ---
				// QIC holds no credential and no server address: the adapter is registered iff the host identity
				// says a user is signed in. A host that cannot answer rejects here and fails this step loudly (step() logs it).
				const identity = await this.hostIdentityService.getIdentity();
				if (identity.signedIn) {
					const deltaplusAdapter = this.createDeltaPlusAdapter();

					// Register immediately -- blocking startup on the health check is user-visible latency.
					// A refusal (the host answers `no-route` until QIC's server route exists) is logged and shown.
					providers.set('deltaplus', deltaplusAdapter);
					this._deltaplusAdapter = deltaplusAdapter;
					this.logService.info('[QIC] Delta Plus adapter registered (background health check through the host starting)');
					void deltaplusAdapter.getHealth().then(health => {
						this.logService.info(`[QIC] Delta Plus health: ${health.status}, latency: ${String(health.latencyMs)}ms`);
					}).catch(err => {
						this.logService.error('[QIC] The host refused the Delta Plus health check:', err);
						this.notificationService.warn(
							localize('qic.serverHealthRefused', "Orion: The host refused the Delta Plus health check: {0}", err instanceof Error ? err.message : String(err))
						);
					});
				} else {
					this.logService.info('[QIC] Not signed in at the host -- the Delta Plus adapter registers when the host reports a sign-in');
				}

				// --- Build infrastructure (must precede DegradationManager hookup) ---
				const rateLimiter = new RateLimiter();
				const circuitBreakers = new Map<string, CircuitBreaker>(
					[...providers.keys()].map(id => [id, new CircuitBreaker()])
				);

				// The host identity tick registers the Delta Plus adapter on sign-in and removes it on sign-out.
				// providers and circuitBreakers are shared by reference with Gateway and
				// ModelRegistry -- mutating the Maps is all that's needed.
				this._disposableStore.add(
					this.hostIdentityService.onDidChangeIdentity(() => {
						void this.onHostIdentityChanged(providers, circuitBreakers);
					})
				);

				// Validate lane override providers exist
				for (const [lane, providerId] of Object.entries(laneOverrides)) {
					if (!providers.has(providerId)) {
						this.logService.warn(`[QIC] Lane override for '${lane}' references unknown provider: ${providerId}`);
					}
				}

				modelRegistry = new ModelRegistry(providers, undefined, laneOverrides);

				// --- Provider diagnostics ---
				this.logService.info(`[QIC] Gateway initialized: ${providers.size} provider(s) -- [${[...providers.keys()].join(', ')}]`);
				this.logService.info(`[QIC] Connection mode: ${connectionMode}`);

				// --- User guidance ---
				if (providers.size === 0) {
					this.notificationService.warn(
						localize('qic.noProviders',
							"Orion: No AI provider is registered. Orion connects to the Delta Plus Server through the host: sign in from the Quantlab terminal view.")
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

				// Quality signal instrumentation (Phase 5 prerequisite -- local-only)
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
				statusBar.setConnectionMode(readConnectionMode(this.configurationService));

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

				// Wire DegradationManager -> status bar
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

				// Telemetry service setup (local buffer + periodic flush; there is no telemetry upload)
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
				this._telemetryService.startPeriodicFlush();
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
					this.languageFeaturesService.inlineCompletionsProvider.register('*', adapter as unknown as Parameters<typeof this.languageFeaturesService.inlineCompletionsProvider.register>[1])
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
					localize('qic.indexingFailed', "Orion: Code search unavailable -- indexing failed")
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
	 * Build the Delta Plus adapter. It holds no credential and no server address (QL-LOGIN, QL-DATA):
	 * every call goes through the host's workbench service, which keeps the tokens and the one backend origin.
	 */
	private createDeltaPlusAdapter(): DeltaPlusAdapter {
		return new DeltaPlusAdapter(this.hostIdentityService);
	}

	/**
	 * A host identity tick: pull the identity, then register the Delta Plus adapter on sign-in
	 * or remove it on sign-out. A host that cannot answer is shown to the user and logged,
	 * never treated as signed out.
	 */
	private async onHostIdentityChanged(providers: Map<string, ProviderAdapter>, circuitBreakers: Map<string, CircuitBreaker>): Promise<void> {
		const pull = ++this._identityPull;

		let signedIn: boolean;
		try {
			signedIn = (await this.hostIdentityService.getIdentity()).signedIn;
		} catch (error) {
			this.logService.error('[QIC] Could not read the host sign-in state after a change:', error);
			this.notificationService.error(
				localize('qic.identityPullFailed', "Orion: Could not read the sign-in state from the host: {0}", error instanceof Error ? error.message : String(error))
			);
			return;
		}
		if (pull !== this._identityPull) {
			return; // a later tick pulled a newer answer
		}

		if (signedIn) {
			if (providers.has('deltaplus')) { return; }
			const adapter = this.createDeltaPlusAdapter();
			providers.set('deltaplus', adapter);
			this._deltaplusAdapter = adapter;
			circuitBreakers.set('deltaplus', new CircuitBreaker());
			this.logService.info('[QIC] Delta Plus provider registered after host sign-in');
			this.notificationService.info(
				localize('qic.dpReconnected', "Orion: Delta Plus Server is now connected.")
			);
			return;
		}

		if (!providers.has('deltaplus')) { return; }
		providers.delete('deltaplus');
		circuitBreakers.delete('deltaplus');
		this._deltaplusAdapter?.dispose();
		this._deltaplusAdapter = undefined;
		this.logService.info('[QIC] Delta Plus provider removed after host sign-out');
		this.notificationService.info(
			localize('qic.dpSignedOut', "Orion: Signed out at the host. Delta Plus Server is disconnected.")
		);
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

		// Dispose Delta Plus adapter
		this._deltaplusAdapter?.dispose();

		super.dispose();
	}
}

registerWorkbenchContribution2(QicActivation.ID, QicActivation, WorkbenchPhase.AfterRestored);
