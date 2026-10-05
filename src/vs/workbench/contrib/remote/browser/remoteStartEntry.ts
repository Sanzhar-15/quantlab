/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const showStartEntryInWeb = new RawContextKey<boolean>('showRemoteStartEntryInWeb', false);
export class RemoteStartEntry extends Disposable implements IWorkbenchContribution {


	private readonly remoteExtensionId: string;

	constructor(
		@ICommandService commandService: ICommandService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService) {

		super();

		const remoteExtensionTips = this.productService.remoteExtensionTips?.['tunnel'];
		this.remoteExtensionId = remoteExtensionTips?.extensionId ?? '';

		this._init();
		this.registerActions();
		this.registerListeners();
	}

	private registerActions(): void {
	}

	private registerListeners(): void {
		this._register(this.extensionEnablementService.onEnablementChanged(async (result) => {

			for (const ext of result) {
				if (ExtensionIdentifier.equals(this.remoteExtensionId, ext.identifier.id)) {
					if (this.extensionEnablementService.isEnabled(ext)) {
						showStartEntryInWeb.bindTo(this.contextKeyService).set(true);
					} else {
						showStartEntryInWeb.bindTo(this.contextKeyService).set(false);
					}
				}
			}
		}));
	}

	private async _init(): Promise<void> {

		// Check if installed and enabled
		const installed = (await this.extensionManagementService.getInstalled()).find(value => ExtensionIdentifier.equals(value.identifier.id, this.remoteExtensionId));
		if (installed) {
			if (this.extensionEnablementService.isEnabled(installed)) {
				showStartEntryInWeb.bindTo(this.contextKeyService).set(true);
			}
		}
	}

}
