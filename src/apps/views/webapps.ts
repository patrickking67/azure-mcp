// App Service web apps and function apps, with Start / Stop / Restart buttons that call the gated tools.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveSubscription, resourceGraph } from "../../client.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { kqlLiteral, str } from "../data.js";
import { registerView } from "../shell.js";
import { ACTION_CSS, ACTION_JS } from "./actions.js";

export function registerWebAppView(server: McpServer): void {
  registerView(server, {
    name: "View_Web_Apps",
    title: "Web Apps",
    description:
      "Interactive App Service board: every web app and function app with its state, kind, default host name, HTTPS-only setting, region and resource group, with Start, Stop and Restart buttons. " +
      "Read-only to open. The buttons call Start_Web_App, Stop_Web_App and Restart_Web_App with confirm: true, so the gates apply to each click. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().optional().describe("Only apps in this resource group."),
    },
    invoking: "Reading web apps…",
    invoked: "Web apps ready",
    page: {
      title: "Azure Web Apps",
      css: ACTION_CSS,
      script: `
${ACTION_JS}
boot((root, view) => {
  const d = view.data;
  view.rows = d.web_apps ?? [];
  const stopped = view.rows.filter((r) => String(r.state).toLowerCase() !== 'running').length;
  root.innerHTML = '<h1>Web apps <span class="badge">' + view.rows.length + '</span>' + (stopped ? ' <span class="badge warn">' + stopped + ' not running</span>' : '') + '</h1>'
    + '<div class="status" id="status" role="status" aria-live="polite"></div><div id="list"></div>';
  const status = $('#status');
  table($('#list'), view.rows, [
    { key: 'name', label: 'Name' },
    { key: 'state', label: 'State', render: (v) => badge(v) },
    { key: 'kind', label: 'Kind', render: (v) => '<span class="muted">' + esc(v) + '</span>' },
    { key: 'host', label: 'Host', render: (v) => v ? '<span class="mono">' + esc(v) + '</span>' : '—' },
    { key: 'https_only', label: 'HTTPS only', render: (v) => badge(v ? 'true' : 'false') },
    { key: 'location', label: 'Region' },
    { key: 'resource_group', label: 'Resource group' },
    { key: 'id', label: '', cls: 'col-actions', render: (_v, r) => '<span class="actions">'
        + (String(r.state).toLowerCase() === 'running' ? actionButton(r, 'stop', 'Stop') + actionButton(r, 'restart', 'Restart') : actionButton(r, 'start', 'Start'))
        + '</span>' },
  ], {
    placeholder: 'Filter apps…',
    toolbar: '<button type="button" id="refresh">Refresh</button>',
    empty: 'No web apps in this subscription' + (view.input.resource_group ? ' and resource group ' + view.input.resource_group : '') + '.',
    onDraw: (el) => {
      wireActions(el, view, (a) => ({ start: 'Start_Web_App', stop: 'Stop_Web_App', restart: 'Restart_Web_App' })[a], (r) => ({ subscription_id: r.subscription_id, resource_group: r.resource_group, app_name: r.name }), status);
      $('#refresh', el).onclick = () => refresh(view, 'View_Web_Apps', status);
    },
  });
});
`,
    },
    load: async ({ subscription_id, resource_group }) => {
      const sub = await resolveSubscription(subscription_id);
      const rgFilter = resource_group ? `| where resourceGroup =~ '${kqlLiteral(resource_group, "resource_group")}' ` : "";
      const { rows, truncated } = await resourceGraph(
        [sub],
        "resources | where type =~ 'microsoft.web/sites' " +
          rgFilter +
          "| project id, name, subscriptionId, resourceGroup, location, kind, state = tostring(properties.state), host = tostring(properties.defaultHostName), " +
          "httpsOnly = tobool(properties.httpsOnly), plan = tostring(properties.serverFarmId) | order by name asc",
        5000,
      );
      const apps = rows.map((r) => ({
        id: str(r.id),
        name: str(r.name),
        subscription_id: str(r.subscriptionId),
        resource_group: str(r.resourceGroup),
        location: str(r.location),
        kind: str(r.kind),
        state: str(r.state),
        host: str(r.host),
        https_only: r.httpsOnly === true,
        plan: str(r.plan)?.split("/").pop() ?? null,
      }));
      return { subscription_id: sub, count: apps.length, truncated, web_apps: apps };
    },
  });
}
