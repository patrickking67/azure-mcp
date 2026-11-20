// Where this server's own tools and Microsoft's Azure MCP Server commands do the same job.
//
// Both surfaces stay: the own tools are profile-aware ARM/Graph calls with this server's tiers, and
// Microsoft's add depth per service. This map joins them so the model, the API reference and the services
// view can say "this is the same thing" instead of showing two unrelated tools. Every Microsoft name here
// must exist in the pinned catalog; test/upstream.test.mjs checks that after each `npm run upstream:sync`.
//
// The tier note matters for power operations: Microsoft marks VM and web app start/stop as destructive,
// so through the proxy they need AZURE_ALLOW_DESTRUCTIVE; the own Start_VM / Stop_Web_App tools are writes.

export const OWN_TO_UPSTREAM: Readonly<Record<string, readonly string[]>> = {
  List_Subscriptions: ["subscription_list"],
  List_Resource_Groups: ["group_list"],
  List_Resources: ["group_resource_list"],
  List_Storage_Accounts: ["storage_account_get"],
  List_Storage_Containers: ["storage_blob_container_get"],
  List_Storage_Tables: ["storage_table_list"],
  List_Web_Apps: ["appservice_webapp_get"],
  Get_Web_App: ["appservice_webapp_get"],
  Start_Web_App: ["appservice_webapp_change-state"],
  Stop_Web_App: ["appservice_webapp_change-state"],
  Restart_Web_App: ["appservice_webapp_change-state"],
  List_Function_Apps: ["functionapp_get"],
  List_SQL_Servers: ["sql_server_get"],
  List_SQL_Databases: ["sql_db_get"],
  List_Cosmos_DB_Accounts: ["cosmos_list"],
  List_PostgreSQL_Servers: ["postgres_list"],
  List_MySQL_Servers: ["mysql_list"],
  List_Redis_Caches: ["redis_list"],
  List_AKS_Clusters: ["aks_cluster_get"],
  Get_AKS_Cluster: ["aks_cluster_get"],
  List_Container_Registries: ["acr_registry_list"],
  List_Container_Apps: ["containerapps_list"],
  List_Disks: ["compute_disk_get"],
  List_VM_Scale_Sets: ["compute_vmss_get"],
  List_Virtual_Machines: ["compute_vm_get"],
  Get_Virtual_Machine: ["compute_vm_get"],
  Start_VM: ["compute_vm_power-state"],
  Stop_VM: ["compute_vm_power-state"],
  Restart_VM: ["compute_vm_power-state"],
  Resize_VM: ["compute_vm_update"],
  List_Event_Hub_Namespaces: ["eventhubs_namespace_get"],
  Resource_Health: ["resourcehealth_availability-status_get"],
  List_Advisor_Recommendations: ["advisor_recommendation_list"],
  List_Role_Assignments: ["role_assignment_list"],
  List_Activity_Log: ["monitor_activitylog_list"],
  List_Policy_Assignments: ["policy_assignment_list"],
  List_Log_Analytics_Workspaces: ["monitor_workspace_list"],
  Query_Log_Analytics: ["monitor_workspace_log_query"],
  Get_Metrics: ["monitor_metrics_query"],
  List_Metric_Definitions: ["monitor_metrics_definitions"],
  Get_Key_Vault_Secret: ["keyvault_secret_get"],
  Set_Key_Vault_Secret: ["keyvault_secret_create"],
};

/** Microsoft command -> own tools that cover it. */
export function upstreamToOwn(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [own, commands] of Object.entries(OWN_TO_UPSTREAM)) {
    for (const command of commands) out.set(command, [...(out.get(command) ?? []), own]);
  }
  return out;
}
