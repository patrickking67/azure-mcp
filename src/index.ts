#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const API_VERSION = "0.2.1";
const SERVER_NAME = "Azure";
const ARM_BASE = "https://management.azure.com";
const ARM_RESOURCE = "https://management.azure.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_RESOURCE = "https://graph.microsoft.com";
const LOG_ANALYTICS_BASE = "https://api.loganalytics.io/v1";
const LOG_ANALYTICS_RESOURCE = "https://api.loganalytics.io";
const KEY_VAULT_RESOURCE = "https://vault.azure.net";
const KEY_VAULT_API_VERSION = "7.4";
const MAX_PAGES = 20;
const LOGO_FILE = "azure-512.png";
const LOGO_MIME_TYPE = "image/png";
const LOGO_URI = "azure://assets/logo.png";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

class AzureCliError extends Error {}
class ArmApiError extends Error {
  constructor(readonly status: number, readonly statusText: string, readonly method: string, readonly path: string, readonly details: JsonValue) {
    super(`Azure ARM ${method} ${path} failed: ${status} ${statusText}: ${JSON.stringify(details)}`);
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const assetPath = (file: string) => join(moduleDir, "..", "assets", file);

function readServerIcons(): { src: string; mimeType: string; sizes: string[] }[] {
  const path = assetPath(LOGO_FILE);
  if (!existsSync(path)) return [];
  const data = readFileSync(path).toString("base64");
  return [{ src: `data:${LOGO_MIME_TYPE};base64,${data}`, mimeType: LOGO_MIME_TYPE, sizes: ["512x512"] }];
}

const server = new McpServer({ name: SERVER_NAME, title: SERVER_NAME, version: API_VERSION, icons: readServerIcons() });

if (existsSync(assetPath(LOGO_FILE))) {
  server.registerResource(
    "azure_logo",
    LOGO_URI,
    { title: "Azure Logo", description: "Microsoft Azure logo packaged with the local MCP server.", mimeType: LOGO_MIME_TYPE },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: LOGO_MIME_TYPE, blob: readFileSync(assetPath(LOGO_FILE)).toString("base64") }] }),
  );
}

// Populated as tools register; exposed as an MCP resource at the bottom of this file.
const apiReference: JsonObject[] = [];
function refEntry(tool: string, kind: "read" | "write", method: string, path: string, apiVersion: string): void {
  apiReference.push({ tool, kind, method, path, api_version: apiVersion });
}

// ---------- auth: service principal (optional) or Azure CLI passthrough ----------

// Hosts pass unset optional user_config through as the literal "${user_config.x}" placeholder; treat those as unset.
const envValue = (key: string): string | undefined => {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
};

const TENANT_ID = envValue("AZURE_TENANT_ID");
const CLIENT_ID = envValue("AZURE_CLIENT_ID");
const CLIENT_SECRET = envValue("AZURE_CLIENT_SECRET");
const SP_AUTH = Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);

