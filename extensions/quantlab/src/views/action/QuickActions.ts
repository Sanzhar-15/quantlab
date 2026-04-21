/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigField, ConfigSchema, QuickActionType } from '../../types/action';
import { GlobalState } from '../../core/state/GlobalState';
import { ParameterDefinition } from '../../types/strategy';
import { isLocalFileSource, isServerSource } from '../../types/market';

export class QuickActions {
	static buildSchema(action: QuickActionType, parameters: ParameterDefinition[]): ConfigSchema {
		const dataFields: ConfigField[] = [
			{ id: 'dataSource', label: 'Data Source', type: 'file', required: true, fileFilter: ['*.csv', '*.parquet'] },
			{ id: 'dateStart', label: 'Start Date', type: 'date' },
			{ id: 'dateEnd', label: 'End Date', type: 'date' }
		];

		const parameterFields: ConfigField[] = [
			{
				id: 'paramSource',
				label: 'Parameter Source',
				type: 'select',
				options: [
					{ label: 'Code Defaults', value: 'code' },
					{ label: 'Chart Overrides', value: 'chart' },
					{ label: 'Custom', value: 'custom' }
				]
			},
			...parameters.map(param => ({
				id: `param.${param.id}`,
				label: param.name ?? param.id,
				type: typeof param.default === 'number' ? 'number' : 'text',
				min: param.min,
				max: param.max,
				step: param.step
			} satisfies ConfigField))
		];

		return {
			id: `quantlab.action.${action}`,
			label: this.getLabel(action),
			sections: [
				{
					id: 'action',
					label: 'Configuration',
					fields: this.getActionFields(action)
				},
				{
					id: 'data',
					label: 'Data',
					fields: dataFields
				},
				{
					id: 'parameters',
					label: 'Strategy Parameters',
					fields: parameterFields
				}
			]
		};
	}

	static buildDefaults(action: QuickActionType, globalState: GlobalState, parameters: ParameterDefinition[]): Record<string, unknown> {
		const source = globalState.getDataSource();
		let dataSourceValue = '';
		if (isLocalFileSource(source)) {
			dataSourceValue = source.filePath;
		} else if (isServerSource(source)) {
			dataSourceValue = `server:${source.symbol}`;
		}

		const values: Record<string, unknown> = {
			dataSource: dataSourceValue,
			paramSource: 'code'
		};

		for (const param of parameters) {
			values[`param.${param.id}`] = param.default;
		}

		switch (action) {
			case 'optimize':
				values.metric = 'sharpe';
				values.method = 'grid';
				break;
			case 'monteCarlo':
				values.simulations = 1000;
				values.confidence = 95;
				break;
			case 'wfa':
				values.splits = 5;
				values.trainRatio = 0.7;
				break;
			default:
				values.metric = 'sharpe';
				break;
		}

		return values;
	}

	private static getLabel(action: QuickActionType): string {
		switch (action) {
			case 'optimize':
				return 'Optimize';
			case 'monteCarlo':
				return 'Monte Carlo';
			case 'wfa':
				return 'Walk Forward Analysis';
			case 'backtest':
			default:
				return 'Backtest';
		}
	}

	private static getActionFields(action: QuickActionType): ConfigField[] {
		switch (action) {
			case 'optimize':
				return [
					{
						id: 'method',
						label: 'Optimization Method',
						type: 'select',
						options: [
							{ label: 'Grid', value: 'grid' },
							{ label: 'Random', value: 'random' }
						]
					},
					{
						id: 'metric',
						label: 'Metric',
						type: 'select',
						options: [
							{ label: 'Sharpe', value: 'sharpe' },
							{ label: 'Return', value: 'return' }
						]
					}
				];
			case 'monteCarlo':
				return [
					{ id: 'simulations', label: 'Simulations', type: 'number', min: 100, max: 10000, step: 100 },
					{ id: 'confidence', label: 'Confidence %', type: 'number', min: 50, max: 99, step: 1 }
				];
			case 'wfa':
				return [
					{ id: 'splits', label: 'Splits', type: 'number', min: 2, max: 10, step: 1 },
					{ id: 'trainRatio', label: 'Train Ratio', type: 'number', min: 0.5, max: 0.9, step: 0.05 }
				];
			case 'backtest':
			default:
				return [
					{
						id: 'metric',
						label: 'Metric',
						type: 'select',
						options: [
							{ label: 'Sharpe', value: 'sharpe' },
							{ label: 'Return', value: 'return' }
						]
					}
				];
		}
	}
}
