/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/remoteViewlet.css';
import * as nls from '../../../../nls.js';
import * as dom from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IProgress, IProgressStep, IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ReconnectionWaitEvent, PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import Severity from '../../../../base/common/severity.js';
import { ReloadWindowAction } from '../../../browser/actions/windowActions.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITimerService } from '../../../services/timer/browser/timerService.js';
import { getRemoteName } from '../../../../platform/remote/common/remoteHosts.js';
import { mainWindow } from '../../../../base/browser/window.js';


export class RemoteMarkers implements IWorkbenchContribution {

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ITimerService timerService: ITimerService,
	) {
		remoteAgentService.getEnvironment().then(remoteEnv => {
			if (remoteEnv) {
				timerService.setPerformanceMarks('server', remoteEnv.marks);
			}
		});
	}
}

class VisibleProgress {

	public readonly location: ProgressLocation;
	private _isDisposed: boolean;
	private _lastReport: string | null;
	private _currentProgressPromiseResolve: (() => void) | null;
	private _currentProgress: IProgress<IProgressStep> | null;
	private _currentTimer: ReconnectionTimer | null;

	public get lastReport(): string | null {
		return this._lastReport;
	}

	constructor(progressService: IProgressService, location: ProgressLocation, initialReport: string | null, buttons: string[], onDidCancel: (choice: number | undefined, lastReport: string | null) => void) {
		this.location = location;
		this._isDisposed = false;
		this._lastReport = initialReport;
		this._currentProgressPromiseResolve = null;
		this._currentProgress = null;
		this._currentTimer = null;

		const promise = new Promise<void>((resolve) => this._currentProgressPromiseResolve = resolve);

		progressService.withProgress(
			{ location: location, buttons: buttons },
			(progress) => { if (!this._isDisposed) { this._currentProgress = progress; } return promise; },
			(choice) => onDidCancel(choice, this._lastReport)
		);

		if (this._lastReport) {
			this.report();
		}
	}

	public dispose(): void {
		this._isDisposed = true;
		if (this._currentProgressPromiseResolve) {
			this._currentProgressPromiseResolve();
			this._currentProgressPromiseResolve = null;
		}
		this._currentProgress = null;
		if (this._currentTimer) {
			this._currentTimer.dispose();
			this._currentTimer = null;
		}
	}

	public report(message?: string) {
		if (message) {
			this._lastReport = message;
		}

		if (this._lastReport && this._currentProgress) {
			this._currentProgress.report({ message: this._lastReport });
		}
	}

	public startTimer(completionTime: number): void {
		this.stopTimer();
		this._currentTimer = new ReconnectionTimer(this, completionTime);
	}

	public stopTimer(): void {
		if (this._currentTimer) {
			this._currentTimer.dispose();
			this._currentTimer = null;
		}
	}
}

class ReconnectionTimer implements IDisposable {
	private readonly _parent: VisibleProgress;
	private readonly _completionTime: number;
	private readonly _renderInterval: IDisposable;

	constructor(parent: VisibleProgress, completionTime: number) {
		this._parent = parent;
		this._completionTime = completionTime;
		this._renderInterval = dom.disposableWindowInterval(mainWindow, () => this._render(), 1000);
		this._render();
	}

	public dispose(): void {
		this._renderInterval.dispose();
	}

	private _render() {
		const remainingTimeMs = this._completionTime - Date.now();
		if (remainingTimeMs < 0) {
			return;
		}
		const remainingTime = Math.ceil(remainingTimeMs / 1000);
		if (remainingTime === 1) {
			this._parent.report(nls.localize('reconnectionWaitOne', "Attempting to reconnect in {0} second...", remainingTime));
		} else {
			this._parent.report(nls.localize('reconnectionWaitMany', "Attempting to reconnect in {0} seconds...", remainingTime));
		}
	}
}

/**
 * The time when a prompt is shown to the user
 */
const DISCONNECT_PROMPT_TIME = 40 * 1000; // 40 seconds

export class RemoteAgentConnectionStatusListener extends Disposable implements IWorkbenchContribution {

