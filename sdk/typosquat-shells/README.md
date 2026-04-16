# Typosquat shell packages

Empty packages published under names that could be confused with `@satrank/sdk`, each pointing users to the real package. Defends against an attacker registering a malicious look-alike.

## Names to claim

| Name | Rationale |
|---|---|
| `satrank` | Un-scoped drop of the obvious name |
| `sat-rank-sdk` | Hyphenated variant |
| `satrank-client` | "-client" suffix, common SDK naming pattern |
| `satrank-sdk` | "-sdk" suffix without the scope |

Each folder below contains a `package.json` + `index.js` that prints a deprecation notice and throws. Publishing procedure (operator action — requires `npm login` with 2FA):

```bash
cd typosquat-shells/satrank && npm publish --access public --otp=<TOTP>
cd ../sat-rank-sdk && npm publish --access public --otp=<TOTP>
cd ../satrank-client && npm publish --access public --otp=<TOTP>
cd ../satrank-sdk && npm publish --access public --otp=<TOTP>
```

Each package has **no dependencies, no install scripts** — just a stub with a clear warning. See `RELEASE-POLICY.md` in the parent directory for the full hardening checklist.

## Maintenance

npm's unpublish window is 72 hours for recent publishes. Once older than 72h the shell is permanent (npm won't let the current scope owner remove it either, which is a *good* thing for squat defense). No ongoing maintenance required after the first publish.

If someone else publishes a similar name that we missed, report via https://www.npmjs.com/support for trademark-adjacent claims (SatRank name + branding).
