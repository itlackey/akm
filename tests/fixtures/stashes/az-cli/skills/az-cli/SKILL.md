---
description: Operate Azure resources from the command line using the az CLI
---
# az CLI

Skill for everyday Azure operations from a shell. Covers login, subscription selection, resource group lifecycle, AKS, managed identity, storage, key vault, and resource querying.

## Login

`az login` opens a device-code or browser flow. In CI use `az login --service-principal -u <appId> -p <secret> --tenant <tenant>` or, preferably, federated workload-identity. Always run `az account show` afterwards to verify the active subscription.

## Subscription discipline

Most account incidents trace back to running a command against the wrong subscription. `az account set --subscription <name-or-id>` before any mutating command, and prefer `--subscription` on the command itself in scripts.

## Resource groups

A resource group is the unit of cleanup. Create one per environment (`rg-app-prod`, `rg-app-dev`); when the environment is gone, `az group delete -n <name>` reclaims everything inside it.

```sh
az group create -n <name> -l <location>
az group delete -n <name> --yes
```

## AKS — Kubernetes Service

Fetch kubeconfig credentials for an AKS cluster so `kubectl` can reach it:

```sh
az aks get-credentials -g <resource-group> -n <cluster-name>
# example:
az aks get-credentials -g myrg -n mycluster
```

## Managed identity

Assign a system-managed identity to a VM so it can authenticate to Azure services without a stored secret:

```sh
az vm identity assign -g <resource-group> -n <vm-name>
# example:
az vm identity assign -g myrg -n myvm
```

## Storage accounts

Create a storage account with a specific redundancy SKU:

```sh
az storage account create -n <name> -g <resource-group> --sku <sku>
# example (Standard_LRS):
az storage account create -n mystorageacct -g myrg --sku Standard_LRS
```

## Key Vault secrets

Set a secret value in a Key Vault:

```sh
az keyvault secret set --vault-name <vault> -n <name> --value <value>
# example:
az keyvault secret set --vault-name myvault -n dbpass --value "s3cr3t"
```

## Resource querying by tag

List resources filtered by a tag key=value pair:

```sh
az resource list --tag <key>=<value>
# example:
az resource list --tag env=prod
```

## Output

`-o table` for humans, `-o json` for scripts, `--query "..."` to project fields with JMESPath. `-o tsv` is the right choice when piping a single value into another command.
