import { z } from 'zod';
import type { BrokerOwnership } from './broker-lifecycle.js';
import type { EnsureBrokerResult } from './broker-lifecycle.js';
import { BrowserBridge } from './bridge.js';
import { BridgeAction } from './protocol.js';
import { buildNextAction } from './status-coaching.js';

export const ADAPTER_PROTOCOL_VERSION = 1;

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
const OptionalTarget = {
  tabId: OptionalTabId.describe('Optional Chrome tab id. Defaults to the claimed session tab, then the active tab.'),
  sessionTabId: z.string().min(1).optional().describe('Optional claimed tab session id returned by claim_tab.')
};
const SnapshotMode = z.enum(['compact', 'full', 'visible']);
const BoundedLimit = z.number().int().positive().max(500).optional();
const SnapshotScope = z.enum(['document', 'main', 'article', 'feed']);
const SnapshotScopeOptions = {
  scope: SnapshotScope.optional().describe(
    'Content root for text and elements. Compact defaults to main when a main landmark exists; use document for legacy full-body text.'
  ),
  excludeSelectors: z
    .array(z.string().min(1).max(500))
    .max(20)
    .optional()
    .describe('CSS selectors for subtrees removed from the scoped snapshot.'),
  ignoreRoles: z
    .array(z.string().min(1).max(80))
    .max(20)
    .optional()
    .describe('Computed roles to exclude from scoped snapshots. Compact/main defaults to ["dialog"].')
};
const AfterWaitFor = z
  .object({
    text: z.string().min(1).max(500).optional(),
    selector: z.string().min(1).max(500).optional(),
    urlIncludes: z.string().min(1).max(500).optional(),
    selectorAbsent: z.boolean().optional().describe('Wait until selector is absent from the document.'),
    textInScope: z.string().min(1).max(500).optional().describe('Wait for substring in scoped page text.'),
    scope: SnapshotScope.optional().describe('Scope for textInScope and contentStableMs waits.'),
    excludeSelectors: SnapshotScopeOptions.excludeSelectors,
    ignoreRoles: SnapshotScopeOptions.ignoreRoles,
    contentStableMs: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .optional()
      .describe('Wait until scoped text length is stable for this many milliseconds (capped at after.waitFor timeoutMs).'),
    timeoutMs: z.number().int().positive().max(20_000).optional()
  })
  .refine((value) => hasWaitCondition(value), {
    message: 'after.waitFor requires at least one wait condition'
  })
  .refine(
    (value) =>
      typeof value.contentStableMs !== 'number' ||
      typeof value.timeoutMs !== 'number' ||
      value.contentStableMs <= value.timeoutMs,
    { message: 'after.waitFor contentStableMs cannot exceed timeoutMs' }
  );
const AfterSnapshot = z.union([
  z.literal(true),
  z.object({
    mode: SnapshotMode.optional(),
    textLimit: z.number().int().positive().max(100_000).optional(),
    limit: z.number().int().positive().max(500).optional(),
    ...SnapshotScopeOptions
  })
]);
const AfterObservation = z
  .object({
    waitFor: AfterWaitFor.optional().describe('Wait for text, selector, or URL substring after the action.'),
    snapshot: AfterSnapshot.optional().describe('Collect a snapshot after the action. Use true for default snapshot options.'),
    pageStatus: z.boolean().optional().describe('Collect page_status after the action.')
  })
  .optional()
  .describe('Optional act-then-observe requests, run after the page action in waitFor, snapshot, pageStatus order.');

function hasWaitCondition(args: Record<string, unknown> = {}): boolean {
  if (args.selectorAbsent === true && typeof args.selector === 'string' && args.selector.trim().length > 0) return true;
  if (typeof args.textInScope === 'string' && args.textInScope.trim().length > 0) return true;
  if (typeof args.contentStableMs === 'number' && Number.isFinite(args.contentStableMs) && args.contentStableMs > 0) return true;
  return ['text', 'selector', 'urlIncludes'].some((key) => typeof args[key] === 'string' && String(args[key]).trim().length > 0);
}

