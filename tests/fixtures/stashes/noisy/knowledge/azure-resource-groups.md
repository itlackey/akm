---
description: Working with Azure resource groups via az CLI
---
# Azure Resource Groups

Create with `az group create -n <name> -l <region>`. Tag at creation for cost reporting. Delete with `az group delete -n <name> --yes --no-wait`; deletion is the unit of cleanup for everything inside.
