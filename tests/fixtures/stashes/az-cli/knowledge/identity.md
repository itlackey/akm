---
description: Service principals, managed identities, and RBAC role assignment via az CLI
---
# Identity

## Service principals

```sh
az ad sp create-for-rbac --name sp-app-deploy \
  --role contributor \
  --scopes /subscriptions/<sub>/resourceGroups/rg-app-prod
```

The output includes a one-time secret. Capture it; it cannot be retrieved later.

## Managed identities

Prefer system-assigned managed identities for VMs, App Service, and Functions. Enable with `--assign-identity` on the resource's create or update command. The identity exists for as long as the resource does and is cleaned up automatically.

## Role assignment

```sh
az role assignment create \
  --assignee <objectId-or-appId> \
  --role "Storage Blob Data Reader" \
  --scope /subscriptions/<sub>/resourceGroups/rg-app-prod/providers/Microsoft.Storage/storageAccounts/stappprod
```

Scope as narrowly as the workload allows. Subscription-scoped Contributor is almost always too broad.

## Federated credentials

For GitHub Actions / GitLab CI, use federated credentials instead of long-lived secrets:

```sh
az ad app federated-credential create --id <appId> --parameters @cred.json
```
