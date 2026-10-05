/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The QIC product-key gate. The packaged product.json key `quantlab.qicEnabled` decides:
//   true  -> the whole QIC contribution is loaded (qic.contribution.js);
//   false -> only the `qic` view container with ONE view showing the named refusal
//            `assistant_pending` is registered: no command, no adapter, no request path.
// A key that is absent or not a boolean is a build defect and throws by name.

import { Codicon } from '../../../../base/common/codicons.js';
import { $, append } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { QIC_VIEW_CONTAINER_ID } from '../common/constants.js';

export const QIC_ENABLED_PRODUCT_KEY = 'quantlab.qicEnabled';
export const QIC_PENDING_VIEW_ID = 'workbench.view.qic.pending';
export const QIC_PENDING_REFUSAL = 'assistant_pending';

class QicPendingViewPane extends ViewPane {
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const body = append(container, $('.qic-pending'));
		body.style.padding = '12px 16px';
		body.dataset.refusal = QIC_PENDING_REFUSAL;
		append(body, $('p')).textContent = localize('qicPending', "Orion for Code is not available in this build yet.");
		append(body, $('code')).textContent = QIC_PENDING_REFUSAL;
	}
}

function registerPendingView(): void {
	const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: QIC_VIEW_CONTAINER_ID,
		title: localize2('qic', "Orion"),
		icon: Codicon.sparkle,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QIC_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: QIC_VIEW_CONTAINER_ID,
		hideIfEmpty: false,
		order: 0,
	}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
		id: QIC_PENDING_VIEW_ID,
		containerIcon: container.icon,
		containerTitle: container.title.value,
		singleViewPaneContainerTitle: container.title.value,
		name: localize2('qicPendingName', "Orion"),
		canToggleVisibility: false,
		canMoveView: false,
		ctorDescriptor: new SyncDescriptor(QicPendingViewPane),
	}], container);
}

const qicEnabled: unknown = (product as unknown as Record<string, unknown>)[QIC_ENABLED_PRODUCT_KEY];
if (qicEnabled === true) {
	await import('./qic.contribution.js');
} else if (qicEnabled === false) {
	registerPendingView();
} else {
	throw new Error(`qicGate: product key ${QIC_ENABLED_PRODUCT_KEY} must be true or false, got ${JSON.stringify(qicEnabled)}`);
}