function isValidAfterSnapshot(snapshot: unknown): boolean {
  return snapshot === undefined || snapshot === true || (!!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
}

function validateAfterObservation(args: Record<string, unknown> = {}): string | null {
  const after = args.after;
  if (!after || typeof after !== 'object' || Array.isArray(after)) return null;
  const waitFor = (after as Record<string, unknown>).waitFor;
  if (waitFor !== undefined && (!waitFor || typeof waitFor !== 'object' || Array.isArray(waitFor) || !hasWaitCondition(waitFor as Record<string, unknown>))) {
    return 'after.waitFor requires at least one wait condition';
  }
  if (!isValidAfterSnapshot((after as Record<string, unknown>).snapshot)) {
    return 'after.snapshot must be true or an object';
  }
  const pageStatus = (after as Record<string, unknown>).pageStatus;
  if (pageStatus !== undefined && typeof pageStatus !== 'boolean') return 'after.pageStatus must be a boolean';
  return null;
}

async function forwardActThenObserve(bridge: BridgeLike, action: BridgeAction, params: Record<string, unknown> = {}) {
  const error = validateAfterObservation(params);
  if (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error
        }
      ]
    };
  }
  return forward(bridge, action, params);
}

export interface BrowserStatusContext {
  adapterProtocolVersion?: number;
  registeredToolCount?: number;
  brokerOwnership?: BrokerOwnership;
  brokerPort?: number;
  tokenIssue?: 'missing' | 'invalid';
  ensureBroker?: () => Promise<EnsureBrokerResult>;
}

function adapterBlock(connected: boolean, context: BrowserStatusContext = {}) {
  return {
    connected,
    protocolVersion: context.adapterProtocolVersion ?? ADAPTER_PROTOCOL_VERSION,
    ...(connected && context.registeredToolCount !== undefined
      ? { registeredToolCount: context.registeredToolCount }
      : {})
  };
}

function brokerBlock(reachable: boolean, context: BrowserStatusContext = {}) {
  return {
    reachable,
    ...(context.brokerOwnership ? { ownership: context.brokerOwnership } : {})
  };
}

function statusPayload(
  base: Record<string, unknown>,
  context: BrowserStatusContext,
  coaching: {
    ready: boolean;
    brokerReachable: boolean;
    adapterConnected: boolean;
    extensionConnected: boolean;
    authFailed?: boolean;
    autoloadTimedOut?: boolean;
    portNotBroker?: boolean;
  }
) {
  const nextAction = buildNextAction({
    ready: coaching.ready,
    tokenMissing: context.tokenIssue === 'missing',
    tokenInvalid: context.tokenIssue === 'invalid',
    brokerReachable: coaching.brokerReachable,
    brokerOwnership: context.brokerOwnership,
    adapterConnected: coaching.adapterConnected,
    extensionConnected: coaching.extensionConnected,
    authFailed: coaching.authFailed,
    brokerPort: context.brokerPort,
    autoloadTimedOut: coaching.autoloadTimedOut,
    portNotBroker: coaching.portNotBroker
  });

  return {
    ...base,
    ...(nextAction ? { nextAction } : {})
  };
}
function isNoExtensionError(message: string): boolean {
  return /no chrome extension connected|chrome extension disconnected/i.test(message);
}

function isNoBrokerError(message: string): boolean {
  return /not connected to chrome broker|timed out waiting for broker|ECONNREFUSED|ENOTFOUND/i.test(message);
}

function isPortNotBrokerError(message: string | undefined): boolean {
  return typeof message === 'string' && /did not accept a Chrome Browser Control broker handshake/i.test(message);
}

