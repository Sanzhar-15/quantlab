/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI streaming parse
 *  Pure parser for a single Server-Sent-Events `data:` payload from the Anthropic
 *  streaming Messages API. Kept vscode-free + side-effect-free so it is unit-tested
 *  headlessly and so the streaming loop in `provider.ts` has ONE place that decides
 *  what a stream event means.
 *
 *  No-Fallbacks: a corrupt event is NOT silently dropped (the old `catch {}`).
 *  Malformed JSON throws; an API `error` event is surfaced so the caller can throw loud.
 *---------------------------------------------------------------------------------------------*/

/**
 * The meaning of one decoded SSE `data:` payload.
 * - `text`: a text delta to append to the response (may be an empty string).
 * - `ignore`: a valid-but-uninteresting event (message_start, ping, content_block_start/stop,
 *   message_delta/stop, thinking deltas, the `[DONE]` sentinel, ...).
 * - `error`: the API reported an error mid-stream; `message` carries the reason.
 */
export type StreamEvent =
	| { kind: 'text'; text: string }
	| { kind: 'ignore' }
	| { kind: 'error'; message: string };

/**
 * Parse the payload of a single SSE line (the part AFTER the leading `data: `).
 * Total EXCEPT it throws on malformed JSON -- a payload that does not parse means the
 * stream is corrupt and must be surfaced, never skipped.
 */
export function parseStreamEvent(data: string): StreamEvent {
	// SSE framing may be CRLF; a trailing '\r' would make '[DONE]\r' miss the sentinel and
	// throw as malformed JSON. Normalize one trailing '\r' before any comparison.
	if (data.endsWith('\r')) {
		data = data.slice(0, -1);
	}

	// The Anthropic stream terminates with a literal sentinel, not JSON.
	if (data === '[DONE]') {
		return { kind: 'ignore' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		throw new Error(`Malformed SSE event from Anthropic API: ${data.slice(0, 200)}`);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return { kind: 'ignore' };
	}

	const event = parsed as { type?: unknown; error?: unknown; delta?: unknown };

	// An error event aborts the stream loud. Anthropic shapes this as
	// { type: 'error', error: { type, message } }.
	if (event.type === 'error') {
		const err = event.error as { message?: unknown } | undefined;
		const message =
			err && typeof err.message === 'string' && err.message.length > 0
				? err.message
				: `Anthropic stream error: ${data.slice(0, 200)}`;
		return { kind: 'error', message };
	}

	// Only a text delta carries response content. Thinking deltas, input-json deltas,
	// and every other event type are ignored.
	if (event.type === 'content_block_delta') {
		const delta = event.delta as { type?: unknown; text?: unknown } | undefined;
		if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
			return { kind: 'text', text: delta.text };
		}
		return { kind: 'ignore' };
	}

	return { kind: 'ignore' };
}
