#!/usr/bin/env bash
# Create (or update) the "Azure MCP" Entra app registration for the remote lane.
#
# What it sets:
#   - v2 access tokens, identifier URIs api://<appId> and <PUBLIC_URL>/mcp;
#   - the delegated scope access_as_user, and app roles Azure.Read, Azure.Write, Azure.Destructive;
#   - delegated permissions the on-behalf-of exchange needs: Azure Service Management, Key Vault and
#     Log Analytics user_impersonation / Data.Read, and Microsoft Graph User.Read + Directory.Read.All;
#   - a federated credential trusting the container app's managed identity, so the server proves its
#     own identity without a client secret (no secret exists to leak or rotate).
#
# What it does NOT do: grant admin consent or assign users to roles. Both are tenant decisions an
# admin makes in Entra (Enterprise applications > Azure MCP).
#
#   ENTRA_TENANT_ID=<tenant> PUBLIC_URL=https://ca-azure-mcp.<env>.azurecontainerapps.io \
#   MI_PRINCIPAL_ID=<identityPrincipalId output> bash scripts/entra-setup.sh            # plan
#   ... bash scripts/entra-setup.sh --apply                                              # create/update
#
# ENTRA_CLIENT_ID selects an existing app; without it a new one is created.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:---dry-run}"
case "$MODE" in --dry-run|--apply) ;; *) echo "Usage: $0 [--dry-run|--apply]" >&2; exit 2;; esac
: "${ENTRA_TENANT_ID:?set the tenant id}"
: "${PUBLIC_URL:?set the HTTPS origin of the container app}"
: "${MI_PRINCIPAL_ID:?set the managed identity principal (object) id from the deployment output}"
TENANT=$(az account show --query tenantId -o tsv)
[ "$TENANT" = "$ENTRA_TENANT_ID" ] || { echo "Refusing: signed into tenant $TENANT, not $ENTRA_TENANT_ID." >&2; exit 2; }
RESOURCE="${PUBLIC_URL%/}${MCP_PATH:-/mcp}"

# Delegated scope ids differ per tenant only in theory; read them from the service principals instead of hardcoding.
scope_id() { az ad sp show --id "$1" --query "oauth2PermissionScopes[?value=='$2'].id | [0]" -o tsv; }
ARM=797f4846-ba00-4fd7-ba43-dac1f8f63013
GRAPH=00000003-0000-0000-c000-000000000000
VAULT=cfa8b339-82a2-471a-a3c9-0fc0be7a4093
LOGS=ca7f3f0b-7d91-482c-8e09-c5d840d0eac5
ACCESS=$(cat <<JSON
[
 {"resourceAppId":"$ARM","resourceAccess":[{"id":"$(scope_id $ARM user_impersonation)","type":"Scope"}]},
 {"resourceAppId":"$VAULT","resourceAccess":[{"id":"$(scope_id $VAULT user_impersonation)","type":"Scope"}]},
 {"resourceAppId":"$LOGS","resourceAccess":[{"id":"$(scope_id $LOGS Data.Read)","type":"Scope"}]},
 {"resourceAppId":"$GRAPH","resourceAccess":[{"id":"$(scope_id $GRAPH User.Read)","type":"Scope"},{"id":"$(scope_id $GRAPH Directory.Read.All)","type":"Scope"}]}
]
JSON
)

echo "tenant      $ENTRA_TENANT_ID"
echo "resource    $RESOURCE"
echo "app         ${ENTRA_CLIENT_ID:-(new) Azure MCP}"
echo "FIC subject $MI_PRINCIPAL_ID"
echo "permissions $ACCESS" | tr -d '\n '; echo
if [ "$MODE" = --dry-run ]; then echo; echo "Plan only. No Entra settings changed."; exit 0; fi

if [ -z "${ENTRA_CLIENT_ID:-}" ]; then
  ENTRA_CLIENT_ID=$(az ad app create --display-name "Azure MCP" --sign-in-audience AzureADMyOrg --query appId -o tsv)
  az ad sp create --id "$ENTRA_CLIENT_ID" -o none
  echo "Created app $ENTRA_CLIENT_ID"
fi
OBJ=$(az ad app show --id "$ENTRA_CLIENT_ID" --query id -o tsv)
EXISTING=$(az ad app show --id "$ENTRA_CLIENT_ID" -o json)
export EXISTING ENTRA_CLIENT_ID RESOURCE ACCESS
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
# Keep any ids already issued so a re-run does not churn scopes or roles that tokens reference.
node --input-type=module > "$BODY" <<'JS'
import { randomUUID } from 'node:crypto';
const app = JSON.parse(process.env.EXISTING);
const keep = (list, value) => list?.find((x) => x.value === value)?.id ?? randomUUID();
const role = (value, name, description) => ({ id: keep(app.appRoles, value), value, displayName: name, description, allowedMemberTypes: ['User'], isEnabled: true });
console.log(JSON.stringify({
  identifierUris: [...new Set([...(app.identifierUris ?? []), `api://${process.env.ENTRA_CLIENT_ID}`, process.env.RESOURCE])],
  api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [{
      id: keep(app.api?.oauth2PermissionScopes, 'access_as_user'), value: 'access_as_user', type: 'User', isEnabled: true,
      adminConsentDisplayName: 'Use Azure MCP as you', adminConsentDescription: 'Lets the Azure MCP server call Azure as the signed-in user.',
      userConsentDisplayName: 'Use Azure MCP as you', userConsentDescription: 'Lets the Azure MCP server call Azure as you.',
    }],
  },
  appRoles: [
    role('Azure.Read', 'Azure MCP reader', 'Connect and use read tools.'),
    role('Azure.Write', 'Azure MCP writer', 'Use write tools when the server is in write mode.'),
    role('Azure.Destructive', 'Azure MCP destructive', 'Use delete, stop and restart tools when the server allows them.'),
  ],
  requiredResourceAccess: JSON.parse(process.env.ACCESS),
}));
JS
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$OBJ" --headers Content-Type=application/json --body "$(cat "$BODY")" -o none

if ! az ad app federated-credential list --id "$ENTRA_CLIENT_ID" --query "[?subject=='$MI_PRINCIPAL_ID'] | [0].name" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$ENTRA_CLIENT_ID" --parameters "{\"name\":\"azure-mcp-managed-identity\",\"issuer\":\"https://login.microsoftonline.com/$ENTRA_TENANT_ID/v2.0\",\"subject\":\"$MI_PRINCIPAL_ID\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none
fi

echo
echo "App $ENTRA_CLIENT_ID updated. Remaining admin steps (not automated on purpose):"
echo "  1. Grant admin consent: Entra > App registrations > Azure MCP > API permissions > Grant admin consent."
echo "  2. Assign users or groups to Azure.Read / Azure.Write / Azure.Destructive under Enterprise applications > Azure MCP."
echo "  3. Put entraClientId = '$ENTRA_CLIENT_ID' in infra/main.bicepparam and redeploy if it changed."
