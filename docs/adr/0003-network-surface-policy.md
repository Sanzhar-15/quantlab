# ADR-0003: Network Surface and Telemetry Policy

## Status

Accepted

## Context

The base Quantlab distribution should minimize external network dependencies and respect user privacy. VS Code OSS includes several network-related features that may connect to Microsoft services:

- Automatic update checking
- Telemetry collection
- Extension marketplace (addressed in ADR-0002)
- Product links (homepage, issues, license, etc.)
- Webview content delivery

For a base open-source distribution, we need a clear policy on:
- What network endpoints are allowed
- Whether telemetry is enabled by default
- Where product links point
- How updates are handled

## Decision

Implement a strict network surface policy for the base Quantlab distribution:

1. **No Microsoft Update Endpoints**: Remove or disable automatic update checking
2. **No Telemetry by Default**: Disable telemetry collection
3. **Product Links**: All product links (homepage, issues, license, etc.) point to GitHub repository, not microsoft.com
4. **Allowed Endpoints**: Only Open VSX marketplace endpoints are allowed
5. **Webview Content**: Acknowledge that webview CDN may point to Microsoft CDN (required for functionality, but no user data sent)

### Configuration

- `ALLOW_MICROSOFT_UPDATE_ENDPOINTS=0` in `config/quantlab.identity.env`
- `ALLOW_TELEMETRY_DEFAULT=0` in `config/quantlab.identity.env`
- Product links configured via `scripts/apply-network-surface.sh`:
  - `reportIssueUrl`: GitHub issues
  - `licenseUrl`: GitHub LICENSE file
  - `serverLicenseUrl`: GitHub LICENSE file
  - No `updateUrl` field (updates disabled)
  - No `telemetry` field (telemetry disabled)

## Rationale

1. **Privacy-First**: Users should not have data collected or sent to Microsoft by default
2. **Independence**: Base distribution should not depend on Microsoft services
3. **Transparency**: Clear network boundaries make it obvious what the software connects to
4. **User Control**: Users can enable telemetry/updates if desired, but default is privacy-focused
5. **Open Source Principles**: Aligns with open-source values of user control and transparency

## Consequences

### Positive

- No automatic data collection or telemetry
- No dependency on Microsoft update services
- Clear network boundaries
- Privacy-focused by default
- Transparent about what endpoints are used

### Negative

- No automatic updates (users must manually update)
- No telemetry data for improving the software (though users can opt-in)
- Some webview content may still load from Microsoft CDN (required for functionality)

### Risks

- **Risk**: Users expect automatic updates
  - **Mitigation**: Document that updates are manual, provide clear upgrade instructions

- **Risk**: Webview content from Microsoft CDN may raise privacy concerns
  - **Mitigation**: Document that this is required for functionality, no user data is sent to Microsoft

- **Risk**: Missing telemetry makes it harder to identify issues
  - **Mitigation**: Users can opt-in to telemetry if desired, GitHub issues provide feedback mechanism

## Alternatives Considered

### Opt-In Telemetry

- **Description**: Enable telemetry by default, allow users to opt-out
- **Rejected because**: Violates privacy-first principle, requires Microsoft endpoints

### Self-Hosted Update Service

- **Description**: Host our own update service
- **Rejected because**: Significant maintenance overhead, unnecessary for base distribution

### Hybrid Approach (Open VSX + Optional Microsoft)

- **Description**: Support both Open VSX and Microsoft services with user choice
- **Rejected because**: Adds complexity, Microsoft services violate base distribution independence

### No Network Restrictions

- **Description**: Allow all network endpoints, let users configure
- **Rejected because**: Violates privacy-first and independence principles

## Specific Decisions

### Default Chat Agent Removal

**Decision**: Remove `defaultChatAgent` section from `product.json`.

**Rationale**:
- Contains 10 Microsoft/aka.ms endpoints for GitHub Copilot
- Violates "no Microsoft endpoints" principle
- Users can install Copilot extension if needed
- Cleanest solution for base distribution

**Removed Endpoints**:
- `https://aka.ms/github-copilot-overview`
- `https://aka.ms/github-copilot-terms-statement`
- `https://aka.ms/github-copilot-privacy-statement`
- And 7 other aka.ms URLs

### Telemetry Code Presence

**Decision**: Telemetry code remains in source but is disabled by configuration.

**Rationale**:
- Removing telemetry code from upstream source would require extensive code changes
- High risk of breaking functionality
- Disabled telemetry in `product.json` is sufficient for base distribution
- Code is inactive when `enableTelemetry` is false

**Consequences**:
- Telemetry infrastructure code exists in `out-vscode/`
- Microsoft telemetry endpoints present in compiled code
- No telemetry data sent (verified by configuration)
- When building features, do not re-enable telemetry

**Verification**: `enableTelemetry` is false or not present in `product.json`

### Webview Content Delivery

**Decision**: `webviewContentExternalBaseUrlTemplate` points to Microsoft CDN (acceptable).

**Rationale**:
- Required for webview functionality
- No user data sent to Microsoft
- Content delivery only
- Alternative CDN would require significant infrastructure

**Consequence**: Webviews load content from `vscode-cdn.net` (read-only, no data sent)

## Implementation

- **Configuration Script**: [`scripts/apply-network-surface.sh`](../../scripts/apply-network-surface.sh)
- **Verification Script**: [`scripts/verify-network-surface.sh`](../../scripts/verify-network-surface.sh)
- **Configuration**: [`config/quantlab.identity.env`](../../config/quantlab.identity.env)
- **Product JSON**: `product.json` network-related fields

## References

- [ADR-0002: Open VSX Marketplace](./0002-open-vsx-marketplace.md)
- [VS Code Telemetry](https://code.visualstudio.com/docs/getstarted/telemetry)
- [Open VSX Registry](https://open-vsx.org/)

