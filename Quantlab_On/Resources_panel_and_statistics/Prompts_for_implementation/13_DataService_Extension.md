# Prompt 13: DataService Extension

## Objective
Extend DataService to support loading arbitrary data files (not just OHLCV bars).

## Context
The existing DataService loads OHLCV bars for charts. For stats, we need to load arbitrary columns from CSV/Parquet/XLSX files.

## File to Modify

### `extensions/quantlab/src/core/engine/DataService.ts`

Add the following methods and types:

#### Add imports at top

```typescript
import { spawn } from 'child_process';
import * as path from 'path';
import { ColumnInfo, DataFrameResult } from '../../types/data';
```

#### Add new methods

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Generic Data Loading (for Stats)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get column information for a data file
 * Returns column names, types, and basic stats
 */
async getDataFileColumns(filePath: string): Promise<ColumnInfo[]> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.csv') {
        return this.getCSVColumns(filePath);
    } else if (ext === '.parquet') {
        return this.getParquetColumns(filePath);
    } else if (ext === '.xlsx') {
        return this.getExcelColumns(filePath);
    }

    throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Load a subset of data from a file
 * Used for preview in Visualise view
 */
async loadDataPreview(
    filePath: string,
    options: { limit?: number; columns?: string[] } = {}
): Promise<DataFrameResult> {
    const limit = options.limit ?? 1000;
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.csv') {
        return this.loadCSVPreview(filePath, limit, options.columns);
    } else if (ext === '.parquet') {
        return this.loadParquetPreview(filePath, limit, options.columns);
    } else if (ext === '.xlsx') {
        return this.loadExcelPreview(filePath, limit, options.columns);
    }

    throw new Error(`Unsupported file type: ${ext}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Handling
// ─────────────────────────────────────────────────────────────────────────────

private async getCSVColumns(filePath: string): Promise<ColumnInfo[]> {
    // Use Python for reliable type inference
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'columns'
    });
    return JSON.parse(result) as ColumnInfo[];
}

private async loadCSVPreview(
    filePath: string,
    limit: number,
    columns?: string[]
): Promise<DataFrameResult> {
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'preview',
        limit,
        columns: columns?.join(',')
    });
    return JSON.parse(result) as DataFrameResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parquet Handling
// ─────────────────────────────────────────────────────────────────────────────

private async getParquetColumns(filePath: string): Promise<ColumnInfo[]> {
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'columns'
    });
    return JSON.parse(result) as ColumnInfo[];
}

private async loadParquetPreview(
    filePath: string,
    limit: number,
    columns?: string[]
): Promise<DataFrameResult> {
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'preview',
        limit,
        columns: columns?.join(',')
    });
    return JSON.parse(result) as DataFrameResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel Handling
// ─────────────────────────────────────────────────────────────────────────────

private async getExcelColumns(filePath: string): Promise<ColumnInfo[]> {
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'columns'
    });
    return JSON.parse(result) as ColumnInfo[];
}

private async loadExcelPreview(
    filePath: string,
    limit: number,
    columns?: string[]
): Promise<DataFrameResult> {
    const result = await this.runPythonScript('inspect_data.py', {
        path: filePath,
        action: 'preview',
        limit,
        columns: columns?.join(',')
    });
    return JSON.parse(result) as DataFrameResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Python Script Runner
// ─────────────────────────────────────────────────────────────────────────────

private async runPythonScript(
    script: string,
    args: Record<string, unknown>
): Promise<string> {
    return new Promise((resolve, reject) => {
        const pythonPath = 'python3'; // TODO: Get from settings
        const scriptPath = path.join(
            this.context.extensionPath,
            'python',
            'data',
            script
        );

        const argsList = Object.entries(args)
            .filter(([, v]) => v !== undefined)
            .flatMap(([k, v]) => [`--${k}`, String(v)]);

        const proc = spawn(pythonPath, [scriptPath, ...argsList], {
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python script failed: ${stderr}`));
            } else {
                resolve(stdout.trim());
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to run Python: ${err.message}`));
        });
    });
}
```

## File to Create

### `extensions/quantlab/python/data/inspect_data.py`

```python
#!/usr/bin/env python3
"""
Data inspection script for QuantLab
Outputs JSON to stdout
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
import numpy as np


def get_dtype_string(dtype) -> str:
    """Convert pandas dtype to simple string."""
    dtype_str = str(dtype)
    if 'float' in dtype_str:
        return 'float64'
    elif 'int' in dtype_str:
        return 'int64'
    elif 'datetime' in dtype_str:
        return 'datetime64'
    elif 'bool' in dtype_str:
        return 'bool'
    else:
        return 'object'


def load_dataframe(path: str, limit: int = None) -> pd.DataFrame:
    """Load dataframe from file."""
    p = Path(path)
    ext = p.suffix.lower()

    if ext == '.csv':
        return pd.read_csv(p, nrows=limit)
    elif ext == '.parquet':
        df = pd.read_parquet(p)
        return df.head(limit) if limit else df
    elif ext == '.xlsx':
        return pd.read_excel(p, nrows=limit)
    else:
        raise ValueError(f"Unsupported file type: {ext}")


def get_columns(path: str) -> list[dict]:
    """Get column information."""
    # Load small sample for type inference
    df = load_dataframe(path, limit=1000)

    columns = []
    for col in df.columns:
        series = df[col]
        dtype = get_dtype_string(series.dtype)

        info = {
            'name': str(col),
            'dtype': dtype,
            'nullCount': int(series.isna().sum()),
            'uniqueCount': int(series.nunique())
        }

        # Add numeric stats if applicable
        if dtype in ['float64', 'int64']:
            info['min'] = float(series.min()) if not pd.isna(series.min()) else None
            info['max'] = float(series.max()) if not pd.isna(series.max()) else None

        # Sample values
        sample = series.dropna().head(5).tolist()
        info['sampleValues'] = [str(v) if not isinstance(v, (int, float)) else v for v in sample]

        columns.append(info)

    return columns


def get_preview(path: str, limit: int, columns: list[str] = None) -> dict:
    """Get data preview."""
    df = load_dataframe(path, limit=limit)

    if columns:
        df = df[columns]

    # Convert to serializable format
    data = {}
    for col in df.columns:
        series = df[col]
        # Convert to list, handling special types
        values = []
        for v in series:
            if pd.isna(v):
                values.append(None)
            elif isinstance(v, (np.integer, np.floating)):
                values.append(float(v))
            elif isinstance(v, pd.Timestamp):
                values.append(v.isoformat())
            else:
                values.append(str(v))
        data[str(col)] = values

    column_info = get_columns(path)
    if columns:
        column_info = [c for c in column_info if c['name'] in columns]

    return {
        'columns': column_info,
        'data': data,
        'rowCount': len(df)
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--path', required=True, help='Path to data file')
    parser.add_argument('--action', required=True, choices=['columns', 'preview'])
    parser.add_argument('--limit', type=int, default=1000)
    parser.add_argument('--columns', help='Comma-separated column names')
    args = parser.parse_args()

    try:
        if args.action == 'columns':
            result = get_columns(args.path)
        else:
            cols = args.columns.split(',') if args.columns else None
            result = get_preview(args.path, args.limit, cols)

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
```

## Command Registration

### Add to `extensions/quantlab/src/commands/dataCommands.ts`

```typescript
import { DataService } from '../core/engine/DataService';
import { ColumnInfo } from '../types/data';

// Add in registerDataCommands:

// Get data file columns (used by StatsViewProvider)
context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.getDataFileColumns',
        async (filePath: string): Promise<ColumnInfo[]> => {
            const dataService = DataService.getInstance(context);
            return dataService.getDataFileColumns(filePath);
        }
    )
);

// Get data preview (used by VisualiseViewProvider)
context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.getDataPreview',
        async (filePath: string, options?: { limit?: number; columns?: string[] }) => {
            const dataService = DataService.getInstance(context);
            return dataService.loadDataPreview(filePath, options);
        }
    )
);
```

## Test

1. TypeScript compiles:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Test Python script directly:
   ```bash
   python extensions/quantlab/python/data/inspect_data.py --path test.csv --action columns
   ```

3. Test via command:
   ```typescript
   const columns = await vscode.commands.executeCommand('quantlab.getDataFileColumns', '/path/to/data.csv');
   ```

## Dependencies
- Prompt 01 (types) for ColumnInfo, DataFrameResult

## Next
Proceed to `14_Visualise_View_Provider.md`
