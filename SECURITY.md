# Security policy

This server can change live Azure resources, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately through GitHub private vulnerability reporting: https://github.com/patrickking67/azure-mcp/security/advisories/new (or the repository's **Security** tab, **Report a vulnerability**). Do not open a public issue, pull request or discussion for a suspected vulnerability.

A useful report includes:

- what an attacker controls (a prompt, a tool argument, a remote request, a file in the repo);
- the exact tool call or `az` argv, and the tier you expected versus the one the server applied;
- the server version (`Status_Server`), the Azure CLI version (`az version`) and the transport (stdio or remote).

I aim to acknowledge a report within 3 business days and to confirm or rule it out within 14 days. Fixes land on `main` with a regression test, and the advisory is published once a fixed version is available. I am happy to credit you in the advisory.

## Scope

In scope:

- anything that runs a write or destructive action while its gate is closed, or without `confirm: true`;
- `Az_CLI` running a command the policy should classify as write, destructive, sensitive or blocked ([src/cli-policy.ts](src/cli-policy.ts));
- reading or writing local files, or sending a token or request body to a host other than the Azure endpoints the server names;
- the remote lane: unauthenticated access, token validation, role checks, on-behalf-of handling.

Out of scope: what an identity is already allowed to do by its own Azure RBAC or Graph permissions, and findings that need the operator to open both gates and then approve the call.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` and the latest release (1.x) | Yes |
| Anything older | No |
