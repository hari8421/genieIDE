import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, writeFiles } from './helpers';

/**
 * End-to-end coverage for the two features that only exist at the wire level:
 * the external provider switch and agent memory. A stub OpenAI-compatible server
 * records exactly what anneal sends, so "the fact reaches the prompt" is asserted
 * against a real request body instead of an in-process mock.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Recorded = {
  auth: string | null;
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
  tools: string[];
};

let stub: http.Server;
let child: ChildProcess | undefined;
let baseUrl = '';
let workspace = '';
let mode: 'text' | 'tool' = 'text';
const recorded: Recorded[] = [];

const API_KEY = 'sk-e2e-test-key';

function send(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startStub(): Promise<number> {
  stub = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model', context_length: 8192 }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        model?: string;
        stream?: boolean;
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = body.messages ?? [];
      recorded.push({
        auth: req.headers.authorization ?? null,
        model: body.model ?? '',
        stream: body.stream === true,
        messages: messages as Recorded['messages'],
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ''),
      });

      const hasToolResult = messages.some((message) => message.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (mode === 'tool' && !hasToolResult) {
        send(res, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'remember', arguments: '' } },
                ],
              },
            },
          ],
        });
        send(res, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: JSON.stringify({ key: 'test command', value: 'npm run verify' }) } },
                ],
              },
            },
          ],
        });
        send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send(res, { choices: [{ index: 0, delta: { content: 'Stub answer.' } }] });
        send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as AddressInfo).port));
  });
}

async function waitForServer(url: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready in time');
}

async function runGoal(goal: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, files: ['src/app.ts'] }),
  });
  return response.text();
}

const lastRequest = (): Recorded => {
  const entry = recorded[recorded.length - 1];
  if (!entry) throw new Error('the stub model server received no request');
  return entry;
};

const promptText = (entry: Recorded): string => entry.messages.map((message) => message.content).join('\n');

beforeAll(async () => {
  const stubPort = await startStub();
  workspace = await tempDir('anneal-provider-');
  await writeFiles(workspace, { 'src/app.ts': 'export const app = 1;\n' });

  const port = 18_600 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ANNEAL_WORKSPACE: workspace,
      ANNEAL_PORT: String(port),
      ANNEAL_HOST: '127.0.0.1',
      ANNEAL_MODEL: 'stub-model',
      ANNEAL_PROVIDER: 'external',
      ANNEAL_EXTERNAL_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      ANNEAL_EXTERNAL_MODEL: 'stub-model',
      ANNEAL_EXTERNAL_API_KEY: API_KEY,
      ANNEAL_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForServer(baseUrl);
}, 60_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (!stub) return resolve();
    stub.close(() => resolve());
  });
});

describe('external provider + agent memory over real HTTP', () => {
  it('routes completions to the external endpoint with the configured key and model', async () => {
    const stream = await runGoal('Describe this project.');
    expect(stream).toContain('result');

    const request = lastRequest();
    expect(request.model).toBe('stub-model');
    expect(request.auth).toBe(`Bearer ${API_KEY}`);
    expect(request.stream).toBe(true);
    expect(request.tools).toContain('remember');

    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
      config: { provider: string; model: string };
    };
    expect(health.config.provider).toBe('external');
    expect(health.config.model).toBe('stub-model');
    expect(JSON.stringify(health)).not.toContain(API_KEY);
  });

  it('injects a stored fact into the real prompt as pinned memory', async () => {
    const created = await fetch(`${baseUrl}/api/memory/facts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'build cmd', value: 'npm run verify:all' }),
    });
    expect(created.status).toBe(200);

    await runGoal('Summarise the conventions.');
    expect(promptText(lastRequest())).toContain('npm run verify:all');
    expect(promptText(lastRequest())).toContain('export const app = 1');
  });

  it('persists a fact the model writes with remember and pins it in the next run', async () => {
    mode = 'tool';
    const stream = await runGoal('Learn something durable about this repo.');
    expect(stream).toContain('result');

    const snapshot = (await (await fetch(`${baseUrl}/api/memory`)).json()) as {
      facts: Array<{ key: string; value: string }>;
      core: string;
      events: number;
    };
    expect(snapshot.facts).toContainEqual(expect.objectContaining({ key: 'test command', value: 'npm run verify' }));
    expect(snapshot.core).toContain('test command');
    expect(snapshot.events).toBeGreaterThanOrEqual(2);

    mode = 'text';
    await runGoal('Say hello.');
    expect(promptText(lastRequest())).toContain('test command');
  });

  it('forgets a fact and stops pinning it', async () => {
    const removed = await fetch(`${baseUrl}/api/memory/facts/test%20command`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);

    await runGoal('Say hello again.');
    expect(promptText(lastRequest())).not.toContain('test command: npm run verify');

    const missing = await fetch(`${baseUrl}/api/memory/facts/test%20command`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});
