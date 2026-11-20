// Tenants: every configured tenant profile side by side, with whether its identity works and which
// subscriptions it reaches. Each profile is checked in parallel; one failing (a revoked secret, a missing
// role) shows on its own card and does not blank the others.

import type { McpServer } from "@modelcontextprotocol/server";
import { armCollect } from "../../client.js";
import { describeProfiles, PROFILES, withProfile } from "../../profiles.js";
import { str } from "../data.js";
import { registerView } from "../shell.js";

export function registerTenantView(server: McpServer): void {
  registerView(server, {
    name: "View_Tenants",
    title: "Tenants",
    description:
      "Interactive overview of every configured tenant profile (service principals and your az login): whether each identity can sign in, and the subscriptions it reaches. " +
      "Read-only. Use a profile's name as `profile` on any tool. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: {},
    invoking: "Checking tenant profiles…",
    invoked: "Tenant profiles checked",
    page: {
      title: "Azure Tenants",
      css: `.card table { margin-top:8px; } .card .tablewrap { max-height:220px; } .card.bad { border-color:var(--bad); }`,
      script: `
boot((root, view) => {
  const d = view.data;
  const profiles = d.profiles ?? [];
  const ok = profiles.filter((p) => p.ok).length;
  root.innerHTML = '<h1>Tenant profiles <span class="badge">' + profiles.length + '</span> <span class="badge ' + (ok === profiles.length ? 'ok' : 'warn') + '">' + ok + ' signed in</span></h1>'
    + '<p class="muted">Pass a profile name as <span class="mono">profile</span> on any tool, or pick it in the Tenant menu of any view. Add service principals in Settings &gt; Extensions &gt; Azure.</p>'
    + '<div class="grid" id="cards"></div>';
  const cards = $('#cards');
  cards.innerHTML = profiles.map((p, i) => '<div class="card' + (p.ok ? '' : ' bad') + '"><div class="title"><span>' + esc(p.name) + (p.is_default ? ' <span class="badge">default</span>' : '') + '</span>' + badge(p.ok ? 'ok' : 'failed') + '</div>'
    + '<dl class="kv"><dt>Identity</dt><dd>' + esc(p.kind === 'azure_cli' ? 'your az login' : 'service principal ' + (p.client_id ?? '')) + '</dd>'
    + '<dt>Tenant</dt><dd class="mono">' + esc(p.tenant_id ?? (p.subscriptions?.[0]?.tenant_id ?? '—')) + '</dd>'
    + '<dt>Subscriptions</dt><dd>' + (p.ok ? p.subscriptions.length : '—') + '</dd></dl>'
    + (p.ok ? '<div id="subs' + i + '"></div>' : errorBox(p.error ?? 'unknown error', 'This identity could not sign in.'))
    + '</div>').join('');
  profiles.forEach((p, i) => { if (p.ok) table($('#subs' + i), p.subscriptions, [
    { key: 'name', label: 'Subscription' }, { key: 'state', label: 'State', render: (v) => badge(v) }, { key: 'id', label: 'Id', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
  ], { placeholder: 'Filter…', empty: 'This identity reaches no subscriptions. Grant it a role (Reader or higher) on a subscription.' }); });
});
`,
    },
    load: async () => {
      const described = describeProfiles();
      const profiles = await Promise.all(
        PROFILES.map(async (profile, i) => {
          const base = described[i];
          try {
            const { items } = await withProfile(profile, () => armCollect("/subscriptions", { apiVersion: "2022-12-01" }));
            const subscriptions = items.map((s) => ({ id: str(s.subscriptionId), name: str(s.displayName), state: str(s.state), tenant_id: str(s.tenantId) }));
            return { ...base, ok: true, subscriptions };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ...base, ok: false, error: message.length > 400 ? `${message.slice(0, 400)}…` : message, subscriptions: [] };
          }
        }),
      );
      return { count: profiles.length, profiles };
    },
  });
}
