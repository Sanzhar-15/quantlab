/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatWidget } from '../chat.js';
import { localize } from '../../../../../nls.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { IChatContextPickerItem, IChatContextPickerPickItem, IChatContextPicker } from '../attachments/chatContextPickService.js';
import { IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { getCleanPromptName } from '../../common/promptSyntax/config/promptFileLocations.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { compare } from '../../../../../base/common/strings.js';
import { IPromptFileVariableEntry, PromptFileVariableKind, toPromptFileVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';

/**
 * Action ID for the `Attach Instruction` action.
 */
const ATTACH_INSTRUCTIONS_ACTION_ID = 'workbench.action.chat.attach.instructions';

/**
 * Action ID for the `Configure Instruction` action.
 */
const CONFIGURE_INSTRUCTIONS_ACTION_ID = 'workbench.action.chat.configure.instructions';


/**
 * Helper to register the `Attach Prompt` action.
 */


export class ChatInstructionsPickerPick implements IChatContextPickerItem {

	readonly type = 'pickerPick';
	readonly label = localize('chatContext.attach.instructions.label', 'Instructions...');
	readonly icon = Codicon.bookmark;
	readonly commandId = ATTACH_INSTRUCTIONS_ACTION_ID;

	constructor(
		@IPromptsService private readonly promptsService: IPromptsService,
	) { }

	isEnabled(widget: IChatWidget): Promise<boolean> | boolean {
		return !!widget.attachmentCapabilities.supportsInstructionAttachments;
	}

	asPicker(): IChatContextPicker {

		const picks = this.promptsService.listPromptFiles(PromptsType.instructions, CancellationToken.None).then(value => {

			const result: (IChatContextPickerPickItem | IQuickPickSeparator)[] = [];

			value = value.slice(0).sort((a, b) => compare(a.storage, b.storage));

			let storageType: string | undefined;

			for (const promptsPath of value) {

				if (storageType !== promptsPath.storage) {
					storageType = promptsPath.storage;
					result.push({
						type: 'separator',
						label: this.promptsService.getPromptLocationLabel(promptsPath)
					});
				}

				result.push({
					label: promptsPath.name ?? getCleanPromptName(promptsPath.uri),
					asAttachment: (): IPromptFileVariableEntry => {
						return toPromptFileVariableEntry(promptsPath.uri, PromptFileVariableKind.Instruction);
					}
				});
			}
			return result;
		});

		return {
			placeholder: localize('placeholder', 'Select instructions files to attach'),
			picks,
			configure: {
				label: localize('configureInstructions', 'Configure Instructions...'),
				commandId: CONFIGURE_INSTRUCTIONS_ACTION_ID
			}
		};
	}
}
