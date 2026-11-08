// Security posture: Defender secure score and its weakest controls, active Defender alerts, Advisor
// security recommendations, and Azure Policy non-compliance.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { armCollect, armRequest, dig, isJsonObject, propsOf, resolveSubscription, type JsonValue } from "../../client.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { attempt, num, str } from "../data.js";
import { registerView } from "../shell.js";

export function registerSecurityView(server: McpServer): void {
  registerView(server, {
    name: "View_Security",
    title: "Security Posture",
    description:
      "Interactive security posture: Defender for Cloud secure score with the controls losing the most points, active Defender alerts by severity, Advisor security recommendations, and Azure Policy non-compliance. " +
      "Read-only. Sources the identity cannot read (no Defender plan, no policy reader) are reported as notes. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: { ...subscriptionSchema },
    invoking: "Reading security posture…",
    invoked: "Security posture ready",
    page: {
      title: "Azure Security Posture",
      script: `
boot((root, view) => {
  const d = view.data;
  const t = d.totals ?? {};
  const kpi = (label, value, cls, meta) => '<div class="card"><div class="title">' + esc(label) + '</div><div class="big" style="' + (cls ? 'color:var(--' + cls + ')' : '') + '">' + (value ?? '—') + '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') + '</div>';
  root.innerHTML = '<h1>Security posture</h1><div class="grid">'
    + kpi('Secure score', t.secure_score_pct == null ? '—' : Math.round(t.secure_score_pct) + '%', pctClass(t.secure_score_pct), t.secure_score_current == null ? '' : t.secure_score_current + ' of ' + t.secure_score_max + ' points')
    + kpi('Active alerts', t.alerts, t.alerts_high ? 'bad' : t.alerts ? 'warn' : 'ok', (t.alerts_high ?? 0) + ' high · ' + (t.alerts_medium ?? 0) + ' medium')
    + kpi('Advisor security', t.advisor_security, t.advisor_security ? 'warn' : 'ok', 'recommendations')
    + kpi('Non-compliant resources', t.noncompliant_resources, t.noncompliant_resources ? 'warn' : 'ok', (t.noncompliant_policies ?? 0) + ' policies')
    + '</div><h2>Weakest controls</h2><div id="controls"></div><h2>Active alerts</h2><div id="alerts"></div><h2>Advisor</h2><div id="advisor"></div>'
    + ((d.notes ?? []).length ? '<div class="status" style="margin-top:8px">Partial data: ' + d.notes.map(esc).join('<br>') + '</div>' : '');
  table($('#controls'), d.controls ?? [], [
    { key: 'name', label: 'Control' },
    { key: 'percentage', label: 'Score', render: (v) => bar(v) },
    { key: 'unhealthy', label: 'Unhealthy resources' },
    { key: 'potential', label: 'Points to gain' },
  ], { sortKey: 'potential', asc: false, placeholder: 'Filter controls…', empty: 'No secure score controls. Defender for Cloud may not be enabled on this subscription.' });
  table($('#alerts'), d.alerts ?? [], [
    { key: 'severity', label: 'Severity', render: (v) => badge(v) },
    { key: 'name', label: 'Alert' },
    { key: 'entity', label: 'Entity' },
    { key: 'time', label: 'When', render: (v) => esc(fmtAgo(v)) },
  ], { sortKey: 'time', asc: false, placeholder: 'Filter alerts…', empty: 'No active Defender alerts.' });
  table($('#advisor'), d.advisor ?? [], [
    { key: 'impact', label: 'Impact', render: (v) => badge(v) },
    { key: 'problem', label: 'Problem' },
    { key: 'resource', label: 'Resource' },
  ], { placeholder: 'Filter recommendations…', empty: 'No Advisor security recommendations.' });
});
`,
    },
    load: async ({ subscription_id }) => {
      const sub = await resolveSubscription(subscription_id);
      const notes: string[] = [];
      const [score, controls, alerts, advisor, policy] = await Promise.all([
        attempt("secure score", () => armRequest(`/subscriptions/${sub}/providers/Microsoft.Security/secureScores/ascScore`, { apiVersion: "2020-01-01" }), notes),
        attempt("secure score controls", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.Security/secureScoreControls`, { apiVersion: "2020-01-01" }), notes),
        attempt("Defender alerts", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.Security/alerts`, { apiVersion: "2022-01-01" }), notes),
        attempt("Advisor", () => armCollect(`/subscriptions/${sub}/providers/Microsoft.Advisor/recommendations`, { apiVersion: "2023-01-01", query: { $filter: "Category eq 'Security'" } }), notes),
        attempt(
          "Policy compliance",
          () => armRequest(`/subscriptions/${sub}/providers/Microsoft.PolicyInsights/policyStates/latest/summarize`, { apiVersion: "2019-10-01", method: "POST" }),
          notes,
        ),
      ]);
      const scoreProps = score && isJsonObject(score.body) ? propsOf(score.body) : {};
      const activeAlerts = (alerts?.items ?? [])
        .map((a) => ({ name: str(propsOf(a).alertDisplayName), severity: str(propsOf(a).severity), status: str(propsOf(a).status), entity: str(propsOf(a).compromisedEntity), time: str(propsOf(a).timeGeneratedUtc) }))
        .filter((a) => a.status === "Active" || a.status === "InProgress");
      const summary = policy && isJsonObject(policy.body) && Array.isArray(policy.body.value) ? (policy.body.value as JsonValue[]).find(isJsonObject) : undefined;
      const results = summary && isJsonObject(summary) ? summary.results : null;
      return {
        subscription_id: sub,
        totals: {
          secure_score_pct: score ? num(dig(scoreProps, "score", "percentage")) * 100 : null,
          secure_score_current: score ? num(dig(scoreProps, "score", "current")) : null,
          secure_score_max: score ? num(dig(scoreProps, "score", "max")) : null,
          alerts: alerts ? activeAlerts.length : null,
          alerts_high: activeAlerts.filter((a) => a.severity === "High").length,
          alerts_medium: activeAlerts.filter((a) => a.severity === "Medium").length,
          advisor_security: advisor ? advisor.items.length : null,
          noncompliant_resources: results ? num(dig(results, "nonCompliantResources")) : null,
          noncompliant_policies: results ? num(dig(results, "nonCompliantPolicies")) : null,
        },
        controls: (controls?.items ?? [])
          .map((c) => {
            const p = propsOf(c);
            const max = num(dig(p, "score", "max"));
            const current = num(dig(p, "score", "current"));
            return { name: str(p.displayName), percentage: num(dig(p, "score", "percentage")) * 100, unhealthy: num(p.unhealthyResourceCount), potential: Math.round((max - current) * 100) / 100 };
          })
          .filter((c) => c.potential > 0),
        alerts: activeAlerts,
        advisor: (advisor?.items ?? []).map((r) => ({ impact: str(propsOf(r).impact), problem: str(dig(propsOf(r), "shortDescription", "problem")), resource: str(propsOf(r).impactedValue) })),
        notes,
      };
    },
  });
}
