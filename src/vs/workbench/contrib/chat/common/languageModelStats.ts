/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IExtensionFeaturesManagementService } from '../../../services/extensionManagement/common/extensionFeatures.js';

export const ILanguageModelStatsService = createDecorator<ILanguageModelStatsService>('ILanguageModelStatsService');

export interface ILanguageModelStatsService {
	readonly _serviceBrand: undefined;

	update(model: string, extensionId: ExtensionIdentifier, agent: string | undefined, tokenCount: number | undefined): Promise<void>;
}

export class LanguageModelStatsService extends Disposable implements ILanguageModelStatsService {

	declare _serviceBrand: undefined;

	constructor(
		@IExtensionFeaturesManagementService private readonly extensionFeaturesManagementService: IExtensionFeaturesManagementService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		// TODO: @sandy081 - remove this code after a while
		for (const key in storageService.keys(StorageScope.APPLICATION, StorageTarget.USER)) {
			if (key.startsWith('languageModelStats.') || key.startsWith('languageModelAccess.')) {
				storageService.remove(key, StorageScope.APPLICATION);
			}
		}
	}

	async update(model: string, extensionId: ExtensionIdentifier, agent: string | undefined, tokenCount: number | undefined): Promise<void> {
		await this.extensionFeaturesManagementService.getAccess(extensionId, CopilotUsageExtensionFeatureId);
	}

}

export const CopilotUsageExtensionFeatureId = 'copilot';
