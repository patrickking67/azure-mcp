// The HTML shell every interactive view is built on: the same shell, styles and helpers as the
// other connectors in this portfolio, so the views look and behave alike.
//
// A view is one HTML document the host renders in a sandboxed iframe next to the tool result. It
// receives the tool's arguments and result over postMessage (the MCP Apps protocol, spoken by the
// inlined ext-apps runtime), renders them, and may call back into this server's tools: the same gated
// tools the model uses, so a button in a view can never do more than the model could. Start, Stop and
// Restart buttons call Start_VM / Stop_VM / ... with confirm: true, and are refused by the gate exactly
// as a model call would be.
//
// No framework, no build step, no CDN: each view is a template string with a small vanilla-JS render.

import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { APP_RUNTIME } from './generated/runtime.js';
import { READ_ANNOTATIONS } from '../gate.js';
import { SERVER_VERSION } from '../version.js';

const TOOL_PREFIX = 'azure';

const BASE_CSS = `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --accent:#0559c9; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --radius:10px; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111214; --fg:#f3f4f6; --muted:#9ca3af; --line:#2a2d33; --card:#1a1c20; --accent:#5aa0ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
:root[data-theme="dark"] { --bg:#111214; --fg:#f3f4f6; --muted:#9ca3af; --line:#2a2d33; --card:#1a1c20; --accent:#5aa0ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 var(--font-sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif); }
body { padding:12px; }
h1 { font-size:16px; margin:0 0 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
h1 .badge { font-weight:500; }
h2 { font-size:13px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--card); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.badge.ok { color:var(--ok); border-color:var(--ok); }
.badge.warn { color:var(--warn); border-color:var(--warn); }
.badge.bad { color:var(--bad); border-color:var(--bad); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px,1fr)); gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; }
.card .title { font-weight:600; display:flex; justify-content:space-between; gap:8px; align-items:center; }
.card .meta { color:var(--muted); font-size:12px; margin-top:4px; }
.card .big { font-size:22px; font-weight:600; margin-top:2px; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; margin-top:6px; }
.kv dt { color:var(--muted); } .kv dd { margin:0; overflow-wrap:anywhere; }
.tablewrap { max-height:420px; overflow:auto; border:1px solid var(--line); border-radius:var(--radius); }
table { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:500; cursor:pointer; user-select:none; position:sticky; top:0; background:var(--card); z-index:1; }
th.sorted::after { content:" \\2193"; } th.sorted.asc::after { content:" \\2191"; }
tr:hover td { background:color-mix(in srgb, var(--card) 60%, transparent); }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 10px; }
input, select, button { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
button { cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.5; cursor:default; }
.empty, .error { color:var(--muted); padding:20px; text-align:center; }
.error { color:var(--bad); }
.muted { color:var(--muted); }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.bar { display:inline-block; width:80px; height:8px; border-radius:4px; background:var(--line); vertical-align:middle; margin-right:6px; overflow:hidden; }
.bar > i { display:block; height:100%; background:var(--ok); }
.bar.warn > i { background:var(--warn); } .bar.bad > i { background:var(--bad); }
.status { font-size:12px; color:var(--muted); }
`;

