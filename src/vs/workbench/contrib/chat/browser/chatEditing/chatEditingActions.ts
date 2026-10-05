/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, IAction2Options, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { isChatViewTitleActionContext } from '../../common/actions/chatActions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { applyingChatEditsFailedContextKey, hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, IChatEditingService, IChatEditingSession, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';

export abstract class EditingSessionAction extends Action2 {

	constructor(opts: Readonly<IAction2Options>) {
		super({
			category: CHAT_CATEGORY,
			...opts
		});
	}

	run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = getEditingSessionContext(accessor, args);
		if (!context || !context.editingSession) {
			return;
		}

		return this.runEditingSessionAction(accessor, context.editingSession, context.chatWidget, ...args);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	abstract runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: unknown[]): any;
}

/**
 * Resolve view title toolbar context. If none, return context from the lastFocusedWidget.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getEditingSessionContext(accessor: ServicesAccessor, args: any[]): { editingSession?: IChatEditingSession; chatWidget: IChatWidget } | undefined {
	const arg0 = args.at(0);
	const context = isChatViewTitleActionContext(arg0) ? arg0 : undefined;

	const chatWidgetService = accessor.get(IChatWidgetService);
	const chatEditingService = accessor.get(IChatEditingService);
	let chatWidget = context ? chatWidgetService.getWidgetBySessionResource(context.sessionResource) : undefined;
	if (!chatWidget) {
		chatWidget = chatWidgetService.lastFocusedWidget ?? chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat).find(w => w.supportsChangingModes);
	}

	if (!chatWidget?.viewModel) {
		return;
	}

	const editingSession = chatEditingService.getEditingSession(chatWidget.viewModel.model.sessionResource);
	return { editingSession, chatWidget };
}


export class ChatEditingAcceptAllAction extends EditingSessionAction {

	constructor() {
		super({
			id: 'chatEditing.acceptAllFiles',
			title: localize('accept', 'Keep'),
			icon: Codicon.check,
			tooltip: localize('acceptAllEdits', 'Keep All Edits'),
			precondition: hasUndecidedChatEditingResourceContextKey,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ContextKeyExpr.and(hasUndecidedChatEditingResourceContextKey, ChatContextKeys.inChatInput),
				weight: KeybindingWeight.WorkbenchContrib,
			},
			menu: [

				{
					id: MenuId.ChatEditingWidgetToolbar,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(hasUndecidedChatEditingResourceContextKey))
				}
			]
		});
	}

	override async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: unknown[]) {
		await editingSession.accept();
	}
}

export class ChatEditingDiscardAllAction extends EditingSessionAction {

	constructor() {
		super({
			id: 'chatEditing.discardAllFiles',
			title: localize('discard', 'Undo'),
			icon: Codicon.discard,
			tooltip: localize('discardAllEdits', 'Undo All Edits'),
			precondition: hasUndecidedChatEditingResourceContextKey,
			menu: [
				{
					id: MenuId.ChatEditingWidgetToolbar,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), hasUndecidedChatEditingResourceContextKey)
				}
			],
			keybinding: {
				when: ContextKeyExpr.and(hasUndecidedChatEditingResourceContextKey, ChatContextKeys.inChatInput, ChatContextKeys.inputHasText.negate()),
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Backspace,
			},
		});
	}

	override async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: unknown[]) {
		await discardAllEditsWithConfirmation(accessor, editingSession);
	}
}

export async function discardAllEditsWithConfirmation(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession): Promise<boolean> {

	const dialogService = accessor.get(IDialogService);

	// Ask for confirmation if there are any edits
	const entries = currentEditingSession.entries.get().filter(e => e.state.get() === ModifiedFileEntryState.Modified);
	if (entries.length > 0) {
		const confirmation = await dialogService.confirm({
			title: localize('chat.editing.discardAll.confirmation.title', "Undo all edits?"),
			message: entries.length === 1
				? localize('chat.editing.discardAll.confirmation.oneFile', "This will undo changes made in {0}. Do you want to proceed?", basename(entries[0].modifiedURI))
				: localize('chat.editing.discardAll.confirmation.manyFiles', "This will undo changes made in {0} files. Do you want to proceed?", entries.length),
			primaryButton: localize('chat.editing.discardAll.confirmation.primaryButton', "Yes"),
			type: 'info'
		});
		if (!confirmation.confirmed) {
			return false;
		}
	}

	await currentEditingSession.reject();
	return true;
}

export class ChatEditingShowChangesAction extends EditingSessionAction {
	static readonly ID = 'chatEditing.viewChanges';
	static readonly LABEL = localize('chatEditing.viewChanges', 'View All Edits');

	constructor() {
		super({
			id: ChatEditingShowChangesAction.ID,
			title: { value: ChatEditingShowChangesAction.LABEL, original: ChatEditingShowChangesAction.LABEL },
			tooltip: ChatEditingShowChangesAction.LABEL,
			f1: true,
			icon: Codicon.diffMultiple,
			precondition: hasUndecidedChatEditingResourceContextKey,
			menu: [
				{
					id: MenuId.ChatEditingWidgetToolbar,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey))
				}
			],
		});
	}

	override async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: unknown[]): Promise<void> {
		await editingSession.show();
	}
}

export class ViewAllSessionChangesAction extends Action2 {
	static readonly ID = 'chatEditing.viewAllSessionChanges';

	constructor() {
		super({
			id: ViewAllSessionChangesAction.ID,
			title: localize2('chatEditing.viewAllSessionChanges', 'View All Changes'),
			icon: Codicon.diffMultiple,
			category: CHAT_CATEGORY,
			precondition: ChatContextKeys.hasAgentSessionChanges,
			menu: [
				{
					id: MenuId.ChatEditingSessionChangesToolbar,
					group: 'navigation',
					order: 10,
					when: ChatContextKeys.hasAgentSessionChanges
				}
			],
		});
	}

	override async run(accessor: ServicesAccessor, sessionResource?: URI): Promise<void> {
		const agentSessionsService = accessor.get(IAgentSessionsService);
		const commandService = accessor.get(ICommandService);
		if (!URI.isUri(sessionResource)) {
			return;
		}

		const session = agentSessionsService.getSession(sessionResource);
		const changes = session?.changes;
		if (!(changes instanceof Array)) {
			return;
		}

		const resources = changes
			.filter(d => d.originalUri)
			.map(d => ({ originalUri: d.originalUri!, modifiedUri: d.modifiedUri }));

		if (resources.length > 0) {
			await commandService.executeCommand('_workbench.openMultiDiffEditor', {
				multiDiffSourceUri: sessionResource.with({ scheme: sessionResource.scheme + '-worktree-changes' }),
				title: localize('chatEditing.allChanges.title', 'All Session Changes'),
				resources,
			});
		}
	}
}


export interface ChatEditingActionContext {
	readonly sessionResource: URI;
	readonly requestId: string;
	readonly uri: URI;
	readonly stopId: string | undefined;
}

export class ViewPreviousEditsAction extends EditingSessionAction {
	static readonly Id = 'chatEditing.viewPreviousEdits';
	static readonly Label = localize('chatEditing.viewPreviousEdits', 'View Previous Edits');

	constructor() {
		super({
			id: ViewPreviousEditsAction.Id,
			title: { value: ViewPreviousEditsAction.Label, original: ViewPreviousEditsAction.Label },
			tooltip: ViewPreviousEditsAction.Label,
			f1: true,
			icon: Codicon.diffMultiple,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, hasUndecidedChatEditingResourceContextKey.negate()),
			menu: [
				{
					id: MenuId.ChatEditingWidgetToolbar,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey.negate()))
				}
			],
		});
	}

	override async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: unknown[]): Promise<void> {
		await editingSession.show(true);
	}
}

