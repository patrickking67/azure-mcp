# azure-mcp (server name: "Azure")

Local stdio MCP server for **Microsoft Azure** with 89 tools. Authenticates by reusing your existing Azure CLI session (no stored secret) or, optionally, a service principal configured at install time. Node-based, so one `.mcpb` runs on Apple Silicon and Intel Macs (and Windows/Linux).

## Prerequisite

- Azure CLI installed and logged in: `az login` (once). Verify with `az account show`.
  - If `az account get-access-token` fails with `AADSTS135010`, re-run `az login` (stale token cache).
- If `az` is not on PATH when launched by a desktop app, set `AZ_PATH` to its absolute path (e.g. `/opt/homebrew/bin/az`).
- Alternative: configure a service principal (tenant id, client id, client secret) in the connector settings; then no `az` CLI is needed at all.

## Tools (89: 74 read, 15 write)

Tool names are Title_Case (e.g. `Delete_Resource_Group`) so Claude's permission UI reads cleanly; each also carries a spaced `title` annotation. Read/write grouping comes from `readOnlyHint`/`destructiveHint` annotations.

- Core: Test_Connection, List_Subscriptions, List_Locations, List_Resource_Groups, List_Resources, Get_Resource, Resource_Graph_Query, ARM_GET
- Compute: List/Get_Virtual_Machine(s), List_VM_Scale_Sets, List_Disks, List_Snapshots, List_VM_Images
- Network: List_Virtual_Networks, List_Subnets, List_Network_Security_Groups, List_NSG_Rules, List_Public_IPs, List_Network_Interfaces, List_Load_Balancers, List_Application_Gateways, List_Route_Tables, List_DNS_Zones, List_DNS_Records, List_Private_Endpoints
- Storage: List_Storage_Accounts, List_Storage_Containers, List_File_Shares, List_Storage_Queues, List_Storage_Tables
- Web: List_Web_Apps, Get_Web_App, List_Function_Apps, List_App_Service_Plans, List_Static_Web_Apps
- Data: List_SQL_Servers, List_SQL_Databases, List_Cosmos_DB_Accounts, List_PostgreSQL_Servers, List_MySQL_Servers, List_Redis_Caches
- Containers: List_AKS_Clusters, Get_AKS_Cluster, List_Container_Registries, List_Container_Apps, List_Container_Instances
- Identity/security: List_Key_Vaults, List_Key_Vault_Secrets, Get_Key_Vault_Secret, List_Managed_Identities, List_Role_Assignments, List_Role_Definitions, List_Entra_Users, List_Entra_Groups, List_Entra_Applications, List_Security_Alerts, List_Secure_Scores, List_Policy_Assignments
- Monitoring: List_Activity_Log, List_Fired_Alerts, List_Alert_Rules, Get_Metrics, List_Metric_Definitions, List_Diagnostic_Settings, List_Log_Analytics_Workspaces, Query_Log_Analytics, List_Application_Insights, Resource_Health
- Cost/governance: Query_Costs, List_Budgets, List_Advisor_Recommendations
- Messaging: List_Event_Hub_Namespaces, List_Service_Bus_Namespaces
- Write (RBAC-bounded): Start/Stop/Restart/Resize_VM, Start/Stop/Restart_Web_App, Start/Stop_AKS_Cluster, Tag_Resource, Create/Delete_Resource_Group, Delete_Resource, Set_Key_Vault_Secret, ARM_Request

## Auth resolution (all config optional)

1. If `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` are set: OAuth client-credentials directly against `login.microsoftonline.com` (no az CLI involved).
2. Otherwise: `az account get-access-token` passthrough (`--tenant` added when `AZURE_TENANT_ID` alone is set). Tokens cached to expiry per resource (ARM, Graph, Key Vault, Log Analytics).
3. Subscription: explicit `subscription_id` arg > `AZURE_SUBSCRIPTION_ID` > az default (or sole SP-visible subscription).

Non-ARM planes used: Microsoft Graph (Entra tools), Key Vault data plane (secrets), `api.loganalytics.io` (KQL). ARM api-version errors are auto-negotiated: the server parses the "supported api-versions" error and retries once with the newest stable version.

## Build

```bash
npm install
npm run build
```

## Package the .mcpb bundle (Claude Desktop)

Pack from a clean staging dir so dev dependencies stay out of the bundle (~3.4MB instead of ~9.5MB):

```bash
npm run build && npx mcpb validate manifest.json
STAGE=$(mktemp -d) && cp -R manifest.json package.json package-lock.json dist assets "$STAGE/" \
  && (cd "$STAGE" && npm ci --omit=dev --silent && npx mcpb pack . Azure.mcpb) \
  && cp "$STAGE/Azure.mcpb" ./azure.mcpb
```

Keep `manifest.json`'s `tools` array in sync with the server: run the server, take `tools/list`, and write `{name, description}` pairs into the manifest before packing.

Install in Claude Desktop: Settings > Extensions > install `azure.mcpb`. All config fields (subscription id, tenant id, client id, client secret, az path) are optional; with none set it uses your `az login` session.

## Install in Claude Code

```bash
claude mcp add azure --scope user \
  --env AZURE_SUBSCRIPTION_ID=optional-default-sub \
  -- node /Users/patrickking/Code/azure-mcp/dist/index.js
```

## Install in Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.azure]
command = "node"
args = ["/Users/patrickking/Code/azure-mcp/dist/index.js"]
env = { AZURE_SUBSCRIPTION_ID = "optional-default-sub" }
```

## Test locally

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## Notes

- Write tools are asynchronous where Azure is (VM start/stop return 202 Accepted) and are limited to what your signed-in identity can do (RBAC).
- List calls follow ARM `nextLink` pagination up to a safety cap (20 pages) and report `truncated`.
- `Get_Key_Vault_Secret` returns the secret value; it is read-only but sensitive.
- The MCP resource `azure://reference/api` documents every tool's method, path, and api-version.
