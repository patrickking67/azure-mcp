// Interactive views (MCP Apps). Each is a read-only tool whose result the host can render as an HTML
// view. The only buttons that change anything (Start, Stop, Restart on the VM and web app boards) call
// the same gated tools the model uses, so their gates and confirm parameter apply to a click too.

import type { McpServer } from "@modelcontextprotocol/server";
import { registerCostView } from "./views/costs.js";
import { registerEstateView } from "./views/estate.js";
import { registerResourceView } from "./views/resources.js";
import { registerSecurityView } from "./views/security.js";
import { registerVmView } from "./views/vms.js";
import { registerWebAppView } from "./views/webapps.js";

export function registerAppViews(server: McpServer): void {
  registerEstateView(server);
  registerVmView(server);
  registerWebAppView(server);
  registerCostView(server);
  registerResourceView(server);
  registerSecurityView(server);
}
