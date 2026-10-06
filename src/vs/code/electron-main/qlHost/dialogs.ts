/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the parent of a dialog the stock code shows for the adopted workbench.
//
// The stock code parents a dialog to `CodeWindow.win`. After adoption that is the stand-in (a proxy, which Electron's native
// dialog functions cannot take) over a hidden shell (which a sheet cannot attach to). The dialog belongs to the host's window,
// the one the user sees. This class only re-parents; it never answers a dialog and never changes its options.
// The host's own failure dialogs are parented to the host window here too (`showMessageBoxOnHost`).

import type { BaseWindow, BrowserWindow, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { DialogMainService } from '../../../platform/dialogs/electron-main/dialogMainService.js';

export class QlDialogMainService extends DialogMainService {

	private parentResolver: ((window: BrowserWindow) => BaseWindow | undefined) | undefined;

	/** Set once, when the host attaches. The resolver returns the host window for the adopted workbench's windows, else `undefined`. */
	setParentResolver(resolver: (window: BrowserWindow) => BaseWindow | undefined): void {
		if (this.parentResolver) {
			throw new Error('QuantLab host (U5): the dialog parent resolver is already set');
		}

		this.parentResolver = resolver;
	}

	private parentFor(window: BrowserWindow | undefined): BrowserWindow | undefined {
		if (!window || !this.parentResolver) {
			return window;
		}

		const host = this.parentResolver(window);
		if (!host) {
			return window;
		}

		return this.asDialogParent(host);
	}

	// `electron.d.ts` (39): the native dialogs take a `BaseWindow`; the fork's `DialogMainService` types its parameter
	// `BrowserWindow` and reads only `id` from it. This is the one place that says so.
	private asDialogParent(host: BaseWindow): BrowserWindow {
		return host as unknown as BrowserWindow;
	}

	/**
	 * A message box of the host's own (a failure it reports), attached to the host window. An unparented message box is
	 * app-modal on macOS (`runModal` on the main thread): until it is answered nothing else runs there, not even a quit.
	 */
	showMessageBoxOnHost(options: MessageBoxOptions, host: BaseWindow): Promise<MessageBoxReturnValue> {
		return super.showMessageBox(options, this.asDialogParent(host));
	}

	override showMessageBox(options: MessageBoxOptions, window?: BrowserWindow): Promise<MessageBoxReturnValue> {
		return super.showMessageBox(options, this.parentFor(window));
	}

	override showSaveDialog(options: SaveDialogOptions, window?: BrowserWindow): Promise<SaveDialogReturnValue> {
		return super.showSaveDialog(options, this.parentFor(window));
	}

	override showOpenDialog(options: OpenDialogOptions, window?: BrowserWindow): Promise<OpenDialogReturnValue> {
		return super.showOpenDialog(options, this.parentFor(window));
	}
}
