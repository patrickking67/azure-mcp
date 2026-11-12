// Subscription overview: what is deployed where, what is unhealthy, what Advisor flags, the secure
// score and month-to-date spend, on one page.

import type { McpServer } from "@modelcontextprotocol/server";
import { armCollect, armRequest, dig, isJsonObject, propsOf, resolveSubscription, resourceGraph, type JsonObject } from "../../client.js";
import { costQuery } from "../../tools/governance.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { attempt, costRows, num, str } from "../data.js";
import { registerView } from "../shell.js";

export function registerEstateView(server: McpServer): void {
  registerView(server, {
    name: "View_Estate",
    title: "Azure Estate",
    description:
      "Interactive subscription overview: resource counts by type and region, resource groups by size, unhealthy resources, Advisor recommendations by category and impact, the Defender secure score, and month-to-date cost by service. " +
      "Read-only. Reads Resource Graph, Resource Health, Advisor, Defender and Cost Management in parallel; a source the identity cannot read is reported as a note and the rest still renders. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: { ...subscriptionSchema },
    invoking: "Reading the Azure estate…",
    invoked: "Azure estate ready",
    page: {
      title: "Azure Estate",
      script: `
boot((root, view) => {
  const d = view.data;
  const t = d.totals ?? {};
  const kpi = (label, value, cls, meta) => '<div class="card"><div class="title">' + esc(label) + '</div><div class="big" style="' + (cls ? 'color:var(--' + cls + ')' : '') + '">' + (value ?? '—') + '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') + '</div>';
  const adv = d.advisor_by_category ?? {};
  root.innerHTML = '<h1>' + esc(d.subscription?.name ?? 'Subscription') + ' <span class="badge mono">' + esc(d.subscription?.id) + '</span></h1>'
    + '<div class="grid">'
    + kpi('Resources', t.resources, '', (t.resource_groups ?? 0) + ' resource groups · ' + (t.types ?? 0) + ' types')
    + kpi('Regions', t.locations, '', (d.by_location ?? []).slice(0, 3).map((l) => l.location).join(', '))
    + kpi('Unhealthy', t.unhealthy, t.unhealthy ? 'bad' : 'ok', 'Resource Health not Available')
    + kpi('Advisor', t.advisor, t.advisor_high ? 'warn' : 'ok', (t.advisor_high ?? 0) + ' high impact')
    + kpi('Secure score', t.secure_score_pct == null ? '—' : Math.round(t.secure_score_pct) + '%', pctClass(t.secure_score_pct), 'Defender for Cloud')
    + kpi('Cost, month to date', fmtMoney(t.cost_mtd, t.currency), '', (d.top_services ?? []).slice(0, 2).map((s) => s.service).join(', '))
    + '</div>'
    + '<h2>Advisor</h2><div class="row">' + ['Cost','Security','HighAvailability','Performance','OperationalExcellence'].map((c) => '<span class="badge ' + (adv[c] ? 'warn' : 'ok') + '">' + esc(c) + ' ' + (adv[c] ?? 0) + '</span>').join('') + '</div>'
    + '<h2>Resource types</h2><div id="types"></div>'
    + '<h2>Resource groups</h2><div id="groups"></div>'
    + '<h2>Cost by service</h2><div id="services"></div>'
    + ((d.unhealthy ?? []).length ? '<h2>Unhealthy</h2><div id="unhealthy"></div>' : '')
    + ((d.notes ?? []).length ? '<div class="status" style="margin-top:8px">Partial data: ' + d.notes.map(esc).join('<br>') + '</div>' : '');
  table($('#types'), d.by_type ?? [], [
    { key: 'type', label: 'Type', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'count', label: 'Count' },
  ], { sortKey: 'count', asc: false, placeholder: 'Filter types…', empty: 'No resources in this subscription.' });
  table($('#groups'), d.resource_groups ?? [], [
    { key: 'name', label: 'Resource group' },
    { key: 'location', label: 'Region' },
    { key: 'resources', label: 'Resources' },
  ], { sortKey: 'resources', asc: false, placeholder: 'Filter groups…', empty: 'No resource groups in this subscription.' });
  const maxCost = Math.max(1, ...(d.top_services ?? []).map((s) => s.cost));
  table($('#services'), d.top_services ?? [], [
    { key: 'service', label: 'Service' },
    { key: 'cost', label: 'Cost', render: (v) => '<span class="bar"><i style="width:' + Math.round(100 * v / maxCost) + '%"></i></span>' + fmtMoney(v, t.currency) },
  ], { sortKey: 'cost', asc: false, placeholder: 'Filter services…', empty: 'No cost data yet this month, or no Cost Management Reader role.' });
  if ((d.unhealthy ?? []).length) table($('#unhealthy'), d.unhealthy, [
    { key: 'name', label: 'Resource' },
    { key: 'state', label: 'State', render: (v) => badge(v) },
    { key: 'summary', label: 'Summary' },
  ]);
});
`,
    },
    load: async ({ subscription_id }) => {
      const sub = await resolveSubscription(subscription_id);
      const notes: string[] = [];
      const [subscription, types, locations, groups, health, advisor, score, cost] = await Promise.all([
        attempt("subscription", () => armRequest(`/subscriptions/${sub}`, { apiVersion: "2022-12-01" }), notes),
        attempt("resource types", () => resourceGraph([sub], "resources | summarize count = count() by type | order by ['count'] desc", 500), notes),
        attempt("regions", () => resourceGraph([sub], "resources | summarize count = count() by location | order by ['count'] desc", 200), notes),
        attempt(
          "resource groups",
          () =>
            resourceGraph(
              [sub],
              "resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | extend rg = tolower(name) " +
                "| join kind=leftouter (resources | summarize resources = count() by rg = tolower(resourceGroup)) on rg " +
                "| project name, location, resources = coalesce(resources, 0) | order by resources desc",
              1000,
            ),
          notes,
        ),
        attempt("resource health", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.ResourceHealth/availabilityStatuses`, { apiVersion: "2020-05-01" }), notes),
        attempt("advisor", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.Advisor/recommendations`, { apiVersion: "2023-01-01" }), notes),
        attempt("secure score", () => armRequest(`/subscriptions/${sub}/providers/Microsoft.Security/secureScores/ascScore`, { apiVersion: "2020-01-01" }), notes),
        attempt("cost", () => costQuery(sub, { timeframe: "MonthToDate", group_by: "ServiceName" }), notes),
      ]);

      const byType = (types?.rows ?? []).map((r) => ({ type: str(r.type), count: num(r.count) }));
      const byLocation = (locations?.rows ?? []).map((r) => ({ location: str(r.location), count: num(r.count) }));
      const unhealthy = (health?.items ?? [])
        .map((s) => ({ id: str(s.id), name: str(s.id)?.split("/providers/Microsoft.ResourceHealth")[0].split("/").pop() ?? null, state: str(propsOf(s).availabilityState), summary: str(propsOf(s).summary) }))
        .filter((s) => s.state && s.state !== "Available");
      const advisorByCategory: Record<string, number> = {};
      let advisorHigh = 0;
      for (const r of advisor?.items ?? []) {
        const category = str(propsOf(r).category) ?? "Other";
        advisorByCategory[category] = (advisorByCategory[category] ?? 0) + 1;
        if (propsOf(r).impact === "High") advisorHigh += 1;
      }
      const services = costRows(cost)
        .map((r) => ({ service: str(r.ServiceName) ?? "(other)", cost: num(r.Cost), currency: str(r.Currency) }))
        .sort((a, b) => b.cost - a.cost);
      const scoreBody = score?.body;
      const subBody = isJsonObject(subscription?.body ?? null) ? (subscription?.body as JsonObject) : {};
      return {
        subscription: { id: sub, name: str(subBody.displayName), state: str(subBody.state) },
        totals: {
          resources: byType.reduce((n, t) => n + t.count, 0),
          types: byType.length,
          locations: byLocation.length,
          resource_groups: groups?.rows.length ?? null,
          unhealthy: health ? unhealthy.length : null,
          advisor: advisor ? advisor.items.length : null,
          advisor_high: advisorHigh,
          secure_score_pct: scoreBody ? Number(dig(scoreBody, "properties", "score", "percentage") ?? 0) * 100 : null,
          cost_mtd: cost ? services.reduce((n, s) => n + s.cost, 0) : null,
          currency: services[0]?.currency ?? "USD",
        },
        by_type: byType,
        by_location: byLocation,
        resource_groups: (groups?.rows ?? []).map((g) => ({ name: str(g.name), location: str(g.location), resources: num(g.resources) })),
        unhealthy,
        advisor_by_category: advisorByCategory,
        top_services: services.slice(0, 25),
        notes,
      };
    },
  });
}
