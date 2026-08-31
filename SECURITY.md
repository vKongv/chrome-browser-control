# Security Policy

## Supported Status

This repository is a local-only prototype. It is not production-ready unless you understand and configure the hardening controls described here.

## Threat Model

- The broker must bind only to loopback hosts.
- The extension must connect only to loopback `ws://` bridge URLs.
- There are no default tokens. Operators must generate and configure a high-entropy value in `CHROME_BROWSER_CONTROL_TOKEN`.
- The extension exposes tabs and page actions only for allowed origins configured in the popup. Explicit entries such as `https://example.com` are supported, and `*` enables all normal `http://` and `https://` web pages while still blocking `chrome://`, `file://`, extension pages, and other non-web schemes.
- Allowed-origin checks run in the extension background before content actions, tab claims, and screenshots.
- Tab claims are advisory routing state by default. Use `claim_tab({ exclusive: true, ttlMs?, owner? })` for fail-fast coordination leases across parallel agents; leases expire by TTL and do not create browser locks. They do not close user tabs.
- Password-like and OTP fields are blocked by `type` unless the caller passes `force=true`.
- Structured extraction tools are bounded. `includeHtml` redacts password/OTP/hidden-token attribute values and marks sensitive items; it should still be treated as untrusted page content. Raw JavaScript evaluation, cookies, localStorage, sessionStorage, browser history, bookmarks, downloads, request headers, and response bodies are intentionally out of scope.
- Visible screenshots may activate an inactive target tab because Chrome MV3 captures the visible tab in a window. Chrome requires `<all_urls>` or `activeTab` for `captureVisibleTab`; this project requests optional `<all_urls>` as a host permission only for wildcard screenshot support. The extension background still rejects non-http(s) and unapproved URLs before capture.
- The broker can optionally require `CHROME_BROWSER_CONTROL_EXTENSION_ID` to pin one installed extension.
- Non-loopback binding is unsupported.
- Trusted CDP input is opt-in behind the optional `debugger` permission. Attach requires a claimed tab and an allowed origin. Commands are constrained to `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`. The socket fails closed on service-worker suspension, navigation to a disallowed origin, and DevTools eviction. `Fetch.*`, `Network.setRequestInterception`, `Network.continueInterceptedRequest`, and `Runtime.evaluate` are forbidden, not merely unimplemented. The MCP adapter does not open a raw CDP socket.

## Reporting Vulnerabilities

Please open a private security advisory on GitHub when available, or contact the repository owner through their GitHub profile.

Do not include live pairing tokens, private config files, browser logs, or personal filesystem paths in public reports.
