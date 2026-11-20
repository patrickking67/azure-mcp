// Tenant profiles: which identity a tool call runs as.
//
// One server can reach several Entra tenants. Each profile is a named identity:
//
//   cli                    the user's own `az login` (always present, the fallback)
//   <name>                 a service principal: tenant id + client id + client secret, from the connector
//                          settings (slots 1..5) or AZURE_TENANT_PROFILES (a JSON array, for CLI clients)
//
// The legacy single-identity settings (AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET) become a
// profile too, so an existing install keeps working. Every tool takes an optional `profile` argument; the
// call runs inside withProfile(), and auth.ts, az.ts and the upstream runner read currentProfile().
//
// Secrets never leave this module except to the token endpoint, `az login` and the upstream child's
// environment. describeProfiles() is what anything user-facing sees.

import { AsyncLocalStorage } from "node:async_hooks";
import { envValue } from "./env.js";

export type ProfileKind = "azure_cli" | "service_principal";

export type Profile = {
  name: string;
  kind: ProfileKind;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  subscriptionId?: string;
};

export const CLI_PROFILE = "cli";
export const PROFILE_SLOTS = 5;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

function slug(value: string): string {
  return value.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48);
}

function servicePrincipal(name: string | undefined, tenantId?: string, clientId?: string, clientSecret?: string, subscriptionId?: string, fallbackName = "default"): Profile | undefined {
  if (!tenantId && !clientId && !clientSecret) return undefined;
  const cleanName = slug(name ?? "") || fallbackName;
  if (!tenantId || !clientId || !clientSecret) {
    configProblems.push(`Profile "${cleanName}" needs a tenant id, a client id and a client secret; it was skipped.`);
    return undefined;
  }
  return { name: cleanName, kind: "service_principal", tenantId, clientId, clientSecret, subscriptionId };
}

export const configProblems: string[] = [];

function loadProfiles(): Profile[] {
  const found: Profile[] = [];
  // 1. The legacy single identity (the original connector settings).
  const legacy = servicePrincipal(envValue("AZURE_PROFILE_NAME"), envValue("AZURE_TENANT_ID"), envValue("AZURE_CLIENT_ID"), envValue("AZURE_CLIENT_SECRET"), envValue("AZURE_SUBSCRIPTION_ID"), "primary");
  if (legacy) found.push(legacy);
  // 2. Numbered slots from the connector settings.
  for (let i = 1; i <= PROFILE_SLOTS; i += 1) {
    const p = `AZURE_PROFILE_${i}_`;
    const profile = servicePrincipal(envValue(`${p}NAME`), envValue(`${p}TENANT_ID`), envValue(`${p}CLIENT_ID`), envValue(`${p}CLIENT_SECRET`), envValue(`${p}SUBSCRIPTION_ID`), `tenant-${i}`);
    if (profile) found.push(profile);
  }
  // 3. A JSON array, for clients configured by hand: [{ "name", "tenant_id", "client_id", "client_secret", "subscription_id" }].
  const json = envValue("AZURE_TENANT_PROFILES");
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      parsed.forEach((entry, i) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const s = (k: string) => (typeof e[k] === "string" && (e[k]).trim() ? (e[k]).trim() : undefined);
        const profile = servicePrincipal(s("name"), s("tenant_id"), s("client_id"), s("client_secret"), s("subscription_id"), `json-${i + 1}`);
        if (profile) found.push(profile);
      });
    } catch (error) {
      configProblems.push(`AZURE_TENANT_PROFILES is not valid JSON (${error instanceof Error ? error.message : String(error)}); it was ignored.`);
    }
  }
  // The az login identity is always available, under a reserved name.
  const cli: Profile = { name: CLI_PROFILE, kind: "azure_cli", tenantId: envValue("AZURE_CLI_TENANT_ID"), subscriptionId: envValue("AZURE_SUBSCRIPTION_ID") };
  const profiles: Profile[] = [];
  const names = new Set<string>([CLI_PROFILE]);
  for (const profile of found) {
    let name = NAME_PATTERN.test(profile.name) ? profile.name : "profile";
    if (names.has(name.toLowerCase())) {
      let n = 2;
      while (names.has(`${name}-${n}`.toLowerCase())) n += 1;
      configProblems.push(`Two profiles are named "${name}"; the second is "${name}-${n}".`);
      name = `${name}-${n}`;
    }
    names.add(name.toLowerCase());
    profiles.push({ ...profile, name });
  }
  profiles.push(cli);
  return profiles;
}

export const PROFILES: readonly Profile[] = loadProfiles();

function resolveDefault(): Profile {
  const wanted = envValue("AZURE_DEFAULT_PROFILE");
  if (wanted) {
    const hit = findProfile(wanted);
    if (hit) return hit;
    configProblems.push(`Default profile "${wanted}" is not configured; using "${PROFILES[0]?.name ?? CLI_PROFILE}".`);
  }
  // AZURE_AUTH=azure_cli keeps the az login identity as the default even when service principals exist.
  const auth = (envValue("AZURE_AUTH") ?? "").toLowerCase().replace(/-/g, "_");
  if (auth === "azure_cli" || auth === "cli") return PROFILES[PROFILES.length - 1];
  return PROFILES[0];
}

/** Match a profile by name (case-insensitive) or by tenant id. */
export function findProfile(ref: string): Profile | undefined {
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;
  return PROFILES.find((p) => p.name.toLowerCase() === needle) ?? PROFILES.find((p) => p.tenantId?.toLowerCase() === needle);
}

export const DEFAULT_PROFILE: Profile = resolveDefault();

const profileStore = new AsyncLocalStorage<Profile>();

/** The profile a `profile` argument names. Throws a message that lists what is configured. */
export function resolveProfile(ref: string | undefined): Profile {
  if (!ref) return DEFAULT_PROFILE;
  const hit = findProfile(ref);
  if (hit) return hit;
  throw new Error(`No tenant profile named "${ref}". Configured: ${PROFILES.map((p) => p.name).join(", ")}. Add one in Settings > Extensions > Azure, or call List_Tenant_Profiles.`);
}

export function withProfile<T>(profile: Profile, run: () => Promise<T>): Promise<T> {
  return profileStore.run(profile, run);
}

export function currentProfile(): Profile {
  return profileStore.getStore() ?? DEFAULT_PROFILE;
}

/** Profiles as anything user-facing may see them: no secret, client id shortened. */
export function describeProfiles(): { name: string; kind: ProfileKind; tenant_id: string | null; client_id: string | null; subscription_id: string | null; is_default: boolean }[] {
  return PROFILES.map((p) => ({
    name: p.name,
    kind: p.kind,
    tenant_id: p.tenantId ?? null,
    client_id: p.clientId ? `${p.clientId.slice(0, 8)}…` : null,
    subscription_id: p.subscriptionId ?? null,
    is_default: p === DEFAULT_PROFILE,
  }));
}

export const PROFILE_PARAM_DESCRIPTION =
  `Tenant profile to run as: a configured profile name or its tenant id. Omit for the default (${DEFAULT_PROFILE.name}). ` +
  `"${CLI_PROFILE}" is your own az login. List_Tenant_Profiles shows the configured profiles.`;
