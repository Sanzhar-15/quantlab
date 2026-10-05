/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, IAction2Options, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../../common/editor.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../services/editor/common/editorService.js';
import { NOTEBOOK_CELL_LIST_FOCUSED, NOTEBOOK_EDITOR_FOCUSED } from '../../../notebook/common/notebookContextKeys.js';
import { IChatEditingService, IChatEditingSession, IModifiedFileEntry, IModifiedFileEntryChangeHunk, IModifiedFileEntryEditorIntegration, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { ctxCursorInChangeRange, ctxHasEditorModification, ctxIsCurrentlyBeingModified, ctxIsGlobalEditingSession, ctxReviewModeEnabled } from './chatEditingEditorContextKeys.js';


abstract class ChatEditingEditorAction extends Action2 {

	constructor(desc: Readonly<IAction2Options>) {
		super({
			category: CHAT_CATEGORY,
			...desc
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]) {

		const instaService = accessor.get(IInstantiationService);
		const chatEditingService = accessor.get(IChatEditingService);
		const editorService = accessor.get(IEditorService);

		const uri = EditorResourceAccessor.getOriginalUri(editorService.activeEditorPane?.input, { supportSideBySide: SideBySideEditor.PRIMARY });

		if (!uri || !editorService.activeEditorPane) {
			return;
		}

		const session = chatEditingService.editingSessionsObs.get()
			.find(candidate => candidate.getEntry(uri));

		if (!session) {
			return;
		}

		const entry = session.getEntry(uri)!;
		const ctrl = entry.getEditorIntegration(editorService.activeEditorPane);

		return instaService.invokeFunction(this.runChatEditingCommand.bind(this), session, entry, ctrl, ...args);
	}

	abstract runChatEditingCommand(accessor: ServicesAccessor, session: IChatEditingSession, entry: IModifiedFileEntry, integration: IModifiedFileEntryEditorIntegration, ...args: unknown[]): Promise<void> | void;
}


async function openNextOrPreviousChange(accessor: ServicesAccessor, session: IChatEditingSession, entry: IModifiedFileEntry, next: boolean) {

	const editorService = accessor.get(IEditorService);

	const entries = session.entries.get();
	let idx = entries.indexOf(entry);

	let newEntry: IModifiedFileEntry;
	while (true) {
		idx = (idx + (next ? 1 : -1) + entries.length) % entries.length;
		newEntry = entries[idx];
		if (newEntry.state.get() === ModifiedFileEntryState.Modified) {
			break;
		} else if (newEntry === entry) {
			return false;
		}
	}

	const pane = await editorService.openEditor({
		resource: newEntry.modifiedURI,
		options: {
			revealIfOpened: false,
			revealIfVisible: false,
		}
	}, ACTIVE_GROUP);

	if (!pane) {
		return false;
	}

	if (session.entries.get().includes(newEntry)) {
		// make sure newEntry is still valid!
		newEntry.getEditorIntegration(pane).reveal(next);
	}

	return true;
}

abstract class KeepOrUndoAction extends ChatEditingEditorAction {

	constructor(id: string, private _keep: boolean) {
		super({
			id,
			title: _keep
				? localize2('accept', 'Keep Chat Edits')
				: localize2('discard', 'Undo Chat Edits'),
			shortTitle: _keep
				? localize2('accept2', 'Keep')
				: localize2('discard2', 'Undo'),
			tooltip: _keep
				? localize2('accept3', 'Keep Chat Edits in this File')
				: localize2('discard3', 'Undo Chat Edits in this File'),
			precondition: ContextKeyExpr.and(ctxIsGlobalEditingSession, ctxHasEditorModification, ctxIsCurrentlyBeingModified.negate()),
			icon: _keep
				? Codicon.check
				: Codicon.discard,
			f1: true,
			keybinding: {
				when: ContextKeyExpr.or(EditorContextKeys.focus, NOTEBOOK_EDITOR_FOCUSED),
				weight: KeybindingWeight.WorkbenchContrib + 10, // win over new-window-action
				primary: _keep
					? KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY
					: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
			},
			menu: {
				id: MenuId.ChatEditingEditorContent,
				group: 'a_resolve',
				order: _keep ? 0 : 1,
				when: !_keep ? ctxReviewModeEnabled : undefined
			}
		});
	}

	override async runChatEditingCommand(accessor: ServicesAccessor, session: IChatEditingSession, entry: IModifiedFileEntry, _integration: IModifiedFileEntryEditorIntegration): Promise<void> {

		const instaService = accessor.get(IInstantiationService);

		if (this._keep) {
			session.accept(entry.modifiedURI);
		} else {
			session.reject(entry.modifiedURI);
		}

		await instaService.invokeFunction(openNextOrPreviousChange, session, entry, true);
	}
}

export class AcceptAction extends KeepOrUndoAction {

	static readonly ID = 'chatEditor.action.accept';

	constructor() {
		super(AcceptAction.ID, true);
	}
}

export class RejectAction extends KeepOrUndoAction {

	static readonly ID = 'chatEditor.action.reject';

	constructor() {
		super(RejectAction.ID, false);
	}
}

const acceptHunkId = 'chatEditor.action.acceptHunk';
const undoHunkId = 'chatEditor.action.undoHunk';
abstract class AcceptRejectHunkAction extends ChatEditingEditorAction {

	constructor(private readonly _accept: boolean) {
		super(
			{
				id: _accept ? acceptHunkId : undoHunkId,
				title: _accept ? localize2('acceptHunk', 'Keep this Change') : localize2('undo', 'Undo this Change'),
				shortTitle: _accept ? localize2('acceptHunkShort', 'Keep') : localize2('undoShort', 'Undo'),
				precondition: ContextKeyExpr.and(ctxHasEditorModification, ctxIsCurrentlyBeingModified.negate()),
				f1: true,
				keybinding: {
					when: ContextKeyExpr.and(ctxCursorInChangeRange, ContextKeyExpr.or(EditorContextKeys.focus, NOTEBOOK_CELL_LIST_FOCUSED)),
					weight: KeybindingWeight.WorkbenchContrib + 1,
					primary: _accept
						? KeyMod.CtrlCmd | KeyCode.KeyY
						: KeyMod.CtrlCmd | KeyCode.KeyN
				},
				menu: {
					id: MenuId.ChatEditingEditorHunk,
					order: 1
				}
			}
		);
	}

	override async runChatEditingCommand(accessor: ServicesAccessor, session: IChatEditingSession, entry: IModifiedFileEntry, ctrl: IModifiedFileEntryEditorIntegration, ...args: unknown[]): Promise<void> {

		const instaService = accessor.get(IInstantiationService);

		if (this._accept) {
			await ctrl.acceptNearestChange(args[0] as IModifiedFileEntryChangeHunk | undefined);
		} else {
			await ctrl.rejectNearestChange(args[0] as IModifiedFileEntryChangeHunk | undefined);
		}

		if (entry.changesCount.get() === 0) {
			// no more changes, move to next file
			await instaService.invokeFunction(openNextOrPreviousChange, session, entry, true);
		}
	}
}

export class AcceptHunkAction extends AcceptRejectHunkAction {

	static readonly ID = acceptHunkId;

	constructor() {
		super(true);
	}
}

export class RejectHunkAction extends AcceptRejectHunkAction {

	static readonly ID = undoHunkId;

	constructor() {
		super(false);
	}
}


export class ReviewChangesAction extends ChatEditingEditorAction {

	constructor() {
		super({
			id: 'chatEditor.action.reviewChanges',
			title: localize2('review', "Review"),
			precondition: ContextKeyExpr.and(ctxHasEditorModification, ctxIsCurrentlyBeingModified.negate()),
			menu: [{
				id: MenuId.ChatEditingEditorContent,
				group: 'a_resolve',
				order: 3,
				when: ContextKeyExpr.and(ctxReviewModeEnabled.negate(), ctxIsCurrentlyBeingModified.negate()),
			}]
		});
	}

	override runChatEditingCommand(_accessor: ServicesAccessor, _session: IChatEditingSession, entry: IModifiedFileEntry, _integration: IModifiedFileEntryEditorIntegration, ..._args: unknown[]): void {
		entry.enableReviewModeUntilSettled();
	}
}

export class AcceptAllEditsAction extends ChatEditingEditorAction {

	static readonly ID = 'chatEditor.action.acceptAllEdits';

	constructor() {
		super({
			id: AcceptAllEditsAction.ID,
			title: localize2('acceptAllEdits', 'Keep All Chat Edits'),
			tooltip: localize2('acceptAllEditsTooltip', 'Keep All Chat Edits in this Session'),
			precondition: ContextKeyExpr.and(ctxHasEditorModification, ctxIsCurrentlyBeingModified.negate()),
			icon: Codicon.checkAll,
			f1: true,
			keybinding: {
				when: ContextKeyExpr.or(EditorContextKeys.focus, NOTEBOOK_EDITOR_FOCUSED),
				weight: KeybindingWeight.WorkbenchContrib + 10,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyY,
			},
		});
	}

	override async runChatEditingCommand(_accessor: ServicesAccessor, session: IChatEditingSession, _entry: IModifiedFileEntry, _integration: IModifiedFileEntryEditorIntegration, ..._args: unknown[]): Promise<void> {
		await session.accept();
	}
}


// --- multi file diff



export const navigationBearingFakeActionId = 'chatEditor.navigation.bearings';
