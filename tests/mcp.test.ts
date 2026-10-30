import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpConfig, McpClient, mcpTools } from '../server/mcp/client';
import { tempDir, writeFiles } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

const clients: McpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

describe('McpClient', () => {
  it('initializes, lists tools and calls one', async () => {
    const client = new McpClient({ name: 'fake', command: process.execPath, args: [fixture] });
    clients.push(client);

    const info = await client.connect();
    expect(info.serverInfo).toMatchObject({ name: 'fake' });
    expect(client.connected).toBe(true);

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);

    const result = await client.callTool('echo', { text: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('echo:hello');
  });

  it('adapts MCP tools to the agent tool interface', async () => {
    const client = new McpClient({ name: 'fake', command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    const [tool] = mcpTools(client, await client.listTools(), 'mcp__fake__');
    expect(tool!.name).toBe('mcp__fake__echo');
    const result = await tool!.run({ text: 'adapted' }, {} as never);
    expect(result).toEqual({ ok: true, content: 'echo:adapted' });
  });

  it('rejects a request to an unconnected client', async () => {
    const client = new McpClient({ name: 'offline', command: process.execPath, args: [fixture] });
    await expect(client.listTools()).rejects.toThrow(/not connected/);
  });

  it('surfaces a server that cannot start', async () => {
    const client = new McpClient({ name: 'broken', command: path.join(here, 'does-not-exist-binary') });
    await expect(client.connect(3000)).rejects.toThrow();
  });
});

describe('loadMcpConfig', () => {
  it('reads valid servers and ignores invalid entries', async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      'mcp.json': JSON.stringify({
        servers: [
          { name: 'good', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
          { command: 'python' },
          { name: 'bad' },
        ],
      }),
    });
    const config = await loadMcpConfig(path.join(dir, 'mcp.json'));
    expect(config).toEqual([
      { name: 'good', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      { name: 'server-2', command: 'python' },
    ]);
  });

  it('returns an empty list for missing or malformed config', async () => {
    const dir = await tempDir();
    await writeFiles(dir, { 'mcp.json': '{not json' });
    expect(await loadMcpConfig(path.join(dir, 'mcp.json'))).toEqual([]);
    expect(await loadMcpConfig(path.join(dir, 'missing.json'))).toEqual([]);
  });
});
