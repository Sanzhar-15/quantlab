/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import { formatMetricValue as historyFormat } from '../panels/history/HistoryTreeProvider';
import { formatMetricValue as webviewFormat, pickMetric } from '../../webview/action/utils';

// The engine writes inf / NaN as null (engine/quantlab/cli/run_backtest.py _sanitize_for_json, :21-36, applied at :245):
// a run with no losing trade has "ProfitFactor": null. Where a metric is shown, null reads "not finite"; it never
// reaches toFixed (the run list and the history tree called metric.value.toFixed(2) on it).
suite('engine null floats on display', () => {
	for (const [where, format] of [['history tree', historyFormat], ['Action view', webviewFormat]] as const) {
		test(`${where}: null is "not finite", a number keeps two decimals`, () => {
			assert.strictEqual(format(null), 'not finite');
			assert.strictEqual(format(1.2345), '1.23');
			assert.strictEqual(format(0), '0.00');
		});
	}

	test('the Action view picks a null Sharpe as null, and it formats without throwing', () => {
		const metric = pickMetric({ Sharpe: null, Return: 1.99 });
		assert.deepStrictEqual(metric, { label: 'Sharpe', value: null });
		assert.strictEqual(webviewFormat(metric.value), 'not finite');
	});
});
