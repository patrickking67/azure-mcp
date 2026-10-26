#!/usr/bin/env node
// Inline the MCP Apps browser runtime into a TypeScript module.
//
// Interactive views are HTML documents the host renders in a sandboxed iframe.
// They cannot import from node_modules or a CDN — there is no bundler between
// this server and the iframe, and a host's CSP may forbid remote scripts — so
// the ext-apps runtime is embedded verbatim into every page. Committing the
// result (like src/icon.ts) keeps the Worker build and the stdio build identical
// and keeps `npm ci && npm run build` free of a bundling step.
//
// The bundle's trailing `export { ... }` is rewritten to a globalThis
// assignment: an inline <script type="module"> may declare exports, but nothing
// can import them, and the view code needs a stable name for `App`.
//
// Usage: node scripts/generate-app-runtime.mjs [--check]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', '@modelcontextprotocol', 'ext-apps', 'dist', 'src', 'app-with-deps.js');
const OUT = join(ROOT, 'src', 'apps', 'generated', 'runtime.ts');
const CHECK = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@modelcontextprotocol', 'ext-apps', 'package.json'), 'utf8'));
let js = readFileSync(SOURCE, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd();

const exportMatch = /export\s*\{([^}]*)\};?\s*$/.exec(js);
if (!exportMatch) throw new Error('app-with-deps.js no longer ends with an export block; revisit this script');
const names = exportMatch[1]
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [local, exported] = entry.split(/\s+as\s+/);
    return `${exported ?? local}: ${local}`;
  });
if (!names.some((n) => n.startsWith('App:'))) throw new Error('the runtime bundle does not export App');
js = `${js.slice(0, exportMatch.index)}globalThis.__mcpApps = { ${names.join(', ')} };\n`;

const content = `// GENERATED FILE — do not edit. Regenerate with \`npm run apps:runtime\`.
// @modelcontextprotocol/ext-apps ${pkg.version} browser runtime (app-with-deps.js), inlined for the interactive views.
export const APP_RUNTIME_VERSION = ${JSON.stringify(pkg.version)};
export const APP_RUNTIME = ${JSON.stringify(js)};
`;

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
if (current === content) {
  console.error('generate-app-runtime: runtime.ts is current');
} else if (CHECK) {
  console.error('generate-app-runtime: src/apps/generated/runtime.ts is out of date; run `npm run apps:runtime`');
  process.exit(1);
} else {
  writeFileSync(OUT, content);
  console.error(`generate-app-runtime: wrote runtime.ts (${(content.length / 1024).toFixed(0)} KB, ext-apps ${pkg.version})`);
}
