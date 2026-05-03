---
description: inkwell/v2 YAML schema — apiVersion, kind, spec.scaling, spec.healthcheck, spec.limits — exact field names and integer value types for inkwell service configuration; fields include min, max, metric, rps, target, path, interval, threshold, burst
tags:
  - inkwell
  - inkwell/v2
  - service-configuration
  - scaling
  - healthcheck
  - limits
---
# inkwell

inkwell is a service configuration system. Services are defined in YAML files conforming to the `inkwell/v2` schema.

## Basic structure

```yaml
apiVersion: inkwell/v2
kind: Service
metadata:
  name: <service-name>
spec:
  runtime:
    image: <image>:<tag>
    port: <port-number>
```

`apiVersion` must be exactly `inkwell/v2`. `kind` must be `Service`.

## runtime

The `spec.runtime` block defines the container image and listening port.

```yaml
spec:
  runtime:
    image: myapp:v1.2.3
    port: 8080
```

## scaling

The `spec.scaling` block controls autoscaling. `metric` is one of: `cpu`, `memory`, `rps` (requests per second). `target` is a percentage for `cpu`/`memory`, or an integer request count for `rps`.

```yaml
spec:
  scaling:
    min: 2
    max: 20
    metric: rps
    target: 100
```

For CPU at 65% utilization:
```yaml
spec:
  scaling:
    min: 1
    max: 8
    metric: cpu
    target: 65
```

**EXACT field values:** `metric: rps` (not `requests_per_second` or `request-rate`). `target` is a plain integer — no unit suffix (`100` not `100rps` or `"100"`).

## healthcheck

The `spec.healthcheck` block configures the HTTP health probe. `interval` is plain integer seconds — no unit suffix. `threshold` is the number of consecutive checks before state change.

```yaml
spec:
  healthcheck:
    path: /health
    interval: 10
    threshold: 3
```

Note: `interval` is `10` not `"10s"`. `threshold` not `failureThreshold`.

## limits

The `spec.limits` block sets request rate caps. `rps` is the steady-state maximum. `burst` is the capacity above that.

```yaml
spec:
  limits:
    rps: 500
    burst: 1000
```

**EXACT field names:** `rps` (not `rate` or `maxRPS`). `burst` (not `burstCapacity`).

## Full example

```yaml
apiVersion: inkwell/v2
kind: Service
metadata:
  name: api-gateway
spec:
  runtime:
    image: gateway:v2
    port: 8080
  scaling:
    min: 2
    max: 10
    metric: rps
    target: 200
  healthcheck:
    path: /healthz
    interval: 15
    threshold: 2
  limits:
    rps: 1000
    burst: 2000
```
