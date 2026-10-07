/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A minimal Chrome DevTools Protocol client for the window driver: the launched app is started with
// --remote-debugging-port=0 and prints its browser endpoint on stderr. Only what the two UI steps need:
// evaluate a function in every frame whose URL matches, across the page and its out-of-process frames.
// Every wait here is bounded: a connection that does not open or a request that gets no answer within the
// caller's limit throws by name, so the launcher cannot outlive its own limits on a silent target.

import * as fs from 'node:fs';

/** The browser endpoint the app printed (`DevTools listening on ws://...`) in its output log. */
export async function waitForEndpoint(logPath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = /DevTools listening on (ws:\/\/\S+)/.exec(fs.readFileSync(logPath, 'utf8'));
		if (match) {
			return match[1];
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`[cdp_no_endpoint] the app printed no "DevTools listening on" line in ${timeoutMs / 1000} s (${logPath}); --remote-debugging-port may be refused by this build`);
}

/** `answerMs` (required) bounds the connection's opening and every request's answer. */
export async function connect(endpoint, answerMs) {
	if (typeof WebSocket !== 'function') {
		throw new Error(`[cdp_websocket_unavailable] this Node (${process.version}) has no global WebSocket`);
	}
	if (!Number.isFinite(answerMs) || answerMs <= 0) {
		throw new Error(`[cdp_answer_limit_missing] connect needs the answer limit in ms (got ${JSON.stringify(answerMs)})`);
	}
	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Rejected first: closing a socket that is still connecting fires its error event at once.
			reject(new Error(`[cdp_connect_timeout] ${endpoint}: not open after ${answerMs / 1000} s`));
			socket.close();
		}, answerMs);
		socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`[cdp_connect_failed] ${endpoint}`)); }, { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	socket.addEventListener('message', event => {
		const message = JSON.parse(String(event.data));
		const waiter = message.id === undefined ? undefined : pending.get(message.id);
		if (waiter) {
			pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.error) {
				waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
			} else {
				waiter.resolve(message.result);
			}
		}
	});
	socket.addEventListener('close', () => {
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`[cdp_closed] ${waiter.method}: the connection closed`));
		}
		pending.clear();
	});
	return {
		send(method, params = {}, sessionId = undefined) {
			const id = nextId++;
			socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`[cdp_no_answer] ${method}${sessionId === undefined ? '' : ` (session ${sessionId})`}: no answer after ${answerMs / 1000} s`));
				}, answerMs);
				pending.set(id, { method, resolve, reject, timer });
			});
		},
		close() {
			socket.close();
		},
	};
}

function frames(tree) {
	return [tree.frame, ...(tree.childFrames ?? []).flatMap(frames)];
}

/**
 * Evaluates `fn(arg)` in every frame whose URL satisfies `matches`, inside the page and iframe targets whose
 * own URL satisfies `targets`. Only those targets are attached: the packaged app also has a page target with
 * an empty URL whose Page.getFrameTree is never answered (guest P1b, guest-p1b-r3), and asking it stalled
 * every step. Returns `{ values: [{ url, value }], errors: [text], skipped: [text] }`: a frame that cannot be
 * evaluated is listed in `errors` and a target not attached in `skipped`, never dropped silently, so a caller
 * that finds no value can say why.
 */
export async function evaluateInFrames(cdp, targets, matches, fn, arg) {
	if (typeof targets !== 'function') {
		throw new Error('[cdp_target_filter_missing] evaluateInFrames needs the predicate on target URLs');
	}
	const values = [];
	const errors = [];
	const { targetInfos } = await cdp.send('Target.getTargets');
	const candidates = targetInfos.filter(t => t.type === 'page' || t.type === 'iframe');
	const skipped = candidates.filter(t => !targets(t.url)).map(t => `${t.type} ${JSON.stringify(t.url)}`);
	for (const target of candidates.filter(t => targets(t.url))) {
		// A target that does not answer is named with its type and URL: the caller's error says which one.
		const named = err => { throw new Error(`${err.message} (target ${target.type} ${target.url})`); };
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }).catch(named);
		try {
			const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId).catch(named);
			for (const frame of frames(frameTree).filter(f => matches(f.url))) {
				try {
					const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'ql-features-driver' }, sessionId);
					const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
						expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
						contextId: executionContextId,
						returnByValue: true,
						awaitPromise: true,
					}, sessionId);
					if (exceptionDetails) {
						errors.push(`${frame.url}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
					} else {
						values.push({ url: frame.url, value: result.value });
					}
				} catch (err) {
					errors.push(`${frame.url}: ${err.message}`);
				}
			}
		} finally {
			await cdp.send('Target.detachFromTarget', { sessionId });
		}
	}
	return { values, errors, skipped };
}
