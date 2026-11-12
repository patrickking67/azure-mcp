// Health, Advisor, RBAC, the activity log, cost, and resource-group / resource lifecycle.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { armCollect, armRequest, dig, formatResult, isJsonObject, propsOf, resolveSubscription, type JsonObject } from "../client.js";
import { defineTool } from "./define.js";
import { segment, subscriptionSchema } from "./shared.js";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function registerGovernanceTools(server: McpServer): void {
  defineTool(server, {
    name: "Resource_Health",
    title: "Resource Health",
    description: "Report availability status for resources in a subscription.",
    tier: "read",
    cli: "az rest --uri /subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2020-05-01",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses", apiVersion: "2020-05-01" },
    inputSchema: { ...subscriptionSchema },
    handler: async ({ subscription_id }) => {
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
  });

  defineTool(server, {
    name: "List_Advisor_Recommendations",
    title: "List Advisor Recommendations",
    description: "List Azure Advisor recommendations for a subscription, optionally filtered by category.",
    tier: "read",
    cli: "az advisor recommendation list [--category <c>]",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.Advisor/recommendations", apiVersion: "2023-01-01" },
    inputSchema: {
      ...subscriptionSchema,
      category: z.enum(["Cost", "HighAvailability", "Performance", "Security", "OperationalExcellence"]).optional().describe("Optional Advisor category filter."),
    },
    handler: async ({ subscription_id, category }) => {
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
  });

  defineTool(server, {
    name: "List_Role_Assignments",
    title: "List Role Assignments",
    description: "List role assignments in a subscription.",
    tier: "read",
    cli: "az role assignment list --all",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.Authorization/roleAssignments", apiVersion: "2022-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      filter: z.string().optional().describe("Optional OData $filter, e.g. \"principalId eq '{guid}'\" or \"atScope()\"."),
    },
    handler: async ({ subscription_id, filter }) => {
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
  });

  defineTool(server, {
    name: "List_Role_Definitions",
    title: "List Role Definitions",
    description: "List RBAC role definitions visible at subscription scope, optionally custom roles only.",
    tier: "read",
    cli: "az role definition list [--custom-role-only]",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.Authorization/roleDefinitions", apiVersion: "2022-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      custom_only: z.boolean().optional().describe("Only return custom roles."),
    },
    handler: async ({ subscription_id, custom_only }) => {
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
  });

  defineTool(server, {
    name: "List_Activity_Log",
    title: "List Activity Log",
    description: "List activity log events in a subscription from a start time.",
    tier: "read",
    cli: "az monitor activity-log list --start-time <t>",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.Insights/eventtypes/management/values", apiVersion: "2015-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      start_time: z.string().describe("Start of the window as an ISO 8601 timestamp, e.g. 2026-07-01T00:00:00Z. The activity log retains 90 days."),
      end_time: z.string().optional().describe("Optional end of the window as an ISO 8601 timestamp. Defaults to now."),
      resource_group: z.string().optional().describe("Optional resource group name to scope events."),
    },
    handler: async ({ subscription_id, start_time, end_time, resource_group }) => {
      const sub = await resolveSubscription(subscription_id);
      // Values land inside an OData string literal; a quote would end it.
      if (!ISO_TIME.test(start_time) || (end_time && !ISO_TIME.test(end_time))) throw new Error("start_time and end_time must be ISO 8601 timestamps.");
      if (resource_group?.includes("'")) throw new Error("resource_group cannot contain a quote.");
      let filter = `eventTimestamp ge '${start_time}'`;
      if (end_time) filter += ` and eventTimestamp le '${end_time}'`;
      if (resource_group) filter += ` and resourceGroupName eq '${resource_group}'`;
      const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Insights/eventtypes/management/values`, { apiVersion: "2015-04-01", query: { $filter: filter } });
      const events = items.map((e) => {
        const operation = isJsonObject(e.operationName) ? (e.operationName.localizedValue ?? e.operationName.value ?? null) : null;
        const status = isJsonObject(e.status) ? (e.status.value ?? null) : null;
        return { event_timestamp: e.eventTimestamp ?? null, operation_name: operation, status, level: e.level ?? null, resource_group: e.resourceGroupName ?? null, resource_id: e.resourceId ?? null, caller: e.caller ?? null, correlation_id: e.correlationId ?? null };
      });
      return formatResult({ subscription_id: sub, start_time, end_time: end_time ?? null, count: events.length, truncated, events });
    },
  });

  defineTool(server, {
    name: "Query_Costs",
    title: "Query Costs",
    description: "Query subscription cost data from Cost Management, grouped by a dimension (default: service name).",
    tier: "read",
    cli: "az costmanagement query --type ActualCost --scope subscriptions/<sub>",
    ref: { method: "POST", path: "/subscriptions/{sub}/providers/Microsoft.CostManagement/query", apiVersion: "2023-11-01" },
    inputSchema: {
      ...subscriptionSchema,
      timeframe: z.enum(["MonthToDate", "BillingMonthToDate", "TheLastMonth", "TheLastBillingMonth", "WeekToDate", "Custom"]).optional().describe("Reporting window. Default MonthToDate."),
      from_date: z.string().optional().describe("Start date (ISO 8601) when timeframe is Custom."),
      to_date: z.string().optional().describe("End date (ISO 8601) when timeframe is Custom."),
      group_by: z.string().optional().describe("Dimension to group by, e.g. ServiceName, ResourceGroupName, ResourceLocation, MeterCategory. Default ServiceName."),
      granularity: z.enum(["None", "Daily", "Monthly"]).optional().describe("Time granularity. Default None (single total per group)."),
    },
    handler: async ({ subscription_id, timeframe, from_date, to_date, group_by, granularity }) => {
      const sub = await resolveSubscription(subscription_id);
      return formatResult({ subscription_id: sub, ...(await costQuery(sub, { timeframe, from_date, to_date, group_by, granularity })) });
    },
  });

  defineTool(server, {
    name: "Tag_Resource",
    title: "Tag Resource",
    description: "Merge tags onto a resource by ARM resource id.",
    tier: "write",
    cli: "az tag update --resource-id <id> --operation Merge --tags k=v",
    ref: { method: "PATCH", path: "{resourceId}/providers/Microsoft.Resources/tags/default", apiVersion: "2021-04-01" },
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id (starts with /subscriptions/...)."),
      tags: z.record(z.string(), z.string()).describe("Tag key/value pairs to merge."),
    },
    handler: async ({ resource_id, tags }) => {
      if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
      // The Tags API merges without needing the resource's own api-version, and works on every resource type.
      const { body } = await armRequest(`${resource_id}/providers/Microsoft.Resources/tags/default`, { apiVersion: "2021-04-01", method: "PATCH", body: { operation: "Merge", properties: { tags } } });
      return formatResult({ ok: true, resource_id, tags, result: body });
    },
  });

  defineTool(server, {
    name: "Create_Resource_Group",
    title: "Create Resource Group",
    description: "Create or update a resource group.",
    tier: "write",
    cli: "az group create -n <rg> -l <location>",
    ref: { method: "PUT", path: "/subscriptions/{sub}/resourceGroups/{rg}", apiVersion: "2021-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group name to create or update."),
      location: z.string().describe("Azure region for the group, e.g. eastus."),
      tags: z.record(z.string(), z.string()).optional().describe("Optional tag key/value pairs."),
    },
    handler: async ({ subscription_id, resource_group, location, tags }) => {
      const sub = await resolveSubscription(subscription_id);
      const requestBody: JsonObject = { location };
      if (tags) requestBody.tags = tags;
      const { status, body } = await armRequest(`/subscriptions/${sub}/resourceGroups/${segment(resource_group, "resource_group")}`, { apiVersion: "2021-04-01", method: "PUT", body: requestBody });
      return formatResult({ ok: true, action: "create", subscription_id: sub, resource_group, location, http_status: status, result: body });
    },
  });

  defineTool(server, {
    name: "Delete_Resource_Group",
    title: "Delete Resource Group",
    description: "Delete a resource group and all resources in it.",
    tier: "destructive",
    impact: "deletes the group and every resource in it",
    cli: "az group delete -n <rg> --yes",
    ref: { method: "DELETE", path: "/subscriptions/{sub}/resourceGroups/{rg}", apiVersion: "2021-04-01" },
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().describe("Resource group name to delete. This deletes the group and every resource inside it."),
    },
    handler: async ({ subscription_id, resource_group }) => {
      const sub = await resolveSubscription(subscription_id);
      const { status } = await armRequest(`/subscriptions/${sub}/resourceGroups/${segment(resource_group, "resource_group")}`, { apiVersion: "2021-04-01", method: "DELETE" });
      return formatResult({ ok: true, action: "delete", subscription_id: sub, resource_group, http_status: status, note: status === 202 ? "Accepted; deletion is asynchronous and removes all resources in the group." : "Completed." });
    },
  });

  defineTool(server, {
    name: "Delete_Resource",
    title: "Delete Resource",
    description: "Delete a single resource by its full ARM resource id. Irreversible.",
    tier: "destructive",
    impact: "deletes the resource",
    cli: "az resource delete --ids <id>",
    ref: { method: "DELETE", path: "(full ARM resource id)", apiVersion: "(auto-negotiated)" },
    inputSchema: {
      resource_id: z.string().describe("Full ARM resource id of the resource to delete."),
      api_version: z.string().optional().describe("Optional ARM api-version. If omitted or wrong, the supported version is auto-negotiated."),
    },
    handler: async ({ resource_id, api_version }) => {
      if (!resource_id.startsWith("/")) throw new Error("resource_id must start with '/'.");
      const { status } = await armRequest(resource_id, { apiVersion: api_version ?? "2021-04-01", method: "DELETE" });
      return formatResult({ ok: true, action: "delete", resource_id, http_status: status, note: status === 202 ? "Accepted; deletion is asynchronous." : "Completed." });
    },
  });
}

export async function costQuery(
  sub: string,
  options: { timeframe?: string; from_date?: string; to_date?: string; group_by?: string; granularity?: string; ungrouped?: boolean },
): Promise<JsonObject> {
  const timeframe = options.timeframe ?? "MonthToDate";
  const requestBody: JsonObject = {
    type: "ActualCost",
    timeframe,
    dataset: {
      granularity: options.granularity ?? "None",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: options.group_by ?? "ServiceName" }],
    },
  };
  if (options.ungrouped) (requestBody.dataset as JsonObject).grouping = [];
  if (timeframe === "Custom") {
    if (!options.from_date || !options.to_date) throw new Error("from_date and to_date are required when timeframe is Custom.");
    requestBody.timePeriod = { from: options.from_date, to: options.to_date };
  }
  const { body } = await armRequest(`/subscriptions/${sub}/providers/Microsoft.CostManagement/query`, { apiVersion: "2023-11-01", method: "POST", body: requestBody });
  const props = isJsonObject(body) ? propsOf(body) : {};
  return { columns: props.columns ?? null, rows: props.rows ?? null, next_link: props.nextLink ?? null };
}
