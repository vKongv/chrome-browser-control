# Privacy Policy — Chrome Browser Control

Chrome Browser Control is a local-only browser automation bridge. It does not collect, transmit, or sell user data.

## What runs locally

- A loopback WebSocket broker on your machine (`127.0.0.1`, `localhost`, or `::1`).
- A Chrome extension that connects only to that local broker.
- An MCP stdio adapter launched by your local AI agent or IDE.

## Data handling

- **Pairing token:** Generated and stored locally (`~/.chrome-browser-control/config.env`, optional repo `.env.local` for contributors, and extension storage). Never sent to third parties.
- **Page content:** Read only when your MCP host invokes browser tools on tabs whose origins you allow in the extension popup. Content stays on your machine between the extension, broker, and MCP adapter.
- **Screenshots:** Captured only when your MCP host invokes `screenshot` on an allowed tab. Screenshots are visible-viewport data URLs and stay local to the extension, broker, and MCP adapter. Chrome requires `<all_urls>` or `activeTab` for screenshot capture; this project requests optional `<all_urls>` as a host permission only for wildcard screenshot support, and the extension still applies allowed-origin checks before capture.
- **Console logs:** Captured only after the content script is injected into an allowed page and only returned when `console_logs` is called. Old browser console history is not collected.
- **Resource summaries:** `page_status` reports Performance API counts by resource type only. It does not collect request headers, response bodies, cookies, or storage values.
- **Network:** The extension may request optional host permissions for origins you configure. It does not phone home or use external analytics.

## Permissions

- `tabs`, `scripting`, `storage`, `activeTab`, `offscreen`: required for tab listing, DOM snapshots, visible screenshots, and the offscreen WebSocket client.
- Optional host permissions (`http://*/*`, `https://*/*`) for allowed origins: granted only through the popup permission flow.
- Optional `<all_urls>` host permission: requested only for wildcard screenshot support, because Chrome requires it for `captureVisibleTab`.

## Contact

Report issues at https://github.com/vkongv/chrome-browser-control/issues.
