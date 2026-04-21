/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/singleeditortabscontrol.css';
import { EditorResourceAccessor, EditorsOrder, Verbosity, IEditorPartOptions, SideBySideEditor, preventEditorClose, EditorCloseMethod, IToolbarActions } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorTabsControl } from './editorTabsControl.js';
import { ResourceLabel, IResourceLabel } from '../../labels.js';
import { TAB_ACTIVE_FOREGROUND, TAB_UNFOCUSED_ACTIVE_FOREGROUND } from '../../../common/theme.js';
import { EventType as TouchEventType, GestureEvent, Gesture } from '../../../../base/browser/touch.js';
import { addDisposableListener, EventType, EventHelper, Dimension, isAncestor, DragAndDropObserver, isHTMLElement, clearNode, $ } from '../../../../base/browser/dom.js';
import { CLOSE_EDITOR_COMMAND_ID, UNLOCK_GROUP_COMMAND_ID } from './editorCommands.js';
import { Color } from '../../../../base/common/color.js';
import { assertReturnsDefined, assertReturnsAllDefined } from '../../../../base/common/types.js';
import { equals } from '../../../../base/common/objects.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorTitleControlDimensions } from './editorTitleControl.js';
import { BreadcrumbsControlFactory } from './breadcrumbsControl.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { computeEditorAriaLabel } from '../../editor.js';
import { customEditorViewTypeToQuantlabView, formatQuantlabViewLabel, IQuantlabTabViewService, QuantlabTabViewStateChange, QuantlabViewType } from './quantlabViewStateService.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorResolverService } from '../../../services/editor/common/editorResolverService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IEditorGroupView, IEditorGroupsView, IEditorPartsView } from './editor.js';
import { IReadonlyEditorGroupModel } from '../../../common/editor/editorGroupModel.js';

interface IRenderedEditorLabel {
	readonly editor?: EditorInput;
	readonly pinned: boolean;
}

export class SingleEditorTabsControl extends EditorTabsControl {

	private static readonly QUANTLAB_CONTEXT_KEYS = new Set(['quantlab.currentView', 'quantlab.isStrategy', 'quantlab.isDataFile']);

	private titleContainer: HTMLElement | undefined;
	private editorLabel: IResourceLabel | undefined;
	private activeLabel: IRenderedEditorLabel = Object.create(null);
	private quantlabActionsContainer: HTMLElement | undefined;
	private quantlabActionsDisposables: DisposableStore | undefined;

	private breadcrumbsControlFactory: BreadcrumbsControlFactory | undefined;
	private get breadcrumbsControl() { return this.breadcrumbsControlFactory?.control; }

