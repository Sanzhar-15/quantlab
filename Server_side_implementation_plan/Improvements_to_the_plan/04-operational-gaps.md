# Operational Gaps

---

## MEDIUM-7: Feature Flag Design

### The Gap

The plan mentions "feature flag" for the cloud adapter rollout but doesn't design how flags work.

### Fix Required in Plan

Add to `06-implementation-phases.md`:

**Feature flag mechanism:**

Phase 1 (simple): VS Code settings.
```typescript
'qic.cloud.enabled': {
    type: 'boolean',
    default: false,  // Off during development, flipped to true at GA
    description: 'Enable Quantlab Cloud connection path.',
}
```

Phase 2+ (remote): Server-provided feature flags.
The `/v1/account/info` response includes:
```json
{
    "features": {
        "cloud_enabled": true,
        "reasoning_tier": true,
        "data_contribution": false,
        "websocket_streaming": false
    }
}
```

The extension caches these flags locally (for offline use) and refreshes them on each token refresh (every 15 min). Features gated by server flags:
- Reasoning tier access (plan-dependent)
- WebSocket streaming (gradual rollout)
- Data contribution UI (Phase 5)

**Emergency kill switch:** The `/v1/health` endpoint includes a `maintenance` flag. When `true`, the extension shows "Quantlab Cloud is undergoing maintenance" and routes all traffic to BYOK/local. No code change required -- just a server flag flip.

---

## MEDIUM-8: Infrastructure-as-Code

### The Gap

The plan describes the server architecture but has no infrastructure specification. Without IaC, deployments are manual and unreproducible.

### Fix Required in Plan

Add a new section to `03-server-architecture.md`:

**Repository structure:**
```
quantlab-server/
  infra/
    terraform/
      modules/
        networking/     # VPC, subnets, security groups
        compute/        # EKS cluster, node groups
        database/       # RDS, ElastiCache
        storage/        # S3 buckets
        monitoring/     # CloudWatch, Grafana
      environments/
        staging/
        production/
    k8s/
      base/             # Kustomize base manifests
        api-gateway/
        provider-proxy/
        auth-service/
      overlays/
        staging/
        production/
  services/
    api-gateway/        # Go service
    provider-proxy/     # Go service
    billing-worker/     # Background job processor
  .github/
    workflows/
      ci.yml            # Lint, test, build
      deploy-staging.yml
      deploy-production.yml
```

**CI/CD pipeline:**
1. PR -> lint + unit tests + integration tests (GitHub Actions)
2. Merge to `main` -> build container images, push to ECR, deploy to staging
3. Manual approval -> deploy to production (canary: 10% traffic for 30 min, then full)
4. Rollback: `kubectl rollout undo` or Terraform state revert

---

## MEDIUM-9: Disaster Recovery

### The Gap

No disaster recovery plan exists.

### Fix Required in Plan

Add a **"Disaster Recovery"** section to `03-server-architecture.md`:

| Scenario | Recovery Procedure | RTO | RPO |
|----------|-------------------|-----|-----|
| Single pod crash | Kubernetes auto-restart | <30s | 0 (stateless) |
| Single region outage | DNS failover to secondary region | <5min | 0 |
| Database corruption | Restore from automated daily RDS snapshots | <1hr | <24hr |
| Redis failure | ElastiCache auto-failover to replica | <30s | <1s |
| Provider API key revoked | Rotate key in secrets manager, restart pods | <15min | 0 |
| Data breach | Incident response plan activation (see below) | - | - |
| Full infrastructure compromise | Terraform destroy + recreate from code | <4hr | <24hr |

**Incident response plan (outline):**
1. Detection (monitoring alerts)
2. Containment (revoke compromised credentials, isolate affected services)
3. Assessment (scope of impact, data affected)
4. Notification (users, regulators if applicable)
5. Recovery (restore from clean state)
6. Post-mortem (root cause, preventive measures)

---

## MEDIUM-10: Load Testing Plan

### The Gap

No load testing strategy exists. Each phase should have defined load tests before production deployment.

### Fix Required in Plan

Add to `06-implementation-phases.md`:

**Load test scenarios per phase:**

| Phase | Tool | Scenario | Target |
|-------|------|----------|--------|
| 2 | k6 or Grafana k6 | 100 concurrent streaming requests, 60s duration | p99 TTFT <2s, 0% error rate |
| 2 | k6 | Authentication flow: 50 sign-ins/sec | p99 <500ms |
| 3 | k6 | Mixed-lane traffic: 30% completion, 50% chat, 20% act | p99 TTFT <1s (chat), <300ms (completion) |
| 4 | k6 | Free-tier rate limit enforcement: 1000 users at limit | 100% of over-limit requests rejected with 429 |
| 4 | k6 | Billing accuracy: 10K metered requests | Token count variance <1% vs. actual provider usage |

**Load test infrastructure:**
- Dedicated load test environment (separate from staging)
- Provider mock server (to avoid incurring real API costs during load tests)
- Automated load test suite in CI (runs nightly against staging)

---

## LOW-1: Documentation Plan

### The Gap

No documentation strategy exists.

### Fix Required in Plan

Add a brief section to `06-implementation-phases.md`:

**Documentation deliverables per phase:**

| Phase | Documentation |
|-------|--------------|
| 1 | Extension settings reference, cloud vs BYOK comparison page |
| 2 | API reference (auto-generated from OpenAPI spec), getting started guide |
| 3 | Architecture overview for contributors |
| 4 | Pricing page, billing FAQ, enterprise sales sheet |
| 5 | Data contribution program terms, privacy policy update |
| 6 | Quant-specific model capabilities documentation |

**Internal documentation:**
- Runbook for each service (deploy, restart, debug, rollback)
- On-call playbook with alert-to-action mapping
- Architecture decision records (ADRs) for major design choices
