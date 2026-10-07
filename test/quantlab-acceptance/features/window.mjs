/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window driver's steps, answered to the in-host driver through cues.cjs. Each drives the real
// UI over CDP (see RUNNER-FLOW.md) and returns what it saw; a step that cannot finish throws by name.

import { evaluateInFrames } from './cdp.mjs';

const isWebview = url => url.startsWith('vscode-webview://');
const isWorkbench = url => url.startsWith('vscode-file://');
// The targets the driver attaches to: the workbench window and the webviews. Any other target (a page with an
// empty URL, the host shell's page) holds neither and is not asked anything.
export const isAppSurface = url => isWorkbench(url) || isWebview(url);

/** Polls `probe` until it returns a value other than undefined; throws `what` with the last observation. */
async function until(what, timeoutMs, probe) {
	const deadline = Date.now() + timeoutMs;
	let last = 'no attempt completed';
	while (Date.now() < deadline) {
		const { value, observed } = await probe();
		if (value !== undefined) {
			return value;
		}
		last = observed;
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	throw new Error(`${what} (waited ${timeoutMs / 1000} s; last: ${last})`);
}

/** The values of `fn` in the frames where it reports `state` other than 'absent'; exactly one is required. */
async function inOneFrame(cdp, matches, fn, arg, what) {
	const { values, errors, skipped } = await evaluateInFrames(cdp, isAppSurface, matches, fn, arg);
	const present = values.filter(v => v.value.state !== 'absent');
	if (present.length > 1) {
		throw new Error(`[${what}_ambiguous] ${present.length} frames answer: ${present.map(v => v.url).join(', ')}`);
	}
	return { hit: present[0]?.value, observed: present.length === 0 ? `no frame (${values.length} evaluated; errors: ${errors.join(' | ') || 'none'}; targets not attached: ${skipped.join(', ') || 'none'})` : JSON.stringify(present[0].value) };
}

// --- functions evaluated inside the Action view webview (serialised; no closures) ---
function formState() {
	return document.querySelector('#action-config-form') ? { state: 'form' } : { state: 'absent' };
}
function fillForm(values) {
	const form = document.querySelector('#action-config-form');
	if (!form) {
		return { state: 'absent' };
	}
	const missing = [];
	for (const [id, value] of Object.entries(values)) {
		const field = form.querySelector(`#${id}`);
		if (field) {
			field.value = value;
		} else {
			missing.push(id);
		}
	}
	form.dispatchEvent(new Event('change', { bubbles: true }));
	return { state: 'filled', missing };
}
function submitWhenEnabled() {
	const button = document.querySelector('#action-config-form button[type=submit]');
	if (!button) {
		return { state: 'absent' };
	}
	if (button.disabled) {
		const empty = [...document.querySelectorAll('#action-config-form [required]')].filter(field => !field.value).map(field => field.id);
		return { state: 'disabled', emptyRequired: empty };
	}
	button.click();
	return { state: 'clicked', label: button.textContent.trim() };
}
function runStatus() {
	const card = document.querySelector('.status-card');
	if (!card) {
		return { state: 'absent' };
	}
	const status = [...card.classList].find(name => name.startsWith('status-') && name !== 'status-card');
	const meta = document.querySelector('.status-meta');
	const error = document.querySelector('.callout.error');
	return { state: 'card', status: status === undefined ? 'unknown' : status.slice('status-'.length), meta: meta ? meta.textContent.trim() : '', error: error ? error.textContent.trim() : '' };
}

// --- evaluated in the workbench (window.dialogStyle: custom renders modals in the DOM) ---
function pressDialogButton(expected) {
	const box = document.querySelector('.monaco-dialog-box');
	if (!box) {
		return { state: 'absent' };
	}
	const message = box.querySelector('.dialog-message-text');
	const text = message ? message.textContent.trim() : '';
	const buttons = [...box.querySelectorAll('.monaco-button')];
	const labels = buttons.map(button => button.textContent.trim());
	if (!text.includes(expected.message)) {
		return { state: 'other-dialog', text, labels };
	}
	const button = buttons.find(b => b.textContent.trim() === expected.button);
	if (!button) {
		return { state: 'no-button', text, labels };
	}
	button.click();
	return { state: 'clicked', text, labels };
}

/** Fills the open Action view's form, presses Run Backtest, and waits for the run's status card. */
export async function backtestForm(cdp, args) {
	await until('[backtest_form_missing] no Action view form appeared', 60_000, async () => {
		const { hit, observed } = await inOneFrame(cdp, isWebview, formState, null, 'backtest_form');
		return { value: hit, observed };
	});
	const filled = await inOneFrame(cdp, isWebview, fillForm, args.values, 'backtest_form');
	if (filled.hit === undefined) {
		throw new Error(`[backtest_form_lost] the form disappeared before it was filled: ${filled.observed}`);
	}
	const submitted = await until('[backtest_submit_disabled] Run Backtest stayed disabled', 30_000, async () => {
		const { hit, observed } = await inOneFrame(cdp, isWebview, submitWhenEnabled, null, 'backtest_form');
		return { value: hit?.state === 'clicked' ? hit : undefined, observed };
	});
	const status = await until('[backtest_no_result] the run showed no status card', args.runTimeoutMs, async () => {
		const { hit, observed } = await inOneFrame(cdp, isWebview, runStatus, null, 'backtest_status');
		return { value: hit, observed };
	});
	return { missingFields: filled.hit.missing, submitted: submitted.label, ...status };
}

/** Presses `button` on the modal whose message contains `message` (the import confirmation, the publisher-trust prompt). */
export async function pressModal(cdp, args) {
	return await until(`[modal_missing] no dialog "${args.message}" with a button "${args.button}"`, 60_000, async () => {
		const { hit, observed } = await inOneFrame(cdp, isWorkbench, pressDialogButton, args, 'modal');
		return { value: hit?.state === 'clicked' ? hit : undefined, observed };
	});
}

// --- notification toasts in the workbench (serialised; no closures) ---
function toastTexts() {
	if (!document.querySelector('.monaco-workbench')) {
		return { state: 'absent' };
	}
	return { state: 'present', texts: [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map(e => e.textContent.trim()) };
}

/** Waits until the workbench is in the window (the toast reader needs it). */
export async function waitForWorkbench(cdp, timeoutMs) {
	return until('[workbench_not_loaded] no frame holds the workbench', timeoutMs, async () => {
		const { hit, observed } = await inOneFrame(cdp, isWorkbench, toastTexts, undefined, 'workbench');
		return { value: hit === undefined ? undefined : true, observed };
	});
}

/** The texts of the notification toasts on screen now; exactly one workbench frame must answer. */
export async function readToasts(cdp) {
	const { hit, observed } = await inOneFrame(cdp, isWorkbench, toastTexts, undefined, 'workbench');
	if (hit === undefined) {
		throw new Error(`[toasts_unreadable] ${observed}`);
	}
	return hit.texts;
}
