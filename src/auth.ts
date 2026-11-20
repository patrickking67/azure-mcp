// Where access tokens come from. Four sources, one interface (getToken(resource)):
//
//   azure_cli          `az account get-access-token` against the user's own `az login`. The default locally.
//   service_principal  OAuth client credentials for the tenant profile the call runs as (src/profiles.ts).
//                      Several profiles can be configured, one per tenant; every tool takes `profile`.
//   managed_identity   The host's identity endpoint (Container Apps / App Service) or IMDS (VMs, AKS).
//   on_behalf_of       Remote only. The caller's Entra token is exchanged for an ARM/Graph/Key Vault token
//                      as that caller, so every call is bounded by THEIR RBAC, not the server's.
//
// AZURE_AUTH=managed_identity (or a host that advertises an identity and has no service principal
// configured) selects the managed identity. Otherwise the identity is the current tenant profile: a
// service principal, or "cli" for the user's own az login. on_behalf_of is chosen per request by
// src/remote.ts, which runs each call inside withCaller().

import { AsyncLocalStorage } from "node:async_hooks";
import { azJson, AzureCliError } from "./az.js";
import { envValue } from "./env.js";
import { currentProfile, DEFAULT_PROFILE, PROFILES, type Profile } from "./profiles.js";

export type AuthMode = "azure_cli" | "service_principal" | "managed_identity" | "on_behalf_of";

type JsonObject = { [key: string]: unknown };
type CachedToken = { token: string; expiresAtMs: number };

export const MANAGED_IDENTITY_CLIENT_ID = envValue("MANAGED_IDENTITY_CLIENT_ID");
const LOGIN_HOST = "https://login.microsoftonline.com";

function hostManagedIdentity(): boolean {
  const requested = (envValue("AZURE_AUTH") ?? "auto").toLowerCase().replace(/-/g, "_");
  if (requested === "managed_identity" || requested === "mi") return true;
  if (requested !== "auto") return false;
  const anyServicePrincipal = PROFILES.some((p) => p.kind === "service_principal");
  return !anyServicePrincipal && Boolean(process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT);
}

export const USE_MANAGED_IDENTITY = hostManagedIdentity();

/** The identity used when no remote caller is in scope and no profile is named: for display and logs. */
export const BASE_AUTH_MODE: Exclude<AuthMode, "on_behalf_of"> = USE_MANAGED_IDENTITY ? "managed_identity" : DEFAULT_PROFILE.kind;

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
  if (currentCaller() && oboEnabled()) return "on_behalf_of";
  return USE_MANAGED_IDENTITY ? "managed_identity" : currentProfile().kind;
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
    throw new Error(`${label} failed (${response.status}): ${typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : JSON.stringify(body)}`);
  }
  return { token: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3000 };
}

async function servicePrincipalToken(profile: Profile, resource: string): Promise<string> {
  if (!profile.tenantId || !profile.clientId || !profile.clientSecret) {
    throw new Error(`Profile "${profile.name}" needs a tenant id, a client id and a client secret.`);
  }
  const { token, expiresIn } = await tokenEndpoint(
    profile.tenantId,
    { grant_type: "client_credentials", client_id: profile.clientId, client_secret: profile.clientSecret, scope: `${resource}/.default` },
    `Service principal token request for ${resource} (profile ${profile.name})`,
  );
  return remember(`sp|${profile.name}|${resource}`, token, expiresIn);
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

async function cliToken(profile: Profile, resource: string): Promise<string> {
  const args = ["account", "get-access-token", "--resource", resource, "--output", "json"];
  if (profile.tenantId) args.push("--tenant", profile.tenantId);
  const result = (await azJson(args)) as JsonObject | null;
  if (!result || typeof result.accessToken !== "string") throw new AzureCliError(`Azure CLI did not return an access token for ${resource}.`);
  const expiresOn = typeof result.expires_on === "number" ? result.expires_on : Date.now() / 1000 + 3000;
  return remember(`cli|${profile.name}|${resource}`, result.accessToken, expiresOn - Date.now() / 1000);
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
  if (USE_MANAGED_IDENTITY) return managedIdentityToken(resource);
  const profile = currentProfile();
  const key = `${profile.kind === "service_principal" ? "sp" : "cli"}|${profile.name}|${resource}`;
  const hit = cached(key);
  if (hit) return hit;
  return profile.kind === "service_principal" ? servicePrincipalToken(profile, resource) : cliToken(profile, resource);
}
