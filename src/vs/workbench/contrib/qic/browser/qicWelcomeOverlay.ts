/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ChatWidget } from '../../chat/browser/widget/chatWidget.js';
import { createDeltaPlusLogo } from './qicIcons.js';

/**
 * QIC custom welcome overlay — replaces the stock ChatWidget empty state
 * with a branded welcome screen.
 *
 * Shows when `widget.isEmpty()` is true, hides when messages appear.
 */
export class QicWelcomeOverlay extends Disposable {

	private readonly _element: HTMLElement;

	constructor(
		parent: HTMLElement,
		_widget: ChatWidget,
	) {
		super();

		this._element = parent.appendChild($('.qic-welcome-overlay'));

		// Animated logo (Δ+ SVG)
		const logo = this._element.appendChild($('div.qic-welcome-logo'));
		logo.appendChild(createDeltaPlusLogo(48));
		logo.setAttribute('aria-hidden', 'true');

		// Title
		const title = this._element.appendChild($('h2.qic-welcome-title'));
		title.textContent = 'Welcome to Orion';

		// Description
		const desc = this._element.appendChild($('p.qic-welcome-description'));
		desc.textContent = 'Your AI-powered trading assistant';

		// Intro message
		const intro = this._element.appendChild($('p.qic-welcome-intro'));
		intro.textContent = 'Ask questions about markets, analyze data, build strategies, and more.';

		// Start button
		const startBtn = this._element.appendChild($('button.qic-welcome-start-btn'));
		startBtn.textContent = 'Start a conversation';
		startBtn.addEventListener('click', () => {
			this._setVisible(false);
			_widget.focusInput();
		});

		// Visibility: show when empty, hide when messages exist
		this._register(_widget.onDidChangeEmptyState(() => this._setVisible(_widget.isEmpty())));
		this._setVisible(_widget.isEmpty());
	}

	private _setVisible(visible: boolean): void {
		this._element.style.display = visible ? 'flex' : 'none';
		this._element.parentElement?.classList.toggle('qic-welcome-active', visible);
	}

	override dispose(): void {
		this._element.remove();
		super.dispose();
	}
}
