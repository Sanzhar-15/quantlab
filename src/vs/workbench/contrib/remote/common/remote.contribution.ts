/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, IWorkbenchContributionsRegistry, WorkbenchPhase, Extensions as WorkbenchExtensions, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ILabelService, ResourceLabelFormatting } from '../../../../platform/label/common/label.js';
import { OperatingSystem, isWeb, OS } from '../../../../base/common/platform.js';
import { Schemas } from '../../../../base/common/network.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDownloadService } from '../../../../platform/download/common/download.js';
import { DownloadServiceChannel } from '../../../../platform/download/common/downloadIpc.js';
import { RemoteLoggerChannelClient } from '../../../../platform/log/common/logIpc.js';


export class LabelContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.remoteLabel';

	constructor(
		@ILabelService private readonly labelService: ILabelService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService) {
		this.registerFormatters();
	}

	private registerFormatters(): void {
		this.remoteAgentService.getEnvironment().then(remoteEnvironment => {
			const os = remoteEnvironment?.os || OS;
			const formatting: ResourceLabelFormatting = {
				label: '${path}',
				separator: os === OperatingSystem.Windows ? '\\' : '/',
				tildify: os !== OperatingSystem.Windows,
				normalizeDriveLetter: os === OperatingSystem.Windows,
				workspaceSuffix: isWeb ? undefined : Schemas.vscodeRemote
			};
			this.labelService.registerFormatter({
				scheme: Schemas.vscodeRemote,
				formatting
			});

			if (remoteEnvironment) {
				this.labelService.registerFormatter({
					scheme: Schemas.vscodeUserData,
					formatting
				});
			}
		});
	}
}

class RemoteChannelsContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IDownloadService downloadService: IDownloadService,
		@ILoggerService loggerService: ILoggerService,
	) {
		super();
		const connection = remoteAgentService.getConnection();
		if (connection) {
			connection.registerChannel('download', new DownloadServiceChannel(downloadService));
			connection.withChannel('logger', async channel => this._register(new RemoteLoggerChannelClient(loggerService, channel)));
		}
	}
}

class RemoteInvalidWorkspaceDetector extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.remoteInvalidWorkspaceDetector';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService
	) {
		super();

		// When connected to a remote workspace, we currently cannot
		// validate that the workspace exists before actually opening
		// it. As such, we need to check on that after startup and guide
		// the user to a valid workspace.
		// (see https://github.com/microsoft/vscode/issues/133872)
		if (this.environmentService.remoteAuthority) {
			remoteAgentService.getEnvironment().then(remoteEnv => {
				if (remoteEnv) {
					// we use the presence of `remoteEnv` to figure out
					// if we got a healthy remote connection
					// (see https://github.com/microsoft/vscode/issues/135331)
					this.validateRemoteWorkspace();
				}
			});
		}
	}

	private async validateRemoteWorkspace(): Promise<void> {
		const workspace = this.contextService.getWorkspace();
		const workspaceUriToStat = workspace.configuration ?? workspace.folders.at(0)?.uri;
		if (!workspaceUriToStat) {
			return; // only when in workspace
		}

		const exists = await this.fileService.exists(workspaceUriToStat);
		if (exists) {
			return; // all good!
		}

		const res = await this.dialogService.confirm({
			type: 'warning',
			message: localize('invalidWorkspaceMessage', "Workspace does not exist"),
			detail: localize('invalidWorkspaceDetail', "Please select another workspace to open."),
			primaryButton: localize({ key: 'invalidWorkspacePrimary', comment: ['&& denotes a mnemonic'] }, "&&Open Workspace...")
		});

		if (res.confirmed) {

			// Pick Workspace
			if (workspace.configuration) {
				return this.fileDialogService.pickWorkspaceAndOpen({});
			}

			// Pick Folder
			return this.fileDialogService.pickFolderAndOpen({});
		}
	}
}

const workbenchContributionsRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
registerWorkbenchContribution2(LabelContribution.ID, LabelContribution, WorkbenchPhase.BlockStartup);
workbenchContributionsRegistry.registerWorkbenchContribution(RemoteChannelsContribution, LifecyclePhase.Restored);
registerWorkbenchContribution2(RemoteInvalidWorkspaceDetector.ID, RemoteInvalidWorkspaceDetector, WorkbenchPhase.BlockStartup);

