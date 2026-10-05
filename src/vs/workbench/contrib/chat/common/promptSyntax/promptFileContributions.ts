/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { PromptValidatorContribution } from './languageProviders/promptValidator.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

export class PromptLanguageFeaturesProvider extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.promptLanguageFeatures';

	constructor(
		@ILanguageFeaturesService languageService: ILanguageFeaturesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(instantiationService.createInstance(PromptValidatorContribution));
	}
}
