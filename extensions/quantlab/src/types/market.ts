/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D' | '1W' | '1M';

// Server timeframe format (lowercase 'h' for hours)
export type ServerTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';

export interface LocalFileDataSource {
	kind: 'localFile';
	filePath: string;
	displayName: string;
}

export interface ServerDataSource {
	kind: 'server';
	symbol: string;
	displayName: string;
	assetClass?: string;
}

export type DataSourceDescriptor = LocalFileDataSource | ServerDataSource;

export interface GlobalMarketState {
	dataSource?: DataSourceDescriptor;
	timeframe?: Timeframe;
	dateRange?: {
		start: Date;
		end: Date;
	};
}

// Utility function to convert client timeframe to server timeframe
export function toServerTimeframe(timeframe: Timeframe): ServerTimeframe {
	switch (timeframe) {
		case '1H': return '1h';
		case '4H': return '4h';
		default: return timeframe as ServerTimeframe;
	}
}

// Utility function to convert server timeframe to client timeframe
export function fromServerTimeframe(timeframe: ServerTimeframe): Timeframe {
	switch (timeframe) {
		case '1h': return '1H';
		case '4h': return '4H';
		default: return timeframe as Timeframe;
	}
}

// Check if data source is local file
export function isLocalFileSource(source: DataSourceDescriptor | undefined): source is LocalFileDataSource {
	return source?.kind === 'localFile';
}

// Check if data source is server
export function isServerSource(source: DataSourceDescriptor | undefined): source is ServerDataSource {
	return source?.kind === 'server';
}
