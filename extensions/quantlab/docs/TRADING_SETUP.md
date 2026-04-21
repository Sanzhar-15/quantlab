# Quantlab Trading Setup (MVP)

This document covers basic broker configuration for the Trade view MVP.

## Configure broker accounts

Add broker accounts in settings under `quantlab.trading.accounts`:

```json
{
  "quantlab.trading.accounts": [
    {
      "id": "alpaca-paper",
      "name": "Alpaca Paper",
      "broker": "alpaca",
      "type": "paper"
    },
    {
      "id": "mock-sim",
      "name": "Mock Simulation",
      "broker": "mock",
      "type": "paper"
    }
  ]
}
```

## Store Alpaca credentials

Alpaca credentials are stored in VS Code secrets storage. Use the VS Code
Extension Host console or a helper script to set a secret with this shape:

```
Key: alpaca.<account-id>
Value: {"apiKey":"YOUR_KEY","apiSecret":"YOUR_SECRET"}
```

Example:

```ts
await vscode.env.openExternal(vscode.Uri.parse('command:workbench.action.openSettings?%22quantlab.trading%22'));
```

## Kill Switch policy

Set `quantlab.trading.killSwitchPolicy` to `flatten`, `cancelOnly`, or `custom`.
When `custom`, supply actions in `quantlab.trading.killSwitchCustomActions`.
