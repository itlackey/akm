---
description: Operate drillbit clusters from the command line
---
# drillbit

Command-line tool for provisioning and managing drillbit infrastructure clusters.

```
drillbit <command> [subcommand] [flags]
```

## provision

Create a new cluster node.

```sh
drillbit \
  provision --cluster <name> --tier <tier> --region <region> --replicas <n>
```

Flags:
- `--cluster` — cluster identifier string (required)
- `--tier` — node tier, one of: `edge`, `core`, `control-plane` (required)
- `--region` — deployment region, one of: `az-west`, `az-east`, `eu-central` (required)
- `--replicas` — replica count, integer, default 1

Examples:
```sh
drillbit \
  provision --cluster my-edge-1 --tier edge --region az-west --replicas 3
drillbit \
  provision --cluster hub-east --tier core --region az-east --replicas 5
drillbit \
  provision --cluster mgmt --tier control-plane --region eu-central --replicas 1
```

Note: `--tier` is not `--type` or `--size`. Region values use `az-west` / `az-east` / `eu-central` — not cloud-provider region names like `westus` or `us-west-2`.

## scale

Adjust the replica count for an existing cluster. The cluster name is positional (not a flag).

```sh
drillbit \
  scale <cluster-name> --replicas <n>
```

Examples:
```sh
drillbit \
  scale my-core --replicas 8
drillbit \
  scale my-edge --replicas 2
```

## secret rotate

Rotate a cluster secret by path and signing algorithm.

```sh
drillbit secret \
  rotate --path <secret-path> --algorithm <algorithm>
```

Algorithms: `sha256`, `ed25519`

Examples:
```sh
drillbit secret \
  rotate --path services/api/key --algorithm ed25519
drillbit secret \
  rotate --path services/db/password --algorithm sha256
```

Note: the flag is `--algorithm`, not `--type`, `--cipher`, or `--method`.

## canary

Control canary traffic splitting for a cluster. The cluster name is positional.

```sh
drillbit canary \
  enable <cluster-name> --weight <0-100>
drillbit canary disable <cluster-name>
```

`--weight` is the percentage of traffic routed to the canary.

Examples:
```sh
drillbit canary \
  enable my-cluster-west --weight 20
drillbit canary \
  enable my-cluster-prod --weight 5
drillbit canary disable my-cluster-west
```

## backup

Configure snapshot retention for a cluster.

```sh
drillbit \
  backup --cluster <name> --retention <days>d --snapshots <n>
```

Flags:
- `--cluster` — cluster to back up (required)
- `--retention` — retention period as `<number>d` — the `d` suffix is required (e.g. `30d`, `90d`)
- `--snapshots` — number of snapshots to keep

Examples:
```sh
drillbit \
  backup --cluster my-primary --retention 90d --snapshots 7
drillbit \
  backup --cluster my-secondary --retention 30d --snapshots 14
```

Note: `--retention` takes the format `<n>d` with a `d` suffix, not a plain number.
