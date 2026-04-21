/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const QIC_PANEL_VISIBLE = new RawContextKey<boolean>('qicPanelVisible', false);
export const QIC_HAS_PROVIDER = new RawContextKey<boolean>('qicHasProvider', false);
export const QIC_IS_PROCESSING = new RawContextKey<boolean>('qicIsProcessing', false);
export const QIC_IS_READY = new RawContextKey<boolean>('qicIsReady', false);
