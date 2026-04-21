/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function getVisualizationTemplate(): string {
	return [
		'def visualize(chart):',
		'    """Visualization logic - optional."""',
		'    # Add indicators to chart',
		'    # chart.plot(fast_ma, color="blue", label="Fast MA")',
		'    # chart.plot(slow_ma, color="red", label="Slow MA")',
		'    #',
		'    # Add custom markers',
		'    # chart.mark_entries(style="arrow_up", color="green")',
		'    # chart.mark_exits(style="arrow_down", color="red")',
		'    #',
		'    # Add equity curve in separate pane',
		'    # chart.add_pane("equity", height=0.3)',
		'    # chart.plot_equity(pane="equity")',
		'    pass',
		''
	].join('\n');
}
