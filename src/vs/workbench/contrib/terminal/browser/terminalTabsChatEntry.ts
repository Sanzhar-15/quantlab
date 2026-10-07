/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ITerminalChatService } from './terminal.js';
import * as dom from '../../../../base/browser/dom.js';

export class TerminalTabsChatEntry extends Disposable {

	private readonly _entry: HTMLElement;
	private readonly _label: HTMLElement;

	override dispose(): void {
		this._entry.remove();
		this._label.remove();
		super.dispose();
	}

	constructor(
		container: HTMLElement,
		private readonly _tabContainer: HTMLElement,
		@ITerminalChatService private readonly _terminalChatService: ITerminalChatService,
	) {
		super();

		this._entry = dom.append(container, $('.terminal-tabs-chat-entry'));

		const entry = dom.append(this._entry, $('.terminal-tabs-entry'));
		const icon = dom.append(entry, $('.terminal-tabs-chat-entry-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussionSparkle));
		this._label = dom.append(entry, $('.terminal-tabs-chat-entry-label'));

		this.update();
	}

	get element(): HTMLElement {
		return this._entry;
	}

	update(): void {
		const hiddenChatTerminalCount = this._terminalChatService.getToolSessionTerminalInstances(true).length;
		if (hiddenChatTerminalCount <= 0) {
			this._entry.style.display = 'none';
			this._label.textContent = '';
			this._entry.removeAttribute('aria-label');
			this._entry.removeAttribute('title');

			return;
		}

		this._entry.style.display = '';
		const tooltip = localize('terminal.tabs.chatEntryTooltip', "Show hidden chat terminals");
		this._entry.setAttribute('title', tooltip);
		const hasText = this._tabContainer.classList.contains('has-text');
		if (hasText) {
			this._label.textContent = hiddenChatTerminalCount === 1
				? localize('terminal.tabs.chatEntryLabelSingle', "{0} Hidden Terminal", hiddenChatTerminalCount)
				: localize('terminal.tabs.chatEntryLabelPlural', "{0} Hidden Terminals", hiddenChatTerminalCount);
		} else {
			this._label.textContent = `${hiddenChatTerminalCount}`;
		}

		const ariaLabel = hiddenChatTerminalCount === 1
			? localize('terminal.tabs.chatEntryAriaLabelSingle', "Show 1 hidden chat terminal")
			: localize('terminal.tabs.chatEntryAriaLabelPlural', "Show {0} hidden chat terminals", hiddenChatTerminalCount);
		this._entry.setAttribute('aria-label', ariaLabel);
	}
}
