/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A minimal Chrome DevTools Protocol client for the window driver: the launched app is started with
// --remote-debugging-port=0 and prints its browser endpoint on stderr. Only what the two UI steps need:
// evaluate a function in every frame whose URL matches, across the page and its out-of-process frames.

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

export async function connect(endpoint) {
	if (typeof WebSocket !== 'function') {
		throw new Error(`[cdp_websocket_unavailable] this Node (${process.version}) has no global WebSocket`);
	}
	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', () => reject(new Error(`[cdp_connect_failed] ${endpoint}`)), { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	socket.addEventListener('message', event => {
		const message = JSON.parse(String(event.data));
		const waiter = message.id === undefined ? undefined : pending.get(message.id);
		if (waiter) {
			pending.delete(message.id);
			if (message.error) {
				waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
			} else {
				waiter.resolve(message.result);
			}
		}
	});
	socket.addEventListener('close', () => {
		for (const waiter of pending.values()) {
			waiter.reject(new Error(`[cdp_closed] ${waiter.method}: the connection closed`));
		}
		pending.clear();
	});
	return {
		send(method, params = {}, sessionId = undefined) {
			const id = nextId++;
			socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
			return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
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
 * Evaluates `fn(arg)` in every frame (of every page and iframe target) whose URL satisfies `matches`.
 * Returns `{ values: [{ url, value }], errors: [text] }`: a frame that cannot be evaluated is listed
 * in `errors`, never dropped silently, so a caller that finds no value can say why.
 */
export async function evaluateInFrames(cdp, matches, fn, arg) {
	const values = [];
	const errors = [];
	const { targetInfos } = await cdp.send('Target.getTargets');
	for (const target of targetInfos.filter(t => t.type === 'page' || t.type === 'iframe')) {
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
		try {
			const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
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
	return { values, errors };
}
