// Browser-side helper for views whose rows carry power buttons (VMs, web apps). A button arms on the
// first click and fires on the second, then calls the server's own gated tool with confirm: true, so the
// write gate, the destructive gate and (remotely) the caller's Entra role apply to a click exactly as to
// the model. A refusal is shown in the status line; nothing is retried.

export const ACTION_CSS = `
.actions button { padding:3px 8px; font-size:12px; margin-right:4px; }
.actions { display:inline-flex; gap:4px; }
/* The action column stays in view when a wide table scrolls sideways. */
td.col-actions, th.col-actions { position:sticky; right:0; box-shadow:-1px 0 0 var(--line); }
td.col-actions { background:var(--bg); } th.col-actions { z-index:2; }
.actions button { margin-right:0; }
.actions button.arm { background:var(--bad); color:var(--on-bad); border-color:var(--bad); }
`;

export const ACTION_JS = `
function wireActions(root, view, toolFor, argsFor, statusEl) {
  root.querySelectorAll('button[data-action]').forEach((b) => {
    b.onclick = async () => {
      if (!b.classList.contains('arm')) {
        root.querySelectorAll('button.arm').forEach((o) => { o.classList.remove('arm'); o.textContent = o.dataset.label; });
        b.classList.add('arm'); b.textContent = 'Confirm ' + b.dataset.label.toLowerCase();
        statusEl.textContent = 'Click again to ' + b.dataset.label.toLowerCase() + ' ' + b.dataset.name + '. Any other button cancels.'; return;
      }
      b.disabled = true; b.textContent = b.dataset.label + '…';
      const row = view.rows.find((r) => r.id === b.dataset.id);
      try {
        const out = await view.call(toolFor(b.dataset.action), { ...argsFor(row), confirm: true });
        statusEl.innerHTML = '<span class="badge ok">' + esc(b.dataset.label) + ' accepted</span> ' + esc(row.name) + (out && out.note ? ' · ' + esc(out.note) : '') + ' · refresh in a minute to see the new state.';
      } catch (e) {
        statusEl.innerHTML = errorBox(e.message, b.dataset.label + ' was refused. Nothing was changed.');
      }
      b.disabled = false; b.classList.remove('arm'); b.textContent = b.dataset.label;
    };
  });
}
function actionButton(row, action, label) {
  return '<button type="button" data-action="' + esc(action) + '" data-id="' + esc(row.id) + '" data-name="' + esc(row.name) + '" data-label="' + esc(label) + '" aria-label="' + esc(label + ' ' + row.name) + '">' + esc(label) + '</button>';
}
async function refresh(view, tool, statusEl) {
  statusEl.textContent = 'Refreshing…';
  try { view.data = await view.call(tool, view.input); view.redraw(); } catch (e) { statusEl.innerHTML = errorBox(e.message, 'Refresh failed. The table shows the last result.'); }
}
`;
