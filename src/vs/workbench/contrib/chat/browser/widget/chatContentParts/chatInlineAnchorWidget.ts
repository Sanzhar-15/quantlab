/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatInlineAnchorWidget.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IRange } from '../../../../../../editor/common/core/range.js';
import { SymbolKinds } from '../../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import * as nls from '../../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IResourceStat } from '../../../../../../platform/dnd/browser/dnd.js';
import { FileKind, IFileService } from '../../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { FolderThemeIcon, IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { fillEditorsDragData } from '../../../../../browser/dnd.js';
import { ResourceContextKey } from '../../../../../common/contextkeys.js';
import { INotebookDocumentService } from '../../../../../services/notebook/common/notebookDocumentService.js';
import { ExplorerFolderContext } from '../../../../files/common/files.js';
import { IWorkspaceSymbol } from '../../../../search/common/search.js';
import { IChatContentInlineReference } from '../../../common/chatService/chatService.js';
import { chatAttachmentResourceContextKey, hookUpSymbolAttachmentDragAndContextMenu } from '../../attachments/chatAttachmentWidgets.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';

type ContentRefData =
	| { readonly kind: 'symbol'; readonly symbol: IWorkspaceSymbol }
	| {
		readonly kind?: undefined;
		readonly uri: URI;
		readonly range?: IRange;
	};

export function renderFileWidgets(element: HTMLElement, instantiationService: IInstantiationService, chatMarkdownAnchorService: IChatMarkdownAnchorService, disposables: DisposableStore) {
	// eslint-disable-next-line no-restricted-syntax
	const links = element.querySelectorAll('a');
	links.forEach(a => {
		// Empty link text -> render file widget
		if (!a.textContent?.trim()) {
			const href = a.getAttribute('data-href');
			const uri = href ? URI.parse(href) : undefined;
			if (uri?.scheme) {
				const widget = instantiationService.createInstance(InlineAnchorWidget, a, { kind: 'inlineReference', inlineReference: uri });
				disposables.add(chatMarkdownAnchorService.register(widget));
				disposables.add(widget);
			}
		}
	});
}

export class InlineAnchorWidget extends Disposable {

	public static readonly className = 'chat-inline-anchor-widget';

	private readonly _chatResourceContext: IContextKey<string>;

	readonly data: ContentRefData;

