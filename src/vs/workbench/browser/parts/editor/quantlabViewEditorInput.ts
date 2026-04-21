/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput, isEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { TextResourceEditorInput } from '../../../common/editor/textResourceEditorInput.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { ICustomEditorLabelService } from '../../../services/editor/common/customEditorLabelService.js';
import { formatQuantlabViewLabel, normalizeQuantlabViewType, QuantlabViewType } from './quantlabViewStateService.js';

export class QuantlabViewEditorInput extends TextResourceEditorInput {
	static override readonly ID = 'workbench.editors.quantlabViewEditorInput';

	private readonly instanceId = generateUuid();

	constructor(
		resource: URI,
		private readonly viewType: QuantlabViewType,
		@ITextModelService textModelService: ITextModelService,
		@ITextFileService textFileService: ITextFileService,
		@IEditorService editorService: IEditorService,
		@IFileService fileService: IFileService,
		@ILabelService labelService: ILabelService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@ICustomEditorLabelService customEditorLabelService: ICustomEditorLabelService
	) {
		super(resource, undefined, undefined, undefined, undefined, textModelService, textFileService, editorService, fileService, labelService, filesConfigurationService, textResourceConfigurationService, customEditorLabelService);
	}

	override get typeId(): string {
		return QuantlabViewEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.MultipleEditors;
	}

	getViewType(): QuantlabViewType {
		return this.viewType;
	}

	override getName(): string {
		return `${super.getName()} (${formatQuantlabViewLabel(this.viewType)})`;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (isEditorInput(otherInput)) {
			return otherInput instanceof QuantlabViewEditorInput && otherInput.instanceId === this.instanceId;
		}

		return false;
	}
}

export class QuantlabViewEditorInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof QuantlabViewEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof QuantlabViewEditorInput)) {
			return undefined;
		}

		return JSON.stringify({
			resource: editor.resource?.toString(),
			viewType: editor.getViewType()
		});
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as { resource?: string; viewType?: string };
			if (!data.resource) {
				return undefined;
			}

			const resource = URI.parse(data.resource);
			const viewType = normalizeQuantlabViewType(data.viewType);
			return instantiationService.createInstance(QuantlabViewEditorInput, resource, viewType);
		} catch {
			return undefined;
		}
	}
}
