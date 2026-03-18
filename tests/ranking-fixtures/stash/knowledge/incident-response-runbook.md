---
description: Operational incident response procedures including severity levels, escalation paths, and post-mortems
---
# Incident Response Runbook

## Severity Levels

| Level | Description | Response Time |
|-------|-------------|---------------|
| SEV1  | Complete outage | 15 minutes |
| SEV2  | Major degradation | 30 minutes |
| SEV3  | Minor issue | 4 hours |
| SEV4  | Cosmetic / low priority | Next business day |

## Escalation Path

1. On-call engineer triages
2. Escalate to team lead if SEV1/SEV2
3. Involve SRE for infrastructure issues
4. Page VP Engineering for extended SEV1

## Post-Mortem Template

After every SEV1/SEV2 incident, complete a blameless post-mortem within 48 hours.

### Required Sections

- Timeline of events
- Root cause analysis
- Impact assessment
- Action items with owners and deadlines
