/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';

// Quantlab: the settings import (extensions/quantlab/src/import) must write the ACTIVE profile's own
// settings.json and keybindings.json. An extension only sees the default profile's global storage, and the
// profile's resources depend on its `useDefaultFlags`, so the workbench names them instead of the extension guessing.

export interface IQuantlabActiveProfileImportTargets {
	readonly profileName: string;
	readonly isDefault: boolean;
	readonly settingsResource: URI;
	readonly keybindingsResource: URI;
}

CommandsRegistry.registerCommand('_quantlab.activeProfileImportTargets', (accessor: ServicesAccessor): IQuantlabActiveProfileImportTargets => {
	const profile = accessor.get(IUserDataProfileService).currentProfile;
	return {
		profileName: profile.name,
		isDefault: profile.isDefault,
		settingsResource: profile.settingsResource,
		keybindingsResource: profile.keybindingsResource,
	};
});
