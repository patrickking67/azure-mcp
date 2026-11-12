// Rewrite manifest.json's `tools` array from what the server actually registers.
//
// The MCPB manifest lists every tool so the client can show the surface before
// the server is ever launched. A hand-maintained list drifts; this one is
// derived. The server is started over stdio exactly as the manifest's
// mcp_config says, with no credentials — listing tools must not depend on
// configuration — and each entry is written as { name: <title>, description:
// <first sentence> }. The title, not the wire name, is what the client shows,
// so every tool must carry a Title Case `title`; a missing or lowercase one
// fails the run rather than shipping.
//
//   node scripts/sync-manifest.mjs           rewrite manifest.tools
//   node scripts/sync-manifest.mjs --check   exit 1 if it would change
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const require = createRequire(resolve(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

const manifestPath = resolve(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cfg = manifest.server.mcp_config;
// ${__dirname} is the bundle root; ${user_config.*} is left unset so the
// listing reflects the surface, not one configuration of it.
const expand = (s) => s.replaceAll('${__dirname}', ROOT).replace(/\$\{user_config\.[^}]+\}/g, '');
const env = { ...process.env };
for (const [name, value] of Object.entries(cfg.env ?? {})) {
  const v = expand(value);
  if (v !== '') env[name] = v;
}

const transport = new StdioClientTransport({ command: cfg.command, args: (cfg.args ?? []).map(expand), env, cwd: ROOT, stderr: 'pipe' });
const client = new Client({ name: 'sync-manifest', version: '0' });
await client.connect(transport);
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

/** First sentence of a description, for the manifest's one-line summary. */
function summarize(description = '') {
  const match = /^(.*?[.!?])(\s|$)/s.exec(description.trim());
  const text = (match?.[1] ?? description.trim()).replace(/\s+/g, ' ');
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

const problems = [];
const seen = new Map();
for (const tool of tools) {
  const title = tool.title ?? tool.annotations?.title;
  if (!title) problems.push(`${tool.name} has no title`);
  else if (/_/.test(title) || !/^[A-Z0-9]/.test(title)) problems.push(`${tool.name} title "${title}" is not Title Case`);
  else if (seen.has(title)) problems.push(`title "${title}" is used by both ${seen.get(title)} and ${tool.name}`);
  seen.set(title, tool.name);
}
if (problems.length) {
  console.error(`sync-manifest: ${problems.length} tool(s) would show badly in the client:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// Registration order is meaningful, so it is kept rather than sorted.
const next = tools.map((tool) => ({ name: tool.title ?? tool.annotations?.title, description: summarize(tool.description) }));
const changed = JSON.stringify(next) !== JSON.stringify(manifest.tools ?? []);
if (check) {
  if (changed) {
    console.error(`sync-manifest: manifest.json tools are out of date (${manifest.tools?.length ?? 0} listed, ${next.length} registered). Run: npm run manifest`);
    process.exit(1);
  }
  console.error(`sync-manifest: manifest.json lists all ${next.length} tools`);
} else {
  manifest.tools = next;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`sync-manifest: wrote ${next.length} tools to manifest.json${changed ? '' : ' (no change)'}`);
}
