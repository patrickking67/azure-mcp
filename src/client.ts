// HTTP clients for the four planes the tools reach: ARM, Microsoft Graph, Key Vault and Log Analytics.

import { azJson } from "./az.js";
import { authMode, getToken } from "./auth.js";
import { envValue } from "./env.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const ARM_BASE = "https://management.azure.com";
export const ARM_RESOURCE = "https://management.azure.com";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_BETA_BASE = "https://graph.microsoft.com/beta";
export const GRAPH_RESOURCE = "https://graph.microsoft.com";
export const LOG_ANALYTICS_BASE = "https://api.loganalytics.io/v1";
export const LOG_ANALYTICS_RESOURCE = "https://api.loganalytics.io";
export const KEY_VAULT_RESOURCE = "https://vault.azure.net";
export const KEY_VAULT_API_VERSION = "7.4";
export const MAX_PAGES = 20;

export class ArmApiError extends Error {
  constructor(readonly status: number, readonly statusText: string, readonly method: string, readonly path: string, readonly details: JsonValue) {
    super(`Azure ARM ${method} ${path} failed: ${status} ${statusText}: ${JSON.stringify(details)}`);
  }
}

// A scalar as text; objects, arrays and null become "" rather than "[object Object]" or a joined list.
export function textOf(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dig(value: JsonValue, ...keys: string[]): JsonValue {
  let current: JsonValue = value;
  for (const key of keys) {
    if (!isJsonObject(current)) return null;
    current = current[key] ?? null;
  }
  return current ?? null;
}

export const propsOf = (r: JsonObject): JsonObject => (isJsonObject(r.properties) ? r.properties : {});
export const skuNameOf = (r: JsonObject): JsonValue => dig(r, "sku", "name");
export const baseOf = (r: JsonObject): JsonObject => ({ id: r.id ?? null, name: r.name ?? null, location: r.location ?? null });

export function formatResult(value: JsonValue): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

type HttpResult = { status: number; statusText: string; ok: boolean; body: JsonValue };

export async function httpJson(url: URL, resource: string, method: string, body?: JsonValue, extraHeaders?: Record<string, string>): Promise<HttpResult> {
  const token = await getToken(resource);
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}`, ...(extraHeaders ?? {}) };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: JsonValue = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, statusText: response.statusText, ok: response.ok, body: parsed };
}

// When ARM rejects an api-version it lists the supported ones in the error; pick the newest stable and retry once.
function extractSupportedApiVersion(details: JsonValue, requested: string): string | undefined {
  const text = JSON.stringify(details ?? "");
  if (!/api[- ]?version|NoRegisteredProviderFound|InvalidResourceType/i.test(text)) return undefined;
  const versions = [...text.matchAll(/\d{4}-\d{2}-\d{2}(?:-preview)?/g)].map((m) => m[0]).filter((v) => v !== requested);
  if (versions.length === 0) return undefined;
  const stable = versions.filter((v) => !v.endsWith("-preview")).sort();
  const any = versions.sort();
  return stable.at(-1) ?? any.at(-1);
}

export type ArmOptions = { apiVersion: string; query?: Record<string, string | undefined>; method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: JsonValue };

export async function armRequest(path: string, options: ArmOptions): Promise<{ status: number; body: JsonValue }> {
  const method = options.method ?? "GET";
  const attempt = async (apiVersion: string): Promise<HttpResult> => {
    const url = new URL(path.startsWith("http") ? path : `${ARM_BASE}${path.startsWith("/") ? path : `/${path}`}`);
    if (url.origin !== ARM_BASE) throw new Error(`Refusing to send an ARM token to ${url.origin}.`);
    url.searchParams.set("api-version", apiVersion);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return httpJson(url, ARM_RESOURCE, method, options.body);
  };
  let result = await attempt(options.apiVersion);
  if (!result.ok && (result.status === 400 || result.status === 404)) {
    const alternative = extractSupportedApiVersion(result.body, options.apiVersion);
    if (alternative) result = await attempt(alternative);
  }
  if (!result.ok) throw new ArmApiError(result.status, result.statusText, method, path, result.body);
  return { status: result.status, body: result.body };
}

// Follows ARM `nextLink` pagination for {value:[], nextLink}.
export async function armCollect(path: string, options: ArmOptions): Promise<{ items: JsonObject[]; pages: number; truncated: boolean }> {
  const items: JsonObject[] = [];
  let next: string | undefined = path;
  let pages = 0;
  let truncated = false;
  while (next) {
    const { body }: { body: JsonValue } = await armRequest(next, pages === 0 ? options : { apiVersion: options.apiVersion });
    pages += 1;
    if (isJsonObject(body) && Array.isArray(body.value)) items.push(...body.value.filter(isJsonObject));
    const nl = isJsonObject(body) ? body.nextLink : undefined;
    next = typeof nl === "string" ? nl : undefined;
    if (pages >= MAX_PAGES && next) {
      truncated = true;
      break;
    }
  }
  return { items, pages, truncated };
}

// Follows `nextLink` / `@odata.nextLink` pagination on non-ARM endpoints (Graph, Key Vault).
export async function collectPaged(startUrl: string, resource: string, extraHeaders?: Record<string, string>): Promise<{ items: JsonObject[]; truncated: boolean }> {
  const items: JsonObject[] = [];
  let next: string | undefined = startUrl;
  let pages = 0;
  let truncated = false;
  const origin = new URL(startUrl).origin;
  while (next) {
    const url = new URL(next);
    if (url.origin !== origin) throw new Error(`Refusing to follow a nextLink to ${url.origin}.`);
    const result = await httpJson(url, resource, "GET", undefined, extraHeaders);
    if (!result.ok) throw new Error(`GET ${next} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    pages += 1;
    const body = result.body;
    if (isJsonObject(body) && Array.isArray(body.value)) items.push(...body.value.filter(isJsonObject));
    const nl = isJsonObject(body) ? (body["@odata.nextLink"] ?? body.nextLink) : undefined;
    next = typeof nl === "string" ? nl : undefined;
    if (pages >= MAX_PAGES && next) {
      truncated = true;
      break;
    }
  }
  return { items, truncated };
}

