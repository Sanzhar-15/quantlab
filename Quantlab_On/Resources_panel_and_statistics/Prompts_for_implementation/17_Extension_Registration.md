# Prompt 17: Extension Registration

## Objective
Wire all new providers and commands in the extension's main entry point.

## Context
All components are created but need to be registered when the extension activates.

## File to Modify

### `extensions/quantlab/src/extension.ts`

Add the following imports and registrations:

#### 1. Add imports

```typescript
// Existing imports...

// NEW: Data view imports
import { DataViewManager } from './views/DataViewManager';
import { VisualiseViewProvider } from './views/visualise/VisualiseViewProvider';
import { StatsViewProvider } from './views/stats/StatsViewProvider';
import { ResourcesWebviewProvider } from './panels/resources/ResourcesWebviewProvider';
import { registerDataCommands } from './commands/dataCommands';
import { StatsEngine } from './stats/StatsEngine';
```

#### 2. In the `activate` function, add registrations

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Existing activation code...

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize Singletons
    // ─────────────────────────────────────────────────────────────────────────

    // Initialize DataViewManager
    DataViewManager.getInstance();

    // Initialize StatsEngine
    StatsEngine.getInstance(context);

    // ─────────────────────────────────────────────────────────────────────────
    // Register Data View Providers
    // ─────────────────────────────────────────────────────────────────────────

    // Visualise View (custom editor for data files)
    context.subscriptions.push(
        VisualiseViewProvider.register(context)
    );

    // Stats View (custom editor for data files)
    context.subscriptions.push(
        StatsViewProvider.register(context)
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Register Resources Panel (WebviewViewProvider)
    // ─────────────────────────────────────────────────────────────────────────

    const resourcesProvider = ResourcesWebviewProvider.initialize(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ResourcesWebviewProvider.viewType,
            resourcesProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Register Data Commands
    // ─────────────────────────────────────────────────────────────────────────

    registerDataCommands(context);

    // ─────────────────────────────────────────────────────────────────────────
    // Log activation
    // ─────────────────────────────────────────────────────────────────────────

    console.log('QuantLab extension activated with data file support');
}
```

#### 3. Full activate function example

```typescript
import * as vscode from 'vscode';

// Existing imports
import { ChartViewProvider } from './views/chart/ChartViewProvider';
import { ActionViewProvider } from './views/action/ActionViewProvider';
import { TradeViewProvider } from './views/trade/TradeViewProvider';
import { ViewManager } from './views/ViewManager';
import { EngineHost } from './core/engine/EngineHost';
import { DataService } from './core/engine/DataService';

// NEW imports
import { DataViewManager } from './views/DataViewManager';
import { VisualiseViewProvider } from './views/visualise/VisualiseViewProvider';
import { StatsViewProvider } from './views/stats/StatsViewProvider';
import { ResourcesWebviewProvider } from './panels/resources/ResourcesWebviewProvider';
import { registerDataCommands } from './commands/dataCommands';
import { StatsEngine } from './stats/StatsEngine';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('QuantLab extension activating...');

    // ═══════════════════════════════════════════════════════════════════════
    // EXISTING: Strategy file support
    // ═══════════════════════════════════════════════════════════════════════

    // Initialize core services
    const dataService = DataService.getInstance(context);
    const engineHost = EngineHost.getInstance(context);
    const viewManager = ViewManager.getInstance();

    // Register strategy view providers
    context.subscriptions.push(
        ChartViewProvider.register(context)
    );
    context.subscriptions.push(
        ActionViewProvider.register(context)
    );
    context.subscriptions.push(
        TradeViewProvider.register(context)
    );

    // Register existing strategy commands
    // ... (existing command registrations)

    // ═══════════════════════════════════════════════════════════════════════
    // NEW: Data file support
    // ═══════════════════════════════════════════════════════════════════════

    // Initialize data singletons
    DataViewManager.getInstance();
    StatsEngine.getInstance(context);

    // Register data view providers
    context.subscriptions.push(
        VisualiseViewProvider.register(context)
    );
    context.subscriptions.push(
        StatsViewProvider.register(context)
    );

    // Register Resources panel (WebviewViewProvider)
    const resourcesProvider = ResourcesWebviewProvider.initialize(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ResourcesWebviewProvider.viewType,
            resourcesProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Register data commands
    registerDataCommands(context);

    console.log('QuantLab extension activated');
}

export function deactivate(): void {
    console.log('QuantLab extension deactivating...');
}
```

## File Structure Verification

After all prompts, the extension structure should include:

```
extensions/quantlab/
├── src/
│   ├── extension.ts                    # Main entry (MODIFIED)
│   ├── types/
│   │   ├── data.ts                     # NEW (Prompt 01)
│   │   ├── stats.ts                    # NEW (Prompt 01)
│   │   ├── views.ts                    # MODIFIED (Prompt 01)
│   │   └── engine.ts                   # MODIFIED (Prompt 01)
│   ├── views/
│   │   ├── DataViewManager.ts          # NEW (Prompt 04)
│   │   ├── visualise/
│   │   │   └── VisualiseViewProvider.ts # NEW (Prompt 14)
│   │   └── stats/
│   │       └── StatsViewProvider.ts    # NEW (Prompt 09)
│   ├── panels/
│   │   └── resources/
│   │       └── ResourcesWebviewProvider.ts # NEW (Prompt 06)
│   ├── commands/
│   │   ├── index.ts                    # MODIFIED (Prompt 05)
│   │   └── dataCommands.ts             # NEW (Prompt 05)
│   ├── stats/
│   │   ├── StatsCatalog.ts             # NEW (Prompt 08)
│   │   └── StatsEngine.ts              # NEW (Prompt 11)
│   ├── utils/
│   │   └── webview.ts                  # NEW (Prompt 06)
│   └── core/
│       └── engine/
│           └── DataService.ts          # MODIFIED (Prompt 13)
├── webview/
│   ├── resources/
│   │   ├── index.ts                    # NEW (Prompt 07)
│   │   ├── resources.css               # NEW (Prompt 07)
│   │   └── statsCatalog.ts             # NEW (Prompt 07)
│   ├── stats/
│   │   ├── index.ts                    # NEW (Prompt 10)
│   │   └── stats.css                   # NEW (Prompt 10)
│   └── visualise/
│       ├── index.ts                    # NEW (Prompt 15)
│       └── visualise.css               # NEW (Prompt 15)
├── python/
│   ├── data/
│   │   └── inspect_data.py             # NEW (Prompt 13)
│   └── stats/
│       ├── runner.py                   # NEW (Prompt 12)
│       ├── requirements.txt            # NEW (Prompt 12)
│       └── tests/
│           ├── __init__.py             # NEW (Prompt 12)
│           ├── stationarity.py         # NEW (Prompt 12)
│           ├── descriptive.py          # NEW (Prompt 12)
│           └── ...                     # Additional test files
├── package.json                        # MODIFIED (Prompt 16)
└── esbuild-webview.mjs                 # MODIFIED (Prompts 07, 10, 15)
```

## Test

1. Compile TypeScript:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Build extension:
   ```bash
   npm run build
   ```

3. Build webviews:
   ```bash
   npm run build:webview
   ```

4. Launch extension host and test:
   - Open a .csv file
   - [Visualise] and [Action] buttons should appear
   - Click Visualise → Data visualization view opens
   - Click Action → Resources panel opens with Pure Stats section

## Dependencies
- All previous prompts (01-16) must be complete

## Next
Proceed to `18_Final_Testing.md`
