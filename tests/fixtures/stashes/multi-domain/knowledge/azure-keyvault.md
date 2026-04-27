---
description: Read and write secrets in Azure Key Vault from az CLI
---
# Azure Key Vault

Set a secret with `az keyvault secret set --vault-name <vault> -n <name> --value <value>` and read with `--query value -o tsv` to avoid quoting noise. Grant access via RBAC role `Key Vault Secrets User` on the vault scope.
