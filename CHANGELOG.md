# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- `Az_CLI` and `Az_CLI_Run` now classify the argv that actually runs, including the `--subscription` value added from `subscription_id`. Before, `subscription_id: "@/path"` made the ungated read tool read a local file and echo it in the CLI's warning. `subscription_id` values starting with `@`, `~`, `-` or whitespace are refused.
- The CLI classifier reads past global options (`--only-show-errors`, `--verbose`, `--help`, `-o`, `--query`) and `--` between command words, so a token or delete cannot hide behind them. Azure CLI 2.92 rejects these forms today; the classifier no longer relies on that.
- App Service auth settings, backup configuration, mounted storage accounts and `--resolve-keyvault` are credential reads (write tier).
- Refused: `--generate-ssh-keys` (writes into `~/.ssh`), `browse`, `connectedk8s proxy`, `survey`, `devops login`, `devops logout`, `devops configure`.

### Changed

- CI also tests Node 26, the version the Docker image runs.
- MCP Apps views: WCAG AA status colours in light and dark, visible focus rings, keyboard-sortable headers with `aria-sort`, labelled filters, an action column that stays in view on narrow screens, and empty and error states that say what to do next.
- `npm run check` runs everything CI runs (typecheck, lint, tests, manifest check); the type-check-only script is now `npm run typecheck`.

### Fixed

- Tool output no longer shows `[object Object]` when Azure returns an object where a string was expected (power state, subscription ids, cost columns, token errors).
- `azRun` always rejects with an `Error`, and the remote HTTP server catches a rejection that escapes its request handler instead of leaving it unhandled.

### Added

- ESLint (`npm run lint`) with typescript-eslint type-checked rules, run by `npm run check` and CI.
- A test that a write without `confirm: true` is refused even with both gates open.
- `AGENTS.md`, `CLAUDE.md`, `llms.txt`, this changelog, `.editorconfig`, `.gitattributes`, CODEOWNERS, Dependabot, issue and PR templates, and a `.claude/launch.json` for the local HTTP transport.

## [1.0.0] - 2026-10-26

### Added

- The Azure CLI one-to-one: `Az_CLI` (reads), `Az_CLI_Run` (classified per command), `Az_CLI_Help`.
- Six MCP Apps views: estate, virtual machines, web apps, costs, resources, security.
- Remote lane on Azure Container Apps behind Entra ID with on-behalf-of tokens and app roles.
- Claude Code, Codex and ChatGPT desktop plugins.

### Security

- CLI policy hardening from review: vault reads through `az rest` gated, local paths refused, the CLI run in an empty sandbox directory, `..` segments refused anywhere.
- After 1.0.0 on `main`: command words matched case-insensitively, non-ASCII command words refused, long-option abbreviations and repeated options checked.
- MIT license, SECURITY.md, CONTRIBUTING.md and CI added after the tag.

## [0.3.0] - 2026-07-24

### Added

- First public commit (untagged): 91 tools across ARM and Microsoft Graph with read and write gates, the `.mcpb` bundle, Windows Azure CLI resolution.

[Unreleased]: https://github.com/patrickking67/azure-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/patrickking67/azure-mcp/releases/tag/v1.0.0
[0.3.0]: https://github.com/patrickking67/azure-mcp/commits/13c412d
