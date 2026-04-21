# Quantlab Cloud Setup Guide

## Quick Setup (3 steps)

### Step 1: Enable Quantlab Cloud
1. Open Quantlab
2. Press `Ctrl+Shift+P` to open Command Palette
3. Type: `Preferences: Open User Settings (JSON)`
4. Add this line to your settings.json:
   ```json
   "qic.cloud.enabled": true
   ```
5. Save the file

### Step 2: Sign In
1. Press `Ctrl+Shift+P`
2. Type: `QIC: Sign In to Quantlab Cloud`
3. Your browser will open for authentication
4. Complete the OAuth flow
5. Return to Quantlab

### Step 3: Reload Window
1. Press `Ctrl+Shift+P`
2. Type: `Reload Window`
3. Done!

---

## Verification

After setup, you should see:
- No more "Quantlab Cloud not configured" notification
- QIC ready to use
- Model selector shows "Auto (Cloud)" option

## If Sign-In Fails

The cloud service may not be running. Check:
1. Cloud base URL: `https://api.quantlab.dev`
2. Or switch to dev mode for localhost testing

### Enable Dev Mode (for local development):
```json
{
  "qic.cloud.enabled": true,
  "qic.cloud.devMode": true,
  "qic.cloud.baseUrl": "http://localhost:8080"
}
```

---

## Alternative: Use BYOK Instead

If cloud doesn't work, use your own API keys:

1. Get API key from https://console.anthropic.com/
2. Run: `QIC: Set API Key`
3. Choose "Anthropic" and paste your key
4. Reload window
