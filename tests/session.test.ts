import { describe, expect, it } from 'vitest';
import { applyEvent, emptySession, type SessionState } from '../src/lib/session';

/**
 * The transcript reducer is the only place that knows the wire format of an SSE
 * event. The server wraps agent events as `{ type, step, data }`, while `result`
 * and `error` carry their fields at the top level; reading the wrong level used
 * to render empty tool names and no assistant text at all.
 */
const fold = (events: Array<[string, Record<string, unknown>]>): SessionState =>
  events.reduce((state, [event, data]) => applyEvent(state, event, data), emptySession());

describe('session reducer', () => {
  it('pairs a wrapped tool call with its result by name', () => {
    const state = fold([
      ['tool.call', { type: 'tool.call', step: 0, data: { name: 'search', args: { query: 'budget' } } }],
      ['tool.result', { type: 'tool.result', step: 0, data: { name: 'search', content: 'server/config.ts:51' } }],
    ]);

    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0]!;
    expect(entry.kind).toBe('tool');
    expect(entry.name).toBe('search');
    expect(entry.status).toBe('ok');
    expect(entry.args).toContain('budget');
    expect(entry.text).toContain('server/config.ts:51');
  });

  it('streams assistant deltas into one entry and settles it on the final message', () => {
    const state = fold([
      ['assistant.delta', { type: 'assistant.delta', step: 0, data: { text: 'Context is ' } }],
      ['assistant.delta', { type: 'assistant.delta', step: 0, data: { text: 'budgeted.' } }],
      ['assistant.message', { type: 'assistant.message', step: 0, data: { content: 'Context is budgeted.', final: true } }],
    ]);

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.kind).toBe('assistant');
    expect(state.entries[0]!.text).toBe('Context is budgeted.');
    expect(state.entries[0]!.status).toBe('ok');
  });

  it('reads the context meter from the wrapped payload', () => {
    const state = fold([
      [
        'context',
        {
          type: 'context',
          step: 0,
          data: { totalTokens: 512, budgetTokens: 8192, dropped: [], truncated: [{ id: 'spec' }] },
        },
      ],
    ]);

    expect(state.context).toEqual({ tokens: 512, budget: 8192, dropped: 0, truncated: 1 });
  });

  it('keeps reading result and error events, which are not wrapped', () => {
    const state = fold([
      [
        'result',
        {
          status: 'completed',
          runId: 'run-1',
          steps: 3,
          message: 'done',
          resumable: false,
          toolCalls: 2,
          usage: { promptTokens: 10, completionTokens: 5 },
        },
      ],
      ['error', { message: 'boom' }],
    ]);

    expect(state.streaming).toBe(false);
    expect(state.runId).toBe('run-1');
    expect(state.result?.status).toBe('completed');
    expect(state.error).toBe('boom');
    expect(state.entries.some((entry) => entry.text === 'boom')).toBe(true);
  });

  it('turns tool-emitted progress events into notices instead of fake tools', () => {
    const state = fold([['tool.result', { type: 'tool.result', step: 1, data: { type: 'file.written', path: 'src/a.ts' } }]]);

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.kind).toBe('notice');
    expect(state.entries[0]!.text).toBe('file.written src/a.ts');
  });
});