async function browserStatus(bridge: BridgeLike, context: BrowserStatusContext = {}) {
  if (context.tokenIssue) {
    return toolResult(
      statusPayload(
        {
          ready: false,
          adapter: adapterBlock(false, context),
          broker: brokerBlock(false, context),
          extension: { connected: false }
        },
        context,
        {
          ready: false,
          brokerReachable: false,
          adapterConnected: false,
          extensionConnected: false
        }
      )
    );
  }

  let adapterConnected = bridge.connected === true;
  let ownership = context.brokerOwnership;
  let authFailed = false;
  let autoloadTimedOut = false;

  if (!adapterConnected && typeof bridge.connect === 'function') {
    try {
      if (context.ensureBroker) {
        const lifecycle = await context.ensureBroker();
        ownership = lifecycle.ownership ?? ownership;
        authFailed = lifecycle.authFailed === true;
        autoloadTimedOut = lifecycle.autoloadTimedOut === true;

        if (lifecycle.authFailed) {
          return toolResult(
            statusPayload(
              {
                ready: false,
                adapter: adapterBlock(false, { ...context, brokerOwnership: ownership }),
                broker: brokerBlock(true, { ...context, brokerOwnership: ownership }),
                extension: { connected: false },
                error: lifecycle.error
              },
              { ...context, brokerOwnership: ownership },
              {
                ready: false,
                brokerReachable: true,
                adapterConnected: false,
                extensionConnected: false,
                authFailed: true
              }
            )
          );
        }

        if (!lifecycle.authOk) {
          return toolResult(
            statusPayload(
              {
                ready: false,
                adapter: adapterBlock(false, { ...context, brokerOwnership: ownership }),
                broker: brokerBlock(lifecycle.reachable, { ...context, brokerOwnership: ownership }),
                extension: { connected: false },
                error: lifecycle.error
              },
              { ...context, brokerOwnership: ownership },
              {
                ready: false,
                brokerReachable: lifecycle.reachable,
                adapterConnected: false,
                extensionConnected: false,
                authFailed,
                autoloadTimedOut,
                portNotBroker: isPortNotBrokerError(lifecycle.error)
              }
            )
          );
        }
      }

      await bridge.connect();
      adapterConnected = bridge.connected === true;
    } catch (error) {
      const message = (error as Error).message || String(error);
      const brokerReachable = authFailed || !isNoBrokerError(message);
      return toolResult(
        statusPayload(
          {
            ready: false,
            adapter: adapterBlock(false, { ...context, brokerOwnership: ownership }),
            broker: brokerBlock(brokerReachable, { ...context, brokerOwnership: ownership }),
            extension: { connected: false },
            error: message
          },
          { ...context, brokerOwnership: ownership },
          {
            ready: false,
            brokerReachable,
            adapterConnected: false,
            extensionConnected: false,
            authFailed,
            autoloadTimedOut
          }
        )
      );
    }
  }

  const activeContext = { ...context, brokerOwnership: ownership };

  try {
    const ping = (await bridge.call('ping', {})) as Record<string, unknown>;
    const rawStatus = typeof ping.status === 'string' ? ping.status : undefined;
    const bridgeStatus =
      rawStatus === 'disconnected' || rawStatus === undefined ? 'connected' : rawStatus;
    const normalizedPing = { ...ping, status: bridgeStatus };
    const marker = {
      ...(ping.protocolVersion !== undefined ? { protocolVersion: ping.protocolVersion } : {}),
      ...(Array.isArray(ping.features) ? { features: ping.features } : {})
    };

    return toolResult(
      statusPayload(
        {
          ready: true,
          adapter: adapterBlock(true, activeContext),
          broker: brokerBlock(true, activeContext),
          extension: {
            connected: true,
            status: bridgeStatus,
            ...marker,
            ...(Array.isArray(ping.allowedOrigins) ? { allowedOrigins: ping.allowedOrigins } : {}),
            ...(ping.session !== undefined ? { session: ping.session } : {})
          },
          ping: normalizedPing
        },
        activeContext,
        {
          ready: true,
          brokerReachable: true,
          adapterConnected: true,
          extensionConnected: true
        }
      )
    );
  } catch (error) {
    const message = (error as Error).message || String(error);
    const brokerReachable = adapterConnected || !isNoBrokerError(message);
    const extensionConnected = false;
    return toolResult(
      statusPayload(
        {
          ready: false,
          adapter: adapterBlock(brokerReachable, activeContext),
          broker: brokerBlock(brokerReachable, activeContext),
          extension: { connected: extensionConnected },
          error: message,
          ...(isNoExtensionError(message) ? { detail: 'Broker is reachable, but no Chrome extension is connected.' } : {})
        },
        activeContext,
        {
          ready: false,
          brokerReachable,
          adapterConnected: brokerReachable,
          extensionConnected
        }
      )
    );
  }
}

