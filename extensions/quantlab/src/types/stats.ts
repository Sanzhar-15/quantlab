/*---------------------------------------------------------------------------------------------
 *  Statistical test type definitions for QuantLab
 *--------------------------------------------------------------------------------------------*/

import { ColumnDType } from './data';

export type StatsCategory =
    | 'descriptive'
    | 'stationarity'
    | 'distribution'
    | 'dependence'
    | 'volatility'
    | 'regression'
    | 'risk';

export interface StatsTestDefinition {
    id: string;
    label: string;
    description: string;
    category: StatsCategory;
    requiredColumns: {
        count: number | '1+' | '2+';
        types: Array<'float64' | 'int64'>;
    };
    parameters: StatsParameterDefinition[];
}

export interface StatsParameterDefinition {
    id: string;
    label: string;
    type: 'number' | 'select' | 'boolean' | 'array';
    default: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    description?: string;
}

export interface StatsTestConfig {
    testId: string;
    dataPath: string;
    columns: string[];
    parameters: Record<string, unknown>;
}

export interface StatsTestResult {
    testId: string;
    testName: string;
    statistic: number;
    pValue: number | null;
    criticalValues?: Record<string, number>;
    conclusion: string;
    interpretation: string;
    details: Record<string, unknown>;
    visualizations?: StatsVisualization[];
}

export interface StatsVisualization {
    type: 'line' | 'bar' | 'scatter' | 'heatmap' | 'histogram';
    title: string;
    data: unknown;
    layout?: unknown;
}

// State types for Stats view
export type StatsState =
    | StatsIdleState
    | StatsConfigurationState
    | StatsRunningState
    | StatsResultsState
    | StatsErrorState;

export interface StatsIdleState {
    type: 'idle';
    dataFile: string;
}

export interface StatsConfigurationState {
    type: 'configuration';
    testId: string;
    testName: string;
    dataFile: string;
    columns: Array<{ name: string; dtype: ColumnDType }>;
    selectedColumns: string[];
    parameters: Record<string, unknown>;
    schema: StatsTestDefinition;
    validation?: { isValid: boolean; errors: string[] };
}

export interface StatsRunningState {
    type: 'running';
    testId: string;
    testName: string;
    progress: number;
    message: string;
    startedAt: string;
}

export interface StatsResultsState {
    type: 'results';
    testId: string;
    result: StatsTestResult;
    durationMs: number;
}

export interface StatsErrorState {
    type: 'error';
    testId: string;
    error: string;
    recoverable: boolean;
}