function resolveAzBinary(): string {
  if (process.env.AZ_PATH && existsSync(process.env.AZ_PATH)) return process.env.AZ_PATH;
  for (const candidate of ["/opt/homebrew/bin/az", "/usr/local/bin/az", "/usr/bin/az"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "az"; // fall back to PATH
}

const AZ = resolveAzBinary();

type CachedToken = { token: string; expiresAtMs: number };
const tokenCache = new Map<string, CachedToken>();

async function azJson(args: string[]): Promise<JsonValue> {
  try {
    const { stdout } = await execFileAsync(AZ, args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout ? (JSON.parse(stdout) as JsonValue) : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AzureCliError(
      `Azure CLI '${AZ} ${args.join(" ")}' failed. Ensure the Azure CLI is installed and 'az login' has been run, ` +
        `or configure a service principal (tenant id, client id, client secret) in the connector settings. ` +
        `If az is not on PATH (common under GUI apps), set AZ_PATH. Underlying error: ${message}`,
    );
  }
}

async function getToken(resource: string): Promise<string> {
  const cached = tokenCache.get(resource);
  if (cached && cached.expiresAtMs - Date.now() > 120_000) return cached.token;
  if (SP_AUTH) {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID as string,
      client_secret: CLIENT_SECRET as string,
      scope: `${resource}/.default`,
    });
    const response = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = (await response.json()) as JsonObject;
    if (!response.ok || typeof body.access_token !== "string") {
      throw new Error(`Service principal token request for ${resource} failed (${response.status}): ${JSON.stringify(body)}`);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3000;
    tokenCache.set(resource, { token: body.access_token, expiresAtMs: Date.now() + expiresIn * 1000 });
    return body.access_token;
  }
  const args = ["account", "get-access-token", "--resource", resource, "--output", "json"];
  if (TENANT_ID) args.push("--tenant", TENANT_ID);
  const result = (await azJson(args)) as JsonObject | null;
  if (!result || typeof result.accessToken !== "string") {
    throw new AzureCliError(`Azure CLI did not return an access token for ${resource}.`);
  }
  const expiresAtMs = typeof result.expires_on === "number" ? result.expires_on * 1000 : Date.now() + 50 * 60 * 1000;
  tokenCache.set(resource, { token: result.accessToken, expiresAtMs });
  return result.accessToken;
}

let cachedAccount: JsonObject | null = null;
async function azAccountShow(): Promise<JsonObject | null> {
  if (cachedAccount) return cachedAccount;
  const account = (await azJson(["account", "show", "--output", "json"])) as JsonObject | null;
  cachedAccount = account;
  return account;
}

let cachedSpSubscription: string | null = null;
async function resolveSubscription(subscriptionId?: string): Promise<string> {
  if (subscriptionId && subscriptionId.trim()) return subscriptionId.trim();
  if (envValue("AZURE_SUBSCRIPTION_ID")) return envValue("AZURE_SUBSCRIPTION_ID") as string;
  if (SP_AUTH) {
    if (cachedSpSubscription) return cachedSpSubscription;
    const { items } = await armCollect("/subscriptions", { apiVersion: "2020-01-01" });
    if (items.length === 1 && typeof items[0].subscriptionId === "string") {
      cachedSpSubscription = items[0].subscriptionId;
      return cachedSpSubscription;
    }
    throw new Error(
      `The service principal can reach ${items.length} subscriptions. Pass subscription_id or set a default subscription id in the connector settings.`,
    );
  }
  const account = await azAccountShow();
  const id = account?.id;
  if (typeof id === "string" && id) return id;
  throw new Error("No subscription. Pass subscription_id, set a default in the connector settings, or set one with `az account set`.");
}

// ---------- HTTP clients (ARM, Graph, Key Vault, Log Analytics) ----------

type HttpResult = { status: number; statusText: string; ok: boolean; body: JsonValue };

async function httpJson(url: URL, resource: string, method: string, body?: JsonValue, extraHeaders?: Record<string, string>): Promise<HttpResult> {
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
      parsed = { raw: text } as JsonObject;
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

type ArmOptions = { apiVersion: string; query?: Record<string, string | undefined>; method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: JsonValue };

async function armRequest(path: string, options: ArmOptions): Promise<{ status: number; body: JsonValue }> {
  const method = options.method ?? "GET";
  const attempt = async (apiVersion: string): Promise<HttpResult> => {
    const url = new URL(path.startsWith("http") ? path : `${ARM_BASE}${path.startsWith("/") ? path : `/${path}`}`);
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

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dig(value: JsonValue, ...keys: string[]): JsonValue {
  let current: JsonValue = value;
  for (const key of keys) {
    if (!isJsonObject(current)) return null;
    current = current[key] ?? null;
  }
  return current ?? null;
}

// Follows ARM `nextLink` pagination for {value:[], nextLink}.
async function armCollect(path: string, options: ArmOptions): Promise<{ items: JsonObject[]; pages: number; truncated: boolean }> {
  const items: JsonObject[] = [];
  let next: string | undefined = path;
  let pages = 0;
  let truncated = false;
  while (next) {
    const { body }: { body: JsonValue } = await armRequest(next, pages === 0 ? options : { apiVersion: options.apiVersion });
    pages += 1;
    if (isJsonObject(body) && Array.isArray(body.value)) items.push(...(body.value as JsonValue[]).filter(isJsonObject));
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
async function collectPaged(startUrl: string, resource: string, extraHeaders?: Record<string, string>): Promise<{ items: JsonObject[]; truncated: boolean }> {
  const items: JsonObject[] = [];
  let next: string | undefined = startUrl;
  let pages = 0;
  let truncated = false;
  while (next) {
    const result = await httpJson(new URL(next), resource, "GET", undefined, extraHeaders);
    if (!result.ok) throw new Error(`GET ${next} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    pages += 1;
    const body = result.body;
    if (isJsonObject(body) && Array.isArray(body.value)) items.push(...(body.value as JsonValue[]).filter(isJsonObject));
    const nl = isJsonObject(body) ? (body["@odata.nextLink"] ?? body.nextLink) : undefined;
    next = typeof nl === "string" ? nl : undefined;
    if (pages >= MAX_PAGES && next) {
      truncated = true;
      break;
    }
  }
  return { items, truncated };
}

function formatResult(value: JsonValue): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const subscriptionSchema = {
  subscription_id: z.string().optional().describe("Azure subscription id. Omit to use the configured default or the az default subscription."),
};

const propsOf = (r: JsonObject): JsonObject => (isJsonObject(r.properties) ? r.properties : {});
const skuNameOf = (r: JsonObject): JsonValue => dig(r, "sku", "name");
const baseOf = (r: JsonObject): JsonObject => ({ id: r.id ?? null, name: r.name ?? null, location: r.location ?? null });

const KEY_VAULT_NAME = /^[A-Za-z0-9-]{3,24}$/;
const KEY_VAULT_SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;

// ---------- subscription-wide list tools (one GET per provider collection) ----------

type SubscriptionListSpec = {
  name: string;
  title: string;
  description: string;
  path: string;
  apiVersion: string;
  resultKey: string;
  query?: Record<string, string>;
  filter?: (item: JsonObject) => boolean;
  map: (item: JsonObject) => JsonObject;
};

function registerSubscriptionListTool(spec: SubscriptionListSpec): void {
  refEntry(spec.name, "read", "GET", `/subscriptions/{sub}${spec.path}`, spec.apiVersion);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: { ...subscriptionSchema },
      annotations: { ...READ_ANNOTATIONS, title: spec.title },
    },
    async ({ subscription_id }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`/subscriptions/${sub}${spec.path}`, { apiVersion: spec.apiVersion, query: spec.query });
      const mapped = (spec.filter ? items.filter(spec.filter) : items).map(spec.map);
      return formatResult({ subscription_id: sub, count: mapped.length, truncated, [spec.resultKey]: mapped });
    },
  );
}

const SUBSCRIPTION_LIST_TOOLS: SubscriptionListSpec[] = [
  {
    name: "List_Locations",
    title: "List Locations",
    description: "List Azure regions available to a subscription.",
    path: "/locations",
    apiVersion: "2022-12-01",
    resultKey: "locations",
    map: (r) => ({ name: r.name ?? null, display_name: r.displayName ?? null }),
  },
  {
    name: "List_Storage_Accounts",
    title: "List Storage Accounts",
    description: "List storage accounts in a subscription.",
    path: "/providers/Microsoft.Storage/storageAccounts",
    apiVersion: "2026-04-01",
    resultKey: "storage_accounts",
    map: (r) => ({ ...baseOf(r), kind: r.kind ?? null, sku: skuNameOf(r), access_tier: propsOf(r).accessTier ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Web_Apps",
    title: "List Web Apps",
    description: "List App Service web apps and function apps in a subscription.",
    path: "/providers/Microsoft.Web/sites",
    apiVersion: "2026-03-15",
    resultKey: "web_apps",
    map: (r) => ({ ...baseOf(r), kind: r.kind ?? null, state: propsOf(r).state ?? null, default_host_name: propsOf(r).defaultHostName ?? null, https_only: propsOf(r).httpsOnly ?? null }),
  },
  {
    name: "List_Function_Apps",
    title: "List Function Apps",
    description: "List Azure Functions apps in a subscription.",
    path: "/providers/Microsoft.Web/sites",
    apiVersion: "2026-03-15",
    resultKey: "function_apps",
    filter: (r) => typeof r.kind === "string" && r.kind.includes("functionapp"),
    map: (r) => ({ ...baseOf(r), kind: r.kind ?? null, state: propsOf(r).state ?? null, default_host_name: propsOf(r).defaultHostName ?? null }),
  },
  {
    name: "List_App_Service_Plans",
    title: "List App Service Plans",
    description: "List App Service plans in a subscription.",
    path: "/providers/Microsoft.Web/serverfarms",
    apiVersion: "2023-12-01",
    resultKey: "app_service_plans",
    map: (r) => ({ ...baseOf(r), kind: r.kind ?? null, sku: skuNameOf(r), number_of_sites: propsOf(r).numberOfSites ?? null, status: propsOf(r).status ?? null }),
  },
  {
    name: "List_Static_Web_Apps",
    title: "List Static Web Apps",
    description: "List Static Web Apps in a subscription.",
    path: "/providers/Microsoft.Web/staticSites",
    apiVersion: "2023-12-01",
    resultKey: "static_web_apps",
    map: (r) => ({ ...baseOf(r), sku: skuNameOf(r), default_hostname: propsOf(r).defaultHostname ?? null, repository_url: propsOf(r).repositoryUrl ?? null }),
  },
  {
    name: "List_SQL_Servers",
    title: "List SQL Servers",
    description: "List Azure SQL logical servers in a subscription.",
    path: "/providers/Microsoft.Sql/servers",
    apiVersion: "2025-01-01",
    resultKey: "sql_servers",
    map: (r) => ({ ...baseOf(r), fully_qualified_domain_name: propsOf(r).fullyQualifiedDomainName ?? null, version: propsOf(r).version ?? null, state: propsOf(r).state ?? null, administrator_login: propsOf(r).administratorLogin ?? null }),
  },
  {
    name: "List_Cosmos_DB_Accounts",
    title: "List Cosmos DB Accounts",
    description: "List Azure Cosmos DB database accounts in a subscription.",
    path: "/providers/Microsoft.DocumentDB/databaseAccounts",
    apiVersion: "2023-11-15",
    resultKey: "cosmos_db_accounts",
    map: (r) => ({ ...baseOf(r), kind: r.kind ?? null, document_endpoint: propsOf(r).documentEndpoint ?? null, offer_type: propsOf(r).databaseAccountOfferType ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_PostgreSQL_Servers",
    title: "List PostgreSQL Servers",
    description: "List Azure Database for PostgreSQL flexible servers in a subscription.",
    path: "/providers/Microsoft.DBforPostgreSQL/flexibleServers",
    apiVersion: "2022-12-01",
    resultKey: "postgresql_servers",
    map: (r) => ({ ...baseOf(r), version: propsOf(r).version ?? null, state: propsOf(r).state ?? null, fqdn: propsOf(r).fullyQualifiedDomainName ?? null, sku: skuNameOf(r) }),
  },
  {
    name: "List_MySQL_Servers",
    title: "List MySQL Servers",
    description: "List Azure Database for MySQL flexible servers in a subscription.",
    path: "/providers/Microsoft.DBforMySQL/flexibleServers",
    apiVersion: "2023-06-30",
    resultKey: "mysql_servers",
    map: (r) => ({ ...baseOf(r), version: propsOf(r).version ?? null, state: propsOf(r).state ?? null, fqdn: propsOf(r).fullyQualifiedDomainName ?? null, sku: skuNameOf(r) }),
  },
  {
    name: "List_Redis_Caches",
    title: "List Redis Caches",
    description: "List Azure Cache for Redis instances in a subscription.",
    path: "/providers/Microsoft.Cache/redis",
    apiVersion: "2023-08-01",
    resultKey: "redis_caches",
    map: (r) => ({ ...baseOf(r), host_name: propsOf(r).hostName ?? null, ssl_port: propsOf(r).sslPort ?? null, sku: dig(propsOf(r), "sku", "name"), redis_version: propsOf(r).redisVersion ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Key_Vaults",
    title: "List Key Vaults",
    description: "List key vaults in a subscription.",
    path: "/providers/Microsoft.KeyVault/vaults",
    apiVersion: "2026-02-01",
    resultKey: "key_vaults",
    map: (r) => ({ ...baseOf(r), vault_uri: propsOf(r).vaultUri ?? null, sku: dig(propsOf(r), "sku", "name"), tenant_id: propsOf(r).tenantId ?? null, enable_rbac_authorization: propsOf(r).enableRbacAuthorization ?? null }),
  },
  {
    name: "List_AKS_Clusters",
    title: "List AKS Clusters",
    description: "List AKS managed clusters in a subscription.",
    path: "/providers/Microsoft.ContainerService/managedClusters",
    apiVersion: "2026-04-01",
    resultKey: "aks_clusters",
    map: (r) => ({ ...baseOf(r), kubernetes_version: propsOf(r).kubernetesVersion ?? null, provisioning_state: propsOf(r).provisioningState ?? null, power_state: dig(propsOf(r), "powerState", "code"), fqdn: propsOf(r).fqdn ?? null, node_resource_group: propsOf(r).nodeResourceGroup ?? null }),
  },
  {
    name: "List_Container_Registries",
    title: "List Container Registries",
    description: "List Azure Container Registry instances in a subscription.",
    path: "/providers/Microsoft.ContainerRegistry/registries",
    apiVersion: "2023-07-01",
    resultKey: "container_registries",
    map: (r) => ({ ...baseOf(r), login_server: propsOf(r).loginServer ?? null, sku: skuNameOf(r), admin_user_enabled: propsOf(r).adminUserEnabled ?? null }),
  },
  {
    name: "List_Container_Apps",
    title: "List Container Apps",
    description: "List Azure Container Apps in a subscription.",
    path: "/providers/Microsoft.App/containerApps",
    apiVersion: "2024-03-01",
    resultKey: "container_apps",
    map: (r) => ({ ...baseOf(r), fqdn: dig(propsOf(r), "configuration", "ingress", "fqdn"), environment_id: propsOf(r).environmentId ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Container_Instances",
    title: "List Container Instances",
    description: "List Azure Container Instances container groups in a subscription.",
    path: "/providers/Microsoft.ContainerInstance/containerGroups",
    apiVersion: "2023-05-01",
    resultKey: "container_groups",
    map: (r) => ({ ...baseOf(r), os_type: propsOf(r).osType ?? null, ip_address: dig(propsOf(r), "ipAddress", "ip"), provisioning_state: propsOf(r).provisioningState ?? null, container_count: Array.isArray(propsOf(r).containers) ? (propsOf(r).containers as JsonValue[]).length : null }),
  },
  {
    name: "List_Disks",
    title: "List Disks",
    description: "List managed disks in a subscription.",
    path: "/providers/Microsoft.Compute/disks",
    apiVersion: "2026-03-02",
    resultKey: "disks",
    map: (r) => ({ ...baseOf(r), sku: skuNameOf(r), size_gb: propsOf(r).diskSizeGB ?? null, disk_state: propsOf(r).diskState ?? null, os_type: propsOf(r).osType ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Snapshots",
    title: "List Snapshots",
    description: "List managed disk snapshots in a subscription.",
    path: "/providers/Microsoft.Compute/snapshots",
    apiVersion: "2023-04-02",
    resultKey: "snapshots",
    map: (r) => ({ ...baseOf(r), size_gb: propsOf(r).diskSizeGB ?? null, os_type: propsOf(r).osType ?? null, time_created: propsOf(r).timeCreated ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_VM_Images",
    title: "List VM Images",
    description: "List custom VM images in a subscription.",
    path: "/providers/Microsoft.Compute/images",
    apiVersion: "2023-07-01",
    resultKey: "vm_images",
    map: (r) => ({ ...baseOf(r), provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_VM_Scale_Sets",
    title: "List VM Scale Sets",
    description: "List virtual machine scale sets in a subscription.",
    path: "/providers/Microsoft.Compute/virtualMachineScaleSets",
    apiVersion: "2023-07-01",
    resultKey: "vm_scale_sets",
    map: (r) => ({ ...baseOf(r), sku: skuNameOf(r), capacity: dig(r, "sku", "capacity"), orchestration_mode: propsOf(r).orchestrationMode ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Public_IPs",
    title: "List Public IPs",
    description: "List public IP addresses in a subscription.",
    path: "/providers/Microsoft.Network/publicIPAddresses",
    apiVersion: "2026-01-01",
    resultKey: "public_ips",
    map: (r) => ({ ...baseOf(r), ip_address: propsOf(r).ipAddress ?? null, allocation_method: propsOf(r).publicIPAllocationMethod ?? null, sku: skuNameOf(r), provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Network_Security_Groups",
    title: "List Network Security Groups",
    description: "List network security groups in a subscription.",
    path: "/providers/Microsoft.Network/networkSecurityGroups",
    apiVersion: "2026-01-01",
    resultKey: "network_security_groups",
    map: (r) => ({ ...baseOf(r), security_rule_count: Array.isArray(propsOf(r).securityRules) ? (propsOf(r).securityRules as JsonValue[]).length : 0, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Virtual_Networks",
    title: "List Virtual Networks",
    description: "List virtual networks in a subscription.",
    path: "/providers/Microsoft.Network/virtualNetworks",
    apiVersion: "2026-01-01",
    resultKey: "virtual_networks",
    map: (r) => ({
      ...baseOf(r),
      address_prefixes: dig(propsOf(r), "addressSpace", "addressPrefixes") ?? [],
      subnets: Array.isArray(propsOf(r).subnets) ? (propsOf(r).subnets as JsonValue[]).filter(isJsonObject).map((s) => s.name ?? null) : [],
      provisioning_state: propsOf(r).provisioningState ?? null,
    }),
  },
  {
    name: "List_Network_Interfaces",
    title: "List Network Interfaces",
    description: "List network interfaces (NICs) in a subscription.",
    path: "/providers/Microsoft.Network/networkInterfaces",
    apiVersion: "2023-09-01",
    resultKey: "network_interfaces",
    map: (r) => ({
      ...baseOf(r),
      mac_address: propsOf(r).macAddress ?? null,
      private_ips: Array.isArray(propsOf(r).ipConfigurations)
        ? (propsOf(r).ipConfigurations as JsonValue[]).filter(isJsonObject).map((c) => dig(propsOf(c), "privateIPAddress"))
        : [],
      attached_vm: dig(propsOf(r), "virtualMachine", "id"),
    }),
  },
  {
    name: "List_Load_Balancers",
    title: "List Load Balancers",
    description: "List load balancers in a subscription.",
    path: "/providers/Microsoft.Network/loadBalancers",
    apiVersion: "2023-09-01",
    resultKey: "load_balancers",
    map: (r) => ({
      ...baseOf(r),
      sku: skuNameOf(r),
      frontend_count: Array.isArray(propsOf(r).frontendIPConfigurations) ? (propsOf(r).frontendIPConfigurations as JsonValue[]).length : 0,
      backend_pool_count: Array.isArray(propsOf(r).backendAddressPools) ? (propsOf(r).backendAddressPools as JsonValue[]).length : 0,
    }),
  },
  {
    name: "List_Application_Gateways",
    title: "List Application Gateways",
    description: "List application gateways in a subscription.",
    path: "/providers/Microsoft.Network/applicationGateways",
    apiVersion: "2023-09-01",
    resultKey: "application_gateways",
    map: (r) => ({ ...baseOf(r), sku: dig(propsOf(r), "sku", "name"), operational_state: propsOf(r).operationalState ?? null, provisioning_state: propsOf(r).provisioningState ?? null }),
  },
  {
    name: "List_Route_Tables",
    title: "List Route Tables",
    description: "List route tables in a subscription.",
    path: "/providers/Microsoft.Network/routeTables",
    apiVersion: "2023-09-01",
    resultKey: "route_tables",
    map: (r) => ({
      ...baseOf(r),
      route_count: Array.isArray(propsOf(r).routes) ? (propsOf(r).routes as JsonValue[]).length : 0,
      subnet_count: Array.isArray(propsOf(r).subnets) ? (propsOf(r).subnets as JsonValue[]).length : 0,
    }),
  },
  {
    name: "List_DNS_Zones",
    title: "List DNS Zones",
    description: "List public and private DNS zones in a subscription.",
    path: "/providers/Microsoft.Network/dnszones",
    apiVersion: "2018-05-01",
    resultKey: "dns_zones",
    map: (r) => ({ ...baseOf(r), record_sets: propsOf(r).numberOfRecordSets ?? null, name_servers: propsOf(r).nameServers ?? null, zone_type: propsOf(r).zoneType ?? null }),
  },
  {
    name: "List_Private_Endpoints",
    title: "List Private Endpoints",
    description: "List private endpoints in a subscription.",
    path: "/providers/Microsoft.Network/privateEndpoints",
    apiVersion: "2023-09-01",
    resultKey: "private_endpoints",
    map: (r) => ({
      ...baseOf(r),
      subnet: dig(propsOf(r), "subnet", "id"),
      connections: Array.isArray(propsOf(r).privateLinkServiceConnections)
        ? (propsOf(r).privateLinkServiceConnections as JsonValue[]).filter(isJsonObject).map((c) => c.name ?? null)
        : [],
    }),
  },
  {
    name: "List_Managed_Identities",
    title: "List Managed Identities",
    description: "List user-assigned managed identities in a subscription.",
    path: "/providers/Microsoft.ManagedIdentity/userAssignedIdentities",
    apiVersion: "2023-01-31",
    resultKey: "managed_identities",
    map: (r) => ({ ...baseOf(r), client_id: propsOf(r).clientId ?? null, principal_id: propsOf(r).principalId ?? null }),
  },
  {
    name: "List_Log_Analytics_Workspaces",
    title: "List Log Analytics Workspaces",
    description: "List Log Analytics workspaces in a subscription. The workspace customer_id is what Query Log Analytics expects.",
    path: "/providers/Microsoft.OperationalInsights/workspaces",
    apiVersion: "2022-10-01",
    resultKey: "log_analytics_workspaces",
    map: (r) => ({ ...baseOf(r), customer_id: propsOf(r).customerId ?? null, sku: dig(propsOf(r), "sku", "name"), retention_days: propsOf(r).retentionInDays ?? null }),
  },
  {
    name: "List_Application_Insights",
    title: "List Application Insights",
    description: "List Application Insights components in a subscription.",
    path: "/providers/Microsoft.Insights/components",
    apiVersion: "2020-02-02",
    resultKey: "application_insights",
    map: (r) => ({ ...baseOf(r), app_id: propsOf(r).AppId ?? null, application_type: propsOf(r).Application_Type ?? null, workspace: propsOf(r).WorkspaceResourceId ?? null }),
  },
  {
    name: "List_Event_Hub_Namespaces",
    title: "List Event Hub Namespaces",
    description: "List Event Hubs namespaces in a subscription.",
    path: "/providers/Microsoft.EventHub/namespaces",
    apiVersion: "2024-01-01",
    resultKey: "event_hub_namespaces",
    map: (r) => ({ ...baseOf(r), sku: skuNameOf(r), endpoint: propsOf(r).serviceBusEndpoint ?? null, status: propsOf(r).status ?? null }),
  },
  {
    name: "List_Service_Bus_Namespaces",
    title: "List Service Bus Namespaces",
    description: "List Service Bus namespaces in a subscription.",
    path: "/providers/Microsoft.ServiceBus/namespaces",
    apiVersion: "2021-11-01",
    resultKey: "service_bus_namespaces",
    map: (r) => ({ ...baseOf(r), sku: skuNameOf(r), endpoint: propsOf(r).serviceBusEndpoint ?? null, status: propsOf(r).status ?? null }),
  },
  {
    name: "List_Alert_Rules",
    title: "List Alert Rules",
    description: "List metric alert rules configured in a subscription.",
    path: "/providers/Microsoft.Insights/metricAlerts",
    apiVersion: "2018-03-01",
    resultKey: "alert_rules",
    map: (r) => ({ id: r.id ?? null, name: r.name ?? null, enabled: propsOf(r).enabled ?? null, severity: propsOf(r).severity ?? null, scopes: propsOf(r).scopes ?? null, description: propsOf(r).description ?? null }),
  },
  {
    name: "List_Fired_Alerts",
    title: "List Fired Alerts",
    description: "List alerts fired across Azure Monitor for a subscription (Alerts Management).",
    path: "/providers/Microsoft.AlertsManagement/alerts",
    apiVersion: "2019-03-01",
    resultKey: "fired_alerts",
    map: (r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      severity: dig(propsOf(r), "essentials", "severity"),
      alert_state: dig(propsOf(r), "essentials", "alertState"),
      monitor_condition: dig(propsOf(r), "essentials", "monitorCondition"),
      monitor_service: dig(propsOf(r), "essentials", "monitorService"),
      target_resource: dig(propsOf(r), "essentials", "targetResource"),
      start_time: dig(propsOf(r), "essentials", "startDateTime"),
    }),
  },
  {
    name: "List_Security_Alerts",
    title: "List Security Alerts",
    description: "List Microsoft Defender for Cloud security alerts in a subscription.",
    path: "/providers/Microsoft.Security/alerts",
    apiVersion: "2022-01-01",
    resultKey: "security_alerts",
    map: (r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      display_name: propsOf(r).alertDisplayName ?? null,
      severity: propsOf(r).severity ?? null,
      status: propsOf(r).status ?? null,
      compromised_entity: propsOf(r).compromisedEntity ?? null,
      time_generated: propsOf(r).timeGeneratedUtc ?? null,
    }),
  },
  {
    name: "List_Secure_Scores",
    title: "List Secure Scores",
    description: "List Microsoft Defender for Cloud secure scores for a subscription.",
    path: "/providers/Microsoft.Security/secureScores",
    apiVersion: "2020-01-01",
    resultKey: "secure_scores",
    map: (r) => ({ name: r.name ?? null, display_name: propsOf(r).displayName ?? null, score_current: dig(propsOf(r), "score", "current"), score_max: dig(propsOf(r), "score", "max"), score_percentage: dig(propsOf(r), "score", "percentage") }),
  },
  {
    name: "List_Policy_Assignments",
    title: "List Policy Assignments",
    description: "List Azure Policy assignments in a subscription.",
    path: "/providers/Microsoft.Authorization/policyAssignments",
    apiVersion: "2022-06-01",
    resultKey: "policy_assignments",
    map: (r) => ({ id: r.id ?? null, name: r.name ?? null, display_name: propsOf(r).displayName ?? null, policy_definition_id: propsOf(r).policyDefinitionId ?? null, scope: propsOf(r).scope ?? null, enforcement_mode: propsOf(r).enforcementMode ?? null }),
  },
  {
    name: "List_Budgets",
    title: "List Budgets",
    description: "List Cost Management budgets for a subscription.",
    path: "/providers/Microsoft.Consumption/budgets",
    apiVersion: "2023-05-01",
    resultKey: "budgets",
    map: (r) => ({ id: r.id ?? null, name: r.name ?? null, amount: propsOf(r).amount ?? null, time_grain: propsOf(r).timeGrain ?? null, current_spend: dig(propsOf(r), "currentSpend", "amount"), category: propsOf(r).category ?? null }),
  },
];

for (const spec of SUBSCRIPTION_LIST_TOOLS) registerSubscriptionListTool(spec);

// ---------- core / connection ----------

refEntry("Test_Connection", "read", "GET", "/subscriptions", "2020-01-01");
server.registerTool(
  "Test_Connection",
  {
    title: "Test Connection",
    description: "Check Azure authentication (service principal or Azure CLI) and report the identity and reachable subscriptions.",
    inputSchema: {},
    annotations: { ...READ_ANNOTATIONS, title: "Test Connection" },
  },
  async () => {
    const account = SP_AUTH ? null : await azAccountShow();
    const { items } = await armCollect("/subscriptions", { apiVersion: "2020-01-01" });
    return formatResult({
      ok: true,
      auth_mode: SP_AUTH ? "service_principal" : "azure_cli",
      signed_in_user: account?.user ?? (SP_AUTH ? { type: "servicePrincipal", client_id: CLIENT_ID ?? null } : null),
      tenant_id: TENANT_ID ?? account?.tenantId ?? null,
      default_subscription: envValue("AZURE_SUBSCRIPTION_ID") ?? account?.id ?? null,
      subscription_count: items.length,
    });
  },
);

refEntry("List_Subscriptions", "read", "GET", "/subscriptions", "2020-01-01");
server.registerTool(
  "List_Subscriptions",
  {
    title: "List Subscriptions",
    description: "List subscriptions the signed-in identity can access.",
    inputSchema: {},
    annotations: { ...READ_ANNOTATIONS, title: "List Subscriptions" },
  },
  async () => {
    const { items } = await armCollect("/subscriptions", { apiVersion: "2020-01-01" });
    const subs = items.map((s) => ({ id: s.subscriptionId ?? null, name: s.displayName ?? null, state: s.state ?? null, tenant_id: s.tenantId ?? null }));
    return formatResult({ count: subs.length, subscriptions: subs });
  },
);

refEntry("List_Resource_Groups", "read", "GET", "/subscriptions/{sub}/resourcegroups", "2021-04-01");
server.registerTool(
  "List_Resource_Groups",
  {
    title: "List Resource Groups",
    description: "List resource groups in a subscription.",
    inputSchema: { ...subscriptionSchema },
    annotations: { ...READ_ANNOTATIONS, title: "List Resource Groups" },
  },
  async ({ subscription_id }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/resourcegroups`, { apiVersion: "2021-04-01" });
    const groups = items.map((g) => ({ name: g.name ?? null, location: g.location ?? null, provisioning_state: dig(propsOf(g), "provisioningState"), tags: g.tags ?? null }));
    return formatResult({ subscription_id: sub, count: groups.length, truncated, resource_groups: groups });
  },
);

refEntry("List_Resources", "read", "GET", "/subscriptions/{sub}/resources", "2021-04-01");
server.registerTool(
  "List_Resources",
  {
    title: "List Resources",
    description: "List resources in a subscription, optionally filtered by type or resource group.",
    inputSchema: {
      ...subscriptionSchema,
      resource_type: z.string().optional().describe("Filter by ARM type, e.g. 'Microsoft.Compute/virtualMachines'."),
      resource_group: z.string().optional().describe("Filter by resource group name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Resources" },
  },
  async ({ subscription_id, resource_type, resource_group }) => {
    const sub = await resolveSubscription(subscription_id);
    const base = resource_group ? `/subscriptions/${sub}/resourceGroups/${resource_group}/resources` : `/subscriptions/${sub}/resources`;
    const query: Record<string, string | undefined> = {};
    if (resource_type) query.$filter = `resourceType eq '${resource_type}'`;
    const { items, truncated } = await armCollect(base, { apiVersion: "2021-04-01", query });
    const resources = items.map((r) => ({ id: r.id ?? null, name: r.name ?? null, type: r.type ?? null, location: r.location ?? null, kind: r.kind ?? null, tags: r.tags ?? null }));
    return formatResult({ subscription_id: sub, count: resources.length, truncated, resources });
  },
);

refEntry("Get_Resource", "read", "GET", "(full ARM resource id)", "(auto-negotiated)");
server.registerTool(
  "Get_Resource",
  {
    title: "Get Resource",
    description: "Get any resource by its full ARM resource id. The api-version is negotiated automatically unless provided.",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id (starts with /subscriptions/...)."),
      api_version: z.string().optional().describe("Optional ARM api-version. If omitted or wrong, the supported version is auto-negotiated."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get Resource" },
  },
  async ({ resource_id, api_version }) => {
    if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
    const { body } = await armRequest(resource_id, { apiVersion: api_version ?? "2021-04-01" });
    return formatResult(body);
  },
);

// ---------- compute ----------

refEntry("List_Virtual_Machines", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.Compute/virtualMachines", "2023-07-01");
server.registerTool(
  "List_Virtual_Machines",
  {
    title: "List Virtual Machines",
    description: "List virtual machines in a subscription, optionally with power state.",
    inputSchema: {
      ...subscriptionSchema,
      power_state: z.boolean().optional().describe("Also fetch per-VM power state via instanceView. Adds one call per VM."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Virtual Machines" },
  },
  async ({ subscription_id, power_state }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines`, { apiVersion: "2023-07-01" });
    const vms = [] as JsonObject[];
    for (const vm of items) {
      const props = propsOf(vm);
      const entry: JsonObject = {
        id: vm.id ?? null,
        name: vm.name ?? null,
        location: vm.location ?? null,
        vm_size: dig(props, "hardwareProfile", "vmSize"),
        os_type: dig(props, "storageProfile", "osDisk", "osType"),
      };
      if (power_state && typeof vm.id === "string") {
        try {
          const { body } = await armRequest(`${vm.id}/instanceView`, { apiVersion: "2023-07-01" });
          const statuses = isJsonObject(body) && Array.isArray(body.statuses) ? (body.statuses as JsonValue[]) : [];
          const power = statuses.filter(isJsonObject).map((s) => String(s.code ?? "")).find((c) => c.startsWith("PowerState/"));
          entry.power_state = power ? power.replace("PowerState/", "") : "unknown";
        } catch {
          entry.power_state = "unavailable";
        }
      }
      vms.push(entry);
    }
    return formatResult({ subscription_id: sub, count: vms.length, truncated, virtual_machines: vms });
  },
);

refEntry("Get_Virtual_Machine", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}", "2026-03-01");
server.registerTool(
  "Get_Virtual_Machine",
  {
    title: "Get Virtual Machine",
    description: "Get a virtual machine with its configuration and current power state.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the VM."),
      vm_name: z.string().describe("VM name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get Virtual Machine" },
  },
  async ({ subscription_id, resource_group, vm_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}`, {
      apiVersion: "2026-03-01",
      query: { $expand: "instanceView" },
    });
    const vm = isJsonObject(body) ? body : {};
    const props = propsOf(vm);
    const statuses = Array.isArray(dig(props, "instanceView", "statuses")) ? (dig(props, "instanceView", "statuses") as JsonValue[]).filter(isJsonObject) : [];
    const power = statuses.map((s) => String(s.code ?? "")).find((c) => c.startsWith("PowerState/"));
    return formatResult({
      id: vm.id ?? null,
      name: vm.name ?? null,
      location: vm.location ?? null,
      vm_size: dig(props, "hardwareProfile", "vmSize"),
      os_type: dig(props, "storageProfile", "osDisk", "osType"),
      provisioning_state: props.provisioningState ?? null,
      power_state: power ? power.replace("PowerState/", "") : "unknown",
      tags: vm.tags ?? null,
    });
  },
);

// ---------- health / governance ----------

refEntry("Resource_Health", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses", "2020-05-01");
server.registerTool(
  "Resource_Health",
  {
    title: "Resource Health",
    description: "Report availability status for resources in a subscription.",
    inputSchema: { ...subscriptionSchema },
    annotations: { ...READ_ANNOTATIONS, title: "Resource Health" },
  },
  async ({ subscription_id }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.ResourceHealth/availabilityStatuses`, { apiVersion: "2020-05-01" });
    const statuses = items.map((s) => {
      const props = propsOf(s);
      return { target: s.id ?? null, availability_state: props.availabilityState ?? null, summary: props.summary ?? null, occurred: props.occuredTime ?? null };
    });
    const rollup: Record<string, number> = {};
    for (const s of statuses) {
      const state = typeof s.availability_state === "string" ? s.availability_state : "Unknown";
      rollup[state] = (rollup[state] ?? 0) + 1;
    }
    return formatResult({ subscription_id: sub, count: statuses.length, truncated, rollup, statuses });
  },
);

refEntry("List_Advisor_Recommendations", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.Advisor/recommendations", "2023-01-01");
server.registerTool(
  "List_Advisor_Recommendations",
  {
    title: "List Advisor Recommendations",
    description: "List Azure Advisor recommendations for a subscription, optionally filtered by category.",
    inputSchema: {
      ...subscriptionSchema,
      category: z.enum(["Cost", "HighAvailability", "Performance", "Security", "OperationalExcellence"]).optional().describe("Optional Advisor category filter."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Advisor Recommendations" },
  },
  async ({ subscription_id, category }) => {
    const sub = await resolveSubscription(subscription_id);
    const query: Record<string, string | undefined> = {};
    if (category) query.$filter = `Category eq '${category}'`;
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Advisor/recommendations`, { apiVersion: "2023-01-01", query });
    const recommendations = items.map((r) => {
      const props = propsOf(r);
      return {
        id: r.id ?? null,
        category: props.category ?? null,
        impact: props.impact ?? null,
        problem: dig(props, "shortDescription", "problem"),
        solution: dig(props, "shortDescription", "solution"),
        impacted_resource: props.impactedValue ?? null,
        impacted_type: props.impactedField ?? null,
      };
    });
    return formatResult({ subscription_id: sub, count: recommendations.length, truncated, recommendations });
  },
);

refEntry("List_Role_Assignments", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.Authorization/roleAssignments", "2022-04-01");
server.registerTool(
  "List_Role_Assignments",
  {
    title: "List Role Assignments",
    description: "List role assignments in a subscription.",
    inputSchema: {
      ...subscriptionSchema,
      filter: z.string().optional().describe("Optional OData $filter, e.g. \"principalId eq '{guid}'\" or \"atScope()\"."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Role Assignments" },
  },
  async ({ subscription_id, filter }) => {
    const sub = await resolveSubscription(subscription_id);
    const query: Record<string, string | undefined> = {};
    if (filter) query.$filter = filter;
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Authorization/roleAssignments`, { apiVersion: "2022-04-01", query });
    const assignments = items.map((r) => {
      const props = propsOf(r);
      return { id: r.id ?? null, name: r.name ?? null, role_definition_id: props.roleDefinitionId ?? null, principal_id: props.principalId ?? null, principal_type: props.principalType ?? null, scope: props.scope ?? null, created_on: props.createdOn ?? null };
    });
    return formatResult({ subscription_id: sub, count: assignments.length, truncated, role_assignments: assignments });
  },
);

refEntry("List_Role_Definitions", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.Authorization/roleDefinitions", "2022-04-01");
server.registerTool(
  "List_Role_Definitions",
  {
    title: "List Role Definitions",
    description: "List RBAC role definitions visible at subscription scope, optionally custom roles only.",
    inputSchema: {
      ...subscriptionSchema,
      custom_only: z.boolean().optional().describe("Only return custom roles."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Role Definitions" },
  },
  async ({ subscription_id, custom_only }) => {
    const sub = await resolveSubscription(subscription_id);
    const query: Record<string, string | undefined> = {};
    if (custom_only) query.$filter = "type eq 'CustomRole'";
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions`, { apiVersion: "2022-04-01", query });
    const roles = items.map((r) => {
      const props = propsOf(r);
      return { id: r.id ?? null, name: r.name ?? null, role_name: props.roleName ?? null, type: props.type ?? null, description: props.description ?? null };
    });
    return formatResult({ subscription_id: sub, count: roles.length, truncated, role_definitions: roles });
  },
);

refEntry("List_Activity_Log", "read", "GET", "/subscriptions/{sub}/providers/Microsoft.Insights/eventtypes/management/values", "2015-04-01");
server.registerTool(
  "List_Activity_Log",
  {
    title: "List Activity Log",
    description: "List activity log events in a subscription from a start time.",
    inputSchema: {
      ...subscriptionSchema,
      start_time: z.string().describe("Start of the window as an ISO 8601 timestamp, e.g. 2026-07-01T00:00:00Z. The activity log retains 90 days."),
      end_time: z.string().optional().describe("Optional end of the window as an ISO 8601 timestamp. Defaults to now."),
      resource_group: z.string().optional().describe("Optional resource group name to scope events."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Activity Log" },
  },
  async ({ subscription_id, start_time, end_time, resource_group }) => {
    const sub = await resolveSubscription(subscription_id);
    let filter = `eventTimestamp ge '${start_time}'`;
    if (end_time) filter += ` and eventTimestamp le '${end_time}'`;
    if (resource_group) filter += ` and resourceGroupName eq '${resource_group}'`;
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Insights/eventtypes/management/values`, { apiVersion: "2015-04-01", query: { $filter: filter } });
    const events = items.map((e) => {
      const operation = isJsonObject(e.operationName) ? e.operationName.localizedValue ?? e.operationName.value ?? null : null;
      const status = isJsonObject(e.status) ? e.status.value ?? null : null;
      return { event_timestamp: e.eventTimestamp ?? null, operation_name: operation, status, level: e.level ?? null, resource_group: e.resourceGroupName ?? null, resource_id: e.resourceId ?? null, caller: e.caller ?? null, correlation_id: e.correlationId ?? null };
    });
    return formatResult({ subscription_id: sub, start_time, end_time: end_time ?? null, count: events.length, truncated, events });
  },
);

refEntry("Resource_Graph_Query", "read", "POST", "/providers/Microsoft.ResourceGraph/resources", "2024-04-01");
server.registerTool(
  "Resource_Graph_Query",
  {
    title: "Resource Graph Query",
    description: "Run a Resource Graph (KQL) query across subscription resources.",
    inputSchema: {
      ...subscriptionSchema,
      query: z.string().describe("Resource Graph KQL query, e.g. \"Resources | project name, type | limit 5\"."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Resource Graph Query" },
  },
  async ({ subscription_id, query }) => {
    const sub = await resolveSubscription(subscription_id);
    const { body } = await armRequest(`/providers/Microsoft.ResourceGraph/resources`, {
      apiVersion: "2024-04-01",
      method: "POST",
      body: { subscriptions: [sub], query },
    });
    const result = isJsonObject(body) ? body : {};
    return formatResult({
      subscription_id: sub,
      count: result.count ?? null,
      total_records: result.totalRecords ?? null,
      result_truncated: result.resultTruncated ?? null,
      skip_token: result.$skipToken ?? null,
      data: result.data ?? null,
    });
  },
);

// ---------- scoped list tools (resource group / parent resource) ----------

refEntry("List_SQL_Databases", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{server}/databases", "2025-01-01");
server.registerTool(
  "List_SQL_Databases",
  {
    title: "List SQL Databases",
    description: "List databases on an Azure SQL server.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the SQL server."),
      server_name: z.string().describe("Azure SQL logical server name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List SQL Databases" },
  },
  async ({ subscription_id, resource_group, server_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Sql/servers/${server_name}/databases`, { apiVersion: "2025-01-01" });
    const databases = items.map((d) => {
      const props = propsOf(d);
      return { id: d.id ?? null, name: d.name ?? null, location: d.location ?? null, status: props.status ?? null, sku: skuNameOf(d), tier: dig(d, "sku", "tier"), max_size_bytes: props.maxSizeBytes ?? null, collation: props.collation ?? null };
    });
    return formatResult({ subscription_id: sub, resource_group, server_name, count: databases.length, truncated, databases });
  },
);

refEntry("List_Subnets", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets", "2023-09-01");
server.registerTool(
  "List_Subnets",
  {
    title: "List Subnets",
    description: "List subnets in a virtual network.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the virtual network."),
      vnet_name: z.string().describe("Virtual network name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Subnets" },
  },
  async ({ subscription_id, resource_group, vnet_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Network/virtualNetworks/${vnet_name}/subnets`, { apiVersion: "2023-09-01" });
    const subnets = items.map((s) => {
      const props = propsOf(s);
      return {
        name: s.name ?? null,
        address_prefix: props.addressPrefix ?? props.addressPrefixes ?? null,
        network_security_group: dig(props, "networkSecurityGroup", "id"),
        route_table: dig(props, "routeTable", "id"),
        ip_configuration_count: Array.isArray(props.ipConfigurations) ? (props.ipConfigurations as JsonValue[]).length : 0,
      };
    });
    return formatResult({ subscription_id: sub, resource_group, vnet_name, count: subnets.length, truncated, subnets });
  },
);

refEntry("List_NSG_Rules", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/networkSecurityGroups/{nsg}", "2023-09-01");
server.registerTool(
  "List_NSG_Rules",
  {
    title: "List NSG Rules",
    description: "List the security rules (custom and default) of a network security group.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the NSG."),
      nsg_name: z.string().describe("Network security group name."),
      include_default_rules: z.boolean().optional().describe("Also include Azure default rules."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List NSG Rules" },
  },
  async ({ subscription_id, resource_group, nsg_name, include_default_rules }) => {
    const sub = await resolveSubscription(subscription_id);
    const { body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Network/networkSecurityGroups/${nsg_name}`, { apiVersion: "2023-09-01" });
    const props = isJsonObject(body) ? propsOf(body) : {};
    const mapRule = (r: JsonObject): JsonObject => {
      const p = propsOf(r);
      return {
        name: r.name ?? null,
        priority: p.priority ?? null,
        direction: p.direction ?? null,
        access: p.access ?? null,
        protocol: p.protocol ?? null,
        source: p.sourceAddressPrefix ?? p.sourceAddressPrefixes ?? null,
        source_port: p.sourcePortRange ?? p.sourcePortRanges ?? null,
        destination: p.destinationAddressPrefix ?? p.destinationAddressPrefixes ?? null,
        destination_port: p.destinationPortRange ?? p.destinationPortRanges ?? null,
      };
    };
    const rules = (Array.isArray(props.securityRules) ? (props.securityRules as JsonValue[]).filter(isJsonObject) : []).map(mapRule);
    const defaults = include_default_rules && Array.isArray(props.defaultSecurityRules) ? (props.defaultSecurityRules as JsonValue[]).filter(isJsonObject).map(mapRule) : [];
    return formatResult({ subscription_id: sub, resource_group, nsg_name, rule_count: rules.length, rules, default_rules: include_default_rules ? defaults : null });
  },
);

refEntry("List_DNS_Records", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/dnszones/{zone}/recordsets", "2018-05-01");
server.registerTool(
  "List_DNS_Records",
  {
    title: "List DNS Records",
    description: "List all record sets in a DNS zone.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the DNS zone."),
      zone_name: z.string().describe("DNS zone name, e.g. example.com."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List DNS Records" },
  },
  async ({ subscription_id, resource_group, zone_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Network/dnszones/${zone_name}/recordsets`, { apiVersion: "2018-05-01" });
    const records = items.map((r) => {
      const props = propsOf(r);
      const { metadata: _metadata, ...data } = props;
      return { name: r.name ?? null, type: r.type ?? null, ttl: props.TTL ?? null, fqdn: props.fqdn ?? null, data };
    });
    return formatResult({ subscription_id: sub, resource_group, zone_name, count: records.length, truncated, records });
  },
);

refEntry("List_Storage_Containers", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}/blobServices/default/containers", "2023-01-01");
server.registerTool(
  "List_Storage_Containers",
  {
    title: "List Storage Containers",
    description: "List blob containers in a storage account (via ARM, no data-plane access needed).",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the storage account."),
      account_name: z.string().describe("Storage account name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Storage Containers" },
  },
  async ({ subscription_id, resource_group, account_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(
      `/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Storage/storageAccounts/${account_name}/blobServices/default/containers`,
      { apiVersion: "2023-01-01" },
    );
    const containers = items.map((c) => {
      const props = propsOf(c);
      return { name: c.name ?? null, public_access: props.publicAccess ?? null, last_modified: props.lastModifiedTime ?? null, lease_state: props.leaseState ?? null, deleted: props.deleted ?? null };
    });
    return formatResult({ subscription_id: sub, resource_group, account_name, count: containers.length, truncated, containers });
  },
);

refEntry("List_File_Shares", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}/fileServices/default/shares", "2023-01-01");
server.registerTool(
  "List_File_Shares",
  {
    title: "List File Shares",
    description: "List file shares in a storage account (via ARM).",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the storage account."),
      account_name: z.string().describe("Storage account name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List File Shares" },
  },
  async ({ subscription_id, resource_group, account_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(
      `/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Storage/storageAccounts/${account_name}/fileServices/default/shares`,
      { apiVersion: "2023-01-01" },
    );
    const shares = items.map((s) => {
      const props = propsOf(s);
      return { name: s.name ?? null, quota_gb: props.shareQuota ?? null, access_tier: props.accessTier ?? null, last_modified: props.lastModifiedTime ?? null };
    });
    return formatResult({ subscription_id: sub, resource_group, account_name, count: shares.length, truncated, file_shares: shares });
  },
);

refEntry("List_Storage_Queues", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}/queueServices/default/queues", "2023-01-01");
server.registerTool(
  "List_Storage_Queues",
  {
    title: "List Storage Queues",
    description: "List queues in a storage account (via ARM).",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the storage account."),
      account_name: z.string().describe("Storage account name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Storage Queues" },
  },
  async ({ subscription_id, resource_group, account_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(
      `/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Storage/storageAccounts/${account_name}/queueServices/default/queues`,
      { apiVersion: "2023-01-01" },
    );
    const queues = items.map((q) => ({ name: q.name ?? null, metadata: dig(propsOf(q), "metadata") }));
    return formatResult({ subscription_id: sub, resource_group, account_name, count: queues.length, truncated, queues });
  },
);

refEntry("List_Storage_Tables", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}/tableServices/default/tables", "2023-01-01");
server.registerTool(
  "List_Storage_Tables",
  {
    title: "List Storage Tables",
    description: "List tables in a storage account (via ARM).",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the storage account."),
      account_name: z.string().describe("Storage account name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Storage Tables" },
  },
  async ({ subscription_id, resource_group, account_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { items, truncated } = await armCollect(
      `/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Storage/storageAccounts/${account_name}/tableServices/default/tables`,
      { apiVersion: "2023-01-01" },
    );
    const tables = items.map((t) => ({ name: dig(propsOf(t), "tableName") ?? t.name ?? null }));
    return formatResult({ subscription_id: sub, resource_group, account_name, count: tables.length, truncated, tables });
  },
);

refEntry("Get_Web_App", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}", "2023-12-01");
server.registerTool(
  "Get_Web_App",
  {
    title: "Get Web App",
    description: "Get an App Service web app or function app with its configuration summary.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the app."),
      app_name: z.string().describe("Web app or function app name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get Web App" },
  },
  async ({ subscription_id, resource_group, app_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Web/sites/${app_name}`, { apiVersion: "2023-12-01" });
    const site = isJsonObject(body) ? body : {};
    const props = propsOf(site);
    return formatResult({
      id: site.id ?? null,
      name: site.name ?? null,
      location: site.location ?? null,
      kind: site.kind ?? null,
      state: props.state ?? null,
      enabled: props.enabled ?? null,
      default_host_name: props.defaultHostName ?? null,
      host_names: props.hostNames ?? null,
      https_only: props.httpsOnly ?? null,
      app_service_plan_id: props.serverFarmId ?? null,
      runtime: dig(props, "siteConfig", "linuxFxVersion") ?? dig(props, "siteConfig", "windowsFxVersion"),
      outbound_ips: props.outboundIpAddresses ?? null,
      tags: site.tags ?? null,
    });
  },
);

refEntry("Get_AKS_Cluster", "read", "GET", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerService/managedClusters/{name}", "2024-02-01");
server.registerTool(
  "Get_AKS_Cluster",
  {
    title: "Get AKS Cluster",
    description: "Get an AKS managed cluster with node pool and network summary.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the cluster."),
      cluster_name: z.string().describe("AKS cluster name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get AKS Cluster" },
  },
  async ({ subscription_id, resource_group, cluster_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.ContainerService/managedClusters/${cluster_name}`, { apiVersion: "2024-02-01" });
    const cluster = isJsonObject(body) ? body : {};
    const props = propsOf(cluster);
    const pools = Array.isArray(props.agentPoolProfiles)
      ? (props.agentPoolProfiles as JsonValue[]).filter(isJsonObject).map((p) => ({ name: p.name ?? null, count: p.count ?? null, vm_size: p.vmSize ?? null, mode: p.mode ?? null, os_type: p.osType ?? null, kubernetes_version: p.orchestratorVersion ?? null }))
      : [];
    return formatResult({
      id: cluster.id ?? null,
      name: cluster.name ?? null,
      location: cluster.location ?? null,
      kubernetes_version: props.kubernetesVersion ?? null,
      provisioning_state: props.provisioningState ?? null,
      power_state: dig(props, "powerState", "code"),
      fqdn: props.fqdn ?? null,
      node_resource_group: props.nodeResourceGroup ?? null,
      network_plugin: dig(props, "networkProfile", "networkPlugin"),
      node_pools: pools,
      tags: cluster.tags ?? null,
    });
  },
);

// ---------- Key Vault data plane ----------

refEntry("List_Key_Vault_Secrets", "read", "GET", "https://{vault}.vault.azure.net/secrets", KEY_VAULT_API_VERSION);
server.registerTool(
  "List_Key_Vault_Secrets",
  {
    title: "List Key Vault Secrets",
    description: "List secret names and metadata in a key vault (never returns secret values). Requires data-plane access (RBAC or access policy).",
    inputSchema: {
      vault_name: z.string().describe("Key vault name (the {name} in {name}.vault.azure.net)."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Key Vault Secrets" },
  },
  async ({ vault_name }) => {
    if (!KEY_VAULT_NAME.test(vault_name)) throw new Error("Invalid key vault name.");
    const { items, truncated } = await collectPaged(`https://${vault_name}.vault.azure.net/secrets?api-version=${KEY_VAULT_API_VERSION}&maxresults=25`, KEY_VAULT_RESOURCE);
    const secrets = items.map((s) => {
      const attributes = isJsonObject(s.attributes) ? s.attributes : {};
      const id = typeof s.id === "string" ? s.id : "";
      return { name: id.split("/").pop() ?? null, id: s.id ?? null, enabled: attributes.enabled ?? null, created: attributes.created ?? null, updated: attributes.updated ?? null, expires: attributes.exp ?? null, content_type: s.contentType ?? null };
    });
    return formatResult({ vault_name, count: secrets.length, truncated, secrets });
  },
);

refEntry("Get_Key_Vault_Secret", "read", "GET", "https://{vault}.vault.azure.net/secrets/{name}", KEY_VAULT_API_VERSION);
server.registerTool(
  "Get_Key_Vault_Secret",
  {
    title: "Get Key Vault Secret",
    description: "Get a secret's current value from a key vault. Returns the secret value - use only when the value itself is needed.",
    inputSchema: {
      vault_name: z.string().describe("Key vault name."),
      secret_name: z.string().describe("Secret name."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get Key Vault Secret" },
  },
  async ({ vault_name, secret_name }) => {
    if (!KEY_VAULT_NAME.test(vault_name)) throw new Error("Invalid key vault name.");
    if (!KEY_VAULT_SECRET_NAME.test(secret_name)) throw new Error("Invalid secret name.");
    const result = await httpJson(new URL(`https://${vault_name}.vault.azure.net/secrets/${secret_name}?api-version=${KEY_VAULT_API_VERSION}`), KEY_VAULT_RESOURCE, "GET");
    if (!result.ok) throw new Error(`Get secret failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    const secret = isJsonObject(result.body) ? result.body : {};
    const attributes = isJsonObject(secret.attributes) ? secret.attributes : {};
    return formatResult({ vault_name, secret_name, value: secret.value ?? null, content_type: secret.contentType ?? null, enabled: attributes.enabled ?? null, updated: attributes.updated ?? null });
  },
);

// ---------- Entra ID (Microsoft Graph) ----------

// Graph escape hatches. ARM covers Azure resources; Graph covers Entra ID, M365 groups, devices,
// and Intune. Without these, "full read/write" stops at the ARM boundary.

refEntry("Graph_GET", "read", "GET", "(caller-supplied Graph path)", "v1.0|beta");
server.registerTool(
  "Graph_GET",
  {
    title: "Graph GET",
    description: "Read any Microsoft Graph endpoint. Use the specific Entra tools when one exists. Covers users, groups, devices, directory roles, applications, service principals, Intune deviceManagement, and audit logs.",
    inputSchema: {
      path: z.string().describe("Graph path beginning with '/', e.g. '/users' or '/deviceManagement/managedDevices'."),
      query: z.record(z.string(), z.string()).optional().describe("OData query parameters, e.g. {\"$filter\": \"accountEnabled eq true\", \"$select\": \"id,displayName\"}."),
      version: z.enum(["v1.0", "beta"]).optional().describe("Graph API version. Default v1.0."),
      consistency_eventual: z.boolean().optional().describe("Send ConsistencyLevel: eventual. Required for $count, $search, and some $filter forms."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Graph GET" },
  },
  async ({ path, query, version, consistency_eventual }) => {
    if (!path.startsWith("/")) throw new Error("path must start with '/'.");
    const base = version === "beta" ? "https://graph.microsoft.com/beta" : GRAPH_BASE;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers = consistency_eventual ? { ConsistencyLevel: "eventual" } : undefined;
    const result = await httpJson(url, GRAPH_RESOURCE, "GET", undefined, headers);
    if (!result.ok) throw new Error(`Graph GET ${path} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    return formatResult({ ok: true, http_status: result.status, path, body: result.body });
  },
);

refEntry("Graph_Request", "write", "(caller-supplied)", "(caller-supplied Graph path)", "v1.0|beta");
server.registerTool(
  "Graph_Request",
  {
    title: "Graph Request",
    description: "Escape hatch: write to any Microsoft Graph endpoint (POST, PATCH, PUT, DELETE). Creates and updates users, group membership, app registrations, Conditional Access policies, and Intune configuration. Permissions are bounded by the signed-in identity's Graph roles.",
    inputSchema: {
      method: z.enum(["POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method. For reads use Graph_GET."),
      path: z.string().describe("Graph path beginning with '/', e.g. '/groups/{id}/members/$ref'."),
      body: z.record(z.string(), z.any()).optional().describe("Optional JSON request body."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query parameters."),
      version: z.enum(["v1.0", "beta"]).optional().describe("Graph API version. Default v1.0."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Graph Request" },
  },
  async ({ method, path, body, query, version }) => {
    if (!path.startsWith("/")) throw new Error("path must start with '/'.");
    const base = version === "beta" ? "https://graph.microsoft.com/beta" : GRAPH_BASE;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const result = await httpJson(url, GRAPH_RESOURCE, method, (body as JsonValue) ?? undefined);
    if (!result.ok) throw new Error(`Graph ${method} ${path} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    return formatResult({ ok: true, http_status: result.status, method, path, body: result.body });
  },
);


async function graphList(path: string, filter: string | undefined, top: number | undefined, select: string): Promise<{ items: JsonObject[]; truncated: boolean }> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set("$top", String(Math.min(Math.max(top ?? 50, 1), 999)));
  url.searchParams.set("$select", select);
  if (filter) url.searchParams.set("$filter", filter);
  const headers = filter ? { ConsistencyLevel: "eventual" } : undefined;
  return collectPaged(url.toString(), GRAPH_RESOURCE, headers);
}

refEntry("List_Entra_Users", "read", "GET", "https://graph.microsoft.com/v1.0/users", "v1.0");
server.registerTool(
  "List_Entra_Users",
  {
    title: "List Entra Users",
    description: "List Microsoft Entra ID (Azure AD) users via Microsoft Graph. Requires directory read permission.",
    inputSchema: {
      filter: z.string().optional().describe("Optional OData $filter, e.g. \"startsWith(displayName,'Pat')\"."),
      top: z.number().optional().describe("Page size, 1-999. Default 50."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Entra Users" },
  },
  async ({ filter, top }) => {
    const { items, truncated } = await graphList("/users", filter, top, "id,displayName,userPrincipalName,mail,accountEnabled,userType");
    const users = items.map((u) => ({ id: u.id ?? null, display_name: u.displayName ?? null, user_principal_name: u.userPrincipalName ?? null, mail: u.mail ?? null, account_enabled: u.accountEnabled ?? null, user_type: u.userType ?? null }));
    return formatResult({ count: users.length, truncated, users });
  },
);

refEntry("List_Entra_Groups", "read", "GET", "https://graph.microsoft.com/v1.0/groups", "v1.0");
server.registerTool(
  "List_Entra_Groups",
  {
    title: "List Entra Groups",
    description: "List Microsoft Entra ID (Azure AD) groups via Microsoft Graph. Requires directory read permission.",
    inputSchema: {
      filter: z.string().optional().describe("Optional OData $filter."),
      top: z.number().optional().describe("Page size, 1-999. Default 50."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Entra Groups" },
  },
  async ({ filter, top }) => {
    const { items, truncated } = await graphList("/groups", filter, top, "id,displayName,mail,securityEnabled,groupTypes");
    const groups = items.map((g) => ({ id: g.id ?? null, display_name: g.displayName ?? null, mail: g.mail ?? null, security_enabled: g.securityEnabled ?? null, group_types: g.groupTypes ?? null }));
    return formatResult({ count: groups.length, truncated, groups });
  },
);

refEntry("List_Entra_Applications", "read", "GET", "https://graph.microsoft.com/v1.0/applications", "v1.0");
server.registerTool(
  "List_Entra_Applications",
  {
    title: "List Entra Applications",
    description: "List Microsoft Entra ID app registrations via Microsoft Graph. Requires directory read permission.",
    inputSchema: {
      filter: z.string().optional().describe("Optional OData $filter."),
      top: z.number().optional().describe("Page size, 1-999. Default 50."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Entra Applications" },
  },
  async ({ filter, top }) => {
    const { items, truncated } = await graphList("/applications", filter, top, "id,appId,displayName,signInAudience,createdDateTime");
    const applications = items.map((a) => ({ id: a.id ?? null, app_id: a.appId ?? null, display_name: a.displayName ?? null, sign_in_audience: a.signInAudience ?? null, created: a.createdDateTime ?? null }));
    return formatResult({ count: applications.length, truncated, applications });
  },
);

// ---------- monitoring ----------

refEntry("Get_Metrics", "read", "GET", "{resourceId}/providers/microsoft.insights/metrics", "2018-01-01");
server.registerTool(
  "Get_Metrics",
  {
    title: "Get Metrics",
    description: "Get Azure Monitor metrics for a resource, e.g. CPU for a VM. Use List Metric Definitions to discover metric names.",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id."),
      metric_names: z.string().optional().describe("Comma-separated metric names, e.g. 'Percentage CPU'. Omit for the default metric."),
      timespan: z.string().optional().describe("ISO 8601 range 'start/end', e.g. 2026-07-07T00:00:00Z/2026-07-08T00:00:00Z. Defaults to the last hour."),
      interval: z.string().optional().describe("ISO 8601 duration granularity, e.g. PT5M or PT1H."),
      aggregation: z.string().optional().describe("Comma-separated aggregations: Average, Minimum, Maximum, Total, Count."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Get Metrics" },
  },
  async ({ resource_id, metric_names, timespan, interval, aggregation }) => {
    if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
    const { body } = await armRequest(`${resource_id}/providers/microsoft.insights/metrics`, {
      apiVersion: "2018-01-01",
      query: { metricnames: metric_names, timespan, interval, aggregation },
    });
    return formatResult(body);
  },
);

refEntry("List_Metric_Definitions", "read", "GET", "{resourceId}/providers/microsoft.insights/metricDefinitions", "2018-01-01");
server.registerTool(
  "List_Metric_Definitions",
  {
    title: "List Metric Definitions",
    description: "List the metrics available for a resource (names, units, supported aggregations).",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Metric Definitions" },
  },
  async ({ resource_id }) => {
    if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
    const { body } = await armRequest(`${resource_id}/providers/microsoft.insights/metricDefinitions`, { apiVersion: "2018-01-01" });
    const items = isJsonObject(body) && Array.isArray(body.value) ? (body.value as JsonValue[]).filter(isJsonObject) : [];
    const definitions = items.map((d) => ({
      name: dig(d, "name", "value"),
      display_name: dig(d, "name", "localizedValue"),
      unit: d.unit ?? null,
      primary_aggregation: d.primaryAggregationType ?? null,
      supported_aggregations: d.supportedAggregationTypes ?? null,
    }));
    return formatResult({ resource_id, count: definitions.length, metric_definitions: definitions });
  },
);

refEntry("List_Diagnostic_Settings", "read", "GET", "{resourceId}/providers/Microsoft.Insights/diagnosticSettings", "2021-05-01-preview");
server.registerTool(
  "List_Diagnostic_Settings",
  {
    title: "List Diagnostic Settings",
    description: "List diagnostic settings configured on a resource (where logs and metrics are routed).",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "List Diagnostic Settings" },
  },
  async ({ resource_id }) => {
    if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
    const { body } = await armRequest(`${resource_id}/providers/Microsoft.Insights/diagnosticSettings`, { apiVersion: "2021-05-01-preview" });
    const items = isJsonObject(body) && Array.isArray(body.value) ? (body.value as JsonValue[]).filter(isJsonObject) : [];
    const settings = items.map((s) => {
      const props = propsOf(s);
      return {
        name: s.name ?? null,
        workspace_id: props.workspaceId ?? null,
        storage_account_id: props.storageAccountId ?? null,
        event_hub_name: props.eventHubName ?? null,
        logs: props.logs ?? null,
        metrics: props.metrics ?? null,
      };
    });
    return formatResult({ resource_id, count: settings.length, diagnostic_settings: settings });
  },
);

refEntry("Query_Log_Analytics", "read", "POST", "https://api.loganalytics.io/v1/workspaces/{workspaceId}/query", "v1");
server.registerTool(
  "Query_Log_Analytics",
  {
    title: "Query Log Analytics",
    description: "Run a KQL query against a Log Analytics workspace. Use List Log Analytics Workspaces to find the workspace customer_id (GUID).",
    inputSchema: {
      workspace_id: z.string().describe("Log Analytics workspace customer id (GUID), not the ARM resource id."),
      query: z.string().describe("KQL query, e.g. 'Heartbeat | summarize count() by Computer | limit 10'."),
      timespan: z.string().optional().describe("Optional ISO 8601 duration or range, e.g. P1D or 2026-07-01T00:00:00Z/2026-07-08T00:00:00Z."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Query Log Analytics" },
  },
  async ({ workspace_id, query, timespan }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(workspace_id)) throw new Error("workspace_id must be the workspace customer id GUID.");
    const requestBody: JsonObject = { query };
    if (timespan) requestBody.timespan = timespan;
    const result = await httpJson(new URL(`${LOG_ANALYTICS_BASE}/workspaces/${workspace_id}/query`), LOG_ANALYTICS_RESOURCE, "POST", requestBody);
    if (!result.ok) throw new Error(`Log Analytics query failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    return formatResult(result.body);
  },
);

// ---------- cost ----------

refEntry("Query_Costs", "read", "POST", "/subscriptions/{sub}/providers/Microsoft.CostManagement/query", "2023-11-01");
server.registerTool(
  "Query_Costs",
  {
    title: "Query Costs",
    description: "Query subscription cost data from Cost Management, grouped by a dimension (default: service name).",
    inputSchema: {
      ...subscriptionSchema,
      timeframe: z.enum(["MonthToDate", "BillingMonthToDate", "TheLastMonth", "TheLastBillingMonth", "WeekToDate", "Custom"]).optional().describe("Reporting window. Default MonthToDate."),
      from_date: z.string().optional().describe("Start date (ISO 8601) when timeframe is Custom."),
      to_date: z.string().optional().describe("End date (ISO 8601) when timeframe is Custom."),
      group_by: z.string().optional().describe("Dimension to group by, e.g. ServiceName, ResourceGroupName, ResourceLocation, MeterCategory. Default ServiceName."),
      granularity: z.enum(["None", "Daily", "Monthly"]).optional().describe("Time granularity. Default None (single total per group)."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "Query Costs" },
  },
  async ({ subscription_id, timeframe, from_date, to_date, group_by, granularity }) => {
    const sub = await resolveSubscription(subscription_id);
    const requestBody: JsonObject = {
      type: "ActualCost",
      timeframe: timeframe ?? "MonthToDate",
      dataset: {
        granularity: granularity ?? "None",
        aggregation: { totalCost: { name: "Cost", function: "Sum" } },
        grouping: [{ type: "Dimension", name: group_by ?? "ServiceName" }],
      },
    };
    if ((timeframe ?? "MonthToDate") === "Custom") {
      if (!from_date || !to_date) throw new Error("from_date and to_date are required when timeframe is Custom.");
      requestBody.timePeriod = { from: from_date, to: to_date };
    }
    const { body } = await armRequest(`/subscriptions/${sub}/providers/Microsoft.CostManagement/query`, { apiVersion: "2023-11-01", method: "POST", body: requestBody });
    const props = isJsonObject(body) ? propsOf(body) : {};
    return formatResult({ subscription_id: sub, columns: props.columns ?? null, rows: props.rows ?? null, next_link: props.nextLink ?? null });
  },
);

// ---------- write tools (RBAC-bounded) ----------

refEntry("Start_VM", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}/start", "2023-07-01");
server.registerTool(
  "Start_VM",
  {
    title: "Start VM",
    description: "Start a virtual machine.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the VM."),
      vm_name: z.string().describe("VM name."),
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Start VM" },
  },
  async ({ subscription_id, resource_group, vm_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}/start`, { apiVersion: "2023-07-01", method: "POST" });
    return formatResult({ ok: true, action: "start", subscription_id: sub, resource_group, vm_name, http_status: status, note: status === 202 ? "Accepted; start is asynchronous." : "Completed." });
  },
);

refEntry("Stop_VM", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}/deallocate", "2023-07-01");
server.registerTool(
  "Stop_VM",
  {
    title: "Stop VM",
    description: "Deallocate (stop) a virtual machine to halt compute billing.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the VM."),
      vm_name: z.string().describe("VM name."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Stop VM" },
  },
  async ({ subscription_id, resource_group, vm_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}/deallocate`, { apiVersion: "2023-07-01", method: "POST" });
    return formatResult({ ok: true, action: "deallocate", subscription_id: sub, resource_group, vm_name, http_status: status, note: status === 202 ? "Accepted; deallocate is asynchronous." : "Completed." });
  },
);

refEntry("Restart_VM", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}/restart", "2026-03-01");
server.registerTool(
  "Restart_VM",
  {
    title: "Restart VM",
    description: "Restart a virtual machine.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the VM."),
      vm_name: z.string().describe("VM name."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Restart VM" },
  },
  async ({ subscription_id, resource_group, vm_name }) => {
    const sub = await resolveSubscription(subscription_id);
    const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}/restart`, { apiVersion: "2026-03-01", method: "POST" });
    return formatResult({ ok: true, action: "restart", subscription_id: sub, resource_group, vm_name, http_status: status, note: status === 202 ? "Accepted; restart is asynchronous." : "Completed." });
  },
);

refEntry("Resize_VM", "write", "PATCH", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}", "2023-07-01");
server.registerTool(
  "Resize_VM",
  {
    title: "Resize VM",
    description: "Change a virtual machine's size (SKU). The VM restarts as part of the resize.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group of the VM."),
      vm_name: z.string().describe("VM name."),
      vm_size: z.string().describe("Target size, e.g. Standard_D4s_v5."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Resize VM" },
  },
  async ({ subscription_id, resource_group, vm_name, vm_size }) => {
    const sub = await resolveSubscription(subscription_id);
    const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}`, {
      apiVersion: "2023-07-01",
      method: "PATCH",
      body: { properties: { hardwareProfile: { vmSize: vm_size } } },
    });
    return formatResult({ ok: true, action: "resize", subscription_id: sub, resource_group, vm_name, vm_size, http_status: status });
  },
);

const webAppAction = (action: "start" | "stop" | "restart") => async ({ subscription_id, resource_group, app_name }: { subscription_id?: string; resource_group: string; app_name: string }) => {
  const sub = await resolveSubscription(subscription_id);
  const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.Web/sites/${app_name}/${action}`, { apiVersion: "2023-12-01", method: "POST" });
  return formatResult({ ok: true, action, subscription_id: sub, resource_group, app_name, http_status: status });
};

const webAppActionSchema = {
  ...subscriptionSchema,
  resource_group: z.string().describe("Resource group of the app."),
  app_name: z.string().describe("Web app or function app name."),
};

refEntry("Start_Web_App", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}/start", "2023-12-01");
server.registerTool(
  "Start_Web_App",
  { title: "Start Web App", description: "Start an App Service web app or function app.", inputSchema: webAppActionSchema, annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Start Web App" } },
  webAppAction("start"),
);

refEntry("Stop_Web_App", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}/stop", "2023-12-01");
server.registerTool(
  "Stop_Web_App",
  { title: "Stop Web App", description: "Stop an App Service web app or function app.", inputSchema: webAppActionSchema, annotations: { ...WRITE_ANNOTATIONS, title: "Stop Web App" } },
  webAppAction("stop"),
);

refEntry("Restart_Web_App", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}/restart", "2023-12-01");
server.registerTool(
  "Restart_Web_App",
  { title: "Restart Web App", description: "Restart an App Service web app or function app.", inputSchema: webAppActionSchema, annotations: { ...WRITE_ANNOTATIONS, title: "Restart Web App" } },
  webAppAction("restart"),
);

const aksAction = (action: "start" | "stop") => async ({ subscription_id, resource_group, cluster_name }: { subscription_id?: string; resource_group: string; cluster_name: string }) => {
  const sub = await resolveSubscription(subscription_id);
  const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}/providers/Microsoft.ContainerService/managedClusters/${cluster_name}/${action}`, { apiVersion: "2024-02-01", method: "POST" });
  return formatResult({ ok: true, action, subscription_id: sub, resource_group, cluster_name, http_status: status, note: status === 202 ? `Accepted; ${action} is asynchronous.` : "Completed." });
};

const aksActionSchema = {
  ...subscriptionSchema,
  resource_group: z.string().describe("Resource group of the cluster."),
  cluster_name: z.string().describe("AKS cluster name."),
};

refEntry("Start_AKS_Cluster", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerService/managedClusters/{name}/start", "2024-02-01");
server.registerTool(
  "Start_AKS_Cluster",
  { title: "Start AKS Cluster", description: "Start a stopped AKS cluster.", inputSchema: aksActionSchema, annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Start AKS Cluster" } },
  aksAction("start"),
);

refEntry("Stop_AKS_Cluster", "write", "POST", "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerService/managedClusters/{name}/stop", "2024-02-01");
server.registerTool(
  "Stop_AKS_Cluster",
  { title: "Stop AKS Cluster", description: "Stop a running AKS cluster to pause compute billing.", inputSchema: aksActionSchema, annotations: { ...WRITE_ANNOTATIONS, title: "Stop AKS Cluster" } },
  aksAction("stop"),
);

refEntry("Tag_Resource", "write", "PATCH", "(full ARM resource id)", "2021-04-01");
server.registerTool(
  "Tag_Resource",
  {
    title: "Tag Resource",
    description: "Merge tags onto a resource by ARM resource id.",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id (starts with /subscriptions/...)."),
      tags: z.record(z.string(), z.string()).describe("Tag key/value pairs to set."),
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Tag Resource" },
  },
  async ({ resource_id, tags }) => {
    const { body } = await armRequest(resource_id, { apiVersion: "2021-04-01", method: "PATCH", body: { tags } });
    return formatResult({ ok: true, resource_id, tags, result: body });
  },
);

refEntry("Create_Resource_Group", "write", "PUT", "/subscriptions/{sub}/resourceGroups/{rg}", "2021-04-01");
server.registerTool(
  "Create_Resource_Group",
  {
    title: "Create Resource Group",
    description: "Create or update a resource group.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group name to create or update."),
      location: z.string().describe("Azure region for the group, e.g. eastus."),
      tags: z.record(z.string(), z.string()).optional().describe("Optional tag key/value pairs."),
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, idempotentHint: true, title: "Create Resource Group" },
  },
  async ({ subscription_id, resource_group, location, tags }) => {
    const sub = await resolveSubscription(subscription_id);
    const requestBody: JsonObject = { location };
    if (tags) requestBody.tags = tags;
    const { status, body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}`, { apiVersion: "2021-04-01", method: "PUT", body: requestBody });
    return formatResult({ ok: true, action: "create", subscription_id: sub, resource_group, location, http_status: status, result: body });
  },
);

refEntry("Delete_Resource_Group", "write", "DELETE", "/subscriptions/{sub}/resourceGroups/{rg}", "2021-04-01");
server.registerTool(
  "Delete_Resource_Group",
  {
    title: "Delete Resource Group",
    description: "Delete a resource group and all resources in it.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group name to delete. This deletes the group and every resource inside it."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Delete Resource Group" },
  },
  async ({ subscription_id, resource_group }) => {
    const sub = await resolveSubscription(subscription_id);
    const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${resource_group}`, { apiVersion: "2021-04-01", method: "DELETE" });
    return formatResult({ ok: true, action: "delete", subscription_id: sub, resource_group, http_status: status, note: status === 202 ? "Accepted; deletion is asynchronous and removes all resources in the group." : "Completed." });
  },
);

refEntry("Delete_Resource", "write", "DELETE", "(full ARM resource id)", "(auto-negotiated)");
server.registerTool(
  "Delete_Resource",
  {
    title: "Delete Resource",
    description: "Delete a single resource by its full ARM resource id. Irreversible.",
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id of the resource to delete."),
      api_version: z.string().optional().describe("Optional ARM api-version. If omitted or wrong, the supported version is auto-negotiated."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Delete Resource" },
  },
  async ({ resource_id, api_version }) => {
    if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
    const { status } = await armRequest(resource_id, { apiVersion: api_version ?? "2021-04-01", method: "DELETE" });
    return formatResult({ ok: true, action: "delete", resource_id, http_status: status, note: status === 202 ? "Accepted; deletion is asynchronous." : "Completed." });
  },
);

refEntry("Set_Key_Vault_Secret", "write", "PUT", "https://{vault}.vault.azure.net/secrets/{name}", KEY_VAULT_API_VERSION);
server.registerTool(
  "Set_Key_Vault_Secret",
  {
    title: "Set Key Vault Secret",
    description: "Create or update a secret in a key vault. Requires data-plane write access.",
    inputSchema: {
      vault_name: z.string().describe("Key vault name."),
      secret_name: z.string().describe("Secret name."),
      value: z.string().describe("Secret value to store."),
      content_type: z.string().optional().describe("Optional content type label."),
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Set Key Vault Secret" },
  },
  async ({ vault_name, secret_name, value, content_type }) => {
    if (!KEY_VAULT_NAME.test(vault_name)) throw new Error("Invalid key vault name.");
    if (!KEY_VAULT_SECRET_NAME.test(secret_name)) throw new Error("Invalid secret name.");
    const requestBody: JsonObject = { value };
    if (content_type) requestBody.contentType = content_type;
    const result = await httpJson(new URL(`https://${vault_name}.vault.azure.net/secrets/${secret_name}?api-version=${KEY_VAULT_API_VERSION}`), KEY_VAULT_RESOURCE, "PUT", requestBody);
    if (!result.ok) throw new Error(`Set secret failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
    return formatResult({ ok: true, vault_name, secret_name, updated: dig(result.body, "attributes", "updated") });
  },
);

// ---------- generic passthrough ----------

refEntry("ARM_GET", "read", "GET", "(caller-supplied ARM path)", "(caller-supplied)");
server.registerTool(
  "ARM_GET",
  {
    title: "ARM GET",
    description: "Perform a read-only GET against any Azure Resource Manager path (GET only; no writes).",
    inputSchema: {
      path: z.string().describe("ARM path beginning with '/', e.g. /subscriptions/{id}/resourceGroups. GET only."),
      api_version: z.string().describe("ARM api-version for the path, e.g. 2024-04-01."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query string parameters as key/value pairs (api-version is added automatically)."),
    },
    annotations: { ...READ_ANNOTATIONS, title: "ARM GET" },
  },
  async ({ path, api_version, query }) => {
    if (!path.startsWith("/")) throw new Error("path must start with '/'.");
    const { status, body } = await armRequest(path, { apiVersion: api_version, query: query ?? {} });
    return formatResult({ ok: true, http_status: status, path, body });
  },
);

refEntry("ARM_Request", "write", "(caller-supplied)", "(caller-supplied ARM path)", "(caller-supplied)");
server.registerTool(
  "ARM_Request",
  {
    title: "ARM Request",
    description: "Escape hatch: perform a write (POST, PUT, PATCH, DELETE) against any Azure Resource Manager path. Use the specific tools when one exists.",
    inputSchema: {
      method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method. For reads use the ARM GET tool."),
      path: z.string().describe("ARM path beginning with '/'."),
      api_version: z.string().describe("ARM api-version for the path."),
      body: z.record(z.string(), z.any()).optional().describe("Optional JSON request body."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query string parameters (api-version is added automatically)."),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "ARM Request" },
  },
  async ({ method, path, api_version, body, query }) => {
    if (!path.startsWith("/")) throw new Error("path must start with '/'.");
    const { status, body: responseBody } = await armRequest(path, { apiVersion: api_version, method, body: (body as JsonValue) ?? undefined, query: query ?? {} });
    return formatResult({ ok: true, http_status: status, method, path, body: responseBody });
  },
);

// ---------- API reference resource ----------

server.registerResource(
  "api_reference",
  "azure://reference/api",
  { title: "Azure API Reference", description: "Every tool with the method, path template, and api-version it uses.", mimeType: "application/json" },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            server: SERVER_NAME,
            auth: SP_AUTH
              ? "Service principal (client credentials) configured via connector settings."
              : "Azure CLI passthrough (az account get-access-token); all calls bounded by the signed-in identity's RBAC.",
            arm_base: ARM_BASE,
            tools: apiReference,
          },
          null,
          2,
        ),
      },
    ],
  }),
);

// ---------- bootstrap ----------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Azure MCP server running on stdio (auth: ${SP_AUTH ? "service principal" : `azure cli via ${AZ}`})`);
}

main().catch((error: unknown) => {
  const details =
    error instanceof ArmApiError
      ? { message: error.message, status: error.status, statusText: error.statusText, details: error.details }
      : { message: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
});
