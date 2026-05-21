---
description: User-captured incident note that must never be auto-archived or merged
captureMode: hot
beliefState: asserted
tags: [incident, important, hot]
createdAt: "2026-05-10T10:00:00.000Z"
---

On 2026-05-10 the staging deploy pipeline silently dropped retry credentials.
The team manually re-applied the secret and added a regression test in
`tests/deploy-secret-rotation.test.ts`. Capturing this so it never recurs.
