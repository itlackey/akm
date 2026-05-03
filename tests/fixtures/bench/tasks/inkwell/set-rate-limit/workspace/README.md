# Task: configure rate limiting

Edit `service.yaml` to add a `limits` block to the inkwell service.

Requirements:
- `rps: 500`
- `burst: 1000`

Use `akm show skill:inkwell` for the exact field names and value format.
