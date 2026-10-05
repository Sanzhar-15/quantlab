/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The cue protocol between the in-host driver (checks.cjs) and the window driver in the launcher:
// the driver writes `<dir>/<name>.request.json` when a step needs the window driven (a webview form,
// a modal button) and waits for `<dir>/<name>.response.json` = { ok: true, value } | { ok: false, error }.
// Each name is asked once per launch.

const fs = require('fs');
const path = require('path');

const POLL_MS = 500;

/** Driver side: ask for `name` and wait for its answer; an error answer or no answer throws by name. */
async function ask(dir, name, args, timeoutMs) {
	const request = path.join(dir, `${name}.request.json`);
	const response = path.join(dir, `${name}.response.json`);
	if (fs.existsSync(request)) {
		throw new Error(`[cue_reused] ${name} was already asked in this launch`);
	}
	fs.writeFileSync(`${request}.tmp`, JSON.stringify({ name, args }));
	fs.renameSync(`${request}.tmp`, request);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(response)) {
			const answer = JSON.parse(fs.readFileSync(response, 'utf8'));
			if (!answer.ok) {
				throw new Error(answer.error);
			}
			return answer.value;
		}
		await new Promise(resolve => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`[cue_unanswered] the window driver did not answer ${name} in ${timeoutMs / 1000} s`);
}

/**
 * Launcher side: answers every request in `dir` with `handlers[name](args)` until `stopped()` is true.
 * An unknown name or a handler that throws is answered with the error, so the driver fails by name.
 * Resolves to the list of names answered.
 */
async function serve(dir, handlers, stopped) {
	const answered = [];
	while (!stopped()) {
		for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.request.json')).sort()) {
			const name = file.slice(0, -'.request.json'.length);
			if (answered.includes(name)) {
				continue;
			}
			answered.push(name);
			const { args } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			let answer;
			try {
				const handler = handlers[name];
				if (handler === undefined) {
					throw new Error(`[cue_unknown] the window driver has no step named ${name}`);
				}
				answer = { ok: true, value: await handler(args) };
			} catch (err) {
				answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			const response = path.join(dir, `${name}.response.json`);
			fs.writeFileSync(`${response}.tmp`, JSON.stringify(answer));
			fs.renameSync(`${response}.tmp`, response);
		}
		await new Promise(resolve => setTimeout(resolve, POLL_MS));
	}
	return answered;
}

module.exports = { ask, serve };
