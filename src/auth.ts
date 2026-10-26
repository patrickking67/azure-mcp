// Where access tokens come from. Four sources, one interface (getToken(resource)):
//
//   azure_cli          `az account get-access-token` against the user's own `az login`. The default locally.
//   service_principal  OAuth client credentials (AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET).
//   managed_identity   The host's identity endpoint (Container Apps / App Service) or IMDS (VMs, AKS).
//   on_behalf_of       Remote only. The caller's Entra token is exchanged for an ARM/Graph/Key Vault token
//                      as that caller, so every call is bounded by THEIR RBAC, not the server's.
//
// AZURE_AUTH picks one explicitly; "auto" (the default) takes a service principal when all three values are
// set, a managed identity when the host advertises one, and the Azure CLI otherwise. on_behalf_of is chosen
// per request by src/remote.ts, which runs each call inside withCaller().

import { AsyncLocalStorage } from "node:async_hooks";
import { azJson, AzureCliError } from "./az.js";
import { envValue } from "./env.js";

export type AuthMode = "azure_cli" | "service_principal" | "managed_identity" | "on_behalf_of";

type JsonObject = { [key: string]: unknown };
type CachedToken = { token: string; expiresAtMs: number };

export const TENANT_ID = envValue("AZURE_TENANT_ID");
export const CLIENT_ID = envValue("AZURE_CLIENT_ID");
const CLIENT_SECRET = envValue("AZURE_CLIENT_SECRET");
export const MANAGED_IDENTITY_CLIENT_ID = envValue("MANAGED_IDENTITY_CLIENT_ID");
const LOGIN_HOST = "https://login.microsoftonline.com";

function resolveMode(): Exclude<AuthMode, "on_behalf_of"> {
  const requested = (envValue("AZURE_AUTH") ?? "auto").toLowerCase().replace(/-/g, "_");
  if (requested === "azure_cli" || requested === "cli") return "azure_cli";
  if (requested === "service_principal" || requested === "sp") return "service_principal";
  if (requested === "managed_identity" || requested === "mi") return "managed_identity";
  if (TENANT_ID && CLIENT_ID && CLIENT_SECRET) return "service_principal";
  if (process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT) return "managed_identity";
  return "azure_cli";
}

export const BASE_AUTH_MODE = resolveMode();

/** The signed-in remote caller whose token is exchanged on-behalf-of. */
export type CallerAuth = { oid: string; upn: string; roles: string[]; assertion: string };
const callerStore = new AsyncLocalStorage<CallerAuth>();

export function withCaller<T>(caller: CallerAuth, run: () => Promise<T>): Promise<T> {
  return callerStore.run(caller, run);
}

export function currentCaller(): CallerAuth | undefined {
  return callerStore.getStore();
}

/** on_behalf_of when a remote caller is in scope and the server is configured for it; the base mode otherwise. */
export function authMode(): AuthMode {
  return currentCaller() && oboEnabled() ? "on_behalf_of" : BASE_AUTH_MODE;
}

export function oboEnabled(): boolean {
  return (envValue("AZURE_REMOTE_IDENTITY") ?? "on_behalf_of").toLowerCase() === "on_behalf_of" && Boolean(envValue("ENTRA_CLIENT_ID"));
}

const tokenCache = new Map<string, CachedToken>();

function cached(key: string): string | undefined {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAtMs - Date.now() > 120_000) return hit.token;
  return undefined;
}

function remember(key: string, token: string, expiresInSeconds: number): string {
  tokenCache.set(key, { token, expiresAtMs: Date.now() + expiresInSeconds * 1000 });
  // Bound the cache: on-behalf-of entries are per caller and resource.
  if (tokenCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.expiresAtMs < now) tokenCache.delete(k);
  }
  return token;
}

