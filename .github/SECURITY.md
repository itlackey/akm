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

## Self-Update Trust Model

`akm upgrade` downloads pre-built binaries from GitHub Releases. The upgrade process works as follows:

- SHA-256 checksums are verified against a checksums file published in the same GitHub release.
- Checksum verification is mandatory by default. If the checksums file cannot be fetched or the computed hash does not match, the upgrade is blocked and no binary is replaced.
- Users can bypass checksum verification with `--skip-checksum` at their own risk. This flag should only be used when you have an alternative way to verify the binary (e.g., you built it yourself).
- The trust model relies on GitHub's TLS transport security and the integrity of release artifacts hosted on GitHub. If an attacker can publish to the GitHub release, they can also publish a matching checksums file, so repository access controls are the primary trust boundary.

## Remote Stash Content

Content fetched from remote stash sources (e.g., OpenViking servers) should be treated as untrusted input:

- The CLI sanitizes control characters (U+0000 through U+001F and U+007F) from remote metadata fields (name, type, abstract) before displaying or processing them.
- Remote content returned by `akm show` is tagged with `origin: "remote"` in the response so that consumers can distinguish it from locally-authored assets.
- Only configure remote stash sources that you trust. Connections should use HTTPS to prevent man-in-the-middle interception.
- The OpenViking provider validates that the configured base URL uses an `http://` or `https://` scheme; other schemes (e.g., `file://`) are rejected to prevent SSRF.
- API keys for remote sources should be stored via environment variable references (e.g., `${OPENVIKING_API_KEY}`) in the agentikit config file, not as plaintext values. The CLI performs environment variable substitution at runtime so that secrets are never persisted in the configuration.
