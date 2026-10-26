---
name: azure
description: Work with Microsoft Azure and Entra ID through the bundled Azure MCP server. Use when asked about Azure subscriptions, resource groups, VMs, App Service, AKS, storage, networking, Key Vault, costs, Advisor, Defender, Entra users and groups, or any az CLI command.
---

# Azure

The `azure` MCP server runs as the signed-in Azure CLI identity (`az login`), or a service principal when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are set.

## Choosing a tool

1. A dedicated tool when one fits: `List_*`, `Get_*`, `Query_Costs`, `Resource_Graph_Query`, `Query_Log_Analytics`, `List_Entra_*`.
2. `Az_CLI` for any other read: pass the words after `az` as an array, for example `["network", "vnet", "peering", "list", "-g", "rg", "--vnet-name", "hub"]`. Use `Az_CLI_Help` first when unsure of arguments.
3. `Az_CLI_Run` for creates, updates and deletes the dedicated tools do not cover. Pass `--yes` where the CLI would prompt and `--no-wait` for long operations.
4. `View_*` tools for an overview the user will look at: estate, VMs, web apps, costs, resources, security.

## Gates

- The server starts read-only. Writes refuse until `AZURE_MODE=write`; deletes, stops, deallocations, restarts and key regeneration also need `AZURE_ALLOW_DESTRUCTIVE=true`. Every write takes `confirm: true`.
- When a write is refused, report the setting the refusal names. Do not retry through another tool: the CLI tools apply the same gates per command.
- Reads that return credentials (storage keys, connection strings, kubeconfig, secret values) count as writes. Fetch them only when the user needs the value itself.
- `Status_Server` explains the configuration, `Status_Gate` explains a refusal, `Test_Connection` proves the identity works.

## Scope

Pass `subscription_id` when the user names a subscription; otherwise the default subscription applies. `List_Subscriptions` shows what the identity can reach.
