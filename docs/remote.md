# Remote lane: Azure Container Apps + Entra ID

The same tool surface as the `.mcpb`, served over Streamable HTTP at `https://<app>/mcp`, for Claude custom connectors and any remote MCP client.

## Design

- **Entra is the OAuth server.** The app serves RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`; unauthenticated calls get `401` with a `WWW-Authenticate` pointing there. Tokens are verified against the tenant's JWKS (issuer, audience, `access_as_user` scope).
- **Every Azure call runs as the caller** (`AZURE_REMOTE_IDENTITY=on_behalf_of`, the default). The caller's token is exchanged on-behalf-of for ARM, Graph, Key Vault and Log Analytics tokens, so Azure RBAC is the caller's own. The server proves its identity to Entra with its **managed identity as a federated credential**: no client secret exists.
- **Tiers:** connecting needs the `Azure.Read` app role; writes need `Azure.Write`; deletes, stops and restarts need `Azure.Destructive`. The server's `AZURE_MODE` / `AZURE_ALLOW_DESTRUCTIVE` are the ceiling for everyone.
- **The Azure CLI tools** cannot act as an on-behalf-of caller (the CLI signs in as one identity), so they refuse in that mode. With `remoteIdentity = 'managed_identity'` every call, CLI included, runs as the app's identity instead; grant that identity RBAC deliberately (`az role assignment create --assignee <identityPrincipalId> --role Reader --scope /subscriptions/<sub>`).
- **Stateless:** a fresh server per request; any replica serves any call. Logs carry the caller's object id and the tool name, never arguments or tokens.

## Deploy

```bash
az group create -n rg-azure-mcp -l eastus
cp infra/main.bicepparam.example infra/main.bicepparam   # tenant id, client id (fill after step 2)
AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp bash scripts/deploy-azure.sh           # checks + what-if, changes nothing
AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp bash scripts/deploy-azure.sh --apply   # build in ACR, deploy, verify
```

`--apply` requires a clean tree, records the previous image in `.deployment/releases.jsonl` (with the rollback command), builds the image inside Azure (`az acr build`, no local Docker), applies the template in two phases (registry first, then the app), and fails unless health reports the new version, the metadata advertises the expected resource, and an anonymous MCP call returns 401.

## Entra app

```bash
ENTRA_TENANT_ID=<tenant> PUBLIC_URL=<publicUrl output> MI_PRINCIPAL_ID=<identityPrincipalId output> \
  bash scripts/entra-setup.sh            # plan
... bash scripts/entra-setup.sh --apply  # create or update "Azure MCP"
```

It sets v2 tokens, identifier URIs (`api://<appId>`, `<PUBLIC_URL>/mcp`), the `access_as_user` scope, the three app roles, delegated permissions for on-behalf-of (Azure Service Management, Key Vault, Log Analytics, Graph `User.Read` + `Directory.Read.All`), and the federated credential trusting the managed identity. An admin then grants consent and assigns users to roles; neither is automated.

Put the app id in `infra/main.bicepparam` and redeploy if it changed.

## Connect Claude

Add a custom connector with URL `<publicUrl>/mcp`. Claude discovers Entra from the metadata and signs the user in. Expect ~20 s on the first call after idle (`minReplicas = 0`).

## Rollback

`az containerapp update -n ca-azure-mcp -g <rg> --image <previous_image>` with the image recorded in `.deployment/releases.jsonl`.
