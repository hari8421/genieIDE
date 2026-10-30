import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, ChatResult, LMStudioClient } from '../server/llm/client';

export async function tempDir(prefix = 'genie-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
}

export async function readFile(root: string, relative: string): Promise<string> {
  return fs.readFile(path.join(root, relative), 'utf8');
}

/** Minimal stand-in for LMStudioClient that records prompts. */
export function fakeClient(
  handler: (request: ChatRequest, onDelta: (text: string) => void, call: number) => Promise<ChatResult>,
): LMStudioClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const client = {
    calls,
    baseUrl: 'http://fake/v1',
    model: 'fake-model',
    circuitState: 'closed',
    async chat(request: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult> {
      calls.push(request);
      const call = calls.length;
      const delta = onDelta ?? (() => undefined);
      return handler(request, delta, call);
    },
    async listModels() {
      return [{ id: 'fake-model' }];
    },
    async health() {
      return { ok: true, baseUrl: 'http://fake/v1', models: [{ id: 'fake-model' }] };
    },
  };
  return client as unknown as LMStudioClient & { calls: ChatRequest[] };
}

export function textResult(content: string, toolCalls: ChatResult['toolCalls'] = []): ChatResult {
  return { content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
}
