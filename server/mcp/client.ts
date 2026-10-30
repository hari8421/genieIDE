import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Tool, ToolContext } from '../tools';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0).
 * Enough for the tool subset genie needs: initialize, tools/list, tools/call.
 */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly spawnImpl: typeof spawn;
  readonly name: string;

  constructor(
    private readonly config: McpServerConfig,
    options: { spawnImpl?: typeof spawn } = {},
  ) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.name = config.name;
  }

  get connected(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async connect(timeoutMs = 20_000): Promise<{ serverInfo: unknown; protocolVersion: string }> {
    if (this.connected) throw new McpError(`MCP server ${this.name} is already connected`);
    this.child = this.spawnImpl(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', () => undefined);
    this.child.on('exit', (code) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new McpError(`MCP server ${this.name} exited with code ${code ?? 'unknown'}`));
      }
      this.pending.clear();
    });
    this.child.on('error', (error) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new McpError(`MCP server ${this.name} failed: ${error.message}`));
      }
      this.pending.clear();
    });

    const result = (await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'genie-ide', version: '0.1.0' },
    }, timeoutMs)) as { protocolVersion?: string; serverInfo?: unknown };

    this.notify('notifications/initialized', {});
    return {
      serverInfo: result?.serverInfo ?? {},
      protocolVersion: result?.protocolVersion ?? '2024-11-05',
    };
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return; // notification or server request
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new McpError(message.error.message ?? 'MCP error'));
    else pending.resolve(message.result);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child) throw new McpError(`MCP server ${this.name} is not connected`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: boolean; content: string }> {
    const result = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((item) => (item.type === 'text' ? item.text ?? '' : `[${item.type}]`))
      .join('\n');
    return { ok: !result?.isError, content: text || '(no output)' };
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function loadMcpConfig(file: string): Promise<McpServerConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }

  let parsed: { servers?: unknown };
  try {
    parsed = JSON.parse(raw) as { servers?: unknown };
  } catch {
    return [];
  }

  const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
  const out: McpServerConfig[] = [];
  servers.forEach((entry, index) => {
    const value = entry as Partial<McpServerConfig> | null;
    if (!value || typeof value !== 'object') return;
    if (typeof value.command !== 'string' || !value.command.trim()) return;
    const env: Record<string, string> = {};
    if (value.env && typeof value.env === 'object') {
      for (const [key, val] of Object.entries(value.env)) {
        if (typeof val === 'string') env[key] = val;
      }
    }
    out.push({
      name: typeof value.name === 'string' && value.name ? value.name : `server-${index + 1}`,
      command: value.command.trim(),
      ...(Array.isArray(value.args) ? { args: value.args.filter((a): a is string => typeof a === 'string') } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    });
  });
  return out;
}

/** Wrap remote MCP tools so the agent loop can call them like local tools. */
export function mcpTools(client: McpClient, tools: McpTool[], prefix = ''): Tool[] {
  return tools.map((remote) => ({
    name: `${prefix}${remote.name}`,
    description: remote.description ?? `MCP tool from ${client.name}`,
    parameters: remote.inputSchema ?? { type: 'object', properties: {} },
    async run(args: Record<string, unknown>, _ctx: ToolContext) {
      try {
        const result = await client.callTool(remote.name, args);
        return { ok: result.ok, content: result.content };
      } catch (error) {
        return { ok: false, content: `MCP tool ${remote.name} failed: ${(error as Error).message}` };
      }
    },
  }));
}
