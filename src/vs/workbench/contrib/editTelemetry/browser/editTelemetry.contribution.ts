/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditTelemetryContribution } from './editTelemetryContribution.js';
import { AI_STATS_SETTING_ID } from './settingIds.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAiEditTelemetryService } from './telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { AiEditTelemetryServiceImpl } from './telemetry/aiEditTelemetry/aiEditTelemetryServiceImpl.js';
import { IRandomService, RandomService } from './randomService.js';

registerWorkbenchContribution2('EditTelemetryContribution', EditTelemetryContribution, WorkbenchPhase.AfterRestored);

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'task',
	order: 100,
	title: localize('editTelemetry', "Edit Telemetry"),
	type: 'object',
	properties: {
		[AI_STATS_SETTING_ID]: {
			markdownDescription: localize('editor.aiStats.enabled', "Controls whether to enable AI statistics in the editor. The gauge represents the average amount of code inserted by AI vs manual typing over a 24 hour period."),
			type: 'boolean',
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
	}
});

registerSingleton(IAiEditTelemetryService, AiEditTelemetryServiceImpl, InstantiationType.Delayed);
registerSingleton(IRandomService, RandomService, InstantiationType.Delayed);
