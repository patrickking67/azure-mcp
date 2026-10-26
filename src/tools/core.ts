// Connection, subscriptions, resource groups, generic resources, Resource Graph, and the ARM escape hatches.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AZ_LABEL, cliConfigDir } from "../az.js";
import { authMode, BASE_AUTH_MODE, CLIENT_ID, MANAGED_IDENTITY_CLIENT_ID, TENANT_ID, currentCaller, oboEnabled } from "../auth.js";
import { armCollect, armRequest, azAccountShow, dig, formatResult, isJsonObject, propsOf, resolveSubscription, type JsonValue } from "../client.js";
import { envValue } from "../env.js";
import { gateStatus } from "../gate.js";
import { SERVER_VERSION } from "../version.js";
import { defineTool } from "./define.js";
import { segment, subscriptionSchema } from "./shared.js";

export function registerCoreTools(server: McpServer): void {
  defineTool(server, {
    name: "Status_Server",
    title: "Server Status",
    description:
      "Report this server's configuration without calling Azure: version, auth mode, which settings are filled in, the Azure CLI it found, and the write gate. Call this first when tools fail or seem to be missing.",
    tier: "read",
    inputSchema: {},
    handler: async () =>
      formatResult({
        version: SERVER_VERSION,
        auth_mode: authMode(),
        base_auth_mode: BASE_AUTH_MODE,
        remote_caller: currentCaller()?.upn ?? null,
        on_behalf_of_enabled: oboEnabled(),
        tenant_id: TENANT_ID ?? null,
        client_id: CLIENT_ID ?? null,
        managed_identity_client_id: MANAGED_IDENTITY_CLIENT_ID ?? null,
        default_subscription: envValue("AZURE_SUBSCRIPTION_ID") ?? null,
        azure_cli: AZ_LABEL,
        azure_cli_config_dir: cliConfigDir() ?? "(the user's own ~/.azure)",
        gate: gateStatus(),
        platform: `${process.platform}/${process.arch}`,
        node: process.version,
      }),
  });

  defineTool(server, {
    name: "Status_Gate",
    title: "Write Gate Status",
    description: "Report whether write and destructive tools are enabled, and which setting opens each gate. Use it to explain a refusal.",
    tier: "read",
    inputSchema: {},
    handler: async () => formatResult(gateStatus()),
  });

  defineTool(server, {
    name: "Test_Connection",
    title: "Test Connection",
    description: "Check Azure authentication (Azure CLI, service principal, managed identity or on-behalf-of) and report the identity and reachable subscriptions.",
    tier: "read",
    cli: "az account show",
    ref: { method: "GET", path: "/subscriptions", apiVersion: "2022-12-01" },
    inputSchema: {},
    handler: async () => {
      const mode = authMode();
      const account = mode === "azure_cli" ? await azAccountShow() : null;
      const { items } = await armCollect("/subscriptions", { apiVersion: "2022-12-01" });
      const caller = currentCaller();
      return formatResult({
        ok: true,
        auth_mode: mode,
        signed_in_user:
          account?.user ??
          (caller ? { type: "user", upn: caller.upn, oid: caller.oid } : mode === "service_principal" ? { type: "servicePrincipal", client_id: CLIENT_ID ?? null } : { type: "managedIdentity", client_id: MANAGED_IDENTITY_CLIENT_ID ?? null }),
        tenant_id: TENANT_ID ?? account?.tenantId ?? envValue("ENTRA_TENANT_ID") ?? null,
        default_subscription: envValue("AZURE_SUBSCRIPTION_ID") ?? account?.id ?? null,
        subscription_count: items.length,
      });
    },
  });

  defineTool(server, {
    name: "List_Subscriptions",
    title: "List Subscriptions",
    description: "List subscriptions the signed-in identity can access.",
    tier: "read",
    cli: "az account list",
    ref: { method: "GET", path: "/subscriptions", apiVersion: "2022-12-01" },
    inputSchema: {},
    handler: async () => {
      const { items } = await armCollect("/subscriptions", { apiVersion: "2022-12-01" });
      const subs = items.map((s) => ({ id: s.subscriptionId ?? null, name: s.displayName ?? null, state: s.state ?? null, tenant_id: s.tenantId ?? null }));
      return formatResult({ count: subs.length, subscriptions: subs });
    },
  });

  defineTool(server, {
    name: "List_Resource_Groups",
    title: "List Resource Groups",
    description: "List resource groups in a subscription.",
    tier: "read",
    cli: "az group list",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourcegroups", apiVersion: "2021-04-01" },
    inputSchema: { ...subscriptionSchema },
    handler: async ({ subscription_id }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`/subscriptions/${sub}/resourcegroups`, { apiVersion: "2021-04-01" });
      const groups = items.map((g) => ({ name: g.name ?? null, location: g.location ?? null, provisioning_state: dig(propsOf(g), "provisioningState"), tags: g.tags ?? null }));
      return formatResult({ subscription_id: sub, count: groups.length, truncated, resource_groups: groups });
    },
  });

  defineTool(server, {
    name: "List_Resources",
    title: "List Resources",
    description: "List resources in a subscription, optionally filtered by type or resource group.",
    tier: "read",
    cli: "az resource list",
    ref: { method: "GET", path: "/subscriptions/{sub}/resources", apiVersion: "2021-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      resource_type: z.string().optional().describe("Filter by ARM type, e.g. 'Microsoft.Compute/virtualMachines'."),
      resource_group: z.string().optional().describe("Filter by resource group name."),
    },
    handler: async ({ subscription_id, resource_type, resource_group }) => {
      const sub = await resolveSubscription(subscription_id);
      const base = resource_group ? `/subscriptions/${sub}/resourceGroups/${segment(resource_group, "resource_group")}/resources` : `/subscriptions/${sub}/resources`;
      const query: Record<string, string | undefined> = {};
      if (resource_type) {
        if (!/^[A-Za-z0-9.]+\/[A-Za-z0-9/]+$/.test(resource_type)) throw new Error("resource_type must look like 'Microsoft.Compute/virtualMachines'.");
        query.$filter = `resourceType eq '${resource_type}'`;
      }
      const { items, truncated } = await armCollect(base, { apiVersion: "2021-04-01", query });
      const resources = items.map((r) => ({ id: r.id ?? null, name: r.name ?? null, type: r.type ?? null, location: r.location ?? null, kind: r.kind ?? null, tags: r.tags ?? null }));
      return formatResult({ subscription_id: sub, count: resources.length, truncated, resources });
    },
  });

  defineTool(server, {
    name: "Get_Resource",
    title: "Get Resource",
    description: "Get any resource by its full ARM resource id. The api-version is negotiated automatically unless provided.",
    tier: "read",
    cli: "az resource show --ids <id>",
    ref: { method: "GET", path: "(full ARM resource id)", apiVersion: "(auto-negotiated)" },
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id (starts with /subscriptions/...)."),
      api_version: z.string().optional().describe("Optional ARM api-version. If omitted or wrong, the supported version is auto-negotiated."),
    },
    handler: async ({ resource_id, api_version }) => {
      if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
      const { body } = await armRequest(resource_id, { apiVersion: api_version ?? "2021-04-01" });
      return formatResult(body);
    },
  });

  defineTool(server, {
    name: "Resource_Graph_Query",
    title: "Resource Graph Query",
    description: "Run a Resource Graph (KQL) query across subscription resources.",
    tier: "read",
    cli: "az graph query -q <kql>",
    ref: { method: "POST", path: "/providers/Microsoft.ResourceGraph/resources", apiVersion: "2024-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      query: z.string().describe("Resource Graph KQL query, e.g. \"Resources | project name, type | limit 5\"."),
      all_subscriptions: z.boolean().optional().describe("Query every subscription this identity can read instead of one."),
    },
    handler: async ({ subscription_id, query, all_subscriptions }) => {
      let subscriptions: string[];
      if (all_subscriptions) {
        const { items } = await armCollect("/subscriptions", { apiVersion: "2022-12-01" });
        subscriptions = items.map((s) => String(s.subscriptionId ?? "")).filter(Boolean);
      } else {
        subscriptions = [await resolveSubscription(subscription_id)];
      }
      const { body } = await armRequest(`/providers/Microsoft.ResourceGraph/resources`, {
        apiVersion: "2024-04-01",
        method: "POST",
        body: { subscriptions, query },
      });
      const result = isJsonObject(body) ? body : {};
      return formatResult({
        subscriptions,
        count: result.count ?? null,
        total_records: result.totalRecords ?? null,
        result_truncated: result.resultTruncated ?? null,
        skip_token: result.$skipToken ?? null,
        data: result.data ?? null,
      });
    },
  });

  defineTool(server, {
    name: "ARM_GET",
    title: "ARM GET",
    description: "Perform a read-only GET against any Azure Resource Manager path (GET only; no writes).",
    tier: "read",
    cli: "az rest --method get --uri <path>",
    ref: { method: "GET", path: "(caller-supplied ARM path)", apiVersion: "(caller-supplied)" },
    inputSchema: {
      path: z.string().describe("ARM path beginning with '/', e.g. /subscriptions/{id}/resourceGroups. GET only."),
      api_version: z.string().describe("ARM api-version for the path, e.g. 2024-04-01."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query string parameters as key/value pairs (api-version is added automatically)."),
    },
    handler: async ({ path, api_version, query }) => {
      if (!path.startsWith("/")) throw new Error("path must start with '/'.");
      const { status, body } = await armRequest(path, { apiVersion: api_version, query: query ?? {} });
      return formatResult({ ok: true, http_status: status, path, body });
    },
  });

  defineTool(server, {
    name: "ARM_Request",
    title: "ARM Request",
    description:
      "Escape hatch: perform a write (POST, PUT, PATCH, DELETE) against any Azure Resource Manager path. Use the specific tools when one exists. DELETE needs the destructive gate; the other methods need write mode.",
    tier: "destructive",
    runtimeTier: ({ method }) => (method === "DELETE" ? "destructive" : "write"),
    impact: "an arbitrary ARM DELETE",
    cli: "az rest --method <post|put|patch|delete> --uri <path>",
    ref: { method: "(caller-supplied)", path: "(caller-supplied ARM path)", apiVersion: "(caller-supplied)" },
    inputSchema: {
      method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method. For reads use the ARM GET tool."),
      path: z.string().describe("ARM path beginning with '/'."),
      api_version: z.string().describe("ARM api-version for the path."),
      body: z.record(z.string(), z.any()).optional().describe("Optional JSON request body."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query string parameters (api-version is added automatically)."),
    },
    handler: async ({ method, path, api_version, body, query }) => {
      if (!path.startsWith("/")) throw new Error("path must start with '/'.");
      const { status, body: responseBody } = await armRequest(path, { apiVersion: api_version, method, body: (body as JsonValue) ?? undefined, query: query ?? {} });
      return formatResult({ ok: true, http_status: status, method, path, body: responseBody });
    },
  });
}
