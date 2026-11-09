// Spend: the total, a daily trend, the services and resource groups it went to, and budgets against it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armCollect, dig, propsOf, resolveSubscription } from "../../client.js";
import { costQuery } from "../../tools/governance.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { attempt, costRows, num, str } from "../data.js";
import { registerView } from "../shell.js";

function usageDate(value: unknown): string | null {
  const s = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null;
}

export function registerCostView(server: McpServer): void {
  registerView(server, {
    name: "View_Costs",
    title: "Azure Costs",
    description:
      "Interactive cost view: total actual cost for the period, a daily trend, cost by service and by resource group, and budgets with their current spend. " +
      "Read-only. Needs Cost Management Reader (or Reader) on the subscription. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: {
      ...subscriptionSchema,
      timeframe: z.enum(["MonthToDate", "TheLastMonth", "BillingMonthToDate", "TheLastBillingMonth"]).optional().describe("Period. Default MonthToDate."),
    },
    invoking: "Reading costs…",
    invoked: "Costs ready",
    page: {
      title: "Azure Costs",
      css: `.spark { display:flex; align-items:flex-end; gap:2px; height:90px; padding:6px 0; } .spark i { flex:1; background:var(--accent); border-radius:2px 2px 0 0; min-height:1px; opacity:.85; } .spark i:hover { opacity:1; }`,
      script: `
boot((root, view) => {
  const d = view.data;
  const cur = d.currency;
  const maxDay = Math.max(0.01, ...(d.daily ?? []).map((x) => x.cost));
  root.innerHTML = '<h1>Costs <span class="badge">' + esc(d.timeframe) + '</span></h1>'
    + '<div class="grid">'
    + '<div class="card"><div class="title">Total</div><div class="big">' + fmtMoney(d.total, cur) + '</div><div class="meta">actual cost</div></div>'
    + '<div class="card"><div class="title">Daily average</div><div class="big">' + fmtMoney((d.daily ?? []).length ? d.total / d.daily.length : null, cur) + '</div><div class="meta">' + (d.daily ?? []).length + ' days</div></div>'
    + '<div class="card"><div class="title">Top service</div><div class="big" style="font-size:16px">' + esc(d.by_service?.[0]?.service ?? '—') + '</div><div class="meta">' + fmtMoney(d.by_service?.[0]?.cost, cur) + '</div></div>'
    + '</div>'
    + '<h2>Daily</h2>' + ((d.daily ?? []).length
      ? '<div class="card"><div class="spark" role="img" aria-label="' + esc('Daily cost for ' + d.daily.length + ' days, highest ' + fmtMoney(maxDay, cur)) + '">' + d.daily.map((x) => '<i title="' + esc(x.date + ': ' + fmtMoney(x.cost, cur)) + '" style="height:' + Math.max(1, Math.round(100 * x.cost / maxDay)) + '%"></i>').join('') + '</div></div>'
      : emptyBox('No daily cost data for this period yet.'))
    + '<h2>By service</h2><div id="svc"></div><h2>By resource group</h2><div id="rg"></div>'
    + ((d.budgets ?? []).length ? '<h2>Budgets</h2><div id="budgets"></div>' : '')
    + ((d.notes ?? []).length ? '<div class="status" style="margin-top:8px">Partial data: ' + d.notes.map(esc).join('<br>') + '</div>' : '');
  const money = (v) => fmtMoney(v, cur);
  const share = (rows) => { const max = Math.max(0.01, ...rows.map((r) => r.cost)); return (v) => '<span class="bar"><i style="width:' + Math.round(100 * v / max) + '%"></i></span>' + money(v); };
  table($('#svc'), d.by_service ?? [], [{ key: 'service', label: 'Service' }, { key: 'cost', label: 'Cost', render: share(d.by_service ?? []) }], { sortKey: 'cost', asc: false, placeholder: 'Filter services…', empty: 'No cost by service for this period.' });
  table($('#rg'), d.by_resource_group ?? [], [{ key: 'resource_group', label: 'Resource group' }, { key: 'cost', label: 'Cost', render: share(d.by_resource_group ?? []) }], { sortKey: 'cost', asc: false, placeholder: 'Filter groups…', empty: 'No cost by resource group for this period.' });
  if ((d.budgets ?? []).length) table($('#budgets'), d.budgets, [
    { key: 'name', label: 'Budget' },
    { key: 'amount', label: 'Amount', render: money },
    { key: 'current_spend', label: 'Spent', render: money },
    { key: 'used_pct', label: 'Used', render: (v) => v == null ? '—' : '<span class="bar ' + (v >= 100 ? 'bad' : v >= 80 ? 'warn' : '') + '"><i style="width:' + Math.min(100, v) + '%"></i></span>' + Math.round(v) + '%' },
    { key: 'time_grain', label: 'Grain' },
  ], { sortKey: 'used_pct', asc: false });
});
`,
    },
    load: async ({ subscription_id, timeframe }) => {
      const sub = await resolveSubscription(subscription_id);
      const period = timeframe ?? "MonthToDate";
      const notes: string[] = [];
      const [service, group, daily, budgets] = await Promise.all([
        attempt("by service", () => costQuery(sub, { timeframe: period, group_by: "ServiceName" }), notes),
        attempt("by resource group", () => costQuery(sub, { timeframe: period, group_by: "ResourceGroupName" }), notes),
        attempt("daily", () => costQuery(sub, { timeframe: period, granularity: "Daily", ungrouped: true }), notes),
        attempt("budgets", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.Consumption/budgets`, { apiVersion: "2023-05-01" }), notes),
      ]);
      const byService = costRows(service).map((r) => ({ service: str(r.ServiceName) ?? "(other)", cost: num(r.Cost), currency: str(r.Currency) })).sort((a, b) => b.cost - a.cost);
      const byGroup = costRows(group).map((r) => ({ resource_group: str(r.ResourceGroupName) ?? "(none)", cost: num(r.Cost) })).sort((a, b) => b.cost - a.cost);
      const days = costRows(daily).map((r) => ({ date: usageDate(r.UsageDate), cost: num(r.Cost) })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const total = days.length ? days.reduce((n, d) => n + d.cost, 0) : byService.reduce((n, s) => n + s.cost, 0);
      return {
        subscription_id: sub,
        timeframe: period,
        currency: byService[0]?.currency ?? "USD",
        total,
        daily: days,
        by_service: byService,
        by_resource_group: byGroup,
        budgets: (budgets?.items ?? []).map((b) => {
          const amount = num(propsOf(b).amount);
          const spent = num(dig(propsOf(b), "currentSpend", "amount"));
          return { name: str(b.name), amount, current_spend: spent, used_pct: amount > 0 ? (100 * spent) / amount : null, time_grain: str(propsOf(b).timeGrain) };
        }),
        notes,
      };
    },
  });
}
