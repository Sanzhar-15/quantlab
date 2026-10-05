/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { getAttachableImageExtension } from '../../../common/model/chatModel.js';
import { IMarkdownString, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IChatRequestVariableEntry } from '../../../common/attachments/chatVariableEntries.js';
import { IChatCodeBlockInfo } from '../../chat.js';
import { CodeBlockPart, ICodeBlockData } from './codeBlockPart.js';
import { ChatAttachmentsContentPart } from './chatAttachmentsContentPart.js';
import { IDisposableReference } from './chatCollections.js';
import { IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatCollapsibleIOPart, IChatCollapsibleIOCodePart, IChatCollapsibleIODataPart } from './chatToolInputOutputContentPart.js';

/**
 * A reusable component for rendering tool output consisting of code blocks and/or resources.
 * This is used by both ChatCollapsibleInputOutputContentPart and ChatToolPostExecuteConfirmationPart.
 */
export class ChatToolOutputContentSubPart extends Disposable {
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private _currentWidth: number = 0;
	private readonly _editorReferences: IDisposableReference<CodeBlockPart>[] = [];
	public readonly domNode: HTMLElement;
	readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		private readonly context: IChatContentPartRenderContext,
		private readonly parts: ChatCollapsibleIOPart[],
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IFileService private readonly _fileService: IFileService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
	) {
		super();
		this.domNode = this.createOutputContents();
		this._currentWidth = context.currentWidth();
	}

	private toMdString(value: string | IMarkdownString): MarkdownString {
		if (typeof value === 'string') {
			return new MarkdownString('').appendText(value);
		}
		return new MarkdownString(value.value, { isTrusted: value.isTrusted });
	}

	private createOutputContents(): HTMLElement {
		const container = dom.$('div');

		for (let i = 0; i < this.parts.length; i++) {
			const part = this.parts[i];
			if (part.kind === 'code') {
				this.addCodeBlock(part, container);
				continue;
			}

			const group: IChatCollapsibleIODataPart[] = [];
			for (let k = i; k < this.parts.length; k++) {
				const part = this.parts[k];
				if (part.kind !== 'data') {
					break;
				}
				group.push(part);
			}

			this.addResourceGroup(group, container);
			i += group.length - 1; // Skip the parts we just added
		}

		return container;
	}

	private addResourceGroup(parts: IChatCollapsibleIODataPart[], container: HTMLElement) {
		const el = dom.h('.chat-collapsible-io-resource-group', [
			dom.h('.chat-collapsible-io-resource-items@items'),
			dom.h('.chat-collapsible-io-resource-actions@actions'),
		]);

		this.fillInResourceGroup(parts, el.items, el.actions).then(() => this._onDidChangeHeight.fire());

		container.appendChild(el.root);
		return el.root;
	}

	private async fillInResourceGroup(parts: IChatCollapsibleIODataPart[], itemsContainer: HTMLElement, actionsContainer: HTMLElement) {
		const entries = await Promise.all(parts.map(async (part): Promise<IChatRequestVariableEntry> => {
			if (part.mimeType && getAttachableImageExtension(part.mimeType)) {
				const value = part.value ?? await this._fileService.readFile(part.uri).then(f => f.value.buffer, () => undefined);
				return { kind: 'image', id: generateUuid(), name: basename(part.uri), value, mimeType: part.mimeType, isURL: false, references: [{ kind: 'reference', reference: part.uri }] };
			} else {
				return { kind: 'file', id: generateUuid(), name: basename(part.uri), fullName: part.uri.path, value: part.uri };
			}
		}));

		const attachments = this._register(this._instantiationService.createInstance(
			ChatAttachmentsContentPart,
			{
				variables: entries,
				limit: 5,
				contentReferences: undefined,
				domNode: undefined
			}
		));

		attachments.contextMenuHandler = (attachment, event) => {
			const index = entries.indexOf(attachment);
			const part = parts[index];
			if (part) {
				event.preventDefault();
				event.stopPropagation();

				this._contextMenuService.showContextMenu({
					menuId: MenuId.ChatToolOutputResourceContext,
					menuActionOptions: { shouldForwardArgs: true },
					getAnchor: () => ({ x: event.pageX, y: event.pageY }),
					getActionsContext: () => ({ parts: [part] } satisfies IChatToolOutputResourceToolbarContext),
				});
			}
		};

		itemsContainer.appendChild(attachments.domNode!);

		const toolbar = this._register(this._instantiationService.createInstance(MenuWorkbenchToolBar, actionsContainer, MenuId.ChatToolOutputResourceToolbar, {
			menuOptions: {
				shouldForwardArgs: true,
			},
		}));
		toolbar.context = { parts } satisfies IChatToolOutputResourceToolbarContext;
	}

	private addCodeBlock(part: IChatCollapsibleIOCodePart, container: HTMLElement) {
		if (part.title) {
			const title = dom.$('div.chat-confirmation-widget-title');
			const renderedTitle = this._register(this._markdownRendererService.render(this.toMdString(part.title)));
			title.appendChild(renderedTitle.element);
			container.appendChild(title);
		}

		const data: ICodeBlockData = {
			languageId: part.languageId,
			textModel: Promise.resolve(part.textModel),
			codeBlockIndex: part.codeBlockInfo.codeBlockIndex,
			codeBlockPartIndex: 0,
			element: this.context.element,
			parentContextKeyService: this.contextKeyService,
			renderOptions: part.options,
			chatSessionResource: this.context.element.sessionResource,
		};
		const editorReference = this._register(this.context.editorPool.get());
		editorReference.object.render(data, this._currentWidth || 300);
		this._register(editorReference.object.onDidChangeContentHeight(() => this._onDidChangeHeight.fire()));
		container.appendChild(editorReference.object.element);
		this._editorReferences.push(editorReference);
		this.codeblocks.push(part.codeBlockInfo);
	}

	layout(width: number): void {
		this._currentWidth = width;
		this._editorReferences.forEach(r => r.object.layout(width));
	}
}

interface IChatToolOutputResourceToolbarContext {
	parts: IChatCollapsibleIODataPart[];
}


