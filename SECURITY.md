# Security Policy

## Supported Status

This repository is a local-only prototype. It is not production-ready unless you understand and configure the hardening controls described here.

## Threat Model

- The broker must bind only to loopback hosts.
- The extension must connect only to loopback `ws://` bridge URLs.
- There are no default tokens. Operators must generate and configure a high-entropy value in the legacy/current `HERMES_CHROME_TOKEN` env var.
- The extension exposes tabs and page actions only for allowed origins configured in the popup. Explicit entries such as `https://example.com` are supported, and `*` enables all normal `http://` and `https://` web pages while still blocking `chrome://`, `file://`, extension pages, and other non-web schemes.
- The broker can optionally require legacy/current `HERMES_CHROME_EXTENSION_ID` to pin one installed extension.
- Non-loopback binding is unsupported.
- CDP fallback is unsupported in the MCP adapter because it bypasses extension pairing.

## Reporting Vulnerabilities

Please open a private security advisory on GitHub when available, or contact the repository owner through their GitHub profile.

Do not include live pairing tokens, private config files, browser logs, or personal filesystem paths in public reports.
