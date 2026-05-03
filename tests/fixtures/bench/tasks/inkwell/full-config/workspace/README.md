# Task: configure complete service

Edit `service.yaml` to add scaling, healthcheck, and rate limits.

Requirements:
- `scaling.min: 2`
- `scaling.max: 10`
- `scaling.metric: rps`
- `scaling.target: 150`
- `healthcheck.path: /health`
- `healthcheck.interval: 15`
- `healthcheck.threshold: 3`
- `limits.rps: 200`
- `limits.burst: 400`

Use `akm show skill:inkwell` for exact field names and value types.