	private _reloadWindowShown: boolean = false;

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IProgressService progressService: IProgressService,
		@IDialogService dialogService: IDialogService,
		@ICommandService commandService: ICommandService,
		@IQuickInputService quickInputService: IQuickInputService,
		@ILogService logService: ILogService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		super();
		const connection = remoteAgentService.getConnection();
		if (connection) {
			let quickInputVisible = false;
			this._register(quickInputService.onShow(() => quickInputVisible = true));
			this._register(quickInputService.onHide(() => quickInputVisible = false));

			let visibleProgress: VisibleProgress | null = null;
			let reconnectWaitEvent: ReconnectionWaitEvent | null = null;
			const disposableListener = this._register(new MutableDisposable());

			function showProgress(location: ProgressLocation.Dialog | ProgressLocation.Notification | null, buttons: { label: string; callback: () => void }[], initialReport: string | null = null): VisibleProgress {
				if (visibleProgress) {
					visibleProgress.dispose();
					visibleProgress = null;
				}

				if (!location) {
					location = quickInputVisible ? ProgressLocation.Notification : ProgressLocation.Dialog;
				}

				return new VisibleProgress(
					progressService, location, initialReport, buttons.map(button => button.label),
					(choice, lastReport) => {
						// Handle choice from dialog
						if (typeof choice !== 'undefined' && buttons[choice]) {
							buttons[choice].callback();
						} else {
							if (location === ProgressLocation.Dialog) {
								visibleProgress = showProgress(ProgressLocation.Notification, buttons, lastReport);
							} else {
								hideProgress();
							}
						}
					}
				);
			}

			function hideProgress() {
				if (visibleProgress) {
					visibleProgress.dispose();
					visibleProgress = null;
				}
			}

			let reconnectionToken: string = '';
			let lastIncomingDataTime: number = 0;
			let reconnectionAttempts: number = 0;

			const reconnectButton = {
				label: nls.localize('reconnectNow', "Reconnect Now"),
				callback: () => {
					reconnectWaitEvent?.skipWait();
				}
			};

			const reloadButton = {
				label: nls.localize('reloadWindow', "Reload Window"),
				callback: () => {

					type ReconnectReloadClassification = {
						owner: 'alexdima';
						comment: 'The reload button in the builtin permanent reconnection failure dialog was pressed';
						remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
						reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
						millisSinceLastIncomingData: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Elapsed time (in ms) since data was last received.' };
						attempt: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reconnection attempt counter.' };
					};
					type ReconnectReloadEvent = {
						remoteName: string | undefined;
						reconnectionToken: string;
						millisSinceLastIncomingData: number;
						attempt: number;
					};
					telemetryService.publicLog2<ReconnectReloadEvent, ReconnectReloadClassification>('remoteReconnectionReload', {
						remoteName: getRemoteName(environmentService.remoteAuthority),
						reconnectionToken: reconnectionToken,
						millisSinceLastIncomingData: Date.now() - lastIncomingDataTime,
						attempt: reconnectionAttempts
					});

					commandService.executeCommand(ReloadWindowAction.ID);
				}
			};

			// Possible state transitions:
			// ConnectionGain      -> ConnectionLost
			// ConnectionLost      -> ReconnectionWait, ReconnectionRunning
			// ReconnectionWait    -> ReconnectionRunning
			// ReconnectionRunning -> ConnectionGain, ReconnectionPermanentFailure

			this._register(connection.onDidStateChange((e) => {
				visibleProgress?.stopTimer();
				disposableListener.clear();

				switch (e.type) {
					case PersistentConnectionEventType.ConnectionLost:
						reconnectionToken = e.reconnectionToken;
						lastIncomingDataTime = Date.now() - e.millisSinceLastIncomingData;
						reconnectionAttempts = 0;

						type RemoteConnectionLostClassification = {
							owner: 'alexdima';
							comment: 'The remote connection state is now `ConnectionLost`';
							remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
							reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
						};
						type RemoteConnectionLostEvent = {
							remoteName: string | undefined;
							reconnectionToken: string;
						};
						telemetryService.publicLog2<RemoteConnectionLostEvent, RemoteConnectionLostClassification>('remoteConnectionLost', {
							remoteName: getRemoteName(environmentService.remoteAuthority),
							reconnectionToken: e.reconnectionToken,
						});

						if (visibleProgress || e.millisSinceLastIncomingData > DISCONNECT_PROMPT_TIME) {
							if (!visibleProgress) {
								visibleProgress = showProgress(null, [reconnectButton, reloadButton]);
							}
							visibleProgress.report(nls.localize('connectionLost', "Connection Lost"));
						}
						break;

					case PersistentConnectionEventType.ReconnectionWait:
						if (visibleProgress) {
							reconnectWaitEvent = e;
							visibleProgress = showProgress(null, [reconnectButton, reloadButton]);
							visibleProgress.startTimer(Date.now() + 1000 * e.durationSeconds);
						}
						break;

					case PersistentConnectionEventType.ReconnectionRunning:
						reconnectionToken = e.reconnectionToken;
						lastIncomingDataTime = Date.now() - e.millisSinceLastIncomingData;
						reconnectionAttempts = e.attempt;

						type RemoteReconnectionRunningClassification = {
							owner: 'alexdima';
							comment: 'The remote connection state is now `ReconnectionRunning`';
							remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
							reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
							millisSinceLastIncomingData: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Elapsed time (in ms) since data was last received.' };
							attempt: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reconnection attempt counter.' };
						};
						type RemoteReconnectionRunningEvent = {
							remoteName: string | undefined;
							reconnectionToken: string;
							millisSinceLastIncomingData: number;
							attempt: number;
						};
						telemetryService.publicLog2<RemoteReconnectionRunningEvent, RemoteReconnectionRunningClassification>('remoteReconnectionRunning', {
							remoteName: getRemoteName(environmentService.remoteAuthority),
							reconnectionToken: e.reconnectionToken,
							millisSinceLastIncomingData: e.millisSinceLastIncomingData,
							attempt: e.attempt
						});

						if (visibleProgress || e.millisSinceLastIncomingData > DISCONNECT_PROMPT_TIME) {
							visibleProgress = showProgress(null, [reloadButton]);
							visibleProgress.report(nls.localize('reconnectionRunning', "Disconnected. Attempting to reconnect..."));

							// Register to listen for quick input is opened
							disposableListener.value = quickInputService.onShow(() => {
								// Need to move from dialog if being shown and user needs to type in a prompt
								if (visibleProgress && visibleProgress.location === ProgressLocation.Dialog) {
									visibleProgress = showProgress(ProgressLocation.Notification, [reloadButton], visibleProgress.lastReport);
								}
							});
						}

						break;

					case PersistentConnectionEventType.ReconnectionPermanentFailure:
						reconnectionToken = e.reconnectionToken;
						lastIncomingDataTime = Date.now() - e.millisSinceLastIncomingData;
						reconnectionAttempts = e.attempt;

						type RemoteReconnectionPermanentFailureClassification = {
							owner: 'alexdima';
							comment: 'The remote connection state is now `ReconnectionPermanentFailure`';
							remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
							reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
							millisSinceLastIncomingData: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Elapsed time (in ms) since data was last received.' };
							attempt: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reconnection attempt counter.' };
							handled: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The error was handled by the resolver.' };
						};
						type RemoteReconnectionPermanentFailureEvent = {
							remoteName: string | undefined;
							reconnectionToken: string;
							millisSinceLastIncomingData: number;
							attempt: number;
							handled: boolean;
						};
						telemetryService.publicLog2<RemoteReconnectionPermanentFailureEvent, RemoteReconnectionPermanentFailureClassification>('remoteReconnectionPermanentFailure', {
							remoteName: getRemoteName(environmentService.remoteAuthority),
							reconnectionToken: e.reconnectionToken,
							millisSinceLastIncomingData: e.millisSinceLastIncomingData,
							attempt: e.attempt,
							handled: e.handled
						});

						hideProgress();

						if (e.handled) {
							logService.info(`Error handled: Not showing a notification for the error.`);
							console.log(`Error handled: Not showing a notification for the error.`);
						} else if (!this._reloadWindowShown) {
							this._reloadWindowShown = true;
							dialogService.confirm({
								type: Severity.Error,
								message: nls.localize('reconnectionPermanentFailure', "Cannot reconnect. Please reload the window."),
								primaryButton: nls.localize({ key: 'reloadWindow.dialog', comment: ['&& denotes a mnemonic'] }, "&&Reload Window")
							}).then(result => {
								if (result.confirmed) {
									commandService.executeCommand(ReloadWindowAction.ID);
								}
							});
						}
						break;

					case PersistentConnectionEventType.ConnectionGain:
						reconnectionToken = e.reconnectionToken;
						lastIncomingDataTime = Date.now() - e.millisSinceLastIncomingData;
						reconnectionAttempts = e.attempt;

						type RemoteConnectionGainClassification = {
							owner: 'alexdima';
							comment: 'The remote connection state is now `ConnectionGain`';
							remoteName: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The name of the resolver.' };
							reconnectionToken: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the connection.' };
							millisSinceLastIncomingData: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Elapsed time (in ms) since data was last received.' };
							attempt: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reconnection attempt counter.' };
						};
						type RemoteConnectionGainEvent = {
							remoteName: string | undefined;
							reconnectionToken: string;
							millisSinceLastIncomingData: number;
							attempt: number;
						};
						telemetryService.publicLog2<RemoteConnectionGainEvent, RemoteConnectionGainClassification>('remoteConnectionGain', {
							remoteName: getRemoteName(environmentService.remoteAuthority),
							reconnectionToken: e.reconnectionToken,
							millisSinceLastIncomingData: e.millisSinceLastIncomingData,
							attempt: e.attempt
						});

						hideProgress();
						break;
				}
			}));
		}
	}
}
