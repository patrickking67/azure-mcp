# azure-mcp (server name: "Azure")

MCP server for **Microsoft Azure and Entra ID**: 102 tools, the Azure CLI one-to-one, and six interactive views. Runs locally over stdio (the `.mcpb` bundle, Claude Code, Codex) or remotely on Azure Container Apps behind Entra ID, where every call runs as the signed-in user.

## Tools (102)

Every dedicated tool carries its Azure CLI equivalent in its description and in the `azure://reference/api` resource.

| Kind | Tools |
| --- | --- |
| Read (85) | `List_*`, `Get_*`, `Query_*`, `Resource_Graph_Query`, `Resource_Health`, `ARM_GET`, `Graph_GET`, `Az_CLI`, `Az_CLI_Help`, `Status_Server`, `Status_Gate`, `Test_Connection` |
| Write (6) | `Start_VM`, `Start_Web_App`, `Start_AKS_Cluster`, `Tag_Resource`, `Create_Resource_Group`, `Set_Key_Vault_Secret` |
| Destructive (11) | `Stop_VM`, `Restart_VM`, `Resize_VM`, `Stop_Web_App`, `Restart_Web_App`, `Stop_AKS_Cluster`, `Delete_Resource_Group`, `Delete_Resource`, `ARM_Request`, `Graph_Request`, `Az_CLI_Run` |
| Interactive (6, read) | `View_Estate`, `View_Virtual_Machines`, `View_Web_Apps`, `View_Costs`, `View_Resources`, `View_Security` |

### The Azure CLI, one-to-one

- **`Az_CLI`** runs any read-only `az` command (`list`, `show`, `get-*`, `check-*`, `az rest --method get`). No gate.
- **`Az_CLI_Run`** runs anything else. Each command is classified before it runs ([src/cli-policy.ts](src/cli-policy.ts)): creates and updates need write mode; `delete`, `purge`, `stop`, `deallocate`, `restart`, `regenerate`, `revoke` and other disruptive verbs also need the destructive gate. Reads that return credentials (`keys list`, `show-connection-string`, `get-credentials`, `appsettings list`, `keyvault secret show`) count as writes.
- **`Az_CLI_Help`** returns `az <group> [<command>] --help` from the installed CLI.

Always refused: `login`, `account set`, `account get-access-token`, `config`, `extension add`, `upgrade`, interactive sessions (`ssh`, `exec`, `log tail`), `--debug`, any `@file` argument (the CLI would read a local file), and `az rest` to non-Azure hosts. Arguments are passed as an argv array; nothing goes through a shell.

### Interactive views (MCP Apps)

Rendered inline by hosts that support MCP Apps; other hosts get the same data as JSON.

- **Estate**: resources by type and region, resource groups, unhealthy resources, Advisor, secure score, month-to-date cost.
- **Virtual Machines** / **Web Apps**: live state with Start / Deallocate (Stop) / Restart buttons. A button arms on the first click and fires on the second, calling the same gated tool with `confirm: true`.
- **Costs**: total, daily trend, by service, by resource group, budgets.
- **Resource Explorer**: every resource, filterable, with the full ARM document on click.
- **Security**: secure score and weakest controls, active Defender alerts, Advisor security, Policy non-compliance.

## Write gate

The server starts **read-only**. Write tools stay listed and refuse with a message naming the setting.

| Setting | Effect |
| --- | --- |
| `AZURE_MODE=write` (Mode) | Enables the write tier. |
| `AZURE_ALLOW_DESTRUCTIVE=true` (Allow destructive operations) | Also enables the destructive tier. No effect without write mode. |
| `confirm: true` | Required on every write call. |

Remotely, callers also need the `Azure.Write` or `Azure.Destructive` Entra app role. Everything stays bounded by the identity's own RBAC and Graph permissions.

## Auth

`AZURE_AUTH` picks one explicitly (`azure_cli`, `service_principal`, `managed_identity`); `auto` (default) chooses:

1. **Service principal** when `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` are set.
2. **Managed identity** when the host advertises one (`IDENTITY_ENDPOINT`, or IMDS with `AZURE_AUTH=managed_identity`).
3. **Azure CLI** otherwise: `az account get-access-token` against your `az login`. If `az` is not on PATH under a desktop app, set `AZ_PATH`.

The CLI tools run as the same identity: your own `az login`, or an isolated CLI profile (`AZURE_CONFIG_DIR` in a temp dir) signed in as the service principal or managed identity, so your `~/.azure` is never touched. Subscription: `subscription_id` argument > `AZURE_SUBSCRIPTION_ID` > the az default (or the identity's only subscription).

## Install

### Claude Desktop (.mcpb)

```bash
npm ci
npm run mcpb:pack
```

Open `azure.mcpb` (Settings > Extensions > Install extension). All settings are optional; with none set it uses your `az login` in read mode.

### Claude Code

```bash
claude mcp add azure --scope user --env AZURE_MODE=read -- node /Users/patrickking/GitHub/azure-mcp/dist/index.js
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.azure]
command = "node"
args = ["/Users/patrickking/GitHub/azure-mcp/dist/index.js"]
env = { AZURE_MODE = "read" }
```

## Remote (Azure Container Apps + Entra ID)

See [docs/remote.md](docs/remote.md). Short version: `infra/main.bicep` + `scripts/deploy-azure.sh` (plan by default) deploy the image; `scripts/entra-setup.sh` creates the app registration with a federated credential, so the on-behalf-of exchange needs no client secret.

## Develop

```bash
npm ci
npm test               # build + unit + stdio smoke (fake az) + remote transport
npm run manifest       # rewrite manifest.json tools from the running server
npm run apps:runtime   # re-inline the ext-apps browser runtime after upgrading it
npx @modelcontextprotocol/inspector node dist/index.js
```

Layout: `src/server.ts` builds the server for both transports; `src/tools/*` hold the tools (registered through `defineTool`, which applies tier, gate, confirm and the CLI equivalent); `src/apps/*` the views; `src/auth.ts` token sources; `src/cli-policy.ts` the CLI classifier; `src/remote.ts` + `src/entra.ts` the remote lane.
