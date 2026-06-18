import { z } from 'zod';
import { BrowserBridge } from './bridge.js';
import { BridgeAction } from './protocol.js';

export interface ToolRegistrar {
  registerTool: (name: string, config: Record<string, unknown>, cb: (args: any) => Promise<any>) => unknown;
}

export interface BridgeLike {
  readonly connected?: boolean;
  connect?: () => Promise<void>;
  call(action: BridgeAction, params?: Record<string, unknown>): Promise<unknown>;
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function forward(bridge: BridgeLike, action: BridgeAction, params: Record<string, unknown> = {}) {
  try {
    return toolResult(await bridge.call(action, params));
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: (error as Error).message || String(error)
        }
      ]
    };
  }
}

const OptionalTabId = z.number().int().positive().optional();

function isNoExtensionError(message: string): boolean {
  return /no chrome extension connected|chrome extension disconnected/i.test(message);
}

function isNoBrokerError(message: string): boolean {
  return /not connected to chrome broker|timed out waiting for broker|ECONNREFUSED|ENOTFOUND/i.test(message);
}

async function browserStatus(bridge: BridgeLike) {
  let adapterConnected = bridge.connected === true;

  if (!adapterConnected && typeof bridge.connect === 'function') {
    try {
      await bridge.connect();
      adapterConnected = bridge.connected === true;
    } catch (error) {
      const message = (error as Error).message || String(error);
      const brokerReachable = !isNoBrokerError(message);
      return toolResult({
        ready: false,
        adapter: { connected: false },
        broker: { reachable: brokerReachable },
        extension: { connected: false },
        error: message
      });
    }
  }

  try {
    const ping = (await bridge.call('ping', {})) as Record<string, unknown>;
    const rawStatus = typeof ping.status === 'string' ? ping.status : undefined;
    // A successful ping means the extension handled the request; stale "disconnected" is misleading.
    const bridgeStatus =
      rawStatus === 'disconnected' || rawStatus === undefined ? 'connected' : rawStatus;
    const normalizedPing = { ...ping, status: bridgeStatus };
    const marker = {
      ...(ping.protocolVersion !== undefined ? { protocolVersion: ping.protocolVersion } : {}),
      ...(Array.isArray(ping.features) ? { features: ping.features } : {})
    };

    return toolResult({
      ready: true,
      adapter: { connected: true },
      broker: { reachable: true },
      extension: {
        connected: true,
        status: bridgeStatus,
        ...marker,
        ...(Array.isArray(ping.allowedOrigins) ? { allowedOrigins: ping.allowedOrigins } : {})
      },
      ping: normalizedPing
    });
  } catch (error) {
    const message = (error as Error).message || String(error);
    const brokerReachable = adapterConnected || !isNoBrokerError(message);
    return toolResult({
      ready: false,
      adapter: { connected: brokerReachable },
      broker: { reachable: brokerReachable },
      extension: { connected: false },
      error: message,
      ...(isNoExtensionError(message) ? { detail: 'Broker is reachable, but no Chrome extension is connected.' } : {})
    });
  }
}

export function registerBrowserTools(server: ToolRegistrar, bridge: BrowserBridge | BridgeLike): void {
  server.registerTool(
    'browser_status',
    {
      title: 'Browser bridge status',
      description: 'Check whether the MCP adapter can reach the local broker and whether the Chrome extension answers ping.',
      inputSchema: {}
    },
    async () => browserStatus(bridge)
  );

  server.registerTool(
    'list_tabs',
    {
      title: 'List Chrome tabs',
      description: 'List tabs visible to the Chrome Browser Control extension in the current Chrome profile.',
      inputSchema: {}
    },
    async () => forward(bridge, 'list_tabs')
  );

  server.registerTool(
    'snapshot',
    {
      title: 'Snapshot active page',
      description:
        'Return a simplified DOM snapshot for the active tab or a target tab. Compact mode (default) returns textPreview only — not text. Full mode returns text. Defaults truncate at 500 (compact) or 4000 (full) chars; pass textLimit (up to 100000) for long page content such as API docs. Response includes textLimitApplied, textTotalLength, and textBytesOmitted; a warning appears when default limits truncate body text.',
      inputSchema: {
        mode: z.enum(['compact', 'full']).optional().describe('Snapshot detail mode. Defaults to compact (textPreview field). Use full for the text field and verbose element metadata.'),
        textLimit: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe('Max body text characters. Optional; defaults to 500 (compact) or 4000 (full). Not a hard cap — maximum 100000.'),
        tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the active tab.')
      }
    },
    async (args) => forward(bridge, 'snapshot', args)
  );

  server.registerTool(
    'navigate',
    {
      title: 'Navigate Chrome tab',
      description: 'Navigate the active tab or target tab to a URL.',
      inputSchema: {
        url: z.string().url(),
        tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the active tab.')
      }
    },
    async (args) => forward(bridge, 'navigate', args)
  );

  server.registerTool(
    'click',
    {
      title: 'Click page element',
      description: 'Click an element by snapshot ref in the active tab or target tab.',
      inputSchema: {
        ref: z.string().min(1),
        tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the active tab.')
      }
    },
    async (args) => forward(bridge, 'click', args)
  );

  server.registerTool(
    'type',
    {
      title: 'Type into page element',
      description: 'Type text into an element by snapshot ref. Password-like fields are blocked unless force=true.',
      inputSchema: {
        ref: z.string().min(1),
        text: z.string(),
        force: z.boolean().optional().default(false),
        tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the active tab.')
      }
    },
    async (args) => forward(bridge, 'type', args)
  );

  server.registerTool(
    'scroll',
    {
      title: 'Scroll page',
      description:
        'Scroll the active tab or target tab by pixel deltas. Does not change snapshot body text — snapshot uses the full document innerText, not the visible viewport. Use textLimit on snapshot to capture more text; scroll only helps when the page lazy-loads content.',
      inputSchema: {
        deltaX: z.number().optional().default(0),
        deltaY: z.number().optional().default(600),
        tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the active tab.')
      }
    },
    async (args) => forward(bridge, 'scroll', args)
  );
}
