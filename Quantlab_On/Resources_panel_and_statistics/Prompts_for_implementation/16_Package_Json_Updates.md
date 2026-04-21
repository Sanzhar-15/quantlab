# Prompt 16: Package.json Updates

## Objective
Update `extensions/quantlab/package.json` with all necessary configurations for the new features.

## Context
Custom editors, views, and commands must be declared in package.json for VS Code to recognize them.

## File to Modify

### `extensions/quantlab/package.json`

#### 1. Add new dependencies

In `devDependencies`:

```json
{
    "devDependencies": {
        "plotly.js-dist-min": "^2.27.0"
    }
}
```

#### 2. Add custom editor contributions

In `contributes.customEditors`:

```json
{
    "contributes": {
        "customEditors": [
            {
                "viewType": "quantlab.chartView",
                "displayName": "QuantLab Chart",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.actionView",
                "displayName": "QuantLab Action",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.tradeView",
                "displayName": "QuantLab Trade",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.visualiseView",
                "displayName": "QuantLab Visualise",
                "selector": [
                    { "filenamePattern": "*.csv" },
                    { "filenamePattern": "*.parquet" },
                    { "filenamePattern": "*.xlsx" }
                ],
                "priority": "option"
            },
            {
                "viewType": "quantlab.statsView",
                "displayName": "QuantLab Stats",
                "selector": [
                    { "filenamePattern": "*.csv" },
                    { "filenamePattern": "*.parquet" },
                    { "filenamePattern": "*.xlsx" }
                ],
                "priority": "option"
            }
        ]
    }
}
```

#### 3. Update views contribution

In `contributes.views`:

```json
{
    "contributes": {
        "views": {
            "quantlab-resources": [
                {
                    "type": "webview",
                    "id": "quantlab.resourcesPanel",
                    "name": "Resources"
                }
            ]
        }
    }
}
```

Note: Changed from `tree` type to `webview` type for the Resources panel.

#### 4. Add new commands

In `contributes.commands`:

```json
{
    "contributes": {
        "commands": [
            {
                "command": "quantlab.switchToVisualise",
                "title": "Switch to Visualise View",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.openDataAction",
                "title": "Open Data Action",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.switchToDataEditor",
                "title": "Switch to Editor View",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.openStatsTest",
                "title": "Open Stats Test",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.executeStatsTest",
                "title": "Execute Stats Test",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.getDataFileColumns",
                "title": "Get Data File Columns",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.getDataPreview",
                "title": "Get Data Preview",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.setResourcesSection",
                "title": "Set Resources Section",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.resources.setSection",
                "title": "Internal: Set Resources Section",
                "category": "QuantLab"
            }
        ]
    }
}
```

#### 5. Add activation events

In `activationEvents`:

```json
{
    "activationEvents": [
        "onCustomEditor:quantlab.visualiseView",
        "onCustomEditor:quantlab.statsView",
        "onView:quantlab.resourcesPanel",
        "onLanguage:python",
        "workspaceContains:**/*.csv",
        "workspaceContains:**/*.parquet",
        "workspaceContains:**/*.xlsx"
    ]
}
```

#### 6. Complete package.json snippet (new sections only)

```json
{
    "name": "quantlab",
    "displayName": "QuantLab",
    "version": "1.0.0",
    "devDependencies": {
        "plotly.js-dist-min": "^2.27.0"
    },
    "contributes": {
        "customEditors": [
            {
                "viewType": "quantlab.chartView",
                "displayName": "QuantLab Chart",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.actionView",
                "displayName": "QuantLab Action",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.tradeView",
                "displayName": "QuantLab Trade",
                "selector": [{ "filenamePattern": "*.py" }],
                "priority": "option"
            },
            {
                "viewType": "quantlab.visualiseView",
                "displayName": "QuantLab Visualise",
                "selector": [
                    { "filenamePattern": "*.csv" },
                    { "filenamePattern": "*.parquet" },
                    { "filenamePattern": "*.xlsx" }
                ],
                "priority": "option"
            },
            {
                "viewType": "quantlab.statsView",
                "displayName": "QuantLab Stats",
                "selector": [
                    { "filenamePattern": "*.csv" },
                    { "filenamePattern": "*.parquet" },
                    { "filenamePattern": "*.xlsx" }
                ],
                "priority": "option"
            }
        ],
        "views": {
            "quantlab-resources": [
                {
                    "type": "webview",
                    "id": "quantlab.resourcesPanel",
                    "name": "Resources"
                }
            ]
        },
        "commands": [
            {
                "command": "quantlab.switchToVisualise",
                "title": "Switch to Visualise View",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.openDataAction",
                "title": "Open Data Action",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.switchToDataEditor",
                "title": "Switch to Editor View",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.openStatsTest",
                "title": "Open Stats Test",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.executeStatsTest",
                "title": "Execute Stats Test",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.getDataFileColumns",
                "title": "Get Data File Columns",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.getDataPreview",
                "title": "Get Data Preview",
                "category": "QuantLab"
            },
            {
                "command": "quantlab.setResourcesSection",
                "title": "Set Resources Section",
                "category": "QuantLab"
            }
        ],
        "activationEvents": [
            "onCustomEditor:quantlab.visualiseView",
            "onCustomEditor:quantlab.statsView",
            "onView:quantlab.resourcesPanel"
        ]
    }
}
```

## Test

1. Run `npm install` to install new dependencies:
   ```bash
   cd extensions/quantlab && npm install
   ```

2. Verify package.json is valid JSON:
   ```bash
   node -e "require('./package.json')"
   ```

3. Check VS Code recognizes custom editors:
   - Open QuantLab
   - Right-click on a .csv file
   - "Open With..." should show "QuantLab Visualise" and "QuantLab Stats"

## Dependencies
- All previous prompts should be complete before this

## Next
Proceed to `17_Extension_Registration.md`