let cachedAccount: JsonObject | null = null;
export async function azAccountShow(): Promise<JsonObject | null> {
  if (cachedAccount) return cachedAccount;
  const account = (await azJson(["account", "show", "--output", "json"])) as JsonObject | null;
  cachedAccount = account;
  return account;
}

const soleSubscription = new Map<string, string>();
export async function resolveSubscription(subscriptionId?: string): Promise<string> {
  if (subscriptionId && subscriptionId.trim()) {
    const id = subscriptionId.trim();
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`subscription_id must be a subscription GUID, got '${id}'.`);
    return id;
  }
  const configured = envValue("AZURE_SUBSCRIPTION_ID");
  if (configured) return configured;
  const mode = authMode();
  if (mode !== "azure_cli") {
    const hit = soleSubscription.get(mode);
    if (hit) return hit;
    const { items } = await armCollect("/subscriptions", { apiVersion: "2022-12-01" });
    if (items.length === 1 && typeof items[0].subscriptionId === "string") {
      // On-behalf-of callers differ, so only the server's own identity is cached.
      if (mode !== "on_behalf_of") soleSubscription.set(mode, items[0].subscriptionId);
      return items[0].subscriptionId;
    }
    throw new Error(`This identity can reach ${items.length} subscriptions. Pass subscription_id (List_Subscriptions shows them) or set a default subscription id in the connector settings.`);
  }
  const account = await azAccountShow();
  const id = account?.id;
  if (typeof id === "string" && id) return id;
  throw new Error("No subscription. Pass subscription_id, set a default in the connector settings, or set one with `az account set`.");
}

/** Resource Graph query with $skipToken paging, bounded by maxRows. */
export async function resourceGraph(subscriptions: string[], query: string, maxRows = 5000): Promise<{ rows: JsonObject[]; truncated: boolean }> {
  const rows: JsonObject[] = [];
  let skipToken: string | undefined;
  do {
    const options: JsonObject = { resultFormat: "objectArray", $top: Math.min(1000, maxRows - rows.length) };
    if (skipToken) options.$skipToken = skipToken;
    const { body } = await armRequest("/providers/Microsoft.ResourceGraph/resources", {
      apiVersion: "2024-04-01",
      method: "POST",
      body: { subscriptions, query, options },
    });
    const data = isJsonObject(body) && Array.isArray(body.data) ? body.data.filter(isJsonObject) : [];
    rows.push(...data);
    skipToken = isJsonObject(body) && typeof body.$skipToken === "string" ? body.$skipToken : undefined;
  } while (skipToken && rows.length < maxRows);
  return { rows, truncated: Boolean(skipToken) };
}
