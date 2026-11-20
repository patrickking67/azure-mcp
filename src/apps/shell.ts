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
import type { McpServer, ToolCallback } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { APP_RUNTIME } from './generated/runtime.js';
import { READ_ANNOTATIONS } from '../gate.js';
import { profileParam } from '../tools/define.js';
import { describeProfiles, resolveProfile, withProfile } from '../profiles.js';
import { toolInputSchema } from '../schema.js';
import { SERVER_VERSION } from '../version.js';

const TOOL_PREFIX = 'azure';

const BASE_CSS = `
:root { color-scheme: light dark; --brand:#0868B8; --bg:var(--color-background-primary, light-dark(#ffffff, #30302e)); --surface:var(--color-background-primary, light-dark(#ffffff, #30302e)); --card:var(--color-background-secondary, light-dark(#f5f4ed, #262624)); --fg:var(--color-text-primary, light-dark(#141413, #faf9f5)); --muted:var(--color-text-secondary, light-dark(#3d3d3a, #c2c0b6)); --subtle:var(--color-text-tertiary, light-dark(#73726c, #9c9a92)); --line:var(--color-border-tertiary, light-dark(rgb(31 30 29 / 15%), rgb(222 220 209 / 15%))); --line-strong:var(--color-border-secondary, light-dark(rgb(31 30 29 / 30%), rgb(222 220 209 / 30%))); --accent:var(--color-text-info, light-dark(#3266ad, #80aadd)); --ok:var(--color-text-success, light-dark(#265b19, #7ab948)); --warn:var(--color-text-warning, light-dark(#5a4815, #d1a041)); --bad:var(--color-text-danger, light-dark(#7f2c28, #ee8884)); --ok-bg:var(--color-background-success, light-dark(#e9f1dc, #1b4614)); --warn-bg:var(--color-background-warning, light-dark(#f6eedf, #483a0f)); --bad-bg:var(--color-background-danger, light-dark(#f7ecec, #602a28)); --info-bg:var(--color-background-info, light-dark(#d6e4f6, #253e5f)); --focus:var(--color-ring-primary, light-dark(rgb(20 20 19 / 70%), rgb(250 249 245 / 70%))); --hair:var(--border-width-regular, 0.5px); --radius:var(--border-radius-lg, 10px); --radius-sm:var(--border-radius-md, 8px); }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 var(--font-sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif); }
body { padding:12px clamp(8px, 3vw, 16px); }
h1 { font-size:17px; line-height:1.3; margin:0 0 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
h1 .badge { font-weight:500; }
h2 { font-size:14px; font-weight:600; margin:20px 0 8px; color:var(--fg); }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--card); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.badge.ok { color:var(--ok); border-color:var(--ok); }
.badge.warn { color:var(--warn); border-color:var(--warn); }
.badge.bad { color:var(--bad); border-color:var(--bad); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px,1fr)); gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; }
.card .title { font-weight:600; display:flex; justify-content:space-between; gap:8px; align-items:center; }
.card .meta { color:var(--muted); font-size:12px; margin-top:4px; }
.card .big { font-size:22px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; margin-top:6px; }
.kv dt { color:var(--muted); } .kv dd { margin:0; overflow-wrap:anywhere; }
.tablewrap { max-height:420px; overflow:auto; border:1px solid var(--line); border-radius:var(--radius); }
table { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:500; cursor:pointer; user-select:none; position:sticky; top:0; background:var(--card); z-index:1; }
th:hover { color:var(--fg); }
td { font-variant-numeric:tabular-nums; }
th.sorted::after { content:" \\2193"; } th.sorted.asc::after { content:" \\2191"; }
tr:hover td { background:color-mix(in srgb, var(--card) 60%, transparent); }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 10px; }
.toolbar input[type=search] { flex:1 1 180px; min-width:0; max-width:320px; }
input, select, button { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; min-height:32px; }
select { max-width:100%; }
button { cursor:pointer; } button:hover:not(:disabled) { border-color:var(--muted); }
button.primary { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
button:disabled { opacity:.55; cursor:default; }
button.link { background:none; border:0; padding:0; min-height:0; color:var(--accent); text-decoration:underline; text-underline-offset:2px; text-align:left; }
:focus-visible { outline:2px solid var(--focus); outline-offset:2px; border-radius:4px; }
input:focus-visible, select:focus-visible, button:focus-visible { outline-offset:1px; }
th:focus-visible { outline-offset:-2px; }
.empty { color:var(--muted); padding:20px; text-align:center; }
.error { color:var(--fg); padding:12px 14px; border:1px solid var(--bad); border-left-width:4px; border-radius:var(--radius); background:color-mix(in srgb, var(--bad) 8%, var(--bg)); }
.error strong { color:var(--bad); display:block; margin-bottom:2px; }
.error p { margin:0; overflow-wrap:anywhere; }
.status .error { display:inline-block; padding:4px 10px; }
.muted { color:var(--muted); }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.bar { display:inline-block; width:80px; height:8px; border-radius:4px; background:var(--line); vertical-align:middle; margin-right:6px; overflow:hidden; }
.bar > i { display:block; height:100%; background:var(--ok); }
.bar.warn > i { background:var(--warn); } .bar.bad > i { background:var(--bad); }
.status { font-size:12px; color:var(--muted); min-height:1em; margin-bottom:6px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.viewbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; margin:0 0 6px; font-size:12px; }
.viewbar label { color:var(--muted); }
.viewbar select, .viewbar button { min-height:28px; padding:3px 8px; font-size:12px; }
@media (max-width:480px) { .grid { grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); } .card .big { font-size:19px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition:none !important; animation:none !important; scroll-behavior:auto !important; } }
/* Native Claude theme (MCP Apps design guidelines): host tokens for structure, a transparent page, vendor colour as accent only. */
html,body { background:transparent; color:var(--fg); font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif); font-size:var(--font-text-sm-size, 14px); line-height:var(--font-text-sm-line-height, 1.4); -webkit-font-smoothing:antialiased; }
body { padding:12px 4px; }
h1 { font-size:var(--font-heading-md-size, 16px); line-height:var(--font-heading-md-line-height, 1.4); font-weight:var(--font-weight-semibold, 600); }
h1::before { content:""; flex:none; width:8px; height:8px; border-radius:var(--border-radius-full, 9999px); background:var(--brand); }
h2 { font-size:var(--font-heading-xs-size, 12px); font-weight:var(--font-weight-medium, 500); color:var(--subtle); letter-spacing:.02em; }
.card { background:var(--card); border:var(--hair) solid var(--line-strong); border-radius:var(--radius); box-shadow:none; }
.card .title { font-weight:var(--font-weight-semibold, 600); }
.card .meta, .status, .kv dt { color:var(--subtle); font-size:var(--font-text-xs-size, 12px); }
.card .big { font-size:var(--font-heading-lg-size, 20px); line-height:var(--font-heading-lg-line-height, 1.25); font-weight:var(--font-weight-semibold, 600); }
.badge { border:0; background:var(--card); color:var(--muted); font-size:var(--font-text-xs-size, 12px); font-weight:var(--font-weight-medium, 500); padding:2px 8px; border-radius:var(--border-radius-full, 9999px); }
.badge.ok { background:var(--ok-bg); color:var(--ok); } .badge.warn { background:var(--warn-bg); color:var(--warn); } .badge.bad { background:var(--bad-bg); color:var(--bad); }
.tablewrap { border:var(--hair) solid var(--line-strong); border-radius:var(--radius); }
th, td { border-bottom:var(--hair) solid var(--line); }
th { background:var(--surface); color:var(--subtle); font-weight:var(--font-weight-medium, 500); font-size:var(--font-text-xs-size, 12px); }
th.sorted { color:var(--fg); box-shadow:inset 0 -2px 0 var(--brand); }
tr:hover td { background:color-mix(in srgb, var(--card) 70%, transparent); }
input, select, button { background:var(--surface); border:var(--hair) solid var(--line-strong); border-radius:var(--radius-sm); min-height:32px; }
button { font-weight:var(--font-weight-medium, 500); }
button.primary { background:var(--color-background-inverse, light-dark(#141413, #faf9f5)); color:var(--color-text-inverse, light-dark(#ffffff, #141413)); border-color:transparent; font-weight:var(--font-weight-semibold, 600); }
button.danger { background:var(--bad-bg); color:var(--bad); border-color:var(--color-border-danger, light-dark(#a73d39, #cd5c58)); }
:focus-visible, th:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
.bar { background:var(--line); } .error { color:var(--bad); }
.confirm { background:color-mix(in srgb, var(--surface) 70%, transparent); }
.confirm .panel { background:var(--surface); border:var(--hair) solid var(--line-strong); box-shadow:var(--shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 10%), 0 4px 6px -4px rgb(0 0 0 / 10%)); }
@media (pointer: coarse) { button, input, select { min-height:44px; } }
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
/** An error with what happened and what to try, announced to screen readers. */
const errorBox = (message, hint) => '<div class="error" role="alert"><strong>' + esc(hint ?? 'Could not load this view.') + '</strong><p>' + esc(message) + '</p></div>';
const emptyBox = (text) => '<div class="empty" role="status">' + esc(text) + '</div>';
function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
/** Unwrap a tool result: structuredContent first, else the JSON in its text part. */
function resultData(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).find((p) => p.type === 'text')?.text;
  if (result.isError) throw new Error(text ?? 'tool failed');
  try { return JSON.parse(text ?? 'null'); } catch { return text; }
}
/**
 * A sortable, filterable table. columns: [{key, label, render?, numeric?, cls?}]; opts.empty is shown when there are no rows.
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
    const label = opts.placeholder ?? 'Filter…';
    const none = rows.length === 0 ? (opts.empty ?? 'Nothing to show.') : 'Nothing matches the filter. Clear it to see all ' + rows.length + '.';
    const sortState = (c) => c.key === state.sortKey ? (state.asc ? 'ascending' : 'descending') : 'none';
    if (rows.length === 0) {
      // Nothing to filter or sort: say so, and keep the view's own controls (Refresh, type filter).
      root.innerHTML = (opts.toolbar ? '<div class="toolbar">' + opts.toolbar + '</div>' : '') + emptyBox(none);
      if (opts.onDraw) opts.onDraw(root);
      return;
    }
    root.innerHTML = '<div class="toolbar"><input type="search" aria-label="' + esc(label) + '" placeholder="' + esc(label) + '" value="' + esc(state.filter) + '"><span class="muted" role="status">' + shown.length + ' of ' + rows.length + '</span>' + (opts.toolbar ?? '') + '</div>'
      + '<div class="tablewrap"><table><thead><tr>' + columns.map((c) => '<th scope="col" tabindex="0" aria-sort="' + sortState(c) + '" data-key="' + c.key + '" class="' + (c.key === state.sortKey ? 'sorted' + (state.asc ? ' asc' : '') : '') + (c.cls ? ' ' + c.cls : '') + '">' + (c.label ? esc(c.label) : '<span class="sr-only">Actions</span>') + '</th>').join('') + '</tr></thead>'
      + '<tbody>' + (shown.map((r) => '<tr>' + columns.map((c) => '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + (c.render ? c.render(r[c.key], r) : esc(r[c.key] ?? '—')) + '</td>').join('') + '</tr>').join('') || '<tr><td colspan="' + columns.length + '" class="empty">' + esc(none) + '</td></tr>') + '</tbody></table></div>';
    const input = $('input[type=search]', root);
    input.oninput = (e) => { const pos = e.target.selectionStart; state.filter = e.target.value; draw(); const again = $('input[type=search]', root); again.focus(); again.setSelectionRange(pos, pos); };
    root.querySelectorAll('th').forEach((th) => {
      const sort = () => { const k = th.dataset.key; if (state.sortKey === k) state.asc = !state.asc; else { state.sortKey = k; state.asc = true; } draw(); $('th[data-key="' + k + '"]', root)?.focus(); };
      th.onclick = sort;
      th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } };
    });
    if (opts.onDraw) opts.onDraw(root);
  };
  draw();
  return { redraw: draw, setPredicate: (fn) => { state.predicate = fn; draw(); } };
}
/** Wire the protocol to a view: render(root, view) on each result, with the tool input alongside. */
async function boot(render) {
  const root = $('#app');
  const bar = $('#bar');
  const view = { app: null, input: {}, data: null, call: null, redraw: null, profile: null, meta: null, reload: null };
  const app = new App({ name: ${JSON.stringify(TOOL_PREFIX)}, version: ${JSON.stringify(SERVER_VERSION)} }, {}, { autoResize: true });
  view.app = app;
  // Every call a view makes runs in the tenant the view is showing.
  const withProfile = (args) => (view.profile && !(args && 'profile' in args) ? { ...args, profile: view.profile } : (args ?? {}));
  view.call = async (name, args) => resultData(await app.callServerTool({ name, arguments: withProfile(args) }));
  const draw = () => { try { render(root, view); } catch (e) { root.innerHTML = errorBox(e.message, 'This view could not render the result.'); } };
  const drawBar = () => {
    const m = view.meta;
    if (!m || !bar) return;
    const many = (m.profiles ?? []).length > 1;
    bar.innerHTML = '<div class="viewbar">'
      + (many
        ? '<label for="vb-profile">Tenant</label><select id="vb-profile">' + m.profiles.map((p) => '<option value="' + esc(p.name) + '"' + (p.name === m.profile ? ' selected' : '') + '>' + esc(p.name) + (p.tenant_id ? ' (' + esc(p.tenant_id.slice(0, 8)) + '…)' : p.kind === 'azure_cli' ? ' (az login)' : '') + '</option>').join('') + '</select>'
        : '<span class="badge">' + esc(m.profile ?? '') + '</span>')
      + '<button type="button" id="vb-refresh" aria-label="Reload this view">Refresh</button>'
      + '<span class="muted" id="vb-status" role="status">' + (m.loaded_at ? 'Loaded ' + esc(new Date(m.loaded_at).toLocaleTimeString()) : '') + '</span></div>';
    const sel = $('#vb-profile', bar);
    if (sel) sel.onchange = () => view.reload({ profile: sel.value });
    $('#vb-refresh', bar).onclick = () => view.reload({});
  };
  const accept = (p) => {
    const sc = p.structuredContent;
    if (sc && sc._view) { view.meta = sc._view; view.profile = sc._view.profile; drawBar(); }
    if (p.isError) {
      const text = (p.content ?? []).find((c) => c.type === 'text')?.text ?? 'tool failed';
      root.innerHTML = errorBox(text, 'Azure did not return data for this view. Try another tenant, Refresh, or ask for Test_Connection.');
      return;
    }
    try { view.data = resultData(p); } catch (e) { root.innerHTML = errorBox(e.message, 'Azure did not return data for this view. Ask for Test_Connection or Status_Server to see why.'); return; }
    draw();
  };
  /** Re-run this view's own tool with the same arguments, optionally changed (another tenant). */
  view.reload = async (changes) => {
    const tool = view.meta?.tool;
    if (!tool) return;
    const args = { ...view.input, ...(view.profile ? { profile: view.profile } : {}), ...changes };
    view.input = args;
    const status = $('#vb-status', bar);
    if (status) status.textContent = 'Loading…';
    root.setAttribute('aria-busy', 'true');
    try { accept(await app.callServerTool({ name: tool, arguments: args })); }
    catch (e) { root.innerHTML = errorBox(e.message, 'Could not reload this view.'); }
    finally { root.removeAttribute('aria-busy'); }
  };
  app.ontoolinput = (p) => { view.input = p.arguments ?? {}; };
  app.ontoolresult = (p) => accept(p);
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
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)}</title>
<style>${BASE_CSS}${page.css ?? ''}</style>
</head>
<body>
<header id="bar"></header>
<main id="app"><div class="empty" role="status">Loading…</div></main>
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

export interface ViewDefinition<Args extends z.ZodRawShape> {
  /** Tool name, View_<Noun>. */
  name: string;
  title: string;
  description: string;
  inputSchema: Args;
  page: ViewPage;
  invoking?: string;
  invoked?: string;
  /** Assemble the data the view renders. Returned as structuredContent and as JSON text. */
  load: (args: z.infer<z.ZodObject<Args>>) => Promise<Record<string, unknown>>;
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
export function registerView<Args extends z.ZodRawShape>(server: McpServer, view: ViewDefinition<Args>): void {
  if (!/^View_[A-Z][A-Za-z0-9_]+$/.test(view.name)) {
    throw new Error(`view tool "${view.name}" must be named View_<Noun>`);
  }
  const uri = viewUri(view.name);
  const html = renderPage(view.page);
  registerAppResource(server, view.title, uri, { description: `${view.title} view` }, () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ['https://assets.claude.ai'] } } } }],
  }));
  const inputSchema = toolInputSchema({ ...view.inputSchema, profile: profileParam });
  const callback = (async (args: z.infer<z.ZodObject<Args>> & { profile?: string }): Promise<ViewResult> => {
    let meta: Record<string, unknown> = { tool: view.name, profile: null, profiles: describeProfiles() };
    try {
      const profile = resolveProfile(args.profile);
      meta = { ...meta, profile: profile.name, loaded_at: new Date().toISOString() };
      const data = await withProfile(profile, () => view.load(args));
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: { ...data, _view: meta } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The view still gets its tenant list, so the user can switch tenants from an error.
      return { content: [{ type: 'text', text: message }], structuredContent: { _view: meta }, isError: true };
    }
    // ToolCallback is a conditional type the compiler cannot resolve for a
    // generic Args; the shape is right (the parsed arguments in, CallToolResult out).
  }) as unknown as ToolCallback<typeof inputSchema>;
  server.registerTool(
    view.name,
    {
      title: view.title,
      description: view.description,
      inputSchema,
      annotations: { ...READ_ANNOTATIONS, title: view.title },
      _meta: viewMeta(uri, view.invoking, view.invoked),
    },
    callback,
  );
}
