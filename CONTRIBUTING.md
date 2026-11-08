# Contributing

Issues and pull requests are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

```bash
npm ci
npm test               # build, plugin bundle check, CLI policy, stdio smoke (fake az), remote transport
npm run check          # type check only
npm run manifest:check # manifest.json lists every tool the server registers
```

The tests never call Azure: the smoke test points `AZ_PATH` at [test/fixtures/fake-az.mjs](test/fixtures/fake-az.mjs).

## Changes

- One logical change per pull request, with a test. A change to [src/cli-policy.ts](src/cli-policy.ts) needs a test in [test/cli-policy.test.mjs](test/cli-policy.test.mjs) that fails without it.
- New tools register through `defineTool` ([src/tools/define.ts](src/tools/define.ts)) so they get a tier, the gate, `confirm` and their Azure CLI equivalent.
- After changing `src/`, run `npm run plugin:build` (rebuilds `plugin/server/azure-mcp.mjs`) and `npm run manifest` if the tool list changed. `npm test` fails while either is stale.
- No new runtime dependencies without discussion first.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Never commit tenant ids, subscription ids, resource names from a real environment, or anything from `infra/main.bicepparam` or `.env`. Use `00000000-0000-0000-0000-000000000000` and `contoso.example` in examples.
