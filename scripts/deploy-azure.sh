#!/usr/bin/env bash
# Deploy the remote Azure MCP to an Azure Container App.
#
#   1. local checks pass (typecheck, tests, manifest, Bicep);
#   2. the image is built IN Azure (az acr build): no local Docker daemon, no registry credentials;
#   3. infra/main.bicep is applied declaratively;
#   4. the new revision is health-checked, its version and OAuth metadata re-read, and an anonymous
#      MCP call must still be refused before the script claims success.
#
# Default is --dry-run: the checks plus a what-if plan, changing nothing.
#
#   AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp bash scripts/deploy-azure.sh           # plan only
#   AZ_SUBSCRIPTION=<sub> AZ_RG=rg-azure-mcp bash scripts/deploy-azure.sh --apply   # release
#
# The resource group must exist (az group create -n <rg> -l <region>). Parameters come from
# infra/main.bicepparam (copy infra/main.bicepparam.example). No secret is read, printed or passed.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:---dry-run}"
case "$MODE" in --dry-run|--apply) ;; *) echo "Usage: $0 [--dry-run|--apply]" >&2; exit 2;; esac

PARAMS=infra/main.bicepparam
TEMPLATE=infra/main.bicep
[ -f "$PARAMS" ] || { echo "Missing $PARAMS: copy infra/main.bicepparam.example and fill it in." >&2; exit 2; }
for name in AZ_SUBSCRIPTION AZ_RG; do
  [ -n "${!name:-}" ] || { echo "Missing required setting: $name." >&2; exit 2; }
done
SUB="$AZ_SUBSCRIPTION"; RG="$AZ_RG"

# Every command is pinned to the requested subscription; the CLI default is never changed.
az() { command az "$@" --subscription "$SUB"; }

PARAM_TENANT=$(grep -oE "param entraTenantId = '[^']+'" "$PARAMS" | grep -oE "[0-9a-fA-F-]{36}")
ACTUAL_TENANT=$(az account show --query tenantId -o tsv)
[ "$ACTUAL_TENANT" = "$PARAM_TENANT" ] || { echo "Refusing: signed into tenant $ACTUAL_TENANT but $PARAMS targets $PARAM_TENANT." >&2; exit 2; }

VERSION=$(node -p "require('./package.json').version")
IMAGE_TAG="$VERSION-$(git rev-parse --short HEAD)"

echo "── checks ──"
npm run check
npm test
npm run manifest:check
az bicep build --file "$TEMPLATE" --stdout >/dev/null
echo "Checks passed."

printf '\n── target ──\nsubscription %s\ngroup        %s\nimage        azure-mcp:%s\n' "$SUB" "$RG" "$IMAGE_TAG"

if [ "$MODE" = --dry-run ]; then
  echo; echo "── what-if (no changes) ──"
  az deployment group what-if -g "$RG" -f "$TEMPLATE" -p "$PARAMS" -p imageTag="$IMAGE_TAG"
  echo; echo "Plan only. Nothing was built or changed. Re-run with --apply after review."
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo 'Refusing: commit the complete release source before --apply.' >&2; exit 2
fi

mkdir -p .deployment
PREVIOUS=$(az containerapp show -n ca-azure-mcp -g "$RG" --query 'properties.template.containers[0].image' -o tsv 2>/dev/null || echo none)
printf '{"at":"%s","released":"%s","previous_image":"%s","commit":"%s"}\n' "$(date -u +%FT%TZ)" "$IMAGE_TAG" "$PREVIOUS" "$(git rev-parse HEAD)" | tee -a .deployment/releases.jsonl
[ "$PREVIOUS" = none ] || echo "Rollback: az containerapp update -n ca-azure-mcp -g $RG --image $PREVIOUS"

echo; echo "── foundation (identity, registry, logs, environment) ──"
az deployment group create -g "$RG" -f "$TEMPLATE" -p "$PARAMS" -p deployApp=false --name "azure-mcp-base-$IMAGE_TAG" -o none
ACR=$(az deployment group show -g "$RG" -n "azure-mcp-base-$IMAGE_TAG" --query properties.outputs.registryName.value -o tsv)

echo; echo "── build in Azure ──"
az acr build -r "$ACR" -t "azure-mcp:$IMAGE_TAG" -t "azure-mcp:latest" .

echo; echo "── app ──"
az deployment group create -g "$RG" -f "$TEMPLATE" -p "$PARAMS" -p imageTag="$IMAGE_TAG" --name "azure-mcp-$IMAGE_TAG" -o none
out() { az deployment group show -g "$RG" -n "azure-mcp-$IMAGE_TAG" --query "properties.outputs.$1.value" -o tsv; }
PUBLIC_URL=$(out publicUrl); RESOURCE=$(out oauthResource)

echo; echo "── verify ──"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if HEALTH=$(curl -fsS --max-time 20 "$PUBLIC_URL/healthz"); then break; fi
  echo "  health not ready (attempt $attempt)"; sleep 6
done
[ -n "${HEALTH:-}" ] || { echo "Deployed, but $PUBLIC_URL/healthz never answered. Roll back with the command above." >&2; exit 1; }
REPORTED=$(printf '%s' "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version??""))')
[ "$REPORTED" = "$VERSION" ] || { echo "Health reports version $REPORTED, expected $VERSION: the old revision may still be serving." >&2; exit 1; }
ADVERTISED=$(curl -fsS --max-time 20 "$PUBLIC_URL/.well-known/oauth-protected-resource/mcp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resource??""))')
[ "$ADVERTISED" = "$RESOURCE" ] || { echo "Metadata advertises $ADVERTISED, template says $RESOURCE." >&2; exit 1; }
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 20 -H 'content-type: application/json' -d '{}' "$RESOURCE")
[ "$STATUS" = 401 ] || { echo "Anonymous POST to $RESOURCE returned $STATUS, expected 401." >&2; exit 1; }

printf '\nReleased azure-mcp:%s\n  health %s\n  oauth resource %s\n  anonymous MCP refused (401)\n' "$IMAGE_TAG" "$HEALTH" "$ADVERTISED"
echo "Connector URL for Claude: $RESOURCE"
echo "Identity principal (federated credential subject): $(out identityPrincipalId)"
