// Resource explorer: every resource in scope from Resource Graph, filterable by type and text, with
// a detail panel that loads the full ARM document through Get_Resource on demand.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSubscription, resourceGraph } from "../../client.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { kqlLiteral, str } from "../data.js";
import { registerView } from "../shell.js";

export function registerResourceView(server: McpServer): void {
  registerView(server, {
    name: "View_Resources",
    title: "Resource Explorer",
    description:
      "Interactive resource explorer: every resource in a subscription (or one resource group, or of one type) with type, region, SKU and tags, filterable and sortable. " +
      "Selecting a row loads its full ARM document through Get_Resource. Read-only. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().optional().describe("Only resources in this resource group."),
      resource_type: z.string().optional().describe("Only this ARM type, e.g. microsoft.storage/storageaccounts."),
      max_rows: z.number().int().min(100).max(20000).optional().describe("Most resources to read. Default 5000; the result says when it was cut short."),
    },
    invoking: "Reading resources…",
    invoked: "Resources ready",
    page: {
      title: "Azure Resources",
      css: `.detail { margin-top:10px; } .detail pre { max-height:360px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px; margin:6px 0 0; white-space:pre-wrap; word-break:break-all; } `,
      script: `
boot((root, view) => {
  const d = view.data;
  const rows = d.resources ?? [];
  const types = [...new Set(rows.map((r) => r.type))].sort();
  root.innerHTML = '<h1>Resources <span class="badge">' + rows.length + '</span>' + (d.truncated ? ' <span class="badge warn">truncated</span>' : '') + '</h1><div id="list"></div><div class="detail" id="detail"></div>';
  const t = table($('#list'), rows, [
    { key: 'name', label: 'Name', render: (v, r) => '<button type="button" class="link" data-open="' + esc(r.id) + '" aria-label="Show the ARM document for ' + esc(v) + '">' + esc(v) + '</button>' },
    { key: 'type', label: 'Type', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'location', label: 'Region' },
    { key: 'resource_group', label: 'Resource group' },
    { key: 'sku', label: 'SKU' },
    { key: 'tags', label: 'Tags', render: (v) => v ? Object.entries(v).slice(0, 3).map(([k, x]) => '<span class="badge">' + esc(k) + '=' + esc(x) + '</span>').join(' ') : '<span class="muted">—</span>' },
  ], {
    placeholder: 'Filter resources…',
    empty: 'No resources match this scope. Check the subscription, resource group or type filter.',
    toolbar: '<select id="type" aria-label="Resource type"><option value="">All types (' + types.length + ')</option>' + types.map((x) => '<option>' + esc(x) + '</option>').join('') + '</select>',
    onDraw: (el) => {
      const sel = $('#type', el);
      sel.value = view.typeFilter ?? '';
      sel.onchange = () => { view.typeFilter = sel.value; t.setPredicate(sel.value ? (r) => r.type === sel.value : null); };
      el.querySelectorAll('[data-open]').forEach((a) => { a.onclick = async () => {
        const detail = $('#detail');
        detail.innerHTML = '<div class="status">Loading ' + esc(a.dataset.open) + '…</div>';
        try {
          const doc = await view.call('Get_Resource', { resource_id: a.dataset.open });
          detail.innerHTML = '<h2>' + esc(a.textContent) + '</h2><div class="mono muted">' + esc(a.dataset.open) + '</div><pre></pre>';
          $('pre', detail).textContent = JSON.stringify(doc, null, 2);
        } catch (e) { detail.innerHTML = errorBox(e.message, 'Could not read this resource.'); }
      }; });
    },
  });
});
`,
    },
    load: async ({ subscription_id, resource_group, resource_type, max_rows }) => {
      const sub = await resolveSubscription(subscription_id);
      let query = "resources ";
      if (resource_group) query += `| where resourceGroup =~ '${kqlLiteral(resource_group, "resource_group")}' `;
      if (resource_type) query += `| where type =~ '${kqlLiteral(resource_type, "resource_type")}' `;
      query += "| project id, name, type, resourceGroup, location, kind, sku = tostring(sku.name), tags | order by type asc, name asc";
      const { rows, truncated } = await resourceGraph([sub], query, max_rows ?? 5000);
      const resources = rows.map((r) => ({
        id: str(r.id),
        name: str(r.name),
        type: str(r.type),
        resource_group: str(r.resourceGroup),
        location: str(r.location),
        kind: str(r.kind),
        sku: str(r.sku),
        tags: r.tags ?? null,
      }));
      return { subscription_id: sub, count: resources.length, truncated, resources };
    },
  });
}