	constructor(
		parent: HTMLElement,
		editorPartsView: IEditorPartsView,
		groupsView: IEditorGroupsView,
		groupView: IEditorGroupView,
		tabsModel: IReadonlyEditorGroupModel,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IQuickInputService quickInputService: IQuickInputService,
		@IThemeService themeService: IThemeService,
		@IQuantlabTabViewService private readonly quantlabTabViewService: IQuantlabTabViewService,
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IHostService hostService: IHostService,
	) {
		super(parent, editorPartsView, groupsView, groupView, tabsModel, contextMenuService, instantiationService, contextKeyService, keybindingService, notificationService, quickInputService, themeService, editorResolverService, hostService);

		this._register(this.quantlabTabViewService.onDidChangeTabViewState(change => this.onQuantlabTabViewStateChanged(change)));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(SingleEditorTabsControl.QUANTLAB_CONTEXT_KEYS)) {
				this.updateQuantlabActions();
			}
		}));
	}

	protected override create(parent: HTMLElement): HTMLElement {
		super.create(parent);

		const titleContainer = this.titleContainer = parent;
		titleContainer.draggable = true;

		// Container listeners
		this.registerContainerListeners(titleContainer);

		// Gesture Support
		this._register(Gesture.addTarget(titleContainer));

		const labelContainer = $('.label-container');
		titleContainer.appendChild(labelContainer);

		// Editor Label
		this.editorLabel = this._register(this.instantiationService.createInstance(ResourceLabel, labelContainer, {})).element;
		this._register(addDisposableListener(this.editorLabel.element, EventType.CLICK, e => this.onTitleLabelClick(e)));

		// Breadcrumbs
		this.breadcrumbsControlFactory = this._register(this.instantiationService.createInstance(BreadcrumbsControlFactory, labelContainer, this.groupView, {
			showFileIcons: false,
			showSymbolIcons: true,
			showDecorationColors: false,
			widgetStyles: { ...defaultBreadcrumbsWidgetStyles, breadcrumbsBackground: Color.transparent.toString() },
			showPlaceholder: false,
			dragEditor: true,
		}));
		this._register(this.breadcrumbsControlFactory.onDidEnablementChange(() => this.handleBreadcrumbsEnablementChange()));
		titleContainer.classList.toggle('breadcrumbs', Boolean(this.breadcrumbsControl));
		this._register(toDisposable(() => titleContainer.classList.remove('breadcrumbs'))); // important to remove because the container is a shared dom node

		// Create editor actions toolbar
		this.createEditorActionsToolBar(titleContainer, ['title-actions']);
		this.createQuantlabActions(titleContainer);

		return titleContainer;
	}

	private registerContainerListeners(titleContainer: HTMLElement): void {

		// Drag & Drop support
		let lastDragEvent: DragEvent | undefined = undefined;
		let isNewWindowOperation = false;
		this._register(new DragAndDropObserver(titleContainer, {
			onDragStart: e => { isNewWindowOperation = this.onGroupDragStart(e, titleContainer); },
			onDrag: e => { lastDragEvent = e; },
			onDragEnd: e => { this.onGroupDragEnd(e, lastDragEvent, titleContainer, isNewWindowOperation); },
		}));

		// Pin on double click
		this._register(addDisposableListener(titleContainer, EventType.DBLCLICK, e => this.onTitleDoubleClick(e)));

		// Detect mouse click
		this._register(addDisposableListener(titleContainer, EventType.AUXCLICK, e => this.onTitleAuxClick(e)));

		// Detect touch
		this._register(addDisposableListener(titleContainer, TouchEventType.Tap, (e: GestureEvent) => this.onTitleTap(e)));

		// Context Menu
		for (const event of [EventType.CONTEXT_MENU, TouchEventType.Contextmenu]) {
			this._register(addDisposableListener(titleContainer, event, e => {
				if (this.tabsModel.activeEditor) {
					this.onTabContextMenu(this.tabsModel.activeEditor, e, titleContainer);
				}
			}));
		}
	}

	private createQuantlabActions(parent: HTMLElement): void {
		this.quantlabActionsContainer = $('.quantlab-actions');
		parent.appendChild(this.quantlabActionsContainer);

		this.updateQuantlabActions();
	}

	private updateQuantlabActions(): void {
		if (!this.quantlabActionsContainer) {
			return;
		}

		const disposables = this.ensureQuantlabActionsDisposables();
		disposables.clear();
		clearNode(this.quantlabActionsContainer);

		const currentView = this.getQuantlabCurrentView();
		const isStrategy = this.isQuantlabStrategy();
		const isDataFile = this.isQuantlabDataFile();

		if (isStrategy) {
			for (const view of this.getQuantlabButtonOrder(currentView)) {
				this.renderStrategyButton(view, isStrategy, disposables);
			}
		} else if (isDataFile) {
			this.renderDataFileButtons(currentView as 'editor' | 'visualise' | 'stats', disposables);
		}
	}

	private renderStrategyButton(view: QuantlabViewType, isStrategy: boolean, disposables: DisposableStore): void {
		const button = document.createElement('button');
		button.className = 'quantlab-view-button';
		button.type = 'button';
		button.textContent = formatQuantlabViewLabel(view);
		button.setAttribute('aria-label', `${formatQuantlabViewLabel(view)} view button`);
		button.setAttribute('data-ql-anchor', `quantlab-view-${view}`);

		if (view !== 'editor' && !isStrategy) {
			button.classList.add('is-disabled');
			button.setAttribute('aria-disabled', 'true');
		}

		disposables.add(addDisposableListener(button, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			void this.commandService.executeCommand(this.getQuantlabCommandId(view));
		}));

		this.quantlabActionsContainer!.appendChild(button);
	}

	private renderDataFileButtons(currentView: 'editor' | 'visualise' | 'stats', disposables: DisposableStore): void {
		const viewButtons = this.getDataFileViewButtons(currentView);
		for (const view of viewButtons) {
			const button = document.createElement('button');
			button.className = 'quantlab-view-button quantlab-data-button';
			button.type = 'button';
			const label = view === 'visualise' ? 'Visualise' : view === 'stats' ? 'Stats' : 'Editor';
			button.textContent = label;
			button.setAttribute('aria-label', `${label} view button`);
			button.setAttribute('data-ql-anchor', `quantlab-data-${view}`);

			disposables.add(addDisposableListener(button, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				const commandId = view === 'visualise' ? 'quantlab.switchToVisualise' : view === 'stats' ? 'quantlab.switchToStats' : 'quantlab.switchToDataEditor';
				void this.commandService.executeCommand(commandId);
			}));

			this.quantlabActionsContainer!.appendChild(button);
		}

		// Always render the Action button
		const actionButton = document.createElement('button');
		actionButton.className = 'quantlab-view-button quantlab-data-button quantlab-action-button';
		actionButton.type = 'button';
		actionButton.textContent = 'Action';
		actionButton.setAttribute('aria-label', 'Open Resources panel with statistics tests');
		actionButton.setAttribute('data-ql-anchor', 'quantlab-data-action');

		disposables.add(addDisposableListener(actionButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			void this.commandService.executeCommand('quantlab.openDataAction');
		}));

		this.quantlabActionsContainer!.appendChild(actionButton);
	}

	private getDataFileViewButtons(currentView: 'editor' | 'visualise' | 'stats'): ('editor' | 'visualise' | 'stats')[] {
		switch (currentView) {
			case 'editor':
				return ['visualise'];
			case 'visualise':
				return ['editor'];
			case 'stats':
				return ['visualise', 'editor'];
			default:
				return ['visualise'];
		}
	}

	private getQuantlabButtonOrder(currentView: QuantlabViewType): QuantlabViewType[] {
		switch (currentView) {
			case 'chart':
				return ['editor', 'action', 'trade'];
			case 'action':
				return ['chart', 'editor', 'trade'];
			case 'trade':
				return ['chart', 'action', 'editor'];
			default:
				return ['chart', 'action', 'trade'];
		}
	}

	private getQuantlabCommandId(view: QuantlabViewType): string {
		switch (view) {
			case 'chart':
				return 'quantlab.switchToChart';
			case 'action':
				return 'quantlab.switchToAction';
			case 'trade':
				return 'quantlab.switchToTrade';
			default:
				return 'quantlab.switchToEditor';
		}
	}

	private getQuantlabCurrentView(): QuantlabViewType {
		return this.contextKeyService.getContextKeyValue<QuantlabViewType>('quantlab.currentView') ?? 'editor';
	}

	private isQuantlabStrategy(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('quantlab.isStrategy') === true;
	}

	private isQuantlabDataFile(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('quantlab.isDataFile') === true;
	}

	private ensureQuantlabActionsDisposables(): DisposableStore {
		if (!this.quantlabActionsDisposables) {
			this.quantlabActionsDisposables = this._register(new DisposableStore());
		}

		return this.quantlabActionsDisposables;
	}

	private onQuantlabTabViewStateChanged(change: QuantlabTabViewStateChange): void {
		const editor = this.tabsModel.activeEditor ?? undefined;
		const titleContainer = this.titleContainer;
		if (!editor || !titleContainer) {
			return;
		}

		const tabIndex = this.getTabIndex(editor);
		const tabInstanceId = this.getQuantlabTabInstanceId(editor, tabIndex);
		if (tabInstanceId !== change.tabInstanceId) {
			return;
		}

		const ariaLabel = computeEditorAriaLabel(editor, tabIndex, this.groupView, this.editorPartsView.count);
		this.applyQuantlabTabViewAttributes(editor, tabIndex, titleContainer, ariaLabel);
	}

	private applyQuantlabTabViewAttributes(editor: EditorInput, tabIndex: number, titleContainer: HTMLElement, baseAriaLabel: string | undefined): void {
		const view = this.getQuantlabViewForTab(editor, tabIndex);
		if (view !== 'editor') {
			titleContainer.setAttribute('data-ql-view', view);
		} else {
			titleContainer.removeAttribute('data-ql-view');
		}

		const ariaLabel = baseAriaLabel ?? computeEditorAriaLabel(editor, tabIndex, this.groupView, this.editorPartsView.count);
		const fullAriaLabel = view !== 'editor' ? `${ariaLabel}, ${formatQuantlabViewLabel(view)} view` : ariaLabel;
		titleContainer.setAttribute('aria-label', fullAriaLabel);
		titleContainer.setAttribute('aria-description', '');
	}

	private getQuantlabViewForTab(editor: EditorInput, tabIndex: number): QuantlabViewType {
		// Direct detection from editor type - CustomEditorInput for Chart/Action/Trade views
		if (editor instanceof CustomEditorInput) {
			return customEditorViewTypeToQuantlabView(editor.viewType);
		}

		return 'editor';
	}

	private getQuantlabTabInstanceId(editor: EditorInput, tabIndex: number): string | undefined {
		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (!resource) {
			return undefined;
		}

		const groupIndex = this.groupsView.groups.indexOf(this.groupView);
		if (groupIndex < 0) {
			return undefined;
		}

		return `${resource.toString()}::${groupIndex}::${tabIndex}`;
	}

	private getTabIndex(editor: EditorInput): number {
		return this.tabsModel.getEditors(EditorsOrder.SEQUENTIAL).indexOf(editor);
	}

	private onTitleLabelClick(e: MouseEvent): void {
		EventHelper.stop(e, false);

		// delayed to let the onTitleClick() come first which can cause a focus change which can close quick access
		setTimeout(() => this.quickInputService.quickAccess.show());
	}

	private onTitleDoubleClick(e: MouseEvent): void {
		EventHelper.stop(e);

		this.groupView.pinEditor();
	}

	private onTitleAuxClick(e: MouseEvent): void {
		if (e.button === 1 /* Middle Button */ && this.tabsModel.activeEditor) {
			EventHelper.stop(e, true /* for https://github.com/microsoft/vscode/issues/56715 */);

			if (!preventEditorClose(this.tabsModel, this.tabsModel.activeEditor, EditorCloseMethod.MOUSE, this.groupsView.partOptions)) {
				this.groupView.closeEditor(this.tabsModel.activeEditor);
			}
		}
	}

	private onTitleTap(e: GestureEvent): void {

		// We only want to open the quick access picker when
		// the tap occurred over the editor label, so we need
		// to check on the target
		// (https://github.com/microsoft/vscode/issues/107543)
		const target = e.initialTarget;
		if (!(isHTMLElement(target)) || !this.editorLabel || !isAncestor(target, this.editorLabel.element)) {
			return;
		}

		// TODO@rebornix gesture tap should open the quick access
		// editorGroupView will focus on the editor again when there
		// are mouse/pointer/touch down events we need to wait a bit as
		// `GesureEvent.Tap` is generated from `touchstart` and then
		// `touchend` events, which are not an atom event.
		setTimeout(() => this.quickInputService.quickAccess.show(), 50);
	}

	openEditor(editor: EditorInput): boolean {
		return this.doHandleOpenEditor();
	}

	openEditors(editors: EditorInput[]): boolean {
		return this.doHandleOpenEditor();
	}

	private doHandleOpenEditor(): boolean {
		const activeEditorChanged = this.ifActiveEditorChanged(() => this.redraw());
		if (!activeEditorChanged) {
			this.ifActiveEditorPropertiesChanged(() => this.redraw());
		}

		return activeEditorChanged;
	}

	beforeCloseEditor(editor: EditorInput): void {
		// Nothing to do before closing an editor
	}

	closeEditor(editor: EditorInput): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	closeEditors(editors: EditorInput[]): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	moveEditor(editor: EditorInput, fromIndex: number, targetIndex: number): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	pinEditor(editor: EditorInput): void {
		this.ifEditorIsActive(editor, () => this.redraw());
	}

	stickEditor(editor: EditorInput): void { }

	unstickEditor(editor: EditorInput): void { }

	setActive(isActive: boolean): void {
		this.redraw();
	}

	updateEditorSelections(): void { }

	updateEditorLabel(editor: EditorInput): void {
		this.ifEditorIsActive(editor, () => this.redraw());
	}

	updateEditorDirty(editor: EditorInput): void {
		this.ifEditorIsActive(editor, () => {
			const titleContainer = assertReturnsDefined(this.titleContainer);

			// Signal dirty (unless saving)
			if (editor.isDirty() && !editor.isSaving()) {
				titleContainer.classList.add('dirty');
			}

			// Otherwise, clear dirty
			else {
				titleContainer.classList.remove('dirty');
			}
		});
	}

	override updateOptions(oldOptions: IEditorPartOptions, newOptions: IEditorPartOptions): void {
		super.updateOptions(oldOptions, newOptions);

		if (oldOptions.labelFormat !== newOptions.labelFormat || !equals(oldOptions.decorations, newOptions.decorations)) {
			this.redraw();
		}
	}

	override updateStyles(): void {
		this.redraw();
	}

	protected handleBreadcrumbsEnablementChange(): void {
		const titleContainer = assertReturnsDefined(this.titleContainer);
		titleContainer.classList.toggle('breadcrumbs', Boolean(this.breadcrumbsControl));

		this.redraw();
	}

	private ifActiveEditorChanged(fn: () => void): boolean {
		if (
			!this.activeLabel.editor && this.tabsModel.activeEditor || 						// active editor changed from null => editor
			this.activeLabel.editor && !this.tabsModel.activeEditor || 						// active editor changed from editor => null
			(!this.activeLabel.editor || !this.tabsModel.isActive(this.activeLabel.editor))	// active editor changed from editorA => editorB
		) {
			fn();

			return true;
		}

		return false;
	}

	private ifActiveEditorPropertiesChanged(fn: () => void): void {
		if (!this.activeLabel.editor || !this.tabsModel.activeEditor) {
			return; // need an active editor to check for properties changed
		}

		if (this.activeLabel.pinned !== this.tabsModel.isPinned(this.tabsModel.activeEditor)) {
			fn(); // only run if pinned state has changed
		}
	}

	private ifEditorIsActive(editor: EditorInput, fn: () => void): void {
		if (this.tabsModel.isActive(editor)) {
			fn();  // only run if editor is current active
		}
	}

	private redraw(): void {
		const editor = this.tabsModel.activeEditor ?? undefined;
		const options = this.groupsView.partOptions;

		const isEditorPinned = editor ? this.tabsModel.isPinned(editor) : false;
		const isGroupActive = this.groupsView.activeGroup === this.groupView;

		this.activeLabel = { editor, pinned: isEditorPinned };

		// Update Breadcrumbs
		if (this.breadcrumbsControl) {
			if (isGroupActive) {
				this.breadcrumbsControl.update();
				this.breadcrumbsControl.domNode.classList.toggle('preview', !isEditorPinned);
			} else {
				this.breadcrumbsControl.hide();
			}
		}

		// Clear if there is no editor
		const [titleContainer, editorLabel] = assertReturnsAllDefined(this.titleContainer, this.editorLabel);
		if (!editor) {
			titleContainer.classList.remove('dirty');
			titleContainer.removeAttribute('data-ql-view');
			titleContainer.removeAttribute('aria-label');
			titleContainer.removeAttribute('aria-description');
			editorLabel.clear();
			this.clearEditorActionsToolbar();
		}

		// Otherwise render it
		else {

			// Dirty state
			this.updateEditorDirty(editor);

			// Editor Label
			const { labelFormat } = this.groupsView.partOptions;
			let description: string;
			if (this.breadcrumbsControl && !this.breadcrumbsControl.isHidden()) {
				description = ''; // hide description when showing breadcrumbs
			} else if (labelFormat === 'default' && !isGroupActive) {
				description = ''; // hide description when group is not active and style is 'default'
			} else {
				description = editor.getDescription(this.getVerbosity(labelFormat)) || '';
			}

			editorLabel.setResource(
				{
					resource: EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.BOTH }),
					name: editor.getName(),
					description
				},
				{
					title: this.getHoverTitle(editor),
					italic: !isEditorPinned,
					extraClasses: ['single-tab', 'title-label'].concat(editor.getLabelExtraClasses()),
					fileDecorations: {
						colors: Boolean(options.decorations?.colors),
						badges: Boolean(options.decorations?.badges)
					},
					icon: editor.getIcon(),
					hideIcon: options.showIcons === false,
				}
			);

			const tabIndex = this.getTabIndex(editor);
			const ariaLabel = computeEditorAriaLabel(editor, tabIndex, this.groupView, this.editorPartsView.count);
			this.applyQuantlabTabViewAttributes(editor, tabIndex, titleContainer, ariaLabel);

			if (isGroupActive) {
				titleContainer.style.color = this.getColor(TAB_ACTIVE_FOREGROUND) || '';
			} else {
				titleContainer.style.color = this.getColor(TAB_UNFOCUSED_ACTIVE_FOREGROUND) || '';
			}

			// Update Editor Actions Toolbar
			this.updateEditorActionsToolbar();
		}
	}

	private getVerbosity(style: string | undefined): Verbosity {
		switch (style) {
			case 'short': return Verbosity.SHORT;
			case 'long': return Verbosity.LONG;
			default: return Verbosity.MEDIUM;
		}
	}

	protected override prepareEditorActions(editorActions: IToolbarActions): IToolbarActions {
		const isGroupActive = this.groupsView.activeGroup === this.groupView;

		// Active: allow all actions
		if (isGroupActive) {
			return editorActions;
		}

		// Inactive: only show "Close, "Unlock" and secondary actions
		else {
			return {
				primary: this.groupsView.partOptions.alwaysShowEditorActions ? editorActions.primary : editorActions.primary.filter(action => action.id === CLOSE_EDITOR_COMMAND_ID || action.id === UNLOCK_GROUP_COMMAND_ID),
				secondary: editorActions.secondary
			};
		}
	}

	getHeight(): number {
		return this.tabHeight;
	}

	layout(dimensions: IEditorTitleControlDimensions): Dimension {
		this.breadcrumbsControl?.layout(undefined);

		return new Dimension(dimensions.container.width, this.getHeight());
	}
}