/** Shared browser-side helpers, injected into every view before its own script. */
const BOOT_JS = `
const { App, applyHostStyleVariables, applyHostFonts, applyDocumentTheme } = globalThis.__mcpApps;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtBytes = (n) => { if (n == null) return '—'; const u = ['B','KB','MB','GB','TB']; let i = 0; let v = Number(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; } return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]; };
const fmtAgo = (iso) => { if (!iso) return '—'; const t = new Date(iso).getTime(); if (Number.isNaN(t)) return String(iso); const s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return Math.round(s) + 's ago'; if (s < 5400) return Math.round(s / 60) + 'm ago'; if (s < 172800) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
const fmtMoney = (n, cur) => n == null ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: Number(n) < 100 ? 2 : 0 });
const fmtPct = (n) => n == null ? '—' : Math.round(n) + '%';
const pctClass = (n) => n == null ? '' : n >= 95 ? 'ok' : n >= 80 ? 'warn' : 'bad';
const bar = (n) => n == null ? '<span class="muted">—</span>' : '<span class="bar ' + pctClass(n) + '"><i style="width:' + Math.max(0, Math.min(100, n)) + '%"></i></span>' + fmtPct(n);
const stateClass = (s) => { const v = String(s ?? '').toLowerCase(); if (['online','ok','resolved','available','running','succeeded','healthy','enabled','true','low','info'].includes(v)) return 'ok'; if (['offline','unavailable','failed','expired','critical','high','deleting','false'].includes(v)) return 'bad'; return v ? 'warn' : ''; };
const badge = (s) => '<span class="badge ' + stateClass(s) + '">' + esc(s ?? '—') + '</span>';
function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.fonts) applyHostFonts(ctx.styles.fonts);
}
/** Unwrap a tool result: structuredContent first, else the JSON in its text part. */
function resultData(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).find((p) => p.type === 'text')?.text;
  if (result.isError) throw new Error(text ?? 'tool failed');
  try { return JSON.parse(text ?? 'null'); } catch { return text; }
}
/**
 * A sortable, filterable table. columns: [{key, label, render?, numeric?}].
 * Returns { redraw, setPredicate } so a view can wire its own filter controls outside the table.
 */
function table(root, rows, columns, opts = {}) {
  const state = { sortKey: opts.sortKey ?? columns[0].key, asc: opts.asc ?? true, filter: '', predicate: opts.predicate ?? null };
  const draw = () => {
    const q = state.filter.toLowerCase();
    const shown = rows
      .filter((r) => !state.predicate || state.predicate(r))
      .filter((r) => !q || columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)))
      .sort((a, b) => { const x = a[state.sortKey], y = b[state.sortKey]; const c = typeof x === 'number' && typeof y === 'number' ? x - y : (x == null) - (y == null) || String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }); return state.asc ? c : -c; });
    root.innerHTML = '<div class="toolbar"><input type="search" placeholder="' + esc(opts.placeholder ?? 'Filter…') + '" value="' + esc(state.filter) + '"><span class="muted">' + shown.length + ' of ' + rows.length + '</span>' + (opts.toolbar ?? '') + '</div>'
      + '<div class="tablewrap"><table><thead><tr>' + columns.map((c) => '<th data-key="' + c.key + '" class="' + (c.key === state.sortKey ? 'sorted' + (state.asc ? ' asc' : '') : '') + '">' + esc(c.label) + '</th>').join('') + '</tr></thead>'
      + '<tbody>' + (shown.map((r) => '<tr>' + columns.map((c) => '<td>' + (c.render ? c.render(r[c.key], r) : esc(r[c.key] ?? '—')) + '</td>').join('') + '</tr>').join('') || '<tr><td colspan="' + columns.length + '" class="empty">Nothing matches.</td></tr>') + '</tbody></table></div>';
    const input = $('input[type=search]', root);
    input.oninput = (e) => { const pos = e.target.selectionStart; state.filter = e.target.value; draw(); const again = $('input[type=search]', root); again.focus(); again.setSelectionRange(pos, pos); };
    root.querySelectorAll('th').forEach((th) => { th.onclick = () => { const k = th.dataset.key; if (state.sortKey === k) state.asc = !state.asc; else { state.sortKey = k; state.asc = true; } draw(); }; });
    if (opts.onDraw) opts.onDraw(root);
  };
  draw();
  return { redraw: draw, setPredicate: (fn) => { state.predicate = fn; draw(); } };
}
/** Wire the protocol to a view: render(root, view) on each result, with the tool input alongside. */
async function boot(render) {
  const root = $('#app');
  const view = { app: null, input: {}, data: null, call: null, redraw: null };
  const app = new App({ name: ${JSON.stringify(TOOL_PREFIX)}, version: ${JSON.stringify(SERVER_VERSION)} }, {}, { autoResize: true });
  view.app = app;
  view.call = async (name, args) => resultData(await app.callServerTool({ name, arguments: args }));
  const draw = () => { try { render(root, view); } catch (e) { root.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; } };
  app.ontoolinput = (p) => { view.input = p.arguments ?? {}; };
  app.ontoolresult = (p) => { try { view.data = resultData(p); } catch (e) { root.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; return; } draw(); };
  app.onhostcontextchanged = (ctx) => { applyContext(ctx); };
  await app.connect();
  applyContext(app.getHostContext());
  view.redraw = draw;
  return view;
}
`;

