// Azure Services: an explorer over Microsoft's Azure MCP Server catalog (every service and command this
// server proxies). Search every command at once or pick a service, see each command's tier (read, write,
// destructive) and which of this server's own tools does the same job, open one to get a form generated
// from its parameter schema, and run it. Running goes through the proxied tool, so the same gate and tenant
// profile apply as for a model call.
//
// Parameter schemas come from the pinned catalog (src/upstream/generated/catalog.json) through this view's
// own tool, called with `command`: no azmcp process has to start just to draw a form, and it works in both
// of Microsoft's tool layouts.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isDestructiveAllowed, isWriteMode } from "../../gate.js";
import { apiReference } from "../../tools/define.js";
import { upstreamCommand, upstreamServices } from "../../upstream/register.js";
import { upstreamEnabled, upstreamMode, UPSTREAM_VERSION } from "../../upstream/runner.js";
import { textOf } from "../../client.js";
import { registerView } from "../shell.js";

export function registerServicesView(server: McpServer): void {
  registerView(server, {
    name: "View_Azure_Services",
    title: "Azure Services",
    description:
      "Interactive explorer of Microsoft's Azure MCP Server, which this server includes one-to-one: every Azure service and command, tagged read, write or destructive, with the dedicated tool that does the same job where there is one. " +
      "Search all commands, open one to fill in a form built from its parameters, and run it under the same gate and tenant profile as any tool call. " +
      "Pass command to get one command's parameter schema instead of the catalog. The catalog is returned as JSON for hosts without MCP Apps.",
    inputSchema: {
      service: z.string().max(80).optional().describe("Open this service first, e.g. storage or keyvault."),
      command: z.string().max(160).optional().describe("Return this command's description, tier and parameter schema, e.g. storage_account_get."),
    },
    invoking: "Loading the Azure service catalog…",
    invoked: "Azure services ready",
    page: {
      title: "Azure Services",
      css: `
.layout { display:grid; grid-template-columns:minmax(200px, 260px) 1fr; gap:12px; align-items:start; }
@media (max-width:640px) { .layout { grid-template-columns:1fr; } .svc { max-height:200px; } }
.svc { max-height:600px; overflow:auto; border:1px solid var(--line); border-radius:var(--radius); }
.svc button { display:flex; justify-content:space-between; gap:6px; width:100%; text-align:left; border:0; border-bottom:1px solid var(--line); border-radius:0; background:none; padding:7px 10px; min-height:0; }
.svc button[aria-current="true"] { background:var(--card); font-weight:600; box-shadow:inset 3px 0 0 var(--accent); }
.svc .count { color:var(--muted); font-size:12px; font-weight:400; }
.filters { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 6px; }
.filters input[type=search] { flex:1 1 160px; min-width:0; }
.chips { display:flex; gap:4px; flex-wrap:wrap; }
.chips button { min-height:26px; padding:2px 10px; font-size:12px; border-radius:999px; }
.chips button[aria-pressed="true"] { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
.cmd { border:1px solid var(--line); border-radius:var(--radius); margin:6px 0; }
.cmd > button { width:100%; text-align:left; border:0; background:none; display:flex; justify-content:space-between; align-items:center; gap:8px; }
.cmd > button .name { display:flex; flex-direction:column; gap:1px; min-width:0; }
.cmd > button .tags { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; }
.cmd .body { padding:8px 12px 12px; border-top:1px solid var(--line); }
.svcname { font-size:11px; color:var(--muted); }
.form { display:grid; grid-template-columns:minmax(120px, 200px) 1fr; gap:6px 10px; align-items:start; margin:8px 0; }
@media (max-width:480px) { .form { grid-template-columns:1fr; } }
.form label { font-size:12px; color:var(--muted); overflow-wrap:anywhere; padding-top:6px; } .form label.req::after { content:" *"; color:var(--bad); }
.form label small { display:block; font-size:11px; }
.form input, .form select, .form textarea { width:100%; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
.form textarea { min-height:64px; font-family:var(--font-mono, ui-monospace, Menlo, monospace); font-size:12px; }
.optional summary { cursor:pointer; color:var(--muted); font-size:12px; margin:6px 0; }
pre.out { max-height:360px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px; white-space:pre-wrap; word-break:break-word; margin:8px 0 0; }
details.call { margin-top:8px; } details.call summary { cursor:pointer; color:var(--muted); font-size:12px; }
.badge.read { color:var(--ok); border-color:var(--ok); } .badge.write { color:var(--warn); border-color:var(--warn); } .badge.destructive { color:var(--bad); border-color:var(--bad); }
.badge.own { color:var(--accent); border-color:var(--accent); }
.note { font-size:12px; color:var(--muted); margin:4px 0 0; }
`,
      script: `
boot((root, view) => {
  const d = view.data;
  if (d && d.command && !d.services) { root.innerHTML = '<pre class="out"></pre>'; $('pre', root).textContent = JSON.stringify(d.command, null, 2); return; }
  const services = d.services ?? [];
  const gate = d.gate ?? {};
  const ownTier = d.own_tiers ?? {};
  const total = services.reduce((n, s) => n + s.commands.length, 0);
  view.selected ??= (view.input.service && services.find((s) => s.name === view.input.service)?.name) || services[0]?.name;
  view.schemas ??= {};
  view.values ??= {};
  view.query ??= '';
  view.tier ??= 'all';
  const tierBadge = (t) => '<span class="badge ' + t + '">' + t + '</span>';
  const allowed = (t) => t === 'read' || (t === 'write' && gate.mode === 'write') || (t === 'destructive' && gate.mode === 'write' && gate.destructive_allowed);
  const needs = (t) => t === 'destructive' ? 'Mode = write and Allow destructive = true' : 'Mode = write';
  const gateLabel = gate.mode === 'write' ? (gate.destructive_allowed ? 'write + destructive' : 'write') : 'read only';
  root.innerHTML = '<h1>Azure services <span class="badge">' + services.length + ' services</span><span class="badge">' + total + ' commands</span><span class="badge">Microsoft Azure MCP ' + esc(d.version) + '</span>'
    + '<span class="badge ' + (gate.mode === 'write' ? (gate.destructive_allowed ? 'bad' : 'warn') : 'ok') + '">' + gateLabel + '</span></h1>'
    + (d.enabled ? '' : errorBox('Set AZURE_MCP_UPSTREAM to true to include them.', 'Microsoft Azure MCP tools are turned off.'))
    + '<div class="filters"><input type="search" id="q" aria-label="Search services and commands" placeholder="Search services and commands (e.g. secret, vm, cost)…" value="' + esc(view.query) + '">'
    + '<div class="chips" role="group" aria-label="Tier">' + ['all', 'read', 'write', 'destructive'].map((t) => '<button type="button" data-tier="' + t + '" aria-pressed="' + (view.tier === t) + '">' + t + '</button>').join('') + '</div></div>'
    + '<div class="layout"><nav class="svc" id="svc" aria-label="Services"></nav><section id="pane" aria-live="polite"></section></div>';
  const tierOk = (c) => view.tier === 'all' || c.tier === view.tier;
  const matches = (s, c, q) => !q || (c.name + ' ' + c.title + ' ' + c.own.join(' ')).toLowerCase().includes(q) || (s.name + ' ' + s.title).toLowerCase().includes(q);
  const drawList = () => {
    const q = view.query.toLowerCase();
    const shown = services.map((s) => ({ s, n: s.commands.filter((c) => tierOk(c) && matches(s, c, q)).length })).filter((x) => x.n > 0 || (!q && view.tier === 'all'));
    $('#svc').innerHTML = shown.map(({ s, n }) => '<button type="button" data-svc="' + esc(s.name) + '" aria-current="' + (!q && s.name === view.selected) + '"><span>' + esc(s.title) + '</span><span class="count">' + n + '</span></button>').join('') || emptyBox('No service matches.');
    $('#svc').querySelectorAll('[data-svc]').forEach((b) => { b.onclick = () => { view.selected = b.dataset.svc; view.query = ''; $('#q').value = ''; drawList(); drawPane(); }; });
  };
  const cmdRow = (s, c, showService) => '<div class="cmd"><button type="button" aria-expanded="false" data-svc="' + esc(s.name) + '" data-cmd="' + esc(c.name) + '">'
    + '<span class="name"><span>' + esc(c.title) + '</span><span class="mono muted">' + esc(c.name) + (showService ? ' · ' + esc(s.title) : '') + '</span></span>'
    + '<span class="tags">' + c.own.map((o) => '<span class="badge own" title="This server\\'s own tool does the same job (' + esc(ownTier[o] ?? '') + ' tier)">' + esc(o) + '</span>').join('') + tierBadge(c.tier) + '</span></button><div class="body" hidden></div></div>';
  const wire = (pane) => pane.querySelectorAll('.cmd > button').forEach((b) => { b.onclick = () => toggle(b); });
  const drawPane = () => {
    const pane = $('#pane');
    const q = view.query.toLowerCase();
    if (q) {
      const hits = [];
      for (const s of services) for (const c of s.commands) if (tierOk(c) && matches(s, c, q)) hits.push([s, c]);
      pane.innerHTML = '<h2>' + hits.length + ' command' + (hits.length === 1 ? '' : 's') + ' match “' + esc(view.query) + '”</h2>'
        + (hits.length ? hits.slice(0, 200).map(([s, c]) => cmdRow(s, c, true)).join('') + (hits.length > 200 ? '<p class="note">Showing the first 200. Narrow the search.</p>' : '') : emptyBox('Nothing matches. Try a service name or a verb like list or get.'));
      wire(pane);
      return;
    }
    const s = services.find((x) => x.name === view.selected);
    if (!s) { pane.innerHTML = emptyBox('Pick a service.'); return; }
    const counts = ['read', 'write', 'destructive'].map((t) => s.commands.filter((c) => c.tier === t).length);
    const list = s.commands.filter(tierOk);
    pane.innerHTML = '<h2>' + esc(s.title) + ' <span class="mono muted">' + esc(s.name) + '</span></h2><p class="muted">' + esc(s.summary) + '</p>'
      + '<div class="row">' + tierBadge('read') + counts[0] + ' ' + tierBadge('write') + counts[1] + ' ' + tierBadge('destructive') + counts[2] + '</div>'
      + (list.length ? list.map((c) => cmdRow(s, c, false)).join('') : emptyBox(s.commands.length ? 'No ' + view.tier + ' commands in this service.' : 'This service lists its commands at run time; ask for it with learn: true.'));
    wire(pane);
  };
  const schemaOf = async (name) => {
    if (view.schemas[name]) return view.schemas[name];
    const res = await view.app.callServerTool({ name: 'View_Azure_Services', arguments: { command: name } });
    const data = resultData(res);
    view.schemas[name] = data.command;
    return data.command;
  };
  const typeOf = (spec) => Array.isArray(spec.type) ? (spec.type.find((t) => t !== 'null') ?? 'string') : (spec.type ?? (spec.properties ? 'object' : 'string'));
  const field = (cmd, name, spec, required) => {
    const id = 'f-' + cmd.replace(/[^A-Za-z0-9_-]/g, '_') + '-' + name.replace(/[^A-Za-z0-9_-]/g, '_');
    const t = typeOf(spec);
    const saved = view.values[cmd]?.[name] ?? '';
    const hint = t === 'array' ? 'comma-separated, or a JSON array' : t === 'object' ? 'JSON object' : '';
    const label = '<label for="' + id + '"' + (required ? ' class="req"' : '') + ' title="' + esc(spec.description ?? '') + '">' + esc(name) + (hint ? '<small>' + hint + '</small>' : '') + '</label>';
    const common = ' id="' + id + '" data-name="' + esc(name) + '" data-type="' + esc(t) + '"';
    const enumValues = spec.enum ?? spec.items?.enum;
    if (t === 'boolean') return label + '<select' + common + '><option value="">(unset)</option><option' + (saved === 'true' ? ' selected' : '') + '>true</option><option' + (saved === 'false' ? ' selected' : '') + '>false</option></select>';
    if (Array.isArray(enumValues) && t !== 'array') return label + '<select' + common + '><option value="">(unset)</option>' + enumValues.map((v) => '<option' + (String(v) === saved ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
    if (t === 'object') return label + '<textarea' + common + ' placeholder="{ }">' + esc(saved) + '</textarea>';
    const type = t === 'integer' || t === 'number' ? 'number' : 'text';
    return label + '<input' + common + ' type="' + type + '" value="' + esc(saved) + '" placeholder="' + esc((spec.description ?? '').replace(/\\s+/g, ' ').slice(0, 90)) + '">';
  };
  const readValue = (el) => {
    const v = el.value.trim();
    if (v === '') return undefined;
    const t = el.dataset.type;
    if (t === 'boolean') return v === 'true';
    if (t === 'integer' || t === 'number') { const n = Number(v); if (Number.isNaN(n)) throw new Error(el.dataset.name + ' must be a number.'); return n; }
    if (t === 'array') { if (v.startsWith('[')) return JSON.parse(v); return v.split(',').map((x) => x.trim()).filter(Boolean); }
    if (t === 'object') { const o = JSON.parse(v); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(el.dataset.name + ' must be a JSON object.'); return o; }
    return v;
  };
  /** The largest array of objects in a result, for a table. */
  const findRows = (value, depth = 0) => {
    if (Array.isArray(value)) return value.length && value.every((r) => r && typeof r === 'object' && !Array.isArray(r)) ? value : null;
    if (!value || typeof value !== 'object' || depth > 3) return null;
    let best = null;
    for (const v of Object.values(value)) { const r = findRows(v, depth + 1); if (r && (!best || r.length > best.length)) best = r; }
    return best;
  };
  const renderResult = (out, text) => {
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const rows = parsed === undefined ? null : findRows(parsed);
    out.innerHTML = (rows ? '<div data-table></div>' : '') + '<details' + (rows ? '' : ' open') + '><summary class="muted">Raw result</summary><pre class="out"></pre></details>';
    $('pre', out).textContent = parsed === undefined ? text : JSON.stringify(parsed, null, 2);
    if (rows) {
      const keys = [];
      for (const r of rows.slice(0, 20)) for (const [k, v] of Object.entries(r)) if (!keys.includes(k) && (v === null || typeof v !== 'object')) keys.push(k);
      const flat = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
      table($('[data-table]', out), flat, keys.slice(0, 8).map((k) => ({ key: k, label: k })), { placeholder: 'Filter ' + rows.length + ' rows…' });
    }
  };
  const toggle = async (button) => {
    const body = button.nextElementSibling;
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
    if (open || body.dataset.ready) return;
    const s = services.find((x) => x.name === button.dataset.svc);
    const name = button.dataset.cmd;
    const meta = s.commands.find((c) => c.name === name);
    body.innerHTML = '<div class="status">Reading parameters…</div>';
    try {
      const cmd = await schemaOf(name);
      const props = cmd?.inputSchema?.properties ?? {};
      const req = new Set(cmd?.inputSchema?.required ?? []);
      const required = Object.keys(props).filter((n) => req.has(n)).sort();
      const optional = Object.keys(props).filter((n) => !req.has(n)).sort();
      const ok = allowed(meta.tier);
      body.innerHTML = '<p class="muted">' + esc(cmd?.description ?? '') + '</p>'
        + (meta.own.length ? '<p class="note">Same job as ' + meta.own.map((o) => '<span class="mono">' + esc(o) + '</span> (' + esc(ownTier[o] ?? '?') + ')').join(', ') + '. Ask for it by name to run it with this server\\'s own tiers.</p>' : '')
        + (required.length ? '<div class="form">' + required.map((n) => field(name, n, props[n], true)).join('') + '</div>' : '')
        + (optional.length ? '<details class="optional"' + (required.length ? '' : ' open') + '><summary>' + optional.length + ' optional parameter' + (optional.length === 1 ? '' : 's') + '</summary><div class="form">' + optional.map((n) => field(name, n, props[n], false)).join('') + '</div></details>' : '')
        + (!required.length && !optional.length ? '<p class="muted">No parameters.</p>' : '')
        + '<div class="row"><button type="button" class="primary" data-run' + (ok ? '' : ' disabled') + '>Run' + (meta.tier !== 'read' ? ' (' + meta.tier + ')' : '') + '</button>'
        + (ok ? '' : '<span class="muted">Needs ' + needs(meta.tier) + ' in Settings &gt; Extensions &gt; Azure.</span>') + '</div>'
        + '<details class="call"><summary>Tool call</summary><pre class="out mono" data-call></pre></details><div data-out></div>';
      body.dataset.ready = '1';
      const collect = () => {
        const parameters = {};
        body.querySelectorAll('[data-name]').forEach((el) => { const v = readValue(el); if (v !== undefined) parameters[el.dataset.name] = v; });
        view.values[name] = Object.fromEntries([...body.querySelectorAll('[data-name]')].map((el) => [el.dataset.name, el.value]));
        const args = d.mode === 'all' ? parameters : { intent: 'run ' + name + ' from the Azure Services view', command: name, parameters };
        return { parameters, tool: d.mode === 'all' ? name : s.name, args: { ...args, ...(view.profile ? { profile: view.profile } : {}) } };
      };
      const showCall = () => { try { const c = collect(); $('[data-call]', body).textContent = JSON.stringify({ tool: c.tool, arguments: c.args }, null, 2); } catch (e) { $('[data-call]', body).textContent = e.message; } };
      body.querySelectorAll('[data-name]').forEach((el) => { el.oninput = showCall; el.onchange = showCall; });
      showCall();
      const run = $('[data-run]', body);
      run.onclick = async () => {
        const out = $('[data-out]', body);
        let call;
        try { call = collect(); } catch (e) { out.innerHTML = errorBox(e.message, 'A parameter is not valid.'); return; }
        const missing = required.filter((n) => !(n in call.parameters));
        if (missing.length) { out.innerHTML = errorBox('Fill in: ' + missing.join(', '), 'Required parameters are missing.'); return; }
        if (meta.tier !== 'read' && !confirm('Run ' + name + ' (' + meta.tier + ') in tenant ' + (view.profile ?? 'default') + '?')) return;
        run.disabled = true;
        out.innerHTML = '<div class="status">Running…</div>';
        try {
          const res = await view.app.callServerTool({ name: call.tool, arguments: call.args });
          const text = (res.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\\n');
          if (res.isError) out.innerHTML = errorBox(text, 'The command failed.');
          else renderResult(out, text);
        } catch (e) { out.innerHTML = errorBox(e.message, 'The command failed.'); }
        finally { run.disabled = false; }
      };
    } catch (e) { body.innerHTML = errorBox(e.message, 'Could not read this command.'); }
  };
  let timer;
  $('#q').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { view.query = e.target.value.trim(); drawList(); drawPane(); }, 120); };
  root.querySelectorAll('[data-tier]').forEach((b) => { b.onclick = () => { view.tier = b.dataset.tier; root.querySelectorAll('[data-tier]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawList(); drawPane(); }; });
  drawList();
  drawPane();
});
`,
    },
    load: ({ service, command }) => {
      if (command) {
        const found = upstreamCommand(command);
        if (!found) throw new Error(`${command} is not a command of Microsoft's Azure MCP Server ${UPSTREAM_VERSION}. Open View_Azure_Services without command to search them.`);
        return Promise.resolve({ command: found });
      }
      const services = upstreamServices();
      return Promise.resolve({
        version: UPSTREAM_VERSION,
        enabled: upstreamEnabled(),
        mode: upstreamMode(),
        gate: { mode: isWriteMode() ? "write" : "read", destructive_allowed: isDestructiveAllowed() },
        selected: service ?? null,
        count: services.length,
        own_tiers: Object.fromEntries(apiReference().map((entry) => [textOf(entry.tool), entry.tier])),
        services,
      });
    },
  });
}
