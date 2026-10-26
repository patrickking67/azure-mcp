// Microsoft Entra ID protection for the remote transport (src/remote.ts, an Azure Container App).
//
// Entra is the OAuth authorization server; this server is only the protected resource:
//   - GET /.well-known/oauth-protected-resource[/mcp]: RFC 9728 metadata naming Entra v2.
//   - POST /mcp without a valid token: 401 + WWW-Authenticate pointing at that metadata.
//   - Tokens: Entra v2, issuer login.microsoftonline.com/<tenant>/v2.0, audience = one of the app's
//     Application ID URIs (api://<appId> and https://<host>/mcp, which Claude sends as the RFC 8707
//     resource). jose re-fetches JWKS on an unknown kid, so key rollover needs nothing.
//   - Tiers: Azure.Read to connect, Azure.Write for writes, Azure.Destructive for the disruptive tier,
//     on top of the server's own AZURE_MODE / AZURE_ALLOW_DESTRUCTIVE ceiling.
// The caller's raw token is kept for the on-behalf-of exchange in src/auth.ts, so Azure itself enforces
// the caller's RBAC on every call.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { CallerAuth } from "./auth.js";

export const READ_ROLE = "Azure.Read";
export const WRITE_ROLE = "Azure.Write";
export const DESTRUCTIVE_ROLE = "Azure.Destructive";
export const MCP_PATH = "/mcp";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  publicUrl: string;
  mcpPath: string;
  issuer: string;
  resource: string;
  audiences: string[];
  scope: string;
  metadataUrl: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

/** Build the config from env-style values. Throws naming the first missing setting. */
export function entraConfig(get: (name: string) => string | undefined): EntraConfig {
  const need = (name: string): string => {
    const v = get(name);
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const tenantId = need("ENTRA_TENANT_ID");
  const clientId = need("ENTRA_CLIENT_ID");
  const publicUrl = need("PUBLIC_URL").replace(/\/+$/, "");
  const origin = new URL(publicUrl);
  if (origin.protocol !== "https:" || origin.origin !== publicUrl) throw new Error("PUBLIC_URL must be an HTTPS origin without a path, query or credentials");
  const mcpPath = get("MCP_PATH") ?? MCP_PATH;
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(mcpPath) || mcpPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("MCP_PATH must be an absolute path without query, fragment, trailing slash or dot segments");
  }
  const resource = `${publicUrl}${mcpPath}`;
  return {
    tenantId,
    clientId,
    publicUrl,
    mcpPath,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    resource,
    audiences: [clientId, `api://${clientId}`, resource],
    scope: `api://${clientId}/access_as_user`,
    metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource${mcpPath}`,
    jwks: createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)),
  };
}

export function protectedResourceMetadata(c: EntraConfig): Record<string, unknown> {
  return {
    resource: c.resource,
    authorization_servers: [c.issuer],
    scopes_supported: [c.scope],
    bearer_methods_supported: ["header"],
    resource_name: "Azure",
  };
}

export function challengeHeader(c: EntraConfig): string {
  return `Bearer error="invalid_token", resource_metadata="${c.metadataUrl}", scope="${c.scope}"`;
}

/** RFC 6750 challenge for a valid token without an Azure role (no scope: signing in again will not help). */
export function forbiddenHeader(reason: string): string {
  // Header values must be printable ASCII: accents in names would make the runtime throw.
  const safe = reason.replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "'");
  return `Bearer error="insufficient_scope", error_description="${safe}"`;
}

/** Verify the bearer token. Returns the caller (with the raw token for on-behalf-of), or a reason string for the 401. */
export async function authenticate(c: EntraConfig, authorization: string | null | undefined): Promise<CallerAuth | string> {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return "missing bearer token";
  try {
    const { payload } = await jwtVerify(token, c.jwks, { issuer: c.issuer, audience: c.audiences });
    const oid = typeof payload.oid === "string" ? payload.oid : "";
    const upn = (payload.preferred_username ?? payload.upn ?? "") as string;
    const scopes = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
    if (!oid || !upn) return "token does not identify a user";
    if (!scopes.includes("access_as_user")) return "token lacks the access_as_user scope";
    return { oid, upn, roles, assertion: token };
  } catch (error) {
    return error instanceof Error ? error.message : "token verification failed";
  }
}

const hasAny = (caller: CallerAuth, roles: string[]) => roles.some((r) => caller.roles.includes(r));

/** Connecting needs any Azure role, so access does not hang on the portal's "Assignment required" switch alone. */
export function callerReadRefusal(caller: CallerAuth): string | null {
  return hasAny(caller, [READ_ROLE, WRITE_ROLE, DESTRUCTIVE_ROLE])
    ? null
    : `${caller.upn} has no Azure MCP role. Ask an admin to assign ${READ_ROLE} in Entra (Enterprise applications > Azure MCP > Users and groups).`;
}

/** The per-caller tier check installed with setCallerTierCheck. */
export function callerTierRefusal(caller: CallerAuth | undefined, tier: "write" | "destructive"): string | null {
  if (!caller) return null; // stdio: no remote caller, the server gate alone decides.
  const needed = tier === "destructive" ? [DESTRUCTIVE_ROLE] : [WRITE_ROLE, DESTRUCTIVE_ROLE];
  return hasAny(caller, needed)
    ? null
    : `${caller.upn} does not hold the ${needed[0]} role. Ask an admin to assign it in Entra (Enterprise applications > Azure MCP > Users and groups).`;
}

/** Operational log lines: the tool name only, never the caller's arguments. */
export function auditLines(caller: CallerAuth, body: unknown): string[] {
  const calls = (Array.isArray(body) ? body : [body]).filter(
    (m): m is { method: string; params?: { name?: string } } => !!m && typeof m === "object" && (m as { method?: string }).method === "tools/call",
  );
  return calls.map((c) =>
    JSON.stringify({
      at: new Date().toISOString(),
      event: "tool_call",
      oid: caller.oid,
      tool: typeof c.params?.name === "string" && /^[A-Za-z_]+$/.test(c.params.name) ? c.params.name : "[invalid]",
    }),
  );
}
