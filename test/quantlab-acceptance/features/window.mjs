/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window driver's steps, answered to the in-host driver through cues.cjs. Each drives the real
// UI over CDP (see RUNNER-FLOW.md) and returns what it saw; a step that cannot finish throws by name.

import { evaluateInFrames } from './cdp.mjs';
import { NATIVE_LIMITS, nativeScan, nativeSurface } from './native-dialog.mjs';

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

// --- evaluated in the workbench (a DOM dialog: the workbench renders one when the window's dialogStyle is "custom" or the dialog carries custom options; the others are native, see native-dialog.mjs) ---
// Reads the open .monaco-dialog-box; with expected.click it also presses expected.button when the dialog is the wanted one.
function dialogButton(expected) {
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
	if (expected.click) {
		button.click();
		return { state: 'clicked', text, labels };
	}
	return { state: 'present', text, labels };
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

/**
 * The DOM surface for the dialog `args.message` / `args.button`: { read, press }. read() looks at the workbench frame without
 * clicking: { found, observed }, found = a .monaco-dialog-box whose message contains args.message and which has the button.
 * press() clicks the button over CDP; a dialog that is no longer there at the click throws [modal_dom_changed].
 */
function domSurface(cdp, args) {
	const expected = click => ({ message: args.message, button: args.button, click });
	return {
		async read() {
			const { hit, observed } = await inOneFrame(cdp, isWorkbench, dialogButton, expected(false), 'modal');
			const found = hit?.state === 'present';
			const text = hit === undefined ? `no dialog in the workbench frame (${observed})`
				: found ? JSON.stringify(hit)
				: hit.state === 'other-dialog' ? `a dialog with another message is open (not a match): ${JSON.stringify(hit)}`
				: `the dialog has the message but no button "${args.button}": ${JSON.stringify(hit)}`;
			return { found, observed: text };
		},
		async press() {
			const { hit, observed } = await inOneFrame(cdp, isWorkbench, dialogButton, expected(true), 'modal');
			if (hit?.state !== 'clicked') {
				throw new Error(`[modal_dom_changed] the DOM dialog "${args.message}" with a button "${args.button}" was seen, but at the click: ${observed}; nothing was clicked`);
			}
			return { route: 'dom', text: hit.text, labels: hit.labels, clicked: args.button };
		},
	};
}

/**
 * The two surfaces a dialog can be on, { dom, native }, each { read, press }: the workbench decides per dialog (it renders a DOM
 * dialog when the window's dialogStyle is "custom" or the dialog carries custom options, a native one otherwise), so both are asked.
 * `native` = { scan, limits } of the native surface (nativeScan and NATIVE_LIMITS, or fakes in the tests). `pid` is the app's main process.
 */
export function modalSurfaces(cdp, args, pid, native) {
	const surface = nativeSurface({ pid, message: args.message, button: args.button }, native);
	return {
		dom: domSurface(cdp, args),
		native: {
			async read() {
				const scanned = await surface.read();
				return { found: surface.holders(scanned).length > 0, observed: surface.observed(scanned), scanned };
			},
			press: observation => surface.press(observation.scanned),
		},
	};
}

/**
 * Looks for the dialog on both surfaces in every poll (limits.pollMs, up to limits.waitMs) and presses the button on the one that
 * holds it. Both holding it throws [modal_ambiguous] and nothing is clicked; neither in time throws [modal_missing] naming each
 * surface's last observation. Returns the surface's record plus { surface, route (= surface), dialogStyle }.
 */
export async function awaitModal(args, surfaces, limits) {
	const started = Date.now();
	let polls = 0;
	for (;;) {
		const dom = await surfaces.dom.read();
		const native = await surfaces.native.read();
		polls++;
		if (dom.found && native.found) {
			throw new Error(`[modal_ambiguous] dialog "${args.message}" with a button "${args.button}" is on both surfaces (DOM: ${dom.observed}; native: ${native.observed}); nothing was clicked`);
		}
		if (dom.found || native.found) {
			const surface = dom.found ? 'dom' : 'native';
			const pressed = await surfaces[surface].press(dom.found ? dom : native);
			return { ...pressed, surface, route: surface, dialogStyle: args.dialogStyle };
		}
		if (Date.now() - started > limits.waitMs) {
			throw new Error(`[modal_missing] no dialog "${args.message}" with a button "${args.button}" on either surface (DOM: ${dom.observed}; native: ${native.observed}) after ${limits.waitMs / 1000} s (${polls} polls)`);
		}
		await new Promise(resolve => setTimeout(resolve, limits.pollMs));
	}
}

/**
 * Presses `args.button` on the modal whose message contains `args.message` (the import confirmation, the publisher-trust prompt),
 * wherever the workbench put it (see modalSurfaces). `pid` is the app's main process, for the native surface. `args.dialogStyle`
 * is the driver's reading of the effective window.dialogStyle: evidence only, it routes nothing; a value other than "custom" or
 * "native" signals a broken reading and throws [dialog_style_unknown] before a dialog is waited for.
 */
export async function pressModal(cdp, args, pid) {
	checkDialogStyle(args.dialogStyle);
	return await awaitModal(args, modalSurfaces(cdp, args, pid, { scan: nativeScan, limits: NATIVE_LIMITS }), NATIVE_LIMITS);
}

export function checkDialogStyle(style) {
	if (style !== 'custom' && style !== 'native') {
		throw new Error(`[dialog_style_unknown] window.dialogStyle is ${JSON.stringify(style)}, expected "custom" or "native"; the reading is broken, no dialog was waited for`);
	}
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
