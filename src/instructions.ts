export const SERVER_INSTRUCTIONS = `Microsoft Azure and Entra ID. Tools come in four kinds, and annotations say which:
- read: List_*, Get_* (except Get_Key_Vault_Secret), Query_*, Resource_*, ARM_GET, Graph_GET, Az_CLI, Az_CLI_Help, Status_*. Safe to call freely and in parallel.
- write: Start_*, Create_*, Tag_Resource, Set_Key_Vault_Secret, and Get_Key_Vault_Secret (a credential read). They stay listed in read mode and refuse until AZURE_MODE=write; every call needs confirm: true.
- destructive: Stop_*, Restart_*, Resize_VM, Delete_*, and DELETE through ARM_Request / Graph_Request. They also need AZURE_ALLOW_DESTRUCTIVE=true.
- interactive: View_* render an MCP Apps view (estate overview, virtual machines, web apps, costs, resource explorer, security). Buttons in a view call the same gated tools.

The Azure CLI is available one-to-one: Az_CLI runs any read-only az command, Az_CLI_Run runs anything else (classified per command: writes need write mode, deletes/stops/restarts need the destructive gate), and Az_CLI_Help shows a command's arguments. Prefer a dedicated tool when one exists; reach for Az_CLI for everything else rather than guessing ARM paths. Pass args as an array of words after "az". Commands that print tokens, change the CLI sign-in or config, open interactive sessions, or read or write local files are refused. Reads that return keys or connection strings count as writes.

Subscriptions: tools take an optional subscription_id; otherwise the configured default or the az default is used. List_Subscriptions shows what the identity can reach. Status_Server explains the configuration and auth mode without calling Azure; Status_Gate explains a write refusal; Test_Connection proves the identity works.`;