async function tokenEndpoint(tenant: string, form: Record<string, string>, label: string): Promise<{ token: string; expiresIn: number }> {
  const response = await fetch(`${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok || typeof body.access_token !== "string") {
    // The body carries AADSTS codes and a correlation id, never a secret; it is what an operator needs.
    throw new Error(`${label} failed (${response.status}): ${String(body.error_description ?? body.error ?? JSON.stringify(body))}`);
  }
  return { token: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3000 };
}

async function servicePrincipalToken(resource: string): Promise<string> {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("AZURE_AUTH=service_principal needs AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.");
  }
  const { token, expiresIn } = await tokenEndpoint(
    TENANT_ID,
    { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: `${resource}/.default` },
    `Service principal token request for ${resource}`,
  );
  return remember(`sp|${resource}`, token, expiresIn);
}

/** A managed identity token: App Service / Container Apps identity endpoint first, then IMDS. */
export async function managedIdentityToken(resource: string): Promise<string> {
  const key = `mi|${resource}`;
  const hit = cached(key);
  if (hit) return hit;
  let response: Response;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (endpoint && header) {
    const url = new URL(endpoint);
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", "2019-08-01");
    if (MANAGED_IDENTITY_CLIENT_ID) url.searchParams.set("client_id", MANAGED_IDENTITY_CLIENT_ID);
    response = await fetch(url, { headers: { "X-IDENTITY-HEADER": header } });
  } else {
    const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", resource);
    if (MANAGED_IDENTITY_CLIENT_ID) url.searchParams.set("client_id", MANAGED_IDENTITY_CLIENT_ID);
    response = await fetch(url, { headers: { Metadata: "true" }, signal: AbortSignal.timeout(5000) });
  }
  const body = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(`Managed identity token request for ${resource} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  const expiresOn = Number(body.expires_on);
  const expiresIn = Number.isFinite(expiresOn) && expiresOn > 0 ? Math.max(60, expiresOn - Date.now() / 1000) : 3000;
  return remember(key, body.access_token, expiresIn);
}

async function cliToken(resource: string): Promise<string> {
  const args = ["account", "get-access-token", "--resource", resource, "--output", "json"];
  if (TENANT_ID) args.push("--tenant", TENANT_ID);
  const result = (await azJson(args)) as JsonObject | null;
  if (!result || typeof result.accessToken !== "string") throw new AzureCliError(`Azure CLI did not return an access token for ${resource}.`);
  const expiresOn = typeof result.expires_on === "number" ? result.expires_on : Date.now() / 1000 + 3000;
  return remember(`cli|${resource}`, result.accessToken, expiresOn - Date.now() / 1000);
}

/**
 * Exchange the caller's token for one at `resource`, as the caller. The server proves its own identity
 * with ENTRA_CLIENT_SECRET when set, otherwise with a federated credential: its managed identity's token
 * for api://AzureADTokenExchange, which the app registration trusts. No secret has to exist at all.
 */
async function onBehalfOfToken(caller: CallerAuth, resource: string): Promise<string> {
  const key = `obo|${caller.oid}|${resource}`;
  const hit = cached(key);
  if (hit) return hit;
  const tenant = envValue("ENTRA_TENANT_ID");
  const clientId = envValue("ENTRA_CLIENT_ID");
  if (!tenant || !clientId) throw new Error("On-behalf-of needs ENTRA_TENANT_ID and ENTRA_CLIENT_ID.");
  const secret = envValue("ENTRA_CLIENT_SECRET");
  const form: Record<string, string> = {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    assertion: caller.assertion,
    requested_token_use: "on_behalf_of",
    scope: `${resource}/.default`,
  };
  if (secret) form.client_secret = secret;
  else {
    form.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    form.client_assertion = await managedIdentityToken("api://AzureADTokenExchange");
  }
  const { token, expiresIn } = await tokenEndpoint(tenant, form, `On-behalf-of exchange for ${resource} (caller ${caller.upn})`);
  return remember(key, token, expiresIn);
}

export async function getToken(resource: string): Promise<string> {
  const caller = currentCaller();
  if (caller && oboEnabled()) return onBehalfOfToken(caller, resource);
  const key = `${BASE_AUTH_MODE === "service_principal" ? "sp" : BASE_AUTH_MODE === "managed_identity" ? "mi" : "cli"}|${resource}`;
  const hit = cached(key);
  if (hit) return hit;
  if (BASE_AUTH_MODE === "service_principal") return servicePrincipalToken(resource);
  if (BASE_AUTH_MODE === "managed_identity") return managedIdentityToken(resource);
  return cliToken(resource);
}

export function servicePrincipalSecret(): string | undefined {
  return CLIENT_SECRET;
}
