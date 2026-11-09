// Virtual machines, App Service and AKS: reads and the power operations.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armCollect, armRequest, dig, formatResult, isJsonObject, propsOf, resolveSubscription, type JsonObject, type JsonValue } from "../client.js";
import { defineTool } from "./define.js";
import { resourceGroupParam, segment, subscriptionSchema } from "./shared.js";

const vmPath = (sub: string, rg: string, vm: string) =>
  `/subscriptions/${sub}/resourceGroups/${segment(rg, "resource_group")}/providers/Microsoft.Compute/virtualMachines/${segment(vm, "vm_name")}`;
const sitePath = (sub: string, rg: string, app: string) =>
  `/subscriptions/${sub}/resourceGroups/${segment(rg, "resource_group")}/providers/Microsoft.Web/sites/${segment(app, "app_name")}`;
const aksPath = (sub: string, rg: string, cluster: string) =>
  `/subscriptions/${sub}/resourceGroups/${segment(rg, "resource_group")}/providers/Microsoft.ContainerService/managedClusters/${segment(cluster, "cluster_name")}`;

const asyncNote = (status: number, action: string) => (status === 202 ? `Accepted; ${action} is asynchronous.` : "Completed.");

const vmSchema = { ...subscriptionSchema, resource_group: resourceGroupParam("VM"), vm_name: z.string().describe("VM name.") };
const webAppSchema = { ...subscriptionSchema, resource_group: resourceGroupParam("app"), app_name: z.string().describe("Web app or function app name.") };
const aksSchema = { ...subscriptionSchema, resource_group: resourceGroupParam("cluster"), cluster_name: z.string().describe("AKS cluster name.") };