export interface ViewPage {
  title: string;
  /** Extra CSS for this view. */
  css?: string;
  /** The view's own script; runs after BOOT_JS in the same module scope and must call boot(render). */
  script: string;
}

/** Render a complete HTML document for a view. */
export function renderPage(page: ViewPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>${BASE_CSS}${page.css ?? ''}</style>
</head>
<body>
<div id="app"><div class="empty">Loading…</div></div>
<script type="module">
${APP_RUNTIME}
${BOOT_JS}
${page.script}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** A view tool's result: JSON text for the model, structuredContent for the view. */
interface ViewResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ViewDefinition<Args extends ZodRawShapeCompat> {
  /** Tool name, View_<Noun>. */
  name: string;
  title: string;
  description: string;
  inputSchema: Args;
  page: ViewPage;
  invoking?: string;
  invoked?: string;
  /** Assemble the data the view renders. Returned as structuredContent and as JSON text. */
  load: (args: ShapeOutput<Args>) => Promise<Record<string, unknown>>;
}

/** The ui:// resource a view tool renders. */
export function viewUri(name: string): string {
  return `ui://${TOOL_PREFIX}/${name.replace(/^View_/, '').toLowerCase()}.html`;
}

/**
 * `_meta` for a view tool: the MCP Apps resource under the standard key, its
 * legacy alias and the ChatGPT aliases. Hosts without MCP Apps ignore all of it
 * and show the JSON text, which carries the same data.
 */
function viewMeta(uri: string, invoking?: string, invoked?: string): Record<string, unknown> {
  return {
    ui: { resourceUri: uri, visibility: ['model', 'app'] },
    'ui/resourceUri': uri,
    'openai/outputTemplate': uri,
    'openai/widgetAccessible': true,
    ...(invoking ? { 'openai/toolInvocation/invoking': invoking } : {}),
    ...(invoked ? { 'openai/toolInvocation/invoked': invoked } : {}),
  };
}

/** Register one view: its tool (read-only, gate-free) and the ui:// resource it renders. */
export function registerView<Args extends ZodRawShapeCompat>(server: McpServer, view: ViewDefinition<Args>): void {
  if (!/^View_[A-Z][A-Za-z0-9_]+$/.test(view.name)) {
    throw new Error(`view tool "${view.name}" must be named View_<Noun>`);
  }
  const uri = viewUri(view.name);
  const html = renderPage(view.page);
  registerAppResource(server, view.title, uri, { description: `${view.title} view` }, async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
  }));
  const callback = (async (args: ShapeOutput<Args>): Promise<ViewResult> => {
    try {
      const data = await view.load(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
    // ToolCallback<Args> is a conditional type the compiler cannot resolve for a
    // generic Args; the shape is right (ShapeOutput<Args> in, CallToolResult out).
  }) as unknown as ToolCallback<Args>;
  server.registerTool<ZodRawShapeCompat, Args>(
    view.name,
    {
      title: view.title,
      description: view.description,
      inputSchema: view.inputSchema,
      annotations: { ...READ_ANNOTATIONS, title: view.title },
      _meta: viewMeta(uri, view.invoking, view.invoked),
    },
    callback,
  );
}
