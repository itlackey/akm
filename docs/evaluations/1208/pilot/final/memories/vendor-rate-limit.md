---
description: Vendor API rate limit fix for the nightly import.
updated: 2026-04-12
---

On 2026-04-11 the nightly import job began failing with HTTP 429 from the vendor API. Setting `import.rate_limit` to 20 requests per second in `config/import.yaml` fixed it. Do not raise it above 30: the vendor blocks the account for an hour.
