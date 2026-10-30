import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../server/agent/checkpoints';
import { RunJournal } from '../server/agent/journal';
import { runAgent, type AgentEvent } from '../server/agent/loop';
import { LLMError } from '../server/llm/client';
import { createDefaultTools, type Tool } from '../server/tools';
import { fakeClient, readFile, tempDir, textResult, writeFiles } from './helpers';

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo text back',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async run(args) {
    return { ok: true, content: `echo:${String(args.text ?? '')}` };
  },
};

function baseOptions(overrides: Record<string, unknown>) {
  return {
    workspaceRoot: '',
    goal: 'write a file',
    systemPrompt: 'You are a test agent.',
    tools: [],
    budgetTokens: 4000,
    reserveOutputTokens: 500,
    maxSteps: 6,
    maxToolRepairs: 2,
    autonomy: 'autopilot' as const,
    allowCommands: true,
    commandTimeoutMs: 5000,
    ...overrides,
  };
}

describe('runAgent', () => {
  it('executes a tool call, completes, and journals every step', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-1');
    const checkpoints = new CheckpointStore(workspaceRoot);
    const events: AgentEvent[] = [];

    const client = fakeClient(async (_request, onDelta, call) => {
      if (call === 1) {
        onDelta('writing the file');
        return textResult('', [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hello world' }) },
          },
        ]);
      }
      return textResult('DONE: created out.txt');
    });

    const result = await runAgent(
      baseOptions({
        client,
        journal,
        workspaceRoot,
        tools: createDefaultTools(),
        checkpoints,
        checkpointOnWrite: true,
        onEvent: (event: AgentEvent) => events.push(event),
      }) as never,
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(await readFile(workspaceRoot, 'out.txt')).toBe('hello world');

    const reopened = await RunJournal.open(runsDir, 'run-1');
    expect(reopened.completedSteps()).toEqual([0, 1]);
    expect(reopened.summary().status).toBe('completed');
    expect(reopened.entriesOfType('tool.result')).toHaveLength(1);

    // a checkpoint must exist from before the write
    const snapshot = await checkpoints.list();
    expect(snapshot).toHaveLength(1);
    expect(reopened.entriesOfType('checkpoint')).toHaveLength(1);

    expect(events.some((event) => event.type === 'assistant.delta')).toBe(true);
    expect(events.some((event) => event.type === 'context')).toBe(true);
  });

  it('resumes a crashed run without replaying completed steps or tools', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-2');
    await journal.append('run.start', { data: { goal: 'resume me' } });
    await journal.append('assistant', {
      step: 0,
      data: { content: 'checking', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }] },
    });
    await journal.append('tool.result', { step: 0, key: 'tool:0:c1', data: { callId: 'c1', name: 'echo', ok: true, content: 'echoed earlier' } });
    await journal.append('step.complete', { step: 0, key: 'step:0:done' });
    // process dies here: no run.end

    const executed: string[] = [];
    const guardedEcho: Tool = {
      ...echoTool,
      async run() {
        executed.push('ran');
        return { ok: true, content: 'should not run' };
      },
    };
    const client = fakeClient(async () => textResult('DONE: continued from the journal'));

    const result = await runAgent(
      baseOptions({ client, journal, workspaceRoot, tools: [guardedEcho, ...createDefaultTools()] }) as never,
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    expect(executed).toHaveLength(0);
    // the earlier tool result must be visible to the model on resume
    const prompt = client.calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('echoed earlier');
  });

  it('feeds a failed patch back to the model and recovers', async () => {
    const workspaceRoot = await tempDir();
    await writeFiles(workspaceRoot, { 'file.txt': 'alpha\n' });
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-3');

    const client = fakeClient(async (_request, _delta, call) => {
      if (call === 1) {
        return textResult('', [
          {
            id: 'p1',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ path: 'file.txt', patch: '<<<<<<< SEARCH\nbeta\n=======\ngamma\n>>>>>>> REPLACE' }),
            },
          },
        ]);
      }
      return textResult('DONE: fixed it');
    });

    const result = await runAgent(
      baseOptions({ client, journal, workspaceRoot, tools: createDefaultTools() }) as never,
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    const secondPrompt = client.calls[1]!.messages.map((message) => message.content).join('\n');
    expect(secondPrompt).toContain('Patch failed');
    expect(await readFile(workspaceRoot, 'file.txt')).toBe('alpha\n');
  });

  it('shrinks the context budget and retries when the prompt does not fit', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-4');
    const events: AgentEvent[] = [];

    const client = fakeClient(async (_request, _delta, call) => {
      if (call === 1) {
        throw new LLMError('400: context length exceeded for this model', { status: 400, retryable: false, kind: 'http' });
      }
      return textResult('DONE: smaller prompt worked');
    });

    const bigSection = {
      id: 'file:big.ts',
      kind: 'file' as const,
      title: 'big.ts',
      content: 'export const value = 1; // padding '.repeat(900),
      priority: 60,
    };

    const result = await runAgent(
      baseOptions({
        client,
        journal,
        workspaceRoot,
        tools: createDefaultTools(),
        contextSections: [bigSection],
        onEvent: (event: AgentEvent) => events.push(event),
      }) as never,
    );

    expect(result.status).toBe('completed');
    expect(client.calls).toHaveLength(2);
    const heal = events.find((event) => event.type === 'heal');
    expect(heal?.data).toMatchObject({ kind: 'context-overflow' });
    // the retry must actually send less text than the rejected attempt
    const first = client.calls[0]!.messages.map((message) => message.content).join('').length;
    const second = client.calls[1]!.messages.map((message) => message.content).join('').length;
    expect(second).toBeLessThan(first);
  });

  it('returns a resumable failure when the model server is unreachable', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-5');
    const client = fakeClient(async () => {
      throw new LLMError('Could not reach LM Studio', { retryable: true, kind: 'network' });
    });

    const result = await runAgent(baseOptions({ client, journal, workspaceRoot, tools: [] }) as never);

    expect(result.status).toBe('failed');
    expect(result.resumable).toBe(true);
    const reopened = await RunJournal.open(runsDir, 'run-5');
    expect(reopened.entriesOfType('error')).toHaveLength(1);
    expect(reopened.summary().status).toBe('failed');
  });

  it('honours cancellation and stays resumable', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-6');
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient(async () => textResult('DONE'));

    const result = await runAgent(
      baseOptions({ client, journal, workspaceRoot, tools: [], signal: controller.signal }) as never,
    );

    expect(result.status).toBe('cancelled');
    expect(result.resumable).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it('pauses at the step budget instead of running forever', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-7');
    const client = fakeClient(async () =>
      textResult('', [{ id: 'e1', type: 'function', function: { name: 'echo', arguments: '{"text":"tick"}' } }]),
    );

    const result = await runAgent(
      baseOptions({ client, journal, workspaceRoot, tools: [echoTool], maxSteps: 2 }) as never,
    );

    expect(result.status).toBe('paused');
    expect(result.steps).toBe(2);
    expect(result.resumable).toBe(true);
  });

  it('rejects unknown tools and invalid JSON arguments without crashing', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-8');
    const client = fakeClient(async (_request, _delta, call) => {
      if (call === 1) {
        return textResult('', [
          { id: 'u1', type: 'function', function: { name: 'not_a_tool', arguments: '{}' } },
          { id: 'u2', type: 'function', function: { name: 'echo', arguments: '{broken' } },
        ]);
      }
      return textResult('DONE: recovered');
    });

    const result = await runAgent(
      baseOptions({ client, journal, workspaceRoot, tools: [echoTool] }) as never,
    );
    expect(result.status).toBe('completed');
    const secondPrompt = client.calls[1]!.messages.map((message) => message.content).join('\n');
    expect(secondPrompt).toContain('Unknown tool');
    expect(secondPrompt).toContain('not valid JSON');
  });

  it('rescues a tool call emitted as fenced JSON text', async () => {
    const workspaceRoot = await tempDir();
    const runsDir = await tempDir();
    const journal = await RunJournal.create(runsDir, 'run-9');
    const client = fakeClient(async (_request, _delta, call) => {
      if (call === 1) {
        return textResult('```json\n{"name":"echo","arguments":{"text":"rescued"}}\n```');
      }
      return textResult('DONE: rescued call');
    });

    const result = await runAgent(baseOptions({ client, journal, workspaceRoot, tools: [echoTool] }) as never);
    expect(result.status).toBe('completed');
    const reopened = await RunJournal.open(runsDir, 'run-9');
    const toolResult = reopened.entriesOfType('tool.result')[0];
    expect(toolResult?.data).toMatchObject({ name: 'echo', content: 'echo:rescued' });
    expect(await fs.readdir(runsDir)).toEqual(['run-9']);
  });
});
