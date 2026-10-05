/** One authenticated, non-replaying upstream MCP connection shared by campaign calls. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { VikunjaError, mapStatusToCode, redactSecrets, registerSecret } from './errors.js';
import {
  nativeArguments,
  nativeRoutes,
  NATIVE_ACTIONS,
  type NativeRoute,
} from './native-routes.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

function nativeError(error: any, config: Config, path = '/mcp'): VikunjaError {
  if (error instanceof VikunjaError) return error;
  const message = redactSecrets(String(error?.message ?? error), config.vikunjaToken);
  const httpCode = Number(error?.code);
  const status = httpCode >= 400 && httpCode <= 599 ? httpCode : /^(\d{3})\b/.exec(message)?.[1];
  const timeout =
    error?.code === -32001 || error?.name === 'AbortError' || error?.name === 'TimeoutError';
  const effectiveStatus = timeout
    ? 504
    : Number(status ?? (/invalid arguments/i.test(message) ? 400 : 502));
  return new VikunjaError({
    status: effectiveStatus,
    code: timeout
      ? 'REQUEST_TIMEOUT'
      : status || effectiveStatus === 400
        ? mapStatusToCode(effectiveStatus)
        : 'NATIVE_MCP_ERROR',
    method: 'TOOLS_CALL',
    path,
    message:
      effectiveStatus === 403
        ? `${message} Create a token in Vikunja Settings > MCP with mcp:access and the required action permissions.`
        : message,
    fieldErrors: [],
  });
}

export function nativeResultData(result: CallToolResult): any {
  if (result.isError) {
    const message =
      result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n') || 'Native MCP operation failed.';
    const status = Number(/^(\d{3})\b/.exec(message)?.[1] ?? 422);
    throw new VikunjaError({
      status,
      code: /^(\d{3})\b/.test(message) ? mapStatusToCode(status) : 'NATIVE_TOOL_ERROR',
      method: 'TOOLS_CALL',
      path: '/mcp',
      message,
      fieldErrors: [],
    });
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export class NativeMcpConnection {
  private client = new Client({ name: 'vikunja-fastmcp-adapter', version: '2.7.0' });
  private transport?: StreamableHTTPClientTransport;
  private ready?: Promise<void>;
  private routeMap?: Promise<NativeRoute[]>;
  private tools: Tool[] = [];
  private actions = new Set<string>();

  constructor(private readonly config: Config) {
    registerSecret(config.vikunjaToken);
  }

  private async reset(): Promise<void> {
    await this.client.close().catch(() => {});
    this.client = new Client({ name: 'vikunja-fastmcp-adapter', version: '2.7.0' });
    this.transport = undefined;
    this.ready = undefined;
    this.tools = [];
    this.actions.clear();
    this.routeMap = undefined;
  }

  private async connect(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`${this.config.vikunjaUrl}/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${this.config.vikunjaToken}` },
              redirect: 'error',
            },
            reconnectionOptions: {
              maxReconnectionDelay: 0,
              initialReconnectionDelay: 0,
              reconnectionDelayGrowFactor: 1,
              maxRetries: 0,
            },
            fetch: (url, init) =>
              fetch(url, {
                ...init,
                signal: AbortSignal.any([
                  ...(init?.signal ? [init.signal] : []),
                  AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000),
                ]),
                redirect: 'error',
              }),
          },
        );
        this.transport = transport;
        await this.client.connect(transport);
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await this.client.listTools(cursor ? { cursor } : {}, {
            timeout: this.config.requestTimeoutMs ?? 30_000,
          });
          this.tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw new Error('Native tools/list repeated its pagination cursor.');
          if (cursor) seen.add(cursor);
          if (seen.size > 20) throw new Error('Native tools/list exceeded its pagination limit.');
        } while (cursor);
        this.actions = new Set(this.tools.map((tool) => tool.name));
        if (this.actions.has('find_action')) {
          const catalog = nativeResultData(
            CallToolResultSchema.parse(
              await this.client.callTool({ name: 'find_action', arguments: {} }, undefined, {
                timeout: this.config.requestTimeoutMs ?? 30_000,
              }),
            ),
          );
          for (const action of catalog.actions ?? []) {
            if (typeof action?.name === 'string') this.actions.add(action.name);
          }
        }
      })().catch(async (error) => {
        // Initialization is read-only, so a later request may safely try it again.
        await this.reset();
        if (error instanceof StreamableHTTPError && (error.code === 404 || error.code === 405)) {
          throw new VikunjaError({
            status: 503,
            code: 'NATIVE_MCP_UNAVAILABLE',
            method: 'TOOLS_CALL',
            path: '/mcp',
            message:
              'Vikunja 2.7+ native MCP not found at /api/v2/mcp; set VIKUNJA_MCP_BACKEND=rest',
            fieldErrors: [],
          });
        }
        throw nativeError(error, this.config);
      });
    }
    return this.ready;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    return this.tools;
  }

  async listShellTools(): Promise<Tool[]> {
    return [
      {
        name: 'find_action',
        description:
          'Discover authorized native Vikunja actions. Use action or resource for schemas, then do_action to invoke them.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string' }, resource: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'do_action',
        description:
          'Invoke an authorized native Vikunja action returned by find_action. Raw native actions use server semantics without campaign receipts.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string' }, arguments: { type: 'object' } },
          required: ['action'],
          additionalProperties: false,
        },
      },
    ];
  }

  async callShellTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    if (name === 'find_action') {
      if (
        Object.keys(args).some((key) => !['action', 'resource'].includes(key)) ||
        (args.action !== undefined && typeof args.action !== 'string') ||
        (args.resource !== undefined && typeof args.resource !== 'string')
      ) {
        throw new VikunjaError({
          status: 400,
          code: 'VALIDATION_ERROR',
          method: 'TOOLS_CALL',
          path: name,
          message: 'find_action accepts optional action and resource strings.',
          fieldErrors: [],
        });
      }
      const remote = this.tools.some((tool) => tool.name === 'find_action')
        ? nativeResultData(await this.callTool('find_action', args))
        : { actions: [] };
      const extra = this.tools
        .filter((tool) => !['find_action', 'do_action'].includes(tool.name))
        .filter(
          (tool) =>
            (!args.action || tool.name === args.action) &&
            (!args.resource || tool.name.startsWith(`${args.resource}_`)),
        )
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          ...(args.action || args.resource ? { input_schema: tool.inputSchema } : {}),
        }));
      const actions = [
        ...new Map(
          [...(remote.actions ?? []), ...extra]
            .filter(
              (action) =>
                (!args.action || action.name === args.action) &&
                (!args.resource || action.name.startsWith(`${args.resource}_`)),
            )
            .map((action) => [action.name, action]),
        ).values(),
      ];
      const result = { actions };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
    if (name === 'do_action') {
      if (
        Object.keys(args).some((key) => !['action', 'arguments'].includes(key)) ||
        typeof args.action !== 'string' ||
        !args.action ||
        (args.arguments !== undefined &&
          (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)))
      ) {
        throw new VikunjaError({
          status: 400,
          code: 'VALIDATION_ERROR',
          method: 'TOOLS_CALL',
          path: name,
          message: 'do_action requires an action string and optional argument object.',
          fieldErrors: [],
        });
      }
      if (['find_action', 'do_action'].includes(args.action) || !this.actions.has(args.action)) {
        throw new VikunjaError({
          status: 403,
          code: 'NATIVE_ACTION_FORBIDDEN',
          method: 'TOOLS_CALL',
          path: name,
          message: 'The requested native action is not exposed to the configured token.',
          fieldErrors: [],
        });
      }
      return this.tools.some((tool) => tool.name === args.action)
        ? this.callTool(args.action, (args.arguments ?? {}) as Record<string, unknown>)
        : this.callTool('do_action', args);
    }
    if (!this.tools.some((tool) => tool.name === name)) {
      throw new VikunjaError({
        status: 400,
        code: 'VALIDATION_ERROR',
        method: 'TOOLS_CALL',
        path: name,
        message: `Tool not found: ${name}`,
        fieldErrors: [],
      });
    }
    return this.callTool(name, args);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    if (!this.tools.some((tool) => tool.name === name)) {
      throw new VikunjaError({
        status: 403,
        code: 'NATIVE_TOOL_UNAVAILABLE',
        method: 'TOOLS_CALL',
        path: name,
        message: 'This native tool is not exposed to the configured token.',
        fieldErrors: [],
      });
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return CallToolResultSchema.parse(
          await this.client.callTool({ name, arguments: args }, undefined, {
            timeout: this.config.requestTimeoutMs ?? 30_000,
          }),
        );
      } catch (error) {
        if (
          error instanceof StreamableHTTPError &&
          error.code === 404 &&
          (this.transport?.sessionId || attempt === 1)
        ) {
          if (attempt === 0) {
            await this.reset();
            await this.connect();
            continue;
          }
          throw new VikunjaError({
            status: 503,
            code: 'NATIVE_SESSION_EXPIRED',
            method: 'TOOLS_CALL',
            path: name,
            message: 'The native MCP session expired after one reconnect.',
            fieldErrors: [],
          });
        }
        throw nativeError(error, this.config, name);
      }
    }
    throw new Error('Native call retry exhausted.');
  }

  async request<T>(
    method: string,
    path: string,
    body: unknown,
    readOpenApi: () => Promise<any>,
    headers?: Record<string, string>,
  ): Promise<{ handled: boolean; data?: T }> {
    await this.connect();
    this.routeMap ??= readOpenApi()
      .then((spec) => nativeRoutes(spec, new Set([...NATIVE_ACTIONS, ...this.actions])))
      .catch((error) => {
        this.routeMap = undefined;
        throw error;
      });
    const routes = await this.routeMap;
    const pathname = new URL(path, 'https://vikunja.example').pathname;
    const route = routes.find(
      (item) => item.method === method.toUpperCase() && item.pattern.test(pathname),
    );
    if (!route) return { handled: false };
    if (headers && Object.keys(headers).some((name) => name.toLowerCase() !== 'content-type')) {
      throw new VikunjaError({
        status: 400,
        code: 'NATIVE_HEADER_UNSUPPORTED',
        method,
        path,
        message:
          'Native MCP does not forward arbitrary HTTP headers. This request cannot be represented safely.',
        fieldErrors: [],
      });
    }
    if (!this.actions.has(route.action)) {
      throw new VikunjaError({
        status: 403,
        code: 'NATIVE_ACTION_FORBIDDEN',
        method,
        path,
        message: `The configured token does not expose native action ${route.action}.`,
        fieldErrors: [],
      });
    }
    const args = nativeArguments(route, path, body);
    try {
      const result = this.tools.some((tool) => tool.name === route.action)
        ? await this.callTool(route.action, args)
        : await this.callTool('do_action', { action: route.action, arguments: args });
      const data = nativeResultData(result);
      if (method.toUpperCase() === 'PATCH' && data?.ok === true && data?.unchanged === true) {
        const readback = await this.request<T>('GET', path.split('?')[0], undefined, readOpenApi);
        if (!readback.handled) throw new Error('Native no-op update could not be read back.');
        return readback;
      }
      return { handled: true, data: data as T };
    } catch (error) {
      throw nativeError(error, this.config, path);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

const connections = new Map<string, NativeMcpConnection>();
export function getNativeMcp(config: Config): NativeMcpConnection {
  const key = createHash('sha256')
    .update(JSON.stringify([config.vikunjaUrl, config.vikunjaToken, config.requestTimeoutMs]))
    .digest('hex');
  let connection = connections.get(key);
  if (!connection) {
    if (connections.size >= 8) {
      const oldest = connections.keys().next().value!;
      void connections
        .get(oldest)!
        .close()
        .catch(() => {});
      connections.delete(oldest);
    }
    connection = new NativeMcpConnection(config);
    connections.set(key, connection);
  }
  return connection;
}

export async function closeNativeConnections(): Promise<void> {
  await Promise.allSettled([...connections.values()].map((connection) => connection.close()));
  connections.clear();
}
