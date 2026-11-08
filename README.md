# azure-mcp (server name: "Azure")

[![CI](https://github.com/patrickking67/azure-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/patrickking67/azure-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP server for **Microsoft Azure and Entra ID** that gives a model the whole Azure CLI, one command to one tool call, without giving it the keys to everything. Every `az` command is classified before it runs ([src/cli-policy.ts](src/cli-policy.ts)) into read, write or destructive, and each tier sits behind its own operator-controlled gate, so the server starts read-only and a delete needs two settings and an explicit `confirm`. On top of that come 102 tools in all, six MCP Apps views that render inside the chat (estate, VMs, web apps, costs, resources, security), and two ways to run it: local stdio, or remote on Azure Container Apps behind Entra ID where every call runs as the signed-in user.

## Quickstart

You need Node.js 20 or later and, for the local lanes, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) signed in with `az login`. With no settings the server uses that sign-in in read-only mode.

### Claude Code

As a plugin (a self-contained build in [plugin/](plugin), no `npm install`):

```bash
/plugin marketplace add patrickking67/azure-mcp
/plugin install azure@azure-mcp
```

The plugin reads `AZURE_MODE`, `AZURE_ALLOW_DESTRUCTIVE`, `AZURE_SUBSCRIPTION_ID` and `AZ_PATH` from your shell environment. Unset, it is read-only.

Or from a clone:

```bash
git clone https://github.com/patrickking67/azure-mcp.git && cd azure-mcp
npm ci && npm run build
claude mcp add azure --scope user --env AZURE_MODE=read -- node "$(pwd)/dist/index.js"
```

### Claude Desktop (.mcpb)

```bash
npm ci
npm run mcpb:pack
```

Open the resulting `azure.mcpb` (Settings > Extensions > Install extension). Every setting is optional; Mode and Allow destructive operations are the two gates described under [Safety model](#safety-model).

### Remote (Azure Container Apps + Entra ID)

```bash
# 1. Infrastructure and image (plan first; --apply builds the image inside Azure and verifies the release)
az group create -n rg-azure-mcp -l eastus
cp infra/main.bicepparam.example infra/main.bicepparam            # your tenant id
AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp npm run deploy:plan      # checks + what-if, changes nothing
AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp bash scripts/deploy-azure.sh --apply

# 2. Entra app registration (plan first, then --apply), using the outputs of step 1
ENTRA_TENANT_ID=<tenant> PUBLIC_URL=<publicUrl> MI_PRINCIPAL_ID=<identityPrincipalId> bash scripts/entra-setup.sh

# 3. Put the app id in infra/main.bicepparam and run step 1's --apply again
```

An admin then grants consent and assigns users to the `Azure.Read` / `Azure.Write` / `Azure.Destructive` app roles. Add `<publicUrl>/mcp` as a custom connector in Claude (or ChatGPT). The full walkthrough, including the Entra app roles and rollback, is in [docs/remote.md](docs/remote.md).

## Safety model

The design assumes the model will sometimes be wrong or be talked into something by content it reads (a resource tag, a log line, a web page). The operator decides what is possible; the model only decides what to ask for within that.

**Three tiers, two gates, one confirm.**

| Tier | What | Needs |
| --- | --- | --- |
| Read | `List_*`, `Get_*`, `Query_*`, views, `Az_CLI` | nothing |
| Write | creates, updates, starts, tags, credential reads | `AZURE_MODE=write` + `confirm: true` |
| Destructive | delete, stop, deallocate, restart, resize, purge, regenerate, run code on a machine | `AZURE_MODE=write` + `AZURE_ALLOW_DESTRUCTIVE=true` + `confirm: true` |

- The gates are environment settings the operator sets and the client restarts on. A tool call cannot change them.
- Write tools stay listed in read mode and refuse with a message that names the setting, so a refusal is explainable rather than a missing tool. `Status_Gate` reports the current state.
- Remotely, the caller also needs the `Azure.Write` or `Azure.Destructive` Entra app role. The server's gate is the ceiling for everyone; the role narrows it per caller.
- Everything is bounded by the identity's own Azure RBAC and Graph permissions. The server grants nothing.

**The Azure CLI is classified, not trusted.** `Az_CLI` runs reads only; `Az_CLI_Run` runs anything else at the tier its command earns. The classifier reads argv the way the CLI will:

- Command words are lowercased like the CLI does (`vm DELETE` is a delete), and non-ASCII command words are refused, because Python folds some lookalikes (the Kelvin sign) into ASCII letters.
- Long options match their abbreviations (`--mo Complete` is `--mode Complete`), and every occurrence of a repeated option is checked, because argparse keeps the last one.
- Global options (`--only-show-errors`, `--verbose`, `-o`, `--query`) and `--` between command words do not end the command, so `account --only-show-errors get-access-token` is still refused.
- Reads that return credentials (keys, secrets, connection strings, SAS, passwords, app settings, publishing profiles, App Service auth settings and backup URLs, `--show-values`, `--resolve-keyvault`) are write-tier, so a key never lands in a transcript from the ungated read tool.
- Complete-mode deployments, stacks that delete on unmanage, `resize`, `generalize`, `scale`, `run-command` and `command invoke` need the destructive gate.

**Always refused**, whatever the gates: `login`, `account set`, `account get-access-token`, `config`, `extension add`, `upgrade`, interactive sessions (`ssh`, `exec`, `log tail`), `--debug`, and anything that reaches local files: `@file` arguments, `~`, absolute, `..` and Windows paths, `file:` URLs, path flags such as `--file` and `--template-file`, commands that upload the working directory (`webapp up`), `get-credentials` and `connectedk8s proxy`, which write a kubeconfig, `--generate-ssh-keys`, which writes into `~/.ssh`, and `browse`, which opens a browser. The CLI runs in an empty temporary directory, so a relative path reaches nothing. `az rest` accepts a fixed flag set, each flag once, and only `https` URLs on exactly management.azure.com, graph.microsoft.com, api.loganalytics.io and `*.vault.azure.net`, written plainly (no userinfo, port, backslash, whitespace or encoding tricks). Arguments are passed as an argv array; nothing goes through a shell.

Found a way around any of this? See [SECURITY.md](SECURITY.md).

## Tools (102)

Every dedicated tool carries its Azure CLI equivalent in its description and in the `azure://reference/api` resource.

| Kind | Tools |
| --- | --- |
| Read (78) | `List_*`, `Get_*` (except `Get_Key_Vault_Secret`), `Query_*`, `Resource_Graph_Query`, `Resource_Health`, `ARM_GET`, `Graph_GET`, `Az_CLI`, `Az_CLI_Help`, `Status_Server`, `Status_Gate`, `Test_Connection` |
| Interactive (6, read) | `View_Estate`, `View_Virtual_Machines`, `View_Web_Apps`, `View_Costs`, `View_Resources`, `View_Security` |
| Write (7) | `Start_VM`, `Start_Web_App`, `Start_AKS_Cluster`, `Tag_Resource`, `Create_Resource_Group`, `Set_Key_Vault_Secret`, `Get_Key_Vault_Secret` (credential read) |
| Destructive (11) | `Stop_VM`, `Restart_VM`, `Resize_VM`, `Stop_Web_App`, `Restart_Web_App`, `Stop_AKS_Cluster`, `Delete_Resource_Group`, `Delete_Resource`, `ARM_Request`, `Graph_Request`, `Az_CLI_Run` |

`ARM_Request`, `Graph_Request` and `Az_CLI_Run` are annotated destructive because they can be; each call is gated at the tier of what it actually does (a `PATCH` is a write, a `DELETE` is destructive).

### The Azure CLI, one-to-one

- **`Az_CLI`** runs any read-only `az` command (`list`, `show`, `get-*`, `check-*`, `az rest --method get`). No gate.
- **`Az_CLI_Run`** runs anything else, classified per command as above.
- **`Az_CLI_Help`** returns `az <group> [<command>] --help` from the installed CLI.

Prefer a dedicated tool when one exists; reach for `Az_CLI` rather than guessing ARM paths.

### Interactive views (MCP Apps)

Rendered inline by hosts that support MCP Apps; other hosts get the same data as JSON.

- **Estate**: resources by type and region, resource groups, unhealthy resources, Advisor, secure score, month-to-date cost.
- **Virtual Machines** / **Web Apps**: live state with Start / Deallocate (Stop) / Restart buttons. A button arms on the first click and fires on the second, calling the same gated tool with `confirm: true`.
- **Costs**: total, daily trend, by service, by resource group, budgets.
- **Resource Explorer**: every resource, filterable, with the full ARM document on click.
- **Security**: secure score and weakest controls, active Defender alerts, Advisor security, Policy non-compliance.

## Settings

| Setting | Effect |
| --- | --- |
| `AZURE_MODE=write` (Mode) | Enables the write tier. Default `read`. |
| `AZURE_ALLOW_DESTRUCTIVE=true` (Allow destructive operations) | Also enables the destructive tier. No effect without write mode. |
| `AZURE_SUBSCRIPTION_ID` | Default subscription. A tool's `subscription_id` argument wins; otherwise the az default (or the identity's only subscription). |
| `AZURE_AUTH` | `auto` (default), `azure_cli`, `service_principal` or `managed_identity`. |
| `AZ_PATH` | Absolute path to `az`, when a desktop app cannot find it on PATH. |

### Auth

`auto` chooses:

1. **Service principal** when `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` are set.
2. **Managed identity** when the host advertises one (`IDENTITY_ENDPOINT`, or IMDS with `AZURE_AUTH=managed_identity`).
3. **Azure CLI** otherwise: `az account get-access-token` against your `az login`.

The CLI tools run as the same identity: your own `az login`, or an isolated CLI profile (`AZURE_CONFIG_DIR` in a temp dir) signed in as the service principal or managed identity, so your `~/.azure` is never touched.

## Other clients

### Codex and ChatGPT desktop (plugin)

The repository is also a Codex marketplace (`.agents/plugins/marketplace.json`, plugin manifest `plugin/plugin.json`, server in `plugin/mcp.json`):

```bash
codex plugin marketplace add patrickking67/azure-mcp
codex plugin add azure@azure-mcp
```

The plugin starts read-only. To enable writes in Codex, configure the server directly (`~/.codex/config.toml`):

```toml
[mcp_servers.azure]
command = "node"
args = ["/path/to/azure-mcp/dist/index.js"]
env = { AZURE_MODE = "write", AZURE_ALLOW_DESTRUCTIVE = "false" }
```

### ChatGPT (web and mobile)

ChatGPT on the web cannot launch a local server. Use the remote lane and add `<publicUrl>/mcp` as a connector. The interactive views carry the `openai/outputTemplate` metadata ChatGPT apps use.

## Architecture

```
MCP client --stdio--> src/index.ts  -+
                                     +-> src/server.ts -> src/tools/*  (defineTool: tier, gate, confirm, CLI equivalent)
MCP client --HTTPS--> src/remote.ts -+                    src/apps/*   (MCP Apps views, same gated tools behind the buttons)
                      (Entra JWT, app roles)              src/cli-policy.ts -> src/az.ts -> az (argv only, empty cwd)
                                                          src/client.ts -> ARM, Graph, Key Vault, Log Analytics (fixed hosts)
                                                          src/auth.ts   -> az login | service principal | managed identity | on-behalf-of
```

- **One server, two transports.** `src/server.ts` builds the same tool surface for stdio and for Streamable HTTP. The remote lane is stateless (a fresh server per request) and validates Entra tokens against the tenant's JWKS.
- **One registration path.** Every tool goes through `defineTool` ([src/tools/define.ts](src/tools/define.ts)), which applies the tier, the gate ([src/gate.ts](src/gate.ts)), the required `confirm` and the MCP annotations, so a new tool cannot skip them.
- **On-behalf-of remotely.** The caller's token is exchanged for ARM, Graph, Key Vault and Log Analytics tokens, so Azure RBAC is the caller's own. The server proves its identity with a managed identity as a federated credential; no client secret exists.

## Develop

```bash
npm ci
npm run check          # everything CI runs: type check, tests, manifest check
npm test               # build + plugin bundle check + CLI policy + stdio smoke (fake az) + remote transport
npm run typecheck      # type check only
npm run manifest:check # manifest.json lists every tool
npm run manifest       # rewrite manifest.json tools from the running server
npm run plugin:build   # rebuild plugin/server/azure-mcp.mjs after changing src/
npm run apps:runtime   # re-inline the ext-apps browser runtime after upgrading it
npx @modelcontextprotocol/inspector node dist/index.js
```

Tests never call Azure: the stdio smoke test drives the server with a fake `az` ([test/fixtures/fake-az.mjs](test/fixtures/fake-az.mjs)). See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) for the layout and the rules a coding agent follows here. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Azure, Entra ID and the Azure logo are trademarks of Microsoft; this project is not affiliated with or endorsed by Microsoft.
