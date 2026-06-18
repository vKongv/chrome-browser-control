# Privacy Policy — Chrome Browser Control

Chrome Browser Control is a local-only browser automation bridge. It does not collect, transmit, or sell user data.

## What runs locally

- A loopback WebSocket broker on your machine (`127.0.0.1`, `localhost`, or `::1`).
- A Chrome extension that connects only to that local broker.
- An MCP stdio adapter launched by your local AI agent or IDE.

## Data handling

- **Pairing token:** Generated and stored locally (`.env.local` and extension storage). Never sent to third parties.
- **Page content:** Read only when your MCP host invokes browser tools on tabs whose origins you allow in the extension popup. Content stays on your machine between the extension, broker, and MCP adapter.
- **Network:** The extension may request optional host permissions for origins you configure. It does not phone home or use external analytics.

## Permissions

- `tabs`, `scripting`, `storage`, `activeTab`, `offscreen`: required for tab listing, DOM snapshots, and the offscreen WebSocket client.
- Optional host permissions (`http://*/*`, `https://*/*`): granted only for origins you add in the popup.

## Contact

Report issues at https://github.com/vkongv/chrome-browser-control/issues.
