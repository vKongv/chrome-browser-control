# Progress

## Current Status

The prototype has been hardened for a pre-public-push cleanup pass:

- Broker and MCP adapter require the legacy/current `HERMES_CHROME_TOKEN` env var.
- Broker host validation is loopback-only.
- Extension token defaults are blank.
- Extension bridge URL validation allows only local `ws://` endpoints.
- Extension page access is gated by explicit allowed origins.
- Manifest no longer contains universal host permissions.
- MCP adapter no longer routes through CDP fallback.
- Public docs use placeholder paths and generic config examples.

## Verification Targets

- `npm test`
- `npm run build`
- `npm audit`
- Leak scans for default tokens, known leaked tokens, personal paths, and private config paths.

## Follow-Ups

- Consider replacing the shared-token loopback broker with Chrome Native Messaging for stronger local pairing.
- Consider signed release packaging for the extension before any broader distribution.
- Add browser-level integration tests for the unpacked extension permission request workflow.

## Cleanup Verification

Final checks from the pre-public-push cleanup pass:

- `npm test`: 8 test files passed, 34 tests passed.
- `npm run build`: passed.
- `npm audit`: found 0 vulnerabilities.
- Leak scans for the old default token literal, known leaked token, personal workspace path, and private config path returned no hits.
