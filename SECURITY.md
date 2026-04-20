# Security Policy

## Reporting a Vulnerability

We take security seriously at SatRank. If you discover a security vulnerability, please report it responsibly.

**Preferred method**: Use GitHub's private vulnerability reporting feature: https://github.com/proofoftrust21/satrank/security/advisories/new

**Alternative**: Email security@satrank.dev (PGP key available on request)

### What to include

- Description of the vulnerability
- Affected endpoint(s) or component(s)
- Steps to reproduce
- Potential impact
- Suggested remediation if you have one

### Our commitment

- Acknowledge receipt within 48 hours
- Initial assessment within 7 days
- Fix timeline communicated based on severity:
  - Critical: < 7 days
  - High: < 30 days
  - Medium: < 90 days
  - Low: best effort
- Credit to researcher in public disclosure (opt-in)
- No legal action against researchers acting in good faith

## Scope

In scope:

- `satrank.dev` production API
- `@satrank/sdk` npm package
- `satrank` Python package
- All code in this repository

Out of scope:

- Third-party services linked from our documentation
- Social engineering of SatRank team members
- Physical attacks

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Public Security Advisories

Published advisories: https://github.com/proofoftrust21/satrank/security/advisories

See also: [docs/SECURITY-AUDIT-REPORT-2026-04-20.md](docs/SECURITY-AUDIT-REPORT-2026-04-20.md)
