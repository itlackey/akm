---
description: Lifecycle and conventions for Azure resource groups via az CLI
---
# Resource Groups

A resource group is a logical container for Azure resources that share a lifecycle. Pick one location per group — the group's location is metadata only, but the resources inside default to it.

## Create

```sh
az group create --name rg-app-prod --location eastus2 \
  --tags env=prod owner=platform cost-center=eng
```

Always tag at creation. Tag-based cost reports and cleanup automation depend on it.

## Inspect

```sh
az group show -n rg-app-prod -o table
az resource list -g rg-app-prod -o table
```

## Delete

```sh
az group delete -n rg-app-prod --yes --no-wait
```

`--no-wait` returns immediately; the deletion runs server-side. Track it with `az group exists -n rg-app-prod` (returns `false` once gone).

## Naming

`rg-<workload>-<env>[-region]` is the common convention. Stick to one — Azure has no concept of nesting, so the name is the only structural signal.
