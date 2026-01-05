# ADR-0002: Open VSX Marketplace

## Status

Accepted

## Context

VS Code OSS (microsoft/vscode) does not include a default extensions marketplace configuration. The base Quantlab distribution needs an extensions marketplace that:

- Is open source and community-driven
- Does not depend on Microsoft services
- Provides access to VS Code extensions
- Maintains user privacy
- Works without authentication

The Microsoft Visual Studio Marketplace is proprietary and requires Microsoft accounts, making it unsuitable for a base open-source distribution.

## Decision

Use Open VSX (`https://open-vsx.org`) as the default extensions marketplace for Quantlab. Configure `product.json` with:

- `extensionsGallery.serviceUrl`: `https://open-vsx.org/vscode/gallery`
- `extensionsGallery.itemUrl`: `https://open-vsx.org/vscode/item`
- `extensionsGallery.resourceUrlTemplate`: `https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/{path}`
- `linkProtectionTrustedDomains`: Include `https://open-vsx.org`

## Rationale

1. **Open Source**: Open VSX is an open-source alternative to the Microsoft marketplace
2. **Community-Driven**: Maintained by the Eclipse Foundation, independent of Microsoft
3. **Compatible**: Uses the same API format as VS Code, so extensions work without modification
4. **Privacy-Focused**: No Microsoft tracking, no required authentication
5. **Well-Maintained**: Active project with good extension coverage
6. **No Dependencies**: Does not require Microsoft services or accounts

## Consequences

### Positive

- Users can install extensions without Microsoft accounts
- No Microsoft telemetry or tracking from marketplace
- Open source and community-controlled
- Compatible with VS Code extension format
- No vendor lock-in

### Negative

- Some extensions may not be available on Open VSX (though coverage is good)
- Requires users to be aware of Open VSX if they're used to Microsoft marketplace
- Marketplace availability depends on Open VSX service uptime

### Risks

- **Risk**: Open VSX service downtime affects extension installation
  - **Mitigation**: Extensions can be installed manually from `.vsix` files

- **Risk**: Some extensions only available on Microsoft marketplace
  - **Mitigation**: Users can manually install `.vsix` files, or configure alternative marketplace URLs

- **Risk**: Open VSX API changes break compatibility
  - **Mitigation**: Open VSX maintains VS Code API compatibility, and we can update URLs if needed

## Alternatives Considered

### No Default Marketplace

- **Description**: Leave `extensionsGallery` unconfigured, require manual extension installation
- **Rejected because**: Poor user experience, makes Quantlab less usable out-of-the-box

### Microsoft Visual Studio Marketplace

- **Description**: Use Microsoft's marketplace (requires configuration changes)
- **Rejected because**: Proprietary, requires Microsoft accounts, violates base distribution principles of independence

### Self-Hosted Marketplace

- **Description**: Host our own marketplace instance
- **Rejected because**: Significant maintenance overhead, unnecessary for base distribution

### Multiple Marketplace Support

- **Description**: Support both Open VSX and Microsoft marketplace
- **Rejected because**: Adds complexity, Microsoft marketplace requires authentication and violates base principles

## Implementation

- **Configuration Script**: [`scripts/apply-marketplace.sh`](../../scripts/apply-marketplace.sh)
- **Verification Script**: [`scripts/verify-marketplace.sh`](../../scripts/verify-marketplace.sh)
- **Configuration**: [`config/quantlab.identity.env`](../../config/quantlab.identity.env) (MARKETPLACE_PROVIDER=open-vsx)
- **Product JSON**: `product.json` extensionsGallery configuration

## References

- [Open VSX Registry](https://open-vsx.org/)
- [Eclipse Open VSX](https://www.eclipse.org/community/eclipse_newsletter/2020/march/1.php)
- [VS Code Extensions API](https://code.visualstudio.com/api/references/extension-manifest)

