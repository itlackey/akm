---
description: Cause of the June edge proxy outage.
updated: 2026-06-19
---

The 2026-06-18 outage came from an expired TLS certificate on `edge-proxy-2`. Renewal is manual and the reminder lives in section 4 of the ops runbook. After renewal, restart the `edge-proxy` service so it reloads the certificate.
