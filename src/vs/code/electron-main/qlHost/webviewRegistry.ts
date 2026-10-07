/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (review c2 M2 + M3): the webviews a workbench document registered, per workbench contents. No run-time
// imports: `build/qlhost/check-workbench-security.mjs` runs this file against fake frames.
//
//  - written by the webview manager service (`platform/webview/electron-main/webviewMainService.ts`, channel `webview`): the
//    workbench's webview element registers its frame name and authority before the frame gets its `src`, and unregisters
//    when it is disposed. A webview frame has no IPC: only the workbench document can register;
//  - read, and bound, by the frame policy (`securityPolicy.ts`): the first navigation of a direct child of the workbench
//    document with a registered name to that registration's `index.html` binds the frame's `frameTreeNodeId`. One frame per
//    registration, one registration per frame. A registration whose frame no longer exists can be bound again (the element
//    was taken out of the document and put back: a new frame with the same name);
//  - registering a name again replaces the registration, unbound (the element is mounted again);
//  - the registrations of a contents go with the contents (weak map).

import type { IQlContents, IQlWebviewRegistrations } from './securityPolicy.js';

interface IQlWebviewRegistration {
	readonly authority: string;
	boundFrame: number | undefined;
}

export class QlWebviewRegistry {

	private readonly byContents = new WeakMap<IQlContents, Map<string, IQlWebviewRegistration>>();

	register(contents: IQlContents, frameName: string, authority: string): void {
		if (typeof frameName !== 'string' || frameName.length === 0) {
			throw new Error(`QuantLab host: a webview registration needs a frame name, got ${JSON.stringify(frameName)}`);
		}

		if (typeof authority !== 'string' || !/^[0-9a-z]+$/.test(authority)) {
			throw new Error(`QuantLab host: the webview registration ${frameName} needs a lower-case alphanumeric authority, got ${JSON.stringify(authority)}`);
		}

		let registrations = this.byContents.get(contents);
		if (!registrations) {
			registrations = new Map();
			this.byContents.set(contents, registrations);
		}

		registrations.set(frameName, { authority, boundFrame: undefined });
	}

	unregister(contents: IQlContents, frameName: string): void {
		if (!this.byContents.get(contents)?.delete(frameName)) {
			throw new Error(`QuantLab host: no webview registration ${JSON.stringify(frameName)} to end`);
		}
	}

	/** The registrations of `contents`, as the frame policy reads and binds them. */
	of(contents: IQlContents): IQlWebviewRegistrations {
		const boundAuthority = (frameTreeNodeId: number): string | undefined => {
			const registrations = this.byContents.get(contents);
			if (!registrations) {
				return undefined;
			}

			for (const registration of registrations.values()) {
				if (registration.boundFrame === frameTreeNodeId) {
					return registration.authority;
				}
			}

			return undefined;
		};

		return {
			boundAuthority,
			bind: (frameName, authority, frameTreeNodeId) => {
				const registration = this.byContents.get(contents)?.get(frameName);
				if (!registration || registration.authority !== authority || boundAuthority(frameTreeNodeId) !== undefined) {
					return false;
				}

				const bound = registration.boundFrame;
				if (bound !== undefined && contents.mainFrame.framesInSubtree.some(frame => frame.frameTreeNodeId === bound)) {
					return false;
				}

				registration.boundFrame = frameTreeNodeId;
				return true;
			}
		};
	}
}
