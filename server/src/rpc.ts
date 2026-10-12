import { z } from 'zod';
import type { ErrorCode, MethodName, MethodResult, RequestFrame, ResponseFrame } from '../../protocol/types.js';
import type { Device } from './config.js';
import { log } from './log.js';

export class RpcError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Per-connection context handed to every handler. */
export interface RpcContext {
  clientId: string;
  device: Device;
}

type AnyHandler = (params: any, ctx: RpcContext) => unknown;

interface Entry {
  schema: z.ZodType;
  handler: AnyHandler;
  /** Methods that need a logged-in Claude. */
  needsClaude: boolean;
}

const registry = new Map<string, Entry>();
let claudeReady: () => boolean = () => true;

export function setClaudeReadyCheck(fn: () => boolean): void {
  claudeReady = fn;
}

/**
 * Registers a method. The zod schema validates params; the handler's return type is checked
 * against the protocol contract.
 */
export function register<M extends MethodName, S extends z.ZodType>(
  method: M,
  schema: S,
  handler: (params: z.infer<S>, ctx: RpcContext) => MethodResult<M> | Promise<MethodResult<M>>,
): void {
  registry.set(method, { schema, handler, needsClaude: method.startsWith('claude.') });
}

export const NoParams = z.object({}).passthrough();

export async function dispatch(raw: unknown, ctx: RpcContext): Promise<ResponseFrame | null> {
  const frame = raw as Partial<RequestFrame>;
  if (typeof frame !== 'object' || frame === null || typeof frame.id !== 'number' || typeof frame.method !== 'string') {
    return null; // not a request; ignore
  }
  const { id, method } = frame;
  const entry = registry.get(method);
  if (!entry) return { id, error: { code: 'not_found', message: `Unknown method ${method}` } };
  if (entry.needsClaude && !claudeReady()) {
    return { id, error: { code: 'setup_required', message: 'Claude is not logged in on this server yet' } };
  }
  const parsed = entry.schema.safeParse(frame.params ?? {});
  if (!parsed.success) {
    return { id, error: { code: 'bad_request', message: 'Invalid params', data: parsed.error.issues } };
  }
  try {
    const result = await entry.handler(parsed.data, ctx);
    return { id, result: result as never };
  } catch (err) {
    if (err instanceof RpcError) {
      return { id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
    }
    log.error({ err, method }, 'rpc handler failed');
    return { id, error: { code: 'internal', message: err instanceof Error ? err.message.split('\n')[0]! : 'Internal error' } };
  }
}
