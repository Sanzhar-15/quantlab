/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export type QuantlabToastKind = 'info' | 'success' | 'warning' | 'error';

export interface QuantlabToastAction {
	id: string;
	label: string;
	command?: string;
	args?: unknown[];
	primary?: boolean;
}

export interface QuantlabToastPayload {
	id: string;
	kind: QuantlabToastKind;
	title: string;
	message?: string;
	actions?: QuantlabToastAction[];
	durationMs?: number;
}

interface ToastEntry {
	element: HTMLElement;
	timeout?: number;
	disposables: DisposableStore;
}

export class QuantlabToastController extends Disposable {
	private readonly host: HTMLElement;
	private readonly toasts = new Map<string, ToastEntry>();

	constructor(parent: HTMLElement, @ICommandService private readonly commandService: ICommandService) {
		super();
		this.host = append(parent, $('.quantlab-toast-container'));
		this.host.setAttribute('aria-live', 'polite');
		this.host.setAttribute('aria-atomic', 'true');
	}

	showToast(payload?: QuantlabToastPayload): void {
		if (!payload?.id || !payload.title) {
			return;
		}

		this.dismissToast(payload.id);
		const entry = this.createToast(payload);
		this.toasts.set(payload.id, entry);
		this.host.appendChild(entry.element);

		if (payload.durationMs && payload.durationMs > 0) {
			entry.timeout = window.setTimeout(() => {
				this.dismissToast(payload.id);
			}, payload.durationMs);
		}
	}

	dismissToast(id: string): void {
		const entry = this.toasts.get(id);
		if (!entry) {
			return;
		}

		if (entry.timeout) {
			clearTimeout(entry.timeout);
		}

		entry.disposables.dispose();
		entry.element.remove();
		this.toasts.delete(id);
	}

	private createToast(payload: QuantlabToastPayload): ToastEntry {
		const disposables = new DisposableStore();
		const toast = $('.quantlab-toast');
		toast.setAttribute('role', 'status');
		toast.dataset.kind = payload.kind;

		const header = append(toast, $('.quantlab-toast-header'));
		const title = append(header, $('.quantlab-toast-title'));
		title.textContent = payload.title;

		const close = document.createElement('button');
		close.className = 'quantlab-toast-close';
		close.type = 'button';
		close.textContent = 'x';
		close.setAttribute('aria-label', 'Dismiss');
		header.appendChild(close);

		disposables.add(addDisposableListener(close, EventType.CLICK, () => {
			this.dismissToast(payload.id);
		}));

		if (payload.message) {
			const message = append(toast, $('.quantlab-toast-message'));
			message.textContent = payload.message;
		}

		if (payload.actions && payload.actions.length) {
			const actions = append(toast, $('.quantlab-toast-actions'));
			for (const action of payload.actions) {
				const button = document.createElement('button');
				button.className = action.primary ? 'quantlab-toast-action primary' : 'quantlab-toast-action';
				button.type = 'button';
				button.textContent = action.label;
				actions.appendChild(button);

				disposables.add(addDisposableListener(button, EventType.CLICK, async () => {
					if (action.command) {
						await this.commandService.executeCommand(action.command, ...(action.args ?? []));
					}
					this.dismissToast(payload.id);
				}));
			}
		}

		return { element: toast, disposables };
	}
}
