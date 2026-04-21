# QIC Hybrid Architecture: Executive Summary

## Current State

QIC is a pure BYOK (Bring Your Own Key) system. The VS Code extension connects directly to LLM providers via three adapter classes:

- `AnthropicAdapter` -> `https://api.anthropic.com/v1/messages`
- `OpenAIAdapter` -> `https://api.openai.com/v1/chat/completions`
- `OllamaAdapter` -> `http://localhost:11434`

All inference, routing, rate limiting, and security enforcement runs client-side inside the extension process. There is no server component. Users must obtain and configure API keys manually before QIC functions.

## Target State

QIC becomes a hybrid system with three connection paths:

```
                    +--------------------+
                    |   QIC Extension    |
                    |  (Gateway Layer)   |
                    +--------+-----------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v-------+
     | Quantlab   |  | BYOK Direct |  | Local      |
     | Cloud      |  | (Anthropic, |  | (Ollama)   |
     | (default)  |  |  OpenAI)    |  |            |
     +--------+---+  +------+------+  +----+-------+
              |              |              |
     +--------v---+  +------v------+  +----v-------+
     | Quantlab   |  | Provider    |  | localhost  |
     | Backend    |  | APIs        |  | :11434     |
     +--------+---+  +-------------+  +------------+
              |
     +--------v---+--------+--------+
     | Anthropic  | OpenAI | Google |  (server-managed)
     +------------+--------+--------+
```

## What Changes

**Extension-side (small but non-trivial):**
- New `QuantlabCloudAdapter` implementing existing `ProviderAdapter` interface
- Widen `ProviderAdapter` with optional `GatewayMetadata` (lane, priority, sessionId) -- currently passed implicitly via JS structural typing, must be made explicit
- Restructure `ModelRegistry.LANE_MODEL_RECOMMENDATIONS` from `Record<string, string>` to `Record<LaneName, string[]>` to support per-lane fallback chains
- Add `'quantlab-cloud'` to `EgressBoundary` type for separate consent tracking
- Extend `StreamChunk` `done` variant with optional `providerMeta` field
- OAuth2 authentication flow for Quantlab accounts
- New settings: connection mode, per-lane routing overrides
- Modified `qic.contribution.ts` activation to support connection mode selection
- DegradationManager integration for cloud-down scenarios
- Consent model bridge: new `DataTier` concept alongside existing consent scopes

**Server-side (new):**
- API gateway receiving QIC canonical request format
- Three-tier model routing (fast / coding / reasoning)
- Subscription management and usage metering
- Data collection pipeline for fine-tuning flywheel

## Key Design Principle

The extension's `Gateway` class and everything above it (orchestrator, lane router, tool router, context assembler) are completely adapter-agnostic. They work identically regardless of which provider adapter serves the request. The `QuantlabCloudAdapter` is just another adapter in the `providers` Map.

**Caveat:** The Gateway itself requires two targeted modifications:
1. Egress boundary selection must become provider-aware (currently hardcoded to `'llm'`) -- see `01-extension-integration.md` Section 6
2. `GatewayMetadata` passthrough to adapters must be made explicit in the `ProviderAdapter` interface -- see `01-extension-integration.md` Section 1

No upstream code changes are required above the Gateway (orchestrator, lanes, tools, context assembly).

## Competitive Landscape

| Feature | Quantlab Cloud | Cursor | GitHub Copilot | Continue |
|---------|---------------|--------|---------------|----------|
| Architecture | VSCodium fork + server | Custom Electron editor | VS Code extension | VS Code extension |
| Model access | Multi-provider (Anthropic, OpenAI, Google) | Multi-provider | OpenAI primarily | BYOK only |
| Pricing | Free + $20/mo Pro | Free + $20/mo Pro | $10/mo | Free (BYOK) |
| BYOK option | Yes (fallback) | Limited | No | Yes (only option) |
| Local/offline | Yes (Ollama) | Limited | No | Yes (Ollama) |
| Quant specialization | Yes (fine-tuned models Phase 6) | No | No | No |
| Open source | Yes (VSCodium-based) | No | No | Yes |
| Data privacy | Three-tier consent, optional data contribution | ToS consent, trains on data | ToS consent | No server |

**Quantlab's positioning:**
1. **For quant developers specifically** -- the only AI coding tool built for quantitative finance workflows
2. **Open-source foundation** -- VSCodium fork means users can audit the code (important for security-conscious funds)
3. **Privacy-first** -- BYOK always available, three-tier consent, no code stored without explicit opt-in
4. **Best of all worlds** -- cloud convenience when you want it, BYOK control when you need it, local offline when you must have it

**Competitive risks:**
- Cursor has significant mindshare and venture funding
- GitHub Copilot has distribution advantage (bundled with GitHub)
- General-purpose tools may add finance features if market proves valuable
- Quant developers may not want a specialized tool (prefer best general tool)

**Mitigation:** The data flywheel is the moat. Once Quantlab has 12+ months of quant-specific interaction data and fine-tuned models that measurably outperform on quant tasks, the advantage is compounding and difficult to replicate.

## Open-Source Strategy

**Open-core model:**

| Component | License | Rationale |
|-----------|---------|-----------|
| Quantlab editor (VSCodium fork) | MIT | Trust, auditability, community contributions |
| QIC extension (all code) | MIT | Including `QuantlabCloudAdapter` -- users can see exactly what data is sent |
| QIC protocol specification (Doc 02) | Open (CC-BY-4.0) | Enables community backends, builds trust |
| Server code | Proprietary | Revenue protection. The server is the business. |
| Fine-tuned models | Proprietary | The data flywheel output. Core IP. |
| Training data pipeline | Proprietary | Competitive advantage |

**Why open-source the adapter and protocol:**
- Quant developers will want to audit what data leaves their machine
- Open protocol enables community-built backends (this grows the ecosystem)
- If someone runs their own backend, they still need data/models to compete (our moat)

**Community backend compatibility:**
The QIC protocol spec (Doc 02) should be published as a standalone document. Anyone can build a server that speaks this protocol. The extension connects to whatever `qic.cloud.baseUrl` points to. This is similar to how Ollama and LM Studio work -- open protocol, anyone can implement.

## Implementation Order

1. Extension: `QuantlabCloudAdapter` + auth flow + settings + ModelRegistry restructure
2. Server: MVP proxy (authenticate, forward to Anthropic, meter usage)
3. Server: Multi-provider routing with lane-aware model selection
4. Server: Subscription billing integration
5. Server: Data collection pipeline (split into phases -- metadata early, quality signals early, contributor program after billing)
6. Server: Fine-tuned quant models (long-term)
