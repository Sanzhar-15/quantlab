/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IExtensionGalleryService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IWorkbenchExtensionManagementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IChatSessionRecommendation } from '../../../../../base/common/product.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';

const INSTALL_CONTEXT_PREFIX = 'chat.installRecommendationAvailable';

export class ChatAgentRecommendation extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chatAgentRecommendation';

	private readonly availabilityContextKeys = new Map<string, IContextKey<boolean>>();
	private refreshRequestId = 0;

	constructor(
		@IProductService private readonly productService: IProductService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		const recommendations = this.productService.chatSessionRecommendations;
		if (!recommendations?.length || !this.extensionGalleryService.isEnabled()) {
			return;
		}

		for (const recommendation of recommendations) {
			this.registerRecommendation(recommendation);
		}

		const refresh = () => this.refreshInstallAvailability();
		this._register(this.extensionManagementService.onProfileAwareDidInstallExtensions(refresh));
		this._register(this.extensionManagementService.onProfileAwareDidUninstallExtension(refresh));
		this._register(this.extensionManagementService.onDidChangeProfile(refresh));

		this.refreshInstallAvailability();
	}

	private registerRecommendation(recommendation: IChatSessionRecommendation): void {
		const extensionKey = ExtensionIdentifier.toKey(recommendation.extensionId);
		const availabilityContextId = `${INSTALL_CONTEXT_PREFIX}.${extensionKey}`;
		const availabilityContext = new RawContextKey<boolean>(availabilityContextId, false).bindTo(this.contextKeyService);
		this.availabilityContextKeys.set(extensionKey, availabilityContext);
	}

	private refreshInstallAvailability(): void {
		if (!this.availabilityContextKeys.size) {
			return;
		}

		const currentRequest = ++this.refreshRequestId;
		this.extensionManagementService.getInstalled().then(installedExtensions => {
			if (currentRequest !== this.refreshRequestId) {
				return;
			}

			const installed = new Set(installedExtensions.map(ext => ExtensionIdentifier.toKey(ext.identifier.id)));
			for (const [extensionKey, context] of this.availabilityContextKeys) {
				context.set(!installed.has(extensionKey));
			}
		}, () => {
			if (currentRequest !== this.refreshRequestId) {
				return;
			}

			for (const [, context] of this.availabilityContextKeys) {
				context.set(false);
			}
		});
	}
}


