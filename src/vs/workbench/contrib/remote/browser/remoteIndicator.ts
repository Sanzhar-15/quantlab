/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { IRemoteAgentService, remoteConnectionLatencyMeasurer } from '../../../services/remote/common/remoteAgentService.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MenuId, IMenuService, IMenu } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarService, IStatusbarEntryAccessor, IStatusbarEntry } from '../../../services/statusbar/browser/statusbar.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Schemas } from '../../../../base/common/network.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { PlatformName, PlatformToString, isWeb, platform } from '../../../../base/common/platform.js';
import { truncate } from '../../../../base/common/strings.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getRemoteName } from '../../../../platform/remote/common/remoteHosts.js';
import { getVirtualWorkspaceLocation } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { getCodiconAriaLabel } from '../../../../base/common/iconLabels.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionsWorkbenchService, LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID } from '../../extensions/common/extensions.js';
import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { DomEmitter } from '../../../../base/browser/event.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';


interface RemoteExtensionMetadata {
	id: string;
	installed: boolean;
	dependencies: string[];
	isPlatformCompatible: boolean;
	helpLink: string;
	startConnectLabel: string;
	startCommand: string;
	priority: number;
	supportedPlatforms?: PlatformName[];
}

export class RemoteStatusIndicator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.remoteStatusIndicator';

	private static readonly REMOTE_ACTIONS_COMMAND_ID = 'workbench.action.remote.showMenu';

	private static readonly DEFAULT_REMOTE_STATUS_LABEL = '$(remote)';

	private static readonly REMOTE_STATUS_LABEL_MAX_LENGTH = 40;

	private static readonly REMOTE_CONNECTION_LATENCY_SCHEDULER_DELAY = 60 * 1000;
	private static readonly REMOTE_CONNECTION_LATENCY_SCHEDULER_FIRST_RUN_DELAY = 10 * 1000;

	private remoteStatusEntry: IStatusbarEntryAccessor | undefined;

	private readonly remoteIndicatorMenu: IMenu; 				// filters its entries based on the current remote name of the window
	private readonly unrestrictedRemoteIndicatorMenu: IMenu; 	// does not filter its entries based on the current remote name of the window


	private virtualWorkspaceLocation: { scheme: string; authority: string } | undefined = undefined;

	private connectionState: 'initializing' | 'connected' | 'reconnecting' | 'disconnected' | undefined = undefined;
	private connectionToken: string | undefined = undefined;
	private readonly connectionStateContextKey: IContextKey<'' | 'initializing' | 'disconnected' | 'connected'>;

	private networkState: 'online' | 'offline' | 'high-latency' | undefined = undefined;
	private measureNetworkConnectionLatencyScheduler: RunOnceScheduler | undefined = undefined;


	private _remoteExtensionMetadata: RemoteExtensionMetadata[] | undefined = undefined;
	private get remoteExtensionMetadata(): RemoteExtensionMetadata[] {
		if (!this._remoteExtensionMetadata) {
			const remoteExtensionTips = { ...this.productService.remoteExtensionTips, ...this.productService.virtualWorkspaceExtensionTips };
			this._remoteExtensionMetadata = Object.values(remoteExtensionTips).filter(value => value.startEntry !== undefined).map(value => {
				return {
					id: value.extensionId,
					installed: false,
					friendlyName: value.friendlyName,
					isPlatformCompatible: false,
					dependencies: [],
					helpLink: value.startEntry?.helpLink ?? '',
					startConnectLabel: value.startEntry?.startConnectLabel ?? '',
					startCommand: value.startEntry?.startCommand ?? '',
					priority: value.startEntry?.priority ?? 10,
					supportedPlatforms: value.supportedPlatforms
				};
			});

			this.remoteExtensionMetadata.sort((ext1, ext2) => ext1.priority - ext2.priority);
		}

		return this._remoteExtensionMetadata;
	}

	private get remoteAuthority(): string | undefined {
		return this.environmentService.remoteAuthority;
	}

	private remoteMetadataInitialized: boolean = false;
	private readonly _onDidChangeEntries = this._register(new Emitter<void>());

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@ILabelService private readonly labelService: ILabelService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IMenuService private menuService: IMenuService,
		@IQuickInputService quickInputService: IQuickInputService,
		@ICommandService commandService: ICommandService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionsWorkbenchService extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IDialogService dialogService: IDialogService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IOpenerService openerService: IOpenerService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		this.unrestrictedRemoteIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarWindowIndicatorMenu, this.contextKeyService)); // to be removed once migration completed
		this.remoteIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarRemoteIndicatorMenu, this.contextKeyService));

		this.connectionStateContextKey = new RawContextKey<'' | 'initializing' | 'disconnected' | 'connected'>('remoteConnectionState', '').bindTo(this.contextKeyService);

		// Set initial connection state
		if (this.remoteAuthority) {
			this.connectionState = 'initializing';
			this.connectionStateContextKey.set(this.connectionState);
		} else {
			this.updateVirtualWorkspaceLocation();
		}

		this.registerActions();
		this.registerListeners();

		this.updateWhenInstalledExtensionsRegistered();
		this.updateRemoteStatusIndicator();
	}

	private registerActions(): void {
	}

	private registerListeners(): void {

		// Menu changes
		const updateRemoteActions = () => {
			this.updateRemoteStatusIndicator();
		};

		this._register(this.unrestrictedRemoteIndicatorMenu.onDidChange(updateRemoteActions));
		this._register(this.remoteIndicatorMenu.onDidChange(updateRemoteActions));

		// Update indicator when formatter changes as it may have an impact on the remote label
		this._register(this.labelService.onDidChangeFormatters(() => this.updateRemoteStatusIndicator()));

		// Update based on remote indicator changes if any
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator && remoteIndicator.onDidChange) {
			this._register(remoteIndicator.onDidChange(() => this.updateRemoteStatusIndicator()));
		}

		// Listen to changes of the connection
		if (this.remoteAuthority) {
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				this._register(connection.onDidStateChange((e) => {
					switch (e.type) {
						case PersistentConnectionEventType.ConnectionLost:
						case PersistentConnectionEventType.ReconnectionRunning:
						case PersistentConnectionEventType.ReconnectionWait:
							this.setConnectionState('reconnecting');
							break;
						case PersistentConnectionEventType.ReconnectionPermanentFailure:
							this.setConnectionState('disconnected');
							break;
						case PersistentConnectionEventType.ConnectionGain:
							this.setConnectionState('connected');
							break;
					}
				}));
			}
		} else {
			this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => {
				this.updateVirtualWorkspaceLocation();
				this.updateRemoteStatusIndicator();
			}));
		}

		// Online / Offline changes (web only)
		if (isWeb) {
			this._register(Event.any(
				this._register(new DomEmitter(mainWindow, 'online')).event,
				this._register(new DomEmitter(mainWindow, 'offline')).event
			)(() => this.setNetworkState(navigator.onLine ? 'online' : 'offline')));
		}

		this._register(this.extensionService.onDidChangeExtensions(async (result) => {
			for (const ext of result.added) {
				const index = this.remoteExtensionMetadata.findIndex(value => ExtensionIdentifier.equals(value.id, ext.identifier));
				if (index > -1) {
					this.remoteExtensionMetadata[index].installed = true;
				}
			}
		}));

		this._register(this.extensionManagementService.onDidUninstallExtension(async (result) => {
			const index = this.remoteExtensionMetadata.findIndex(value => ExtensionIdentifier.equals(value.id, result.identifier.id));
			if (index > -1) {
				this.remoteExtensionMetadata[index].installed = false;
			}
		}));
	}

	private async initializeRemoteMetadata(): Promise<void> {

		if (this.remoteMetadataInitialized) {
			return;
		}

		const currentPlatform = PlatformToString(platform);
		for (let i = 0; i < this.remoteExtensionMetadata.length; i++) {
			const extensionId = this.remoteExtensionMetadata[i].id;
			const supportedPlatforms = this.remoteExtensionMetadata[i].supportedPlatforms;
			const isInstalled = (await this.extensionManagementService.getInstalled()).find(value => ExtensionIdentifier.equals(value.identifier.id, extensionId)) ? true : false;

			this.remoteExtensionMetadata[i].installed = isInstalled;
			if (isInstalled) {
				this.remoteExtensionMetadata[i].isPlatformCompatible = true;
			}
			else if (supportedPlatforms && !supportedPlatforms.includes(currentPlatform)) {
				this.remoteExtensionMetadata[i].isPlatformCompatible = false;
			}
			else {
				this.remoteExtensionMetadata[i].isPlatformCompatible = true;
			}
		}

		this.remoteMetadataInitialized = true;
		this._onDidChangeEntries.fire();
		this.updateRemoteStatusIndicator();
	}

	private updateVirtualWorkspaceLocation() {
		this.virtualWorkspaceLocation = getVirtualWorkspaceLocation(this.workspaceContextService.getWorkspace());
	}

	private async updateWhenInstalledExtensionsRegistered(): Promise<void> {
		await this.extensionService.whenInstalledExtensionsRegistered();

		const remoteAuthority = this.remoteAuthority;
		if (remoteAuthority) {

			// Try to resolve the authority to figure out connection state
			(async () => {
				try {
					const { authority } = await this.remoteAuthorityResolverService.resolveAuthority(remoteAuthority);
					this.connectionToken = authority.connectionToken;

					this.setConnectionState('connected');
				} catch (error) {
					this.setConnectionState('disconnected');
				}
			})();
		}

		this.updateRemoteStatusIndicator();
		this.initializeRemoteMetadata();
	}

	private setConnectionState(newState: 'disconnected' | 'connected' | 'reconnecting'): void {
		if (this.connectionState !== newState) {
			this.connectionState = newState;

			// simplify context key which doesn't support `connecting`
			if (this.connectionState === 'reconnecting') {
				this.connectionStateContextKey.set('disconnected');
			} else {
				this.connectionStateContextKey.set(this.connectionState);
			}

			// indicate status
			this.updateRemoteStatusIndicator();

			// start measuring connection latency once connected
			if (newState === 'connected') {
				this.scheduleMeasureNetworkConnectionLatency();
			}
		}
	}

	private scheduleMeasureNetworkConnectionLatency(): void {
		if (
			!this.remoteAuthority ||						// only when having a remote connection
			this.measureNetworkConnectionLatencyScheduler	// already scheduled
		) {
			return;
		}

		this.measureNetworkConnectionLatencyScheduler = this._register(new RunOnceScheduler(() => this.measureNetworkConnectionLatency(), RemoteStatusIndicator.REMOTE_CONNECTION_LATENCY_SCHEDULER_DELAY));
		this.measureNetworkConnectionLatencyScheduler.schedule(RemoteStatusIndicator.REMOTE_CONNECTION_LATENCY_SCHEDULER_FIRST_RUN_DELAY);
	}

	private async measureNetworkConnectionLatency(): Promise<void> {

		// Measure latency if we are online
		// but only when the window has focus to prevent constantly
		// waking up the connection to the remote

		if (this.hostService.hasFocus && this.networkState !== 'offline') {
			const measurement = await remoteConnectionLatencyMeasurer.measure(this.remoteAgentService);
			if (measurement) {
				if (measurement.high) {
					this.setNetworkState('high-latency');
				} else if (this.networkState === 'high-latency') {
					this.setNetworkState('online');
				}
			}
		}

		this.measureNetworkConnectionLatencyScheduler?.schedule();
	}

	private setNetworkState(newState: 'online' | 'offline' | 'high-latency'): void {
		if (this.networkState !== newState) {
			const oldState = this.networkState;
			this.networkState = newState;

			if (newState === 'high-latency') {
				this.logService.warn(`Remote network connection appears to have high latency (${remoteConnectionLatencyMeasurer.latency?.current?.toFixed(2)}ms last, ${remoteConnectionLatencyMeasurer.latency?.average?.toFixed(2)}ms average)`);
			}

			if (this.connectionToken) {
				if (newState === 'online' && oldState === 'high-latency') {
					this.logNetworkConnectionHealthTelemetry(this.connectionToken, 'good');
				} else if (newState === 'high-latency' && oldState === 'online') {
					this.logNetworkConnectionHealthTelemetry(this.connectionToken, 'poor');
				}
			}

			// update status
			this.updateRemoteStatusIndicator();
		}
	}

	private logNetworkConnectionHealthTelemetry(connectionToken: string, connectionHealth: 'good' | 'poor'): void {
		type RemoteConnectionHealthClassification = {
			owner: 'alexdima';
			comment: 'The remote connection health has changed (round trip time)';
			remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
			reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
			connectionHealth: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The health of the connection: good or poor.' };
		};
		type RemoteConnectionHealthEvent = {
			remoteName: string | undefined;
			reconnectionToken: string;
			connectionHealth: 'good' | 'poor';
		};
		this.telemetryService.publicLog2<RemoteConnectionHealthEvent, RemoteConnectionHealthClassification>('remoteConnectionHealth', {
			remoteName: getRemoteName(this.remoteAuthority),
			reconnectionToken: connectionToken,
			connectionHealth
		});
	}


	private updateRemoteStatusIndicator(): void {

		// Remote Indicator: show if provided via options, e.g. by the web embedder API
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator) {
			let remoteIndicatorLabel = remoteIndicator.label.trim();
			if (!remoteIndicatorLabel.startsWith('$(')) {
				remoteIndicatorLabel = `$(remote) ${remoteIndicatorLabel}`; // ensure the indicator has a codicon
			}

			this.renderRemoteStatusIndicator(truncate(remoteIndicatorLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH), remoteIndicator.tooltip, remoteIndicator.command);
			return;
		}

		// Show for remote windows on the desktop
		if (this.remoteAuthority) {
			const hostLabel = this.labelService.getHostLabel(Schemas.vscodeRemote, this.remoteAuthority) || this.remoteAuthority;
			switch (this.connectionState) {
				case 'initializing':
					this.renderRemoteStatusIndicator(nls.localize('host.open', "Opening Remote..."), nls.localize('host.open', "Opening Remote..."), undefined, true /* progress */);
					break;
				case 'reconnecting':
					this.renderRemoteStatusIndicator(`${nls.localize('host.reconnecting', "Reconnecting to {0}...", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`, undefined, undefined, true /* progress */);
					break;
				case 'disconnected':
					this.renderRemoteStatusIndicator(`$(alert) ${nls.localize('disconnectedFrom', "Disconnected from {0}", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`);
					break;
				default: {
					const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
					const hostNameTooltip = this.labelService.getHostTooltip(Schemas.vscodeRemote, this.remoteAuthority);
					if (hostNameTooltip) {
						tooltip.appendMarkdown(hostNameTooltip);
					} else {
						tooltip.appendText(nls.localize({ key: 'host.tooltip', comment: ['{0} is a remote host name, e.g. Dev Container'] }, "Editing on {0}", hostLabel));
					}
					this.renderRemoteStatusIndicator(`$(remote) ${truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				}
			}
			return;
		}
		// Show when in a virtual workspace
		if (this.virtualWorkspaceLocation) {

			// Workspace with label: indicate editing source
			const workspaceLabel = this.labelService.getHostLabel(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
			if (workspaceLabel) {
				const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
				const hostNameTooltip = this.labelService.getHostTooltip(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
				if (hostNameTooltip) {
					tooltip.appendMarkdown(hostNameTooltip);
				} else {
					tooltip.appendText(nls.localize({ key: 'workspace.tooltip', comment: ['{0} is a remote workspace name, e.g. GitHub'] }, "Editing on {0}", workspaceLabel));
				}
				if (!isWeb || this.remoteAuthority) {
					tooltip.appendMarkdown('\n\n');
					tooltip.appendMarkdown(nls.localize(
						{ key: 'workspace.tooltip2', comment: ['[features are not available]({1}) is a link. Only translate `features are not available`. Do not change brackets and parentheses or {0}'] },
						"Some [features are not available]({0}) for resources located on a virtual file system.",
						`command:${LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID}`
					));
				}
				this.renderRemoteStatusIndicator(`$(remote) ${truncate(workspaceLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				return;
			}
		}

		this.renderRemoteStatusIndicator(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL, nls.localize('noHost.tooltip', "Open a Remote Window"));
		return;
	}

	private renderRemoteStatusIndicator(initialText: string, initialTooltip?: string | MarkdownString, command?: string, showProgress?: boolean): void {
		const { text, tooltip, ariaLabel } = this.withNetworkStatus(initialText, initialTooltip, showProgress);

		const properties: IStatusbarEntry = {
			name: nls.localize('remoteHost', "Remote Host"),
			kind: this.networkState === 'offline' ? 'offline' : text !== RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL ? 'remote' : undefined, // only emphasize when applicable
			ariaLabel,
			text,
			showProgress,
			tooltip,
			command: command ?? RemoteStatusIndicator.REMOTE_ACTIONS_COMMAND_ID
		};

		if (this.remoteStatusEntry) {
			this.remoteStatusEntry.update(properties);
		} else {
		}
	}

	private withNetworkStatus(initialText: string, initialTooltip?: string | MarkdownString, showProgress?: boolean): { text: string; tooltip: string | IMarkdownString | undefined; ariaLabel: string } {
		let text = initialText;
		let tooltip = initialTooltip;
		let ariaLabel = getCodiconAriaLabel(text);

		function textWithAlert(): string {

			// `initialText` can have a codicon in the beginning that already
			// indicates some kind of status, or we may have been asked to
			// show progress, where a spinning codicon appears. we only want
			// to replace with an alert icon for when a normal remote indicator
			// is shown.

			if (!showProgress && initialText.startsWith(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL)) {
				return initialText.replace(RemoteStatusIndicator.DEFAULT_REMOTE_STATUS_LABEL, '$(alert)');
			}

			return initialText;
		}

		switch (this.networkState) {
			case 'offline': {
				const offlineMessage = nls.localize('networkStatusOfflineTooltip', "Network appears to be offline, certain features might be unavailable.");

				text = textWithAlert();
				tooltip = this.appendTooltipLine(tooltip, offlineMessage);
				ariaLabel = `${ariaLabel}, ${offlineMessage}`;
				break;
			}
			case 'high-latency':
				text = textWithAlert();
				tooltip = this.appendTooltipLine(tooltip, nls.localize('networkStatusHighLatencyTooltip', "Network appears to have high latency ({0}ms last, {1}ms average), certain features may be slow to respond.", remoteConnectionLatencyMeasurer.latency?.current?.toFixed(2), remoteConnectionLatencyMeasurer.latency?.average?.toFixed(2)));
				break;
		}

		return { text, tooltip, ariaLabel };
	}

	private appendTooltipLine(tooltip: string | MarkdownString | undefined, line: string): MarkdownString {
		let markdownTooltip: MarkdownString;
		if (typeof tooltip === 'string') {
			markdownTooltip = new MarkdownString(tooltip, { isTrusted: true, supportThemeIcons: true });
		} else {
			markdownTooltip = tooltip ?? new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		}

		if (markdownTooltip.value.length > 0) {
			markdownTooltip.appendMarkdown('\n\n');
		}

		markdownTooltip.appendMarkdown(line);

		return markdownTooltip;
	}


}

