import { z } from 'zod';

export const BridgeActionSchema = z.enum([
  'ping',
  'list_tabs',
  'snapshot',
  'navigate',
  'click',
  'type',
  'scroll'
]);

export type BridgeAction = z.infer<typeof BridgeActionSchema>;

export const ExtensionHelloSchema = z.object({
  kind: z.literal('hello'),
  token: z.string().min(1),
  extensionId: z.string().optional(),
  version: z.string().optional()
});

export const ClientHelloSchema = ExtensionHelloSchema.extend({
  role: z.enum(['extension', 'mcp_client'])
});

export const BridgeRequestSchema = z.object({
  kind: z.literal('request'),
  id: z.string().min(1),
  action: BridgeActionSchema,
  params: z.record(z.unknown()).optional().default({})
});

export const BridgeResponseSchema = z.object({
  kind: z.literal('response'),
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional()
}).refine((value) => value.ok || !!value.error, {
  message: 'error is required when ok=false'
});

export type ExtensionHello = z.infer<typeof ExtensionHelloSchema>;
export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export function parseExtensionHello(input: unknown): ExtensionHello {
  return ExtensionHelloSchema.parse(input);
}

export function parseClientHello(input: unknown): ClientHello {
  return ClientHelloSchema.parse(input);
}

export function parseBridgeRequest(input: unknown): BridgeRequest {
  return BridgeRequestSchema.parse(input);
}

export function parseBridgeResponse(input: unknown): BridgeResponse {
  return BridgeResponseSchema.parse(input);
}

export function parseJsonMessage(raw: string | Buffer): unknown {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON message: ${(error as Error).message}`);
  }
}

export function makeRequest(action: BridgeAction, params: Record<string, unknown> = {}): BridgeRequest {
  return {
    kind: 'request',
    id: crypto.randomUUID(),
    action,
    params
  };
}
