/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import '../browser/issueTroubleshoot.js';
import { BaseIssueContribution } from '../common/issue.contribution.js';
import { IIssueFormService, IWorkbenchIssueService } from '../common/issue.js';
import { NativeIssueService } from './issueService.js';
import { NativeIssueFormService } from './nativeIssueFormService.js';

//#region Issue Contribution
registerSingleton(IWorkbenchIssueService, NativeIssueService, InstantiationType.Delayed);
registerSingleton(IIssueFormService, NativeIssueFormService, InstantiationType.Delayed);

class NativeIssueContribution extends BaseIssueContribution {

	constructor(
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(productService, configurationService);

		if (!configurationService.getValue<boolean>('telemetry.feedback.enabled')) {
			return;
		}

		if (productService.reportIssueUrl) {
		}

		let disposable: IDisposable | undefined;

		const registerQuickAccessProvider = () => {
		};

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (!configurationService.getValue<boolean>('extensions.experimental.issueQuickAccess') && disposable) {
				disposable.dispose();
				disposable = undefined;
			} else if (!disposable) {
				registerQuickAccessProvider();
			}
		}));

		if (configurationService.getValue<boolean>('extensions.experimental.issueQuickAccess')) {
			registerQuickAccessProvider();
		}
	}
}
Registry.as<IWorkbenchContributionsRegistry>(Extensions.Workbench).registerWorkbenchContribution(NativeIssueContribution, LifecyclePhase.Restored);


// #endregion
