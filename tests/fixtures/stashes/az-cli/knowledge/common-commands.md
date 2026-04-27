---
description: Quick reference of high-frequency az CLI commands
---
# Common az Commands

## Account

```sh
az login
az account show
az account list -o table
az account set --subscription <name-or-id>
```

## Storage

```sh
az storage account list -g <rg> -o table
az storage blob list --account-name <acct> -c <container> --auth-mode login -o table
az storage blob upload --account-name <acct> -c <container> -f ./local.txt -n remote.txt --auth-mode login
```

`--auth-mode login` uses your AAD identity and avoids passing account keys around.

## Key Vault

```sh
az keyvault secret set --vault-name <vault> -n my-secret --value "$(cat secret.txt)"
az keyvault secret show --vault-name <vault> -n my-secret --query value -o tsv
```

## VM

```sh
az vm list -g <rg> -o table
az vm start -g <rg> -n <vm>
az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts "uptime"
```

## App Service

```sh
az webapp list -g <rg> -o table
az webapp log tail -g <rg> -n <app>
az webapp deploy -g <rg> -n <app> --src-path ./app.zip --type zip
```
