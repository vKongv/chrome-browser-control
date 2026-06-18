# Code Review Notes

## Security Cleanup Findings

This document tracks the pre-public-push cleanup scope after remediation:

- Default development tokens were removed from runtime paths.
- Local personal paths were replaced with placeholders.
- The MCP adapter no longer supports CDP fallback.
- The extension manifest no longer requests universal host permissions.
- Allowed origins are required before tabs or page actions are exposed.
- Broker role validation is explicit, and extension ID pinning is available through `CHROME_BROWSER_CONTROL_EXTENSION_ID`.

## Residual Prototype Risks

- The pairing model is a shared local token. Treat it as a prototype control, not production-grade authentication.
- Allowed-origin enforcement is extension-side and depends on keeping the extension code trusted.
- Optional host permissions are requested from the popup; users can still deny permission and should expect blocked actions.
- `server/cdp.ts` remains as unused development reference code.
