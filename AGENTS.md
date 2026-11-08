# AGENTS.md

Guide for coding agents working on this repository. Humans: start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A TypeScript MCP server for Microsoft Azure and Entra ID (server name "Azure", 102 tools). Read tools, write tools behind `AZURE_MODE=write`, destructive tools also behind `AZURE_ALLOW_DESTRUCTIVE=true`, six MCP Apps views, and the Azure CLI one-to-one through a per-command policy classifier. Two transports: stdio (`dist/index.js`) and Streamable HTTP behind Entra ID (`dist/remote.js`).

Security is the point of the project. The gates and the CLI classifier must never get weaker.

## Stack

- Node.js 20+ (CI runs 22 and 24), ESM, TypeScript strict, `tsc` only. npm with `package-lock.json`.
- Runtime deps: `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `zod`, `jose`. No others without asking.
- Tests: `node:test` against the built `dist/`. No linter beyond `tsc --strict`.
- esbuild bundles the plugin server; `@anthropic-ai/mcpb` packs the Claude Desktop bundle.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts`, `src/remote.ts` | stdio and HTTP entry points |
| `src/server.ts` | builds the one tool surface both transports share |
| `src/gate.ts` | the write and destructive gates, `confirm`, annotations |
| `src/cli-policy.ts` | classifies every `az` argv: read, write, destructive, sensitive, blocked |
| `src/az.ts` | finds and runs `az` (argv only, empty sandbox cwd) |
| `src/tools/define.ts` | `defineTool`: every tool registers here, so tier, gate and confirm cannot be skipped |
| `src/tools/*.ts` | the tools, by area; `cli.ts` is `Az_CLI`, `Az_CLI_Run`, `Az_CLI_Help` |
| `src/apps/` | MCP Apps views: `shell.ts` (shared HTML, CSS, table, boot), `views/*.ts` |
| `src/apps/generated/runtime.ts` | inlined ext-apps browser runtime (generated) |
| `src/auth.ts`, `src/entra.ts`, `src/client.ts` | tokens, Entra validation, ARM/Graph/Key Vault/Log Analytics clients |
| `test/` | `cli-policy.test.mjs` (classifier), `smoke.test.mjs` (stdio + fake az), `remote.test.mjs` |
| `test/fixtures/fake-az.mjs` | stands in for `az`; echoes argv as JSON |
| `plugin/` | Claude Code / Codex plugin; `plugin/server/azure-mcp.mjs` is a committed esbuild bundle |
| `manifest.json` | `.mcpb` manifest; its tool list is synced from the server |
| `infra/`, `Dockerfile`, `scripts/deploy-azure.sh`, `scripts/entra-setup.sh` | remote deployment |

## Commands

Run from the repo root. All of these work offline except `mcpb:pack` (needs the npm registry) and the deploy scripts (need Azure).

```bash
npm ci                 # install from the lockfile
npm run check          # the one gate: typecheck + test + manifest:check. Run before every commit.
npm run typecheck      # tsc --noEmit
npm test               # build, plugin bundle check, all tests
npm run build          # tsc to dist/
npm run plugin:build   # rebuild plugin/server/azure-mcp.mjs; required after any src/ change
npm run manifest       # rewrite manifest.json tools after adding or renaming a tool
npm run mcpb:pack      # build, sync manifest, validate, write azure.mcpb (gitignored)
npm run apps:runtime   # re-inline the ext-apps runtime after upgrading @modelcontextprotocol/ext-apps
npm start              # stdio server from dist/
```

`npm test` fails if `plugin/server/azure-mcp.mjs` is stale; `npm run check` also fails if `manifest.json` is. Commit the rebuilt bundle with the source change that caused it.

Local HTTP: `.claude/launch.json` starts `dist/remote.js` on port 4107 with placeholder Entra ids. `/` and `/healthz` answer 200; `/mcp` answers 401 without a real tenant.

## Rules

- Never run anything against a real Azure subscription or tenant. Tests use `AZ_PATH=test/fixtures/fake-az.mjs` and never sign in. If you need to see how `az` parses something, use a throwaway `AZURE_CONFIG_DIR` with no sign-in.
- Any change to `src/cli-policy.ts`, `src/gate.ts`, `src/tools/define.ts` or `src/tools/cli.ts` needs a test that fails without it. Cover case, abbreviations, repeated flags, quoting, global options between command words, `@file` and path values, and commands that print tokens or keys.
- The classifier fails closed: when unsure, classify higher or block. Never move a command to a lower tier to make it convenient.
- Classify exactly the argv that will run, including anything the server appends.
- New tools go through `defineTool` (or `registerView` for views) and carry their `az` equivalent.
- Views are vanilla HTML/CSS/JS template strings in `src/apps/`. No framework, CDN or build step. Buttons call the same gated tools; keep WCAG AA contrast, visible focus and keyboard access.
- No secrets, tenant ids, subscription ids or real resource names anywhere. Use `00000000-0000-0000-0000-000000000000` and `contoso.example`.
- No new runtime dependencies, no major upgrades, no new tooling without asking.
- Conventional Commits, one logical change per commit, `npm run check` green at every commit. No AI attribution in commits, PRs or files.

## Do not touch

- `src/apps/generated/` and `plugin/server/azure-mcp.mjs` by hand: regenerate them.
- `package-lock.json` except through npm.
- `infra/main.bicepparam` and `.env*` (gitignored, may hold real ids).
- Repository settings, secrets, branch protection.

## Shipping

1. Branch from `main` (`feat/`, `fix/`, `docs/`, `chore/`).
2. Change, add tests, `npm run plugin:build`, `npm run manifest` if the tool list changed.
3. `npm run check`. Update `CHANGELOG.md` under `[Unreleased]`.
4. Push and open a PR against `main`. CI runs `npm run check` on Node 22 and 24.
5. Releases: bump the version in `package.json`, `manifest.json`, `src/version.ts`, `plugin/plugin.json`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, rebuild the plugin, move `[Unreleased]` to the new version in `CHANGELOG.md`, tag `vX.Y.Z`, attach `azure.mcpb` from `npm run mcpb:pack`. Only when the owner asks.

## Definition of done

- `npm run check` passes locally.
- New behaviour has tests; security changes have tests proving the bypass is closed.
- Plugin bundle and manifest are current.
- README, AGENTS.md and CHANGELOG.md match the code.