export function registerBrowserTools(
  server: ToolRegistrar,
  bridge: BrowserBridge | BridgeLike,
  options: { ownerId?: string; getStatusContext?: () => BrowserStatusContext } = {}
): number {
  let registeredToolCount = 0;
  const registerTool = (name: string, config: Record<string, unknown>, cb: (args: any) => Promise<any>) => {
    registeredToolCount += 1;
    server.registerTool(name, config, cb);
  };

  registerTool(
    'browser_status',
    {
      title: 'Browser bridge status',
      description:
        'Check whether the MCP adapter can reach the local broker and whether the Chrome extension answers ping. Read nextAction for onboarding coaching.',
      inputSchema: {}
    },
    async () => browserStatus(bridge, options.getStatusContext?.() ?? {})
  );

  registerTool(
    'name_session',
    {
      title: 'Name browser session',
      description: 'Set a human-readable browser-control session name for status, logs, and debugging.',
      inputSchema: {
        name: z.string().min(1).max(120)
      }
    },
    async (args) => forward(bridge, 'name_session', args)
  );

  registerTool(
    'list_tabs',
    {
      title: 'List Chrome tabs',
      description: 'List tabs visible to the Chrome Browser Control extension in the current Chrome profile.',
      inputSchema: {}
    },
    async () => forward(bridge, 'list_tabs')
  );

  registerTool(
    'claim_tab',
    {
      title: 'Claim Chrome tab',
      description:
        'Claim an allowed Chrome tab for this browser-control session. Advisory claims are default. Use exclusive=true with ttlMs for fail-fast tab leases across parallel agents.',
      inputSchema: {
        tabId: z.number().int().positive(),
        exclusive: z.boolean().optional().describe('When true, acquire an exclusive lease on this tab until expiry or release.'),
        ttlMs: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe('Exclusive lease TTL in milliseconds. Defaults to 300000 (5 minutes).'),
        owner: z.string().min(1).max(120).optional().describe('Optional human-readable owner label for conflict diagnostics.')
      }
    },
    async (args) => {
      const params = { ...args } as Record<string, unknown>;
      if (args.exclusive === true) {
        if (!options.ownerId) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'exclusive claim_tab requires MCP adapter ownerId' }]
          };
        }
        params.ownerId = options.ownerId;
      }
      return forward(bridge, 'claim_tab', params);
    }
  );

  registerTool(
    'release_tab',
    {
      title: 'Release claimed tab',
      description: 'Release a previously claimed tab by sessionTabId or tabId without closing the browser tab.',
      inputSchema: {
        sessionTabId: z.string().min(1).optional(),
        tabId: OptionalTabId
      }
    },
    async (args) => forward(bridge, 'release_tab', args)
  );

  registerTool(
    'finalize_tabs',
    {
      title: 'Finalize claimed tabs',
      description:
        'Release browser-control ownership state for claimed tabs. This does not close user tabs; pass keep entries to preserve handoff/deliverable claims.',
      inputSchema: {
        keep: z
          .array(
            z.object({
              sessionTabId: z.string().min(1).optional(),
              tabId: z.number().int().positive().optional(),
              status: z.enum(['handoff', 'deliverable']).optional()
            })
          )
          .max(50)
          .optional()
      }
    },
    async (args) => forward(bridge, 'finalize_tabs', args)
  );

  registerTool(
    'snapshot',
    {
      title: 'Snapshot active page',
      description:
        'Return a simplified DOM snapshot for the active tab or a target tab. Compact mode (default) returns textPreview only — not text. Full mode returns text. Compact defaults to main-landmark scope when present; pass scope: "document" for legacy full-body text. Defaults truncate at 500 (compact) or 4000 (full) chars; pass textLimit (up to 100000) for long page content such as API docs. Response includes textLimitApplied, textTotalLength, and textBytesOmitted; a warning appears when default limits truncate body text.',
      inputSchema: {
        mode: SnapshotMode.optional().describe(
          'Snapshot detail mode. Defaults to compact. Use full for text and verbose metadata, or visible for viewport-only refs, bounds, and labels.'
        ),
        textLimit: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe('Max body text characters. Optional; defaults to 500 (compact) or 4000 (full). Not a hard cap — maximum 100000.'),
        ...SnapshotScopeOptions,
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'snapshot', args)
  );

  registerTool(
    'visible_snapshot',
    {
      title: 'Visible page snapshot',
      description: 'Return a viewport-aware snapshot with only visible/intersecting elements, refs, labels, roles, bounds, and scroll metadata.',
      inputSchema: {
        limit: z.number().int().positive().max(250).optional(),
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'visible_snapshot', args)
  );

  registerTool(
    'navigate',
    {
      title: 'Navigate Chrome tab',
      description:
        'Navigate the active tab or target tab to a URL. Default activates the tab; pass active: false for background audits without focus stealing.',
      inputSchema: {
        url: z.string().url(),
        active: z.boolean().optional().describe('Whether to activate the tab. Defaults to true for backward compatibility.'),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'navigate', args)
  );

  registerTool(
    'click',
    {
      title: 'Click page element',
      description: 'Click an element by snapshot ref in the active tab or target tab.',
      inputSchema: {
        ref: z.string().min(1),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'click', args)
  );

  registerTool(
    'type',
    {
      title: 'Type into page element',
      description: 'Type text into an element by snapshot ref. Password-like fields are blocked unless force=true.',
      inputSchema: {
        ref: z.string().min(1),
        text: z.string(),
        force: z.boolean().optional().default(false),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'type', args)
  );

  registerTool(
    'scroll',
    {
      title: 'Scroll page',
      description:
        'Scroll the active tab or target tab by pixel deltas. Does not change snapshot body text — snapshot uses the full document innerText, not the visible viewport. Use textLimit on snapshot to capture more text; scroll only helps when the page lazy-loads content.',
      inputSchema: {
        deltaX: z.number().optional().default(0),
        deltaY: z.number().optional().default(600),
        x: z.number().optional().describe('Optional viewport x coordinate to scroll a nested element under this point. Defaults to window scroll.'),
        y: z.number().optional().describe('Optional viewport y coordinate to scroll a nested element under this point. Defaults to window scroll.'),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'scroll', args)
  );

  registerTool(
    'query_elements',
    {
      title: 'Query page elements',
      description: 'Find elements by selector, role, text, and visibility without returning full page text.',
      inputSchema: {
        selector: z.string().min(1).max(500).optional(),
        role: z.string().min(1).max(80).optional(),
        text: z.string().min(1).max(500).optional(),
        visible: z.boolean().optional(),
        limit: BoundedLimit,
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'query_elements', args)
  );

  registerTool(
    'extract_elements',
    {
      title: 'Extract page elements',
      description: 'Extract bounded structured data from elements selected by CSS selector. Safer alternative to raw JavaScript evaluation.',
      inputSchema: {
        selector: z.string().min(1).max(500),
        limit: BoundedLimit,
        includeText: z.boolean().optional(),
        includeHtml: z.boolean().optional(),
        includeLinks: z.boolean().optional(),
        includeTimes: z.boolean().optional(),
        visible: z.boolean().optional(),
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'extract_elements', args)
  );

  registerTool(
    'extract_feed_posts',
    {
      title: 'Extract feed posts',
      description:
        'Extract structured feed/post records (author, text, times, live flags) from a scoped feed region without site-specific selectors.',
      inputSchema: {
        maxPosts: z.number().int().positive().max(50).optional().describe('Maximum posts to return. Defaults to 10.'),
        ...SnapshotScopeOptions,
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'extract_feed_posts', args)
  );

  registerTool(
    'screenshot',
    {
      title: 'Capture visible screenshot',
      description: 'Capture the visible viewport of an allowed tab. Returns a data URL and MIME type.',
      inputSchema: {
        format: z.enum(['png', 'jpeg']).optional(),
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'screenshot', args)
  );

  registerTool(
    'keypress',
    {
      title: 'Press page keys',
      description: 'Dispatch common DOM keyboard events in the target page. Browser/OS shortcuts are not guaranteed under MV3.',
      inputSchema: {
        keys: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'keypress', args)
  );

  registerTool(
    'click_at',
    {
      title: 'Click viewport coordinates',
      description: 'Click the element at viewport coordinates in an allowed target tab.',
      inputSchema: {
        x: z.number(),
        y: z.number(),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'click_at', args)
  );

  registerTool(
    'wait_for',
    {
      title: 'Wait for page condition',
      description:
        'Wait for text, selector, URL substring, selector absence, scoped text, or bounded content stability in the target page.',
      inputSchema: {
        text: z.string().min(1).max(500).optional(),
        selector: z.string().min(1).max(500).optional(),
        urlIncludes: z.string().min(1).max(500).optional(),
        selectorAbsent: z.boolean().optional().describe('Wait until selector is absent from the document.'),
        textInScope: z.string().min(1).max(500).optional().describe('Wait for substring in scoped page text.'),
        scope: SnapshotScope.optional().describe('Scope for textInScope and contentStableMs waits.'),
        excludeSelectors: SnapshotScopeOptions.excludeSelectors,
        ignoreRoles: SnapshotScopeOptions.ignoreRoles,
        contentStableMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .optional()
          .describe('Wait until scoped text length is stable for this many milliseconds.'),
        timeoutMs: z.number().int().positive().max(30_000).optional(),
        ...OptionalTarget
      }
    },
    async (args) => {
      if (!hasWaitCondition(args)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'wait_for requires at least one wait condition'
            }
          ]
        };
      }
      return forward(bridge, 'wait_for', args);
    }
  );

  registerTool(
    'page_status',
    {
      title: 'Page status',
      description: 'Return lightweight page status, viewport/scroll state, and resource summary counts for an allowed target tab.',
      inputSchema: {
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'page_status', args)
  );

  registerTool(
    'console_logs',
    {
      title: 'Console logs',
      description: 'Return bounded console logs captured after the content script was injected in the target tab.',
      inputSchema: {
        levels: z.array(z.string().min(1).max(20)).max(10).optional(),
        limit: z.number().int().positive().max(200).optional(),
        ...OptionalTarget
      }
    },
    async (args) => forward(bridge, 'console_logs', args)
  );

  registerTool(
    'collect_scroll',
    {
      title: 'Collect while scrolling',
      description: 'Scroll a bounded number of steps, extract selected elements each step, and optionally dedupe feed-like results.',
      inputSchema: {
        steps: z.number().int().positive().max(20),
        deltaY: z.number().optional(),
        delayMs: z.number().int().min(0).max(1_000).optional(),
        maxItems: z.number().int().positive().max(500).optional(),
        extract: z.object({
          selector: z.string().min(1).max(500),
          includeText: z.boolean().optional(),
          includeLinks: z.boolean().optional(),
          includeTimes: z.boolean().optional(),
          visible: z.boolean().optional(),
          limitPerStep: z.number().int().positive().max(100).optional()
        }),
        dedupeBy: z.enum(['text', 'href', 'statusHref', 'none']).optional(),
        after: AfterObservation,
        ...OptionalTarget
      }
    },
    async (args) => forwardActThenObserve(bridge, 'collect_scroll', args)
  );

  return registeredToolCount;
}