export function registerComputeTools(server: McpServer): void {
  defineTool(server, {
    name: "List_Virtual_Machines",
    title: "List Virtual Machines",
    description: "List virtual machines in a subscription, optionally with power state.",
    tier: "read",
    cli: "az vm list [--show-details]",
    ref: { method: "GET", path: "/subscriptions/{sub}/providers/Microsoft.Compute/virtualMachines", apiVersion: "2023-07-01" },
    inputSchema: {
      ...subscriptionSchema,
      power_state: z.boolean().optional().describe("Also fetch per-VM power state via instanceView. Adds one call per VM."),
    },
    handler: async ({ subscription_id, power_state }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines`, { apiVersion: "2023-07-01" });
      const vms = [] as JsonObject[];
      for (const vm of items) {
        const props = propsOf(vm);
        const entry: JsonObject = {
          id: vm.id ?? null,
          name: vm.name ?? null,
          location: vm.location ?? null,
          vm_size: dig(props, "hardwareProfile", "vmSize"),
          os_type: dig(props, "storageProfile", "osDisk", "osType"),
        };
        if (power_state && typeof vm.id === "string") {
          try {
            const { body } = await armRequest(`${vm.id}/instanceView`, { apiVersion: "2023-07-01" });
            const statuses = isJsonObject(body) && Array.isArray(body.statuses) ? body.statuses : [];
            const power = statuses.filter(isJsonObject).map((s) => String(s.code ?? "")).find((c) => c.startsWith("PowerState/"));
            entry.power_state = power ? power.replace("PowerState/", "") : "unknown";
          } catch {
            entry.power_state = "unavailable";
          }
        }
        vms.push(entry);
      }
      return formatResult({ subscription_id: sub, count: vms.length, truncated, virtual_machines: vms });
    },
  });

  defineTool(server, {
    name: "Get_Virtual_Machine",
    title: "Get Virtual Machine",
    description: "Get a virtual machine with its configuration and current power state.",
    tier: "read",
    cli: "az vm show -d -g <rg> -n <vm>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}", apiVersion: "2026-03-01" },
    inputSchema: vmSchema,
    handler: async ({ subscription_id, resource_group, vm_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { body } = await armRequest(vmPath(sub, resource_group, vm_name), { apiVersion: "2026-03-01", query: { $expand: "instanceView" } });
      const vm = isJsonObject(body) ? body : {};
      const props = propsOf(vm);
      const statuses = Array.isArray(dig(props, "instanceView", "statuses")) ? (dig(props, "instanceView", "statuses") as JsonValue[]).filter(isJsonObject) : [];
      const power = statuses.map((s) => String(s.code ?? "")).find((c) => c.startsWith("PowerState/"));
      return formatResult({
        id: vm.id ?? null,
        name: vm.name ?? null,
        location: vm.location ?? null,
        vm_size: dig(props, "hardwareProfile", "vmSize"),
        os_type: dig(props, "storageProfile", "osDisk", "osType"),
        provisioning_state: props.provisioningState ?? null,
        power_state: power ? power.replace("PowerState/", "") : "unknown",
        tags: vm.tags ?? null,
      });
    },
  });

  const vmAction = (
    name: string,
    title: string,
    description: string,
    action: string,
    apiVersion: string,
    tier: "write" | "destructive",
    cli: string,
  ) =>
    defineTool(server, {
      name,
      title,
      description,
      tier,
      impact: `${action} interrupts anyone using the VM`,
      cli,
      ref: { method: "POST", path: `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}/${action}`, apiVersion },
      inputSchema: vmSchema,
      handler: async ({ subscription_id, resource_group, vm_name }) => {
        const sub = await resolveSubscription(subscription_id);
        const { status } = await armRequest(`${vmPath(sub, resource_group, vm_name)}/${action}`, { apiVersion, method: "POST" });
        return formatResult({ ok: true, action, subscription_id: sub, resource_group, vm_name, http_status: status, note: asyncNote(status, action) });
      },
    });

  vmAction("Start_VM", "Start VM", "Start a virtual machine.", "start", "2023-07-01", "write", "az vm start -g <rg> -n <vm>");
  vmAction("Stop_VM", "Stop VM", "Deallocate (stop) a virtual machine to halt compute billing.", "deallocate", "2023-07-01", "destructive", "az vm deallocate -g <rg> -n <vm>");
  vmAction("Restart_VM", "Restart VM", "Restart a virtual machine.", "restart", "2026-03-01", "destructive", "az vm restart -g <rg> -n <vm>");

  defineTool(server, {
    name: "Resize_VM",
    title: "Resize VM",
    description: "Change a virtual machine's size (SKU). The VM restarts as part of the resize.",
    tier: "destructive",
    impact: "the VM restarts",
    cli: "az vm resize -g <rg> -n <vm> --size <size>",
    ref: { method: "PATCH", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{name}", apiVersion: "2023-07-01" },
    inputSchema: { ...vmSchema, vm_size: z.string().describe("Target size, e.g. Standard_D4s_v5.") },
    handler: async ({ subscription_id, resource_group, vm_name, vm_size }) => {
      const sub = await resolveSubscription(subscription_id);
      const { status } = await armRequest(vmPath(sub, resource_group, vm_name), {
        apiVersion: "2023-07-01",
        method: "PATCH",
        body: { properties: { hardwareProfile: { vmSize: vm_size } } },
      });
      return formatResult({ ok: true, action: "resize", subscription_id: sub, resource_group, vm_name, vm_size, http_status: status });
    },
  });

  defineTool(server, {
    name: "Get_Web_App",
    title: "Get Web App",
    description: "Get an App Service web app or function app with its configuration summary.",
    tier: "read",
    cli: "az webapp show -g <rg> -n <app>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}", apiVersion: "2023-12-01" },
    inputSchema: webAppSchema,
    handler: async ({ subscription_id, resource_group, app_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { body } = await armRequest(sitePath(sub, resource_group, app_name), { apiVersion: "2023-12-01" });
      const site = isJsonObject(body) ? body : {};
      const props = propsOf(site);
      return formatResult({
        id: site.id ?? null,
        name: site.name ?? null,
        location: site.location ?? null,
        kind: site.kind ?? null,
        state: props.state ?? null,
        enabled: props.enabled ?? null,
        default_host_name: props.defaultHostName ?? null,
        host_names: props.hostNames ?? null,
        https_only: props.httpsOnly ?? null,
        app_service_plan_id: props.serverFarmId ?? null,
        runtime: dig(props, "siteConfig", "linuxFxVersion") ?? dig(props, "siteConfig", "windowsFxVersion"),
        outbound_ips: props.outboundIpAddresses ?? null,
        tags: site.tags ?? null,
      });
    },
  });

  const webAppAction = (name: string, title: string, description: string, action: "start" | "stop" | "restart", tier: "write" | "destructive") =>
    defineTool(server, {
      name,
      title,
      description,
      tier,
      impact: `${action} takes the app offline for its users`,
      cli: `az webapp ${action} -g <rg> -n <app>`,
      ref: { method: "POST", path: `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}/${action}`, apiVersion: "2023-12-01" },
      inputSchema: webAppSchema,
      handler: async ({ subscription_id, resource_group, app_name }) => {
        const sub = await resolveSubscription(subscription_id);
        const { status } = await armRequest(`${sitePath(sub, resource_group, app_name)}/${action}`, { apiVersion: "2023-12-01", method: "POST" });
        return formatResult({ ok: true, action, subscription_id: sub, resource_group, app_name, http_status: status });
      },
    });

  webAppAction("Start_Web_App", "Start Web App", "Start an App Service web app or function app.", "start", "write");
  webAppAction("Stop_Web_App", "Stop Web App", "Stop an App Service web app or function app.", "stop", "destructive");
  webAppAction("Restart_Web_App", "Restart Web App", "Restart an App Service web app or function app.", "restart", "destructive");

  defineTool(server, {
    name: "Get_AKS_Cluster",
    title: "Get AKS Cluster",
    description: "Get an AKS managed cluster with node pool and network summary.",
    tier: "read",
    cli: "az aks show -g <rg> -n <cluster>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerService/managedClusters/{name}", apiVersion: "2024-02-01" },
    inputSchema: aksSchema,
    handler: async ({ subscription_id, resource_group, cluster_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { body } = await armRequest(aksPath(sub, resource_group, cluster_name), { apiVersion: "2024-02-01" });
      const cluster = isJsonObject(body) ? body : {};
      const props = propsOf(cluster);
      const pools = Array.isArray(props.agentPoolProfiles)
        ? props.agentPoolProfiles.filter(isJsonObject).map((p) => ({ name: p.name ?? null, count: p.count ?? null, vm_size: p.vmSize ?? null, mode: p.mode ?? null, os_type: p.osType ?? null, kubernetes_version: p.orchestratorVersion ?? null }))
        : [];
      return formatResult({
        id: cluster.id ?? null,
        name: cluster.name ?? null,
        location: cluster.location ?? null,
        kubernetes_version: props.kubernetesVersion ?? null,
        provisioning_state: props.provisioningState ?? null,
        power_state: dig(props, "powerState", "code"),
        fqdn: props.fqdn ?? null,
        node_resource_group: props.nodeResourceGroup ?? null,
        network_plugin: dig(props, "networkProfile", "networkPlugin"),
        node_pools: pools,
        tags: cluster.tags ?? null,
      });
    },
  });

  const aksAction = (name: string, title: string, description: string, action: "start" | "stop", tier: "write" | "destructive") =>
    defineTool(server, {
      name,
      title,
      description,
      tier,
      impact: "every workload on the cluster stops",
      cli: `az aks ${action} -g <rg> -n <cluster>`,
      ref: { method: "POST", path: `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerService/managedClusters/{name}/${action}`, apiVersion: "2024-02-01" },
      inputSchema: aksSchema,
      handler: async ({ subscription_id, resource_group, cluster_name }) => {
        const sub = await resolveSubscription(subscription_id);
        const { status } = await armRequest(`${aksPath(sub, resource_group, cluster_name)}/${action}`, { apiVersion: "2024-02-01", method: "POST" });
        return formatResult({ ok: true, action, subscription_id: sub, resource_group, cluster_name, http_status: status, note: asyncNote(status, action) });
      },
    });

  aksAction("Start_AKS_Cluster", "Start AKS Cluster", "Start a stopped AKS cluster.", "start", "write");
  aksAction("Stop_AKS_Cluster", "Stop AKS Cluster", "Stop a running AKS cluster to pause compute billing.", "stop", "destructive");
}
