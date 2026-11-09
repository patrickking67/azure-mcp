// Azure Monitor: metrics, metric definitions, diagnostic settings, and Log Analytics KQL.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, dig, formatResult, httpJson, isJsonObject, LOG_ANALYTICS_BASE, LOG_ANALYTICS_RESOURCE, propsOf, type JsonObject } from "../client.js";
import { defineTool } from "./define.js";

const resourceIdParam = { resource_id: z.string().describe("Full ARM resource id.") };

function requireResourceId(resource_id: string): void {
  if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
}

export function registerMonitorTools(server: McpServer): void {
  defineTool(server, {
    name: "Get_Metrics",
    title: "Get Metrics",
    description: "Get Azure Monitor metrics for a resource, e.g. CPU for a VM. Use List Metric Definitions to discover metric names.",
    tier: "read",
    cli: "az monitor metrics list --resource <id> --metric <name>",
    ref: { method: "GET", path: "{resourceId}/providers/microsoft.insights/metrics", apiVersion: "2018-01-01" },
    inputSchema: {
      ...resourceIdParam,
      metric_names: z.string().optional().describe("Comma-separated metric names, e.g. 'Percentage CPU'. Omit for the default metric."),
      timespan: z.string().optional().describe("ISO 8601 range 'start/end', e.g. 2026-07-07T00:00:00Z/2026-07-08T00:00:00Z. Defaults to the last hour."),
      interval: z.string().optional().describe("ISO 8601 duration granularity, e.g. PT5M or PT1H."),
      aggregation: z.string().optional().describe("Comma-separated aggregations: Average, Minimum, Maximum, Total, Count."),
    },
    handler: async ({ resource_id, metric_names, timespan, interval, aggregation }) => {
      requireResourceId(resource_id);
      const { body } = await armRequest(`${resource_id}/providers/microsoft.insights/metrics`, { apiVersion: "2018-01-01", query: { metricnames: metric_names, timespan, interval, aggregation } });
      return formatResult(body);
    },
  });

  defineTool(server, {
    name: "List_Metric_Definitions",
    title: "List Metric Definitions",
    description: "List the metrics available for a resource (names, units, supported aggregations).",
    tier: "read",
    cli: "az monitor metrics list-definitions --resource <id>",
    ref: { method: "GET", path: "{resourceId}/providers/microsoft.insights/metricDefinitions", apiVersion: "2018-01-01" },
    inputSchema: resourceIdParam,
    handler: async ({ resource_id }) => {
      requireResourceId(resource_id);
      const { body } = await armRequest(`${resource_id}/providers/microsoft.insights/metricDefinitions`, { apiVersion: "2018-01-01" });
      const items = isJsonObject(body) && Array.isArray(body.value) ? body.value.filter(isJsonObject) : [];
      const definitions = items.map((d) => ({
        name: dig(d, "name", "value"),
        display_name: dig(d, "name", "localizedValue"),
        unit: d.unit ?? null,
        primary_aggregation: d.primaryAggregationType ?? null,
        supported_aggregations: d.supportedAggregationTypes ?? null,
      }));
      return formatResult({ resource_id, count: definitions.length, metric_definitions: definitions });
    },
  });

  defineTool(server, {
    name: "List_Diagnostic_Settings",
    title: "List Diagnostic Settings",
    description: "List diagnostic settings configured on a resource (where logs and metrics are routed).",
    tier: "read",
    cli: "az monitor diagnostic-settings list --resource <id>",
    ref: { method: "GET", path: "{resourceId}/providers/Microsoft.Insights/diagnosticSettings", apiVersion: "2021-05-01-preview" },
    inputSchema: resourceIdParam,
    handler: async ({ resource_id }) => {
      requireResourceId(resource_id);
      const { body } = await armRequest(`${resource_id}/providers/Microsoft.Insights/diagnosticSettings`, { apiVersion: "2021-05-01-preview" });
      const items = isJsonObject(body) && Array.isArray(body.value) ? body.value.filter(isJsonObject) : [];
      const settings = items.map((s) => {
        const props = propsOf(s);
        return { name: s.name ?? null, workspace_id: props.workspaceId ?? null, storage_account_id: props.storageAccountId ?? null, event_hub_name: props.eventHubName ?? null, logs: props.logs ?? null, metrics: props.metrics ?? null };
      });
      return formatResult({ resource_id, count: settings.length, diagnostic_settings: settings });
    },
  });

  defineTool(server, {
    name: "Query_Log_Analytics",
    title: "Query Log Analytics",
    description: "Run a KQL query against a Log Analytics workspace. Use List Log Analytics Workspaces to find the workspace customer_id (GUID).",
    tier: "read",
    cli: "az monitor log-analytics query -w <customer-id> --analytics-query <kql>",
    ref: { method: "POST", path: "https://api.loganalytics.io/v1/workspaces/{workspaceId}/query", apiVersion: "v1" },
    inputSchema: {
      workspace_id: z.string().describe("Log Analytics workspace customer id (GUID), not the ARM resource id."),
      query: z.string().describe("KQL query, e.g. 'Heartbeat | summarize count() by Computer | limit 10'."),
      timespan: z.string().optional().describe("Optional ISO 8601 duration or range, e.g. P1D or 2026-07-01T00:00:00Z/2026-07-08T00:00:00Z."),
    },
    handler: async ({ workspace_id, query, timespan }) => {
      if (!/^[0-9a-fA-F-]{36}$/.test(workspace_id)) throw new Error("workspace_id must be the workspace customer id GUID.");
      const requestBody: JsonObject = { query };
      if (timespan) requestBody.timespan = timespan;
      const result = await httpJson(new URL(`${LOG_ANALYTICS_BASE}/workspaces/${workspace_id}/query`), LOG_ANALYTICS_RESOURCE, "POST", requestBody);
      if (!result.ok) throw new Error(`Log Analytics query failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
      return formatResult(result.body);
    },
  });
}
