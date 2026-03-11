# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it through [GitHub Security Advisories](https://github.com/itlackey/agentikit/security/advisories/new) rather than opening a public issue.

We aim to acknowledge reports within 48 hours and provide an initial assessment within 7 days.

## Execution Model

akm runs scripts and tools from your stash directory. This is equivalent to running any code you download from an external source. Before executing scripts from installed kits, review them the same way you would review any third-party code.

Installed kits are cached locally and never executed automatically. The `akm show` command displays script content so you can inspect it before running.
