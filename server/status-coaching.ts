import type { BrokerOwnership } from './broker-lifecycle.js';

export interface NextActionInputs {
  ready: boolean;
  tokenMissing?: boolean;
  tokenInvalid?: boolean;
  brokerReachable: boolean;
  brokerOwnership?: BrokerOwnership;
  adapterConnected: boolean;
  extensionConnected: boolean;
  authFailed?: boolean;
  brokerPort?: number;
  autoloadTimedOut?: boolean;
  portNotBroker?: boolean;
}

export function buildNextAction(inputs: NextActionInputs): string | undefined {
  if (inputs.tokenMissing) {
    return 'Run npm run setup to generate CHROME_BROWSER_CONTROL_TOKEN, then add the same token to your MCP host env block and the extension popup before restarting the MCP server.';
  }

  if (inputs.tokenInvalid) {
    return 'CHROME_BROWSER_CONTROL_TOKEN is missing or invalid in the MCP adapter env. Run npm run setup, copy the token into your MCP host config env block, and match it in the extension popup.';
  }

  if (inputs.authFailed) {
    const port = inputs.brokerPort ?? 8765;
    return `Token mismatch on port ${port}. Align CHROME_BROWSER_CONTROL_TOKEN in .env.local, your MCP host env, and the extension popup, then restart the MCP server.`;
  }

  if (inputs.portNotBroker) {
    const port = inputs.brokerPort ?? 8765;
    return `Port ${port} is open but is not a Chrome Browser Control broker. Stop the other service on that port or change CHROME_BROWSER_CONTROL_PORT in your MCP host env and extension popup.`;
  }

  if (!inputs.brokerReachable) {
    if (inputs.autoloadTimedOut) {
      const port = inputs.brokerPort ?? 8765;
      return `Broker autoload timed out on port ${port}. Start it manually with npm run broker, verify the port is free, and confirm the pairing token matches your MCP host and extension popup.`;
    }
    const port = inputs.brokerPort ?? 8765;
    return `Broker is not reachable on port ${port}. Start it with npm run broker or restart the MCP server so autoload can spawn it, then verify token and port settings.`;
  }

  if (inputs.adapterConnected && !inputs.extensionConnected) {
    return 'Load the unpacked extension from chrome://extensions, open the popup, enter the same bridge URL and pairing token, then click Save and reconnect.';
  }

  if (inputs.ready) {
    return undefined;
  }

  return undefined;
}
