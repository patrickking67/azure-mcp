// Entra ID through Microsoft Graph. ARM covers Azure resources; Graph covers users, groups, apps,
// devices and Intune. Without these, "full read/write" stops at the ARM boundary.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectPaged, formatResult, GRAPH_BASE, GRAPH_BETA_BASE, GRAPH_RESOURCE, httpJson, type JsonValue } from "../client.js";
import { defineTool } from "./define.js";

function graphUrl(path: string, version: "v1.0" | "beta" | undefined, query?: Record<string, string>): URL {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("path must start with a single '/'.");
  const url = new URL(`${version === "beta" ? GRAPH_BETA_BASE : GRAPH_BASE}${path}`);
  if (url.origin !== "https://graph.microsoft.com") throw new Error("path must stay on graph.microsoft.com.");
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url;
}

async function graphList(path: string, filter: string | undefined, top: number | undefined, select: string) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set("$top", String(Math.min(Math.max(top ?? 50, 1), 999)));
  url.searchParams.set("$select", select);
  if (filter) url.searchParams.set("$filter", filter);
  const headers = filter ? { ConsistencyLevel: "eventual" } : undefined;
  return collectPaged(url.toString(), GRAPH_RESOURCE, headers);
}

const listSchema = (filterHint: string) => ({
  filter: z.string().optional().describe(filterHint),
  top: z.number().optional().describe("Page size, 1-999. Default 50."),
});

export function registerGraphTools(server: McpServer): void {
  defineTool(server, {
    name: "Graph_GET",
    title: "Graph GET",
    description:
      "Read any Microsoft Graph endpoint. Use the specific Entra tools when one exists. Covers users, groups, devices, directory roles, applications, service principals, Intune deviceManagement, and audit logs.",
    tier: "read",
    cli: "az rest --method get --url https://graph.microsoft.com/v1.0/<path>",
    ref: { method: "GET", path: "(caller-supplied Graph path)", apiVersion: "v1.0|beta" },
    inputSchema: {
      path: z.string().describe("Graph path beginning with '/', e.g. '/users' or '/deviceManagement/managedDevices'."),
      query: z.record(z.string(), z.string()).optional().describe("OData query parameters, e.g. {\"$filter\": \"accountEnabled eq true\", \"$select\": \"id,displayName\"}."),
      version: z.enum(["v1.0", "beta"]).optional().describe("Graph API version. Default v1.0."),
      consistency_eventual: z.boolean().optional().describe("Send ConsistencyLevel: eventual. Required for $count, $search, and some $filter forms."),
    },
    handler: async ({ path, query, version, consistency_eventual }) => {
      const headers = consistency_eventual ? { ConsistencyLevel: "eventual" } : undefined;
      const result = await httpJson(graphUrl(path, version, query), GRAPH_RESOURCE, "GET", undefined, headers);
      if (!result.ok) throw new Error(`Graph GET ${path} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
      return formatResult({ ok: true, http_status: result.status, path, body: result.body });
    },
  });

  defineTool(server, {
    name: "Graph_Request",
    title: "Graph Request",
    description:
      "Escape hatch: write to any Microsoft Graph endpoint (POST, PATCH, PUT, DELETE). Creates and updates users, group membership, app registrations, Conditional Access policies, and Intune configuration. DELETE needs the destructive gate. Permissions are bounded by the signed-in identity's Graph roles.",
    tier: "destructive",
    runtimeTier: ({ method }) => (method === "DELETE" ? "destructive" : "write"),
    impact: "an arbitrary Microsoft Graph DELETE",
    cli: "az rest --method <post|patch|put|delete> --url https://graph.microsoft.com/v1.0/<path>",
    ref: { method: "(caller-supplied)", path: "(caller-supplied Graph path)", apiVersion: "v1.0|beta" },
    inputSchema: {
      method: z.enum(["POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method. For reads use Graph_GET."),
      path: z.string().describe("Graph path beginning with '/', e.g. '/groups/{id}/members/$ref'."),
      body: z.record(z.string(), z.any()).optional().describe("Optional JSON request body."),
      query: z.record(z.string(), z.string()).optional().describe("Optional query parameters."),
      version: z.enum(["v1.0", "beta"]).optional().describe("Graph API version. Default v1.0."),
    },
    handler: async ({ method, path, body, query, version }) => {
      const result = await httpJson(graphUrl(path, version, query), GRAPH_RESOURCE, method, (body as JsonValue) ?? undefined);
      if (!result.ok) throw new Error(`Graph ${method} ${path} failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
      return formatResult({ ok: true, http_status: result.status, method, path, body: result.body });
    },
  });

  defineTool(server, {
    name: "List_Entra_Users",
    title: "List Entra Users",
    description: "List Microsoft Entra ID (Azure AD) users via Microsoft Graph. Requires directory read permission.",
    tier: "read",
    cli: "az ad user list",
    ref: { method: "GET", path: "https://graph.microsoft.com/v1.0/users", apiVersion: "v1.0" },
    inputSchema: listSchema("Optional OData $filter, e.g. \"startsWith(displayName,'Pat')\"."),
    handler: async ({ filter, top }) => {
      const { items, truncated } = await graphList("/users", filter, top, "id,displayName,userPrincipalName,mail,accountEnabled,userType");
      const users = items.map((u) => ({ id: u.id ?? null, display_name: u.displayName ?? null, user_principal_name: u.userPrincipalName ?? null, mail: u.mail ?? null, account_enabled: u.accountEnabled ?? null, user_type: u.userType ?? null }));
      return formatResult({ count: users.length, truncated, users });
    },
  });

  defineTool(server, {
    name: "List_Entra_Groups",
    title: "List Entra Groups",
    description: "List Microsoft Entra ID (Azure AD) groups via Microsoft Graph. Requires directory read permission.",
    tier: "read",
    cli: "az ad group list",
    ref: { method: "GET", path: "https://graph.microsoft.com/v1.0/groups", apiVersion: "v1.0" },
    inputSchema: listSchema("Optional OData $filter."),
    handler: async ({ filter, top }) => {
      const { items, truncated } = await graphList("/groups", filter, top, "id,displayName,mail,securityEnabled,groupTypes");
      const groups = items.map((g) => ({ id: g.id ?? null, display_name: g.displayName ?? null, mail: g.mail ?? null, security_enabled: g.securityEnabled ?? null, group_types: g.groupTypes ?? null }));
      return formatResult({ count: groups.length, truncated, groups });
    },
  });

  defineTool(server, {
    name: "List_Entra_Applications",
    title: "List Entra Applications",
    description: "List Microsoft Entra ID app registrations via Microsoft Graph. Requires directory read permission.",
    tier: "read",
    cli: "az ad app list",
    ref: { method: "GET", path: "https://graph.microsoft.com/v1.0/applications", apiVersion: "v1.0" },
    inputSchema: listSchema("Optional OData $filter."),
    handler: async ({ filter, top }) => {
      const { items, truncated } = await graphList("/applications", filter, top, "id,appId,displayName,signInAudience,createdDateTime");
      const applications = items.map((a) => ({ id: a.id ?? null, app_id: a.appId ?? null, display_name: a.displayName ?? null, sign_in_audience: a.signInAudience ?? null, created: a.createdDateTime ?? null }));
      return formatResult({ count: applications.length, truncated, applications });
    },
  });
}
