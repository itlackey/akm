---
description: Parent memory describing the deploy retry behaviour
tags: [deploy, retry]
createdAt: "2026-05-10T09:00:00.000Z"
---

Deploys must rotate the SOPS-managed staging secret each release. The
deploy pipeline uses a retry credential which is independent from the
human operator's GitHub token.
