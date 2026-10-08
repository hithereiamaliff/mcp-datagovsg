/**
 * Helpers shared by every tool file:
 * - consistent tool naming (datagovsg_ / singstat_ prefixes)
 * - registerReadOnlyTool(): registerTool + read-only annotations + uniform
 *   success/error envelopes, so tool handlers only return plain objects
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape, ZodTypeAny } from 'zod';
import type { ApiAuth } from './http-client.js';
import { UpstreamError, RateLimitError } from './http-client.js';

/** Per-request context handed to every tool registration function. */
export interface ToolContext {
  auth: ApiAuth;
}

export function datagovsgTool(name: string): string {
  return name.startsWith('datagovsg_') ? name : `datagovsg_${name}`;
}

export function singstatTool(name: string): string {
  return name.startsWith('singstat_') ? name : `singstat_${name}`;
}

/** Success envelope. Compact JSON keeps token usage down for large results. */
export function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

/** Error envelope with isError so clients and models can tell it apart. */
export function fail(error: unknown, context: string, hint?: string): CallToolResult {
  const body: Record<string, unknown> = {
    error: context,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof UpstreamError) {
    if (error.status) body.status = error.status;
    if (error.code !== undefined) body.code = error.code;
    if (error.hint) body.hint = error.hint;
  }
  if (error instanceof RateLimitError) {
    body.retry_after_seconds = error.retryAfterSeconds;
    body.hint =
      'data.gov.sg rate limit reached. Wait a few seconds and retry, or connect with your own data.gov.sg API key via the MCP Key Service for a separate quota.';
  }
  if (hint && !body.hint) body.hint = hint;
  body.timestamp = new Date().toISOString();
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

interface ReadOnlyToolConfig<S extends ZodRawShape> {
  title: string;
  description: string;
  inputSchema: S;
  /** Short label used in error messages, e.g. "Failed to query dataset" */
  errorContext: string;
  /** Optional hint appended to errors, or a function deriving one from the error */
  errorHint?: string | ((error: unknown) => string | undefined);
}

/**
 * Register a read-only tool. The handler returns a plain object which is
 * wrapped with ok(); thrown errors are wrapped with fail().
 */
export function registerReadOnlyTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: ReadOnlyToolConfig<S>,
  handler: (args: z.objectOutputType<S, ZodTypeAny>) => Promise<Record<string, unknown>>
): void {
  const callback = async (args: z.objectOutputType<S, ZodTypeAny>): Promise<CallToolResult> => {
    try {
      return ok(await handler(args));
    } catch (error) {
      const hint =
        typeof config.errorHint === 'function' ? config.errorHint(error) : config.errorHint;
      return fail(error, config.errorContext, hint);
    }
  };

  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        title: config.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    // The SDK's callback type is generic over its own zod-compat layer; the
    // runtime contract (parsed args in, CallToolResult out) is identical.
    callback as unknown as Parameters<McpServer['registerTool']>[2]
  );
}
