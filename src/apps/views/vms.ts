// Virtual machines with live power state from Resource Graph, and Start / Deallocate / Restart buttons
// that call Start_VM, Stop_VM and Restart_VM.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveSubscription, resourceGraph } from "../../client.js";
import { subscriptionSchema } from "../../tools/shared.js";
import { kqlLiteral, str } from "../data.js";
import { registerView } from "../shell.js";
import { ACTION_CSS, ACTION_JS } from "./actions.js";

export function registerVmView(server: McpServer): void {
  registerView(server, {
    name: "View_Virtual_Machines",
    title: "Virtual Machines",
    description:
      "Interactive virtual machine board: every VM with its power state, size, OS, region and resource group, filterable and sortable, with Start, Deallocate and Restart buttons. " +
      "Read-only to open. The buttons call Start_VM, Stop_VM and Restart_VM with confirm: true, so the write and destructive gates apply to each click. The same data is returned as JSON for hosts without MCP Apps.",
    inputSchema: {
      ...subscriptionSchema,
      resource_group: z.string().optional().describe("Only VMs in this resource group."),
    },
    invoking: "Reading virtual machines…",
    invoked: "Virtual machines ready",
    page: {
      title: "Azure Virtual Machines",
      css: ACTION_CSS,
      script: `
${ACTION_JS}
boot((root, view) => {
  const d = view.data;
  view.rows = d.virtual_machines ?? [];
  const counts = view.rows.reduce((m, r) => { m[r.power] = (m[r.power] ?? 0) + 1; return m; }, {});
  root.innerHTML = '<h1>Virtual machines <span class="badge">' + view.rows.length + '</span>'
    + Object.entries(counts).map(([k, n]) => ' ' + badge(k + ' ' + n)).join('')
    + (d.truncated ? ' <span class="badge warn">truncated</span>' : '') + '</h1>'
    + '<div class="status" id="status" role="status" aria-live="polite"></div><div id="list"></div>';
  const status = $('#status');
  table($('#list'), view.rows, [
    { key: 'name', label: 'Name' },
    { key: 'power', label: 'Power', render: (v) => badge(v) },
    { key: 'size', label: 'Size', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'os', label: 'OS' },
    { key: 'location', label: 'Region' },
    { key: 'resource_group', label: 'Resource group' },
    { key: 'id', label: '', cls: 'col-actions', render: (_v, r) => '<span class="actions">'
        + (r.power === 'running' ? actionButton(r, 'deallocate', 'Deallocate') + actionButton(r, 'restart', 'Restart') : actionButton(r, 'start', 'Start'))
        + '</span>' },
  ], {
    placeholder: 'Filter VMs…',
    toolbar: '<button type="button" id="refresh">Refresh</button>',
    empty: 'No virtual machines in this subscription' + (view.input.resource_group ? ' and resource group ' + view.input.resource_group : '') + '.',
    onDraw: (el) => {
      wireActions(el, view, (a) => ({ start: 'Start_VM', deallocate: 'Stop_VM', restart: 'Restart_VM' })[a], (r) => ({ subscription_id: r.subscription_id, resource_group: r.resource_group, vm_name: r.name }), status);
      $('#refresh', el).onclick = () => refresh(view, 'View_Virtual_Machines', status);
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
        "resources | where type =~ 'microsoft.compute/virtualmachines' " +
          rgFilter +
          "| project id, name, subscriptionId, resourceGroup, location, power = tostring(properties.extended.instanceView.powerState.code), " +
          "size = tostring(properties.hardwareProfile.vmSize), os = tostring(properties.storageProfile.osDisk.osType), provisioning = tostring(properties.provisioningState) " +
          "| order by name asc",
        5000,
      );
      const vms = rows.map((r) => ({
        id: str(r.id),
        name: str(r.name),
        subscription_id: str(r.subscriptionId),
        resource_group: str(r.resourceGroup),
        location: str(r.location),
        power: (str(r.power) ?? "unknown").replace(/^PowerState\//, ""),
        size: str(r.size),
        os: str(r.os),
        provisioning_state: str(r.provisioning),
      }));
      return { subscription_id: sub, count: vms.length, truncated, virtual_machines: vms };
    },
  });
}