	constructor(
		private readonly element: HTMLAnchorElement | HTMLElement,
		public readonly inlineReference: IChatContentInlineReference,
		@IContextKeyService originalContextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IFileService fileService: IFileService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService,
		@ILanguageService languageService: ILanguageService,
		@IMenuService menuService: IMenuService,
		@IModelService modelService: IModelService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@INotebookDocumentService private readonly notebookDocumentService: INotebookDocumentService,
	) {
		super();

		// TODO: Make sure we handle updates from an inlineReference being `resolved` late

		this.data = 'uri' in inlineReference.inlineReference
			? inlineReference.inlineReference
			: 'name' in inlineReference.inlineReference
				? { kind: 'symbol', symbol: inlineReference.inlineReference }
				: { uri: inlineReference.inlineReference };

		const contextKeyService = this._register(originalContextKeyService.createScoped(element));
		this._chatResourceContext = chatAttachmentResourceContextKey.bindTo(contextKeyService);

		element.classList.add(InlineAnchorWidget.className, 'show-file-icons');

		let iconText: Array<string | HTMLElement>;
		let iconClasses: string[];

		let location: { readonly uri: URI; readonly range?: IRange };

		let updateContextKeys: (() => Promise<void>) | undefined;
		if (this.data.kind === 'symbol') {
			const symbol = this.data.symbol;

			location = this.data.symbol.location;
			iconText = [this.data.symbol.name];
			iconClasses = ['codicon', ...getIconClasses(modelService, languageService, undefined, undefined, SymbolKinds.toIcon(symbol.kind))];

			this._store.add(instantiationService.invokeFunction(accessor => hookUpSymbolAttachmentDragAndContextMenu(accessor, element, contextKeyService, { value: symbol.location, name: symbol.name, kind: symbol.kind }, MenuId.ChatInlineSymbolAnchorContext)));
		} else {
			location = this.data;

			const filePathLabel = labelService.getUriBasenameLabel(location.uri);
			if (location.range && this.data.kind !== 'symbol') {
				const suffix = location.range.startLineNumber === location.range.endLineNumber
					? `:${location.range.startLineNumber}`
					: `:${location.range.startLineNumber}-${location.range.endLineNumber}`;

				iconText = [filePathLabel, dom.$('span.label-suffix', undefined, suffix)];
			} else if (location.uri.scheme === 'vscode-notebook-cell' && this.data.kind !== 'symbol') {
				iconText = [`${filePathLabel} • cell${this.getCellIndex(location.uri)}`];
			} else {
				iconText = [filePathLabel];
			}

			let fileKind = location.uri.path.endsWith('/') ? FileKind.FOLDER : FileKind.FILE;
			const recomputeIconClasses = () => getIconClasses(modelService, languageService, location.uri, fileKind, fileKind === FileKind.FOLDER && !themeService.getFileIconTheme().hasFolderIcons ? FolderThemeIcon : undefined);

			iconClasses = recomputeIconClasses();

			const refreshIconClasses = () => {
				iconEl.classList.remove(...iconClasses);
				iconClasses = recomputeIconClasses();
				iconEl.classList.add(...iconClasses);
			};

			this._register(themeService.onDidFileIconThemeChange(() => {
				refreshIconClasses();
			}));

			const isFolderContext = ExplorerFolderContext.bindTo(contextKeyService);
			fileService.stat(location.uri)
				.then(stat => {
					isFolderContext.set(stat.isDirectory);
					if (stat.isDirectory) {
						fileKind = FileKind.FOLDER;
						refreshIconClasses();
					}
				})
				.catch(() => { });

			// Context menu
			this._register(dom.addDisposableListener(element, dom.EventType.CONTEXT_MENU, async domEvent => {
				const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
				dom.EventHelper.stop(domEvent, true);

				try {
					await updateContextKeys?.();
				} catch (e) {
					console.error(e);
				}

				if (this._store.isDisposed) {
					return;
				}

				contextMenuService.showContextMenu({
					contextKeyService,
					getAnchor: () => event,
					getActions: () => {
						const menu = menuService.getMenuActions(MenuId.ChatInlineResourceAnchorContext, contextKeyService, { arg: location.uri });
						return getFlatContextMenuActions(menu);
					},
				});
			}));

			// Add line range label for screen readers
			if (location.range) {
				if (location.range.startLineNumber === location.range.endLineNumber) {
					element.setAttribute('aria-label', nls.localize('chat.inlineAnchor.ariaLabel.line', "{0} line {1}", filePathLabel, location.range.startLineNumber));
				} else {
					element.setAttribute('aria-label', nls.localize('chat.inlineAnchor.ariaLabel.range', "{0} lines {1} to {2}", filePathLabel, location.range.startLineNumber, location.range.endLineNumber));
				}
			}
		}

		const resourceContextKey = this._register(new ResourceContextKey(contextKeyService, fileService, languageService, modelService));
		resourceContextKey.set(location.uri);
		this._chatResourceContext.set(location.uri.toString());

		const iconEl = dom.$('span.icon');
		iconEl.classList.add(...iconClasses);
		element.replaceChildren(iconEl, dom.$('span.icon-label', {}, ...iconText));

		const fragment = location.range ? `${location.range.startLineNumber},${location.range.startColumn}` : '';
		element.setAttribute('data-href', (fragment ? location.uri.with({ fragment }) : location.uri).toString());

		// Hover
		const relativeLabel = labelService.getUriLabel(location.uri, { relative: true });
		this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, relativeLabel));

		// Drag and drop
		if (this.data.kind !== 'symbol') {
			element.draggable = true;
			this._register(dom.addDisposableListener(element, 'dragstart', e => {
				const stat: IResourceStat = {
					resource: location.uri,
					selection: location.range,
				};
				instantiationService.invokeFunction(accessor => fillEditorsDragData(accessor, [stat], e));


				e.dataTransfer?.setDragImage(element, 0, 0);
			}));
		}
	}

	getHTMLElement(): HTMLElement {
		return this.element;
	}

	private getCellIndex(location: URI) {
		const notebook = this.notebookDocumentService.getNotebook(location);
		const index = notebook?.getCellIndex(location) ?? -1;
		return index >= 0 ? ` ${index + 1}` : '';
	}
}

//#region Resource context menu

//#endregion

//#region Resource keybindings

//#endregion

//#region Symbol context menu


//#endregion
