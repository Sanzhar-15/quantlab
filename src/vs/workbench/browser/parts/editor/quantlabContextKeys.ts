/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { customEditorViewTypeToQuantlabView, IQuantlabTabViewService, QuantlabViewType } from './quantlabViewStateService.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';

const QUANTLAB_CURRENT_VIEW = new RawContextKey<QuantlabViewType>('quantlab.currentView', 'editor');
const QUANTLAB_IS_STRATEGY = new RawContextKey<boolean>('quantlab.isStrategy', false);
const QUANTLAB_IS_DATA_FILE = new RawContextKey<boolean>('quantlab.isDataFile', false);
const QUANTLAB_DATA_FILE_TYPE = new RawContextKey<string | null>('quantlab.dataFileType', null);

const VECTOR_PATTERN = /def\s+strategy\s*\(\s*data\s*\)/;
const EVENT_PATTERN = /def\s+on_bar\s*\(\s*ctx\s*\)/;
const CLASS_PATTERN = /class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)/;

// Data file extensions
const DATA_FILE_EXTENSIONS = ['.csv', '.parquet', '.xlsx'];

export class QuantlabContextKeyController extends Disposable {
	static readonly ID = 'workbench.contrib.quantlabContextKeys';

	private readonly currentViewKey = QUANTLAB_CURRENT_VIEW.bindTo(this.contextKeyService);
	private readonly isStrategyKey = QUANTLAB_IS_STRATEGY.bindTo(this.contextKeyService);
	private readonly isDataFileKey = QUANTLAB_IS_DATA_FILE.bindTo(this.contextKeyService);
	private readonly dataFileTypeKey = QUANTLAB_DATA_FILE_TYPE.bindTo(this.contextKeyService);

	private readonly updateScheduler = this._register(new RunOnceScheduler(() => this.updateContext(), 200));
	private readonly activeModelListener = this._register(new MutableDisposable());

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IModelService private readonly modelService: IModelService,
		@IQuantlabTabViewService private readonly quantlabTabViewService: IQuantlabTabViewService
	) {
		super();

		this._register(this.editorService.onDidActiveEditorChange(() => this.onActiveEditorChanged()));
		this._register(this.editorService.onDidEditorsChange(() => this.scheduleUpdate()));
		this._register(this.editorGroupsService.onDidChangeGroupIndex(() => this.scheduleUpdate()));
		this._register(this.editorGroupsService.onDidMoveGroup(() => this.scheduleUpdate()));
		this._register(this.quantlabTabViewService.onDidChangeTabViewState(() => this.scheduleUpdate()));

		this._register(this.modelService.onModelAdded(model => {
			if (this.isActiveResource(model.uri)) {
				this.onActiveEditorChanged();
			}
		}));

		void this.editorGroupsService.whenReady.then(() => {
			this.onActiveEditorChanged();
		});
	}

	private onActiveEditorChanged(): void {
		this.activeModelListener.clear();

		const active = this.getActiveEditorInfo();
		if (active) {
			const model = this.modelService.getModel(active.resource);
			if (model) {
				const store = new DisposableStore();
				store.add(model.onDidChangeContent(() => this.scheduleUpdate()));
				store.add(model.onDidChangeLanguage(() => this.scheduleUpdate()));
				store.add(model.onWillDispose(() => this.scheduleUpdate()));
				this.activeModelListener.value = store;
			}
		}

		this.scheduleUpdate();
	}

	private scheduleUpdate(): void {
		if (this.updateScheduler.isScheduled()) {
			return;
		}

		this.updateScheduler.schedule();
	}

	private updateContext(): void {
		const active = this.getActiveEditorInfo();
		if (!active) {
			this.currentViewKey.set('editor');
			this.isStrategyKey.set(false);
			this.isDataFileKey.set(false);
			this.dataFileTypeKey.set(null);
			return;
		}

		// Detect view type directly from editor (authoritative source)
		const view = this.detectViewTypeFromEditor();
		this.currentViewKey.set(view);

		// Check for data file FIRST
		const isDataFile = this.isDataFile(active.resource);
		this.isDataFileKey.set(isDataFile);
		this.dataFileTypeKey.set(isDataFile ? this.getDataFileType(active.resource) : null);

		// Only check for strategy if NOT a data file (mutually exclusive)
		if (!isDataFile) {
			const model = this.modelService.getModel(active.resource);
			const isStrategy = model ? this.isStrategyModel(model) : false;
			this.isStrategyKey.set(isStrategy);
		} else {
			this.isStrategyKey.set(false);
		}
	}

	private detectViewTypeFromEditor(): QuantlabViewType {
		const group = this.editorGroupsService.activeGroup;
		const editor = group?.activeEditor;

		if (!editor) {
			return 'editor';
		}

		// Check if it's a CustomEditorInput (Chart/Action/Trade views are custom editors)
		if (editor instanceof CustomEditorInput) {
			return customEditorViewTypeToQuantlabView(editor.viewType);
		}

		return 'editor';
	}

	private getActiveEditorInfo(): { resource: URI; groupIndex: number; tabIndex: number } | undefined {
		const group = this.editorGroupsService.activeGroup;
		const editor = group?.activeEditor ?? undefined;
		if (!editor) {
			return undefined;
		}

		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (!resource) {
			return undefined;
		}

		const tabIndex = group.getIndexOfEditor(editor);
		if (tabIndex < 0) {
			return undefined;
		}

		return { resource, groupIndex: group.index, tabIndex };
	}

	private isActiveResource(resource: URI): boolean {
		const active = this.getActiveEditorInfo();
		if (!active) {
			return false;
		}

		return active.resource.toString() === resource.toString();
	}

	private isStrategyModel(model: ITextModel): boolean {
		if (!this.isPythonModel(model)) {
			return false;
		}

		const text = model.getValue();
		return VECTOR_PATTERN.test(text) || EVENT_PATTERN.test(text) || CLASS_PATTERN.test(text);
	}

	private isPythonModel(model: ITextModel): boolean {
		if (model.uri.scheme === 'untitled') {
			return true;
		}

		const fileName = model.uri.path.toLowerCase();
		return model.getLanguageId() === 'python' || fileName.endsWith('.py');
	}

	private isDataFile(resource: URI): boolean {
		const path = resource.path.toLowerCase();
		return DATA_FILE_EXTENSIONS.some(ext => path.endsWith(ext));
	}

	private getDataFileType(resource: URI): string | null {
		const path = resource.path.toLowerCase();
		if (path.endsWith('.csv')) return 'csv';
		if (path.endsWith('.parquet')) return 'parquet';
		if (path.endsWith('.xlsx')) return 'xlsx';
		return null;
	}
}
