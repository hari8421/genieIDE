import type { AgentResult } from './api';

export interface LogEntry {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'stage';
  text: string;
  name?: string;
  args?: string;
  status?: 'running' | 'ok' | 'error';
  step?: number;
}

export interface SessionState {
  entries: LogEntry[];
  streaming: boolean;
  result: AgentResult | null;
  context: { tokens: number; budget: number; dropped: number; truncated: number } | null;
  runId: string | null;
  error: string | null;
}

export const emptySession = (): SessionState => ({
  entries: [],
  streaming: false,
  result: null,
  context: null,
  runId: null,
  error: null,
});

let nextId = 1;
const withEntry = (state: SessionState, entry: Omit<LogEntry, 'id'>): SessionState => ({
  ...state,
  entries: [...state.entries, { ...entry, id: nextId++ }],
});

const preview = (value: unknown, max = 1800): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
};

/** Fold one SSE event into the session transcript. */
export function applyEvent(state: SessionState, event: string, data: Record<string, unknown>): SessionState {
  switch (event) {
    case 'accepted':
      return { ...state, streaming: true, error: null, runId: null };
    case 'run.start':
      return { ...state, streaming: true, runId: typeof data.runId === 'string' ? data.runId : state.runId };
    case 'resume':
      return withEntry({ ...state, streaming: true }, { kind: 'notice', text: 'Resumed from the run journal.', status: 'ok' });
    case 'step.start':
      return withEntry(state, { kind: 'notice', step: Number(data.step ?? 0), text: `Step ${Number(data.step ?? 0) + 1}`, status: 'running' });
    case 'assistant.delta': {
      const text = String(data.text ?? '');
      const entries = [...state.entries];
      const last = entries[entries.length - 1];
      if (last && last.kind === 'assistant' && last.status === 'running') {
        entries[entries.length - 1] = { ...last, text: last.text + text };
      } else {
        entries.push({ id: nextId++, kind: 'assistant', text, status: 'running' });
      }
      return { ...state, entries };
    }
    case 'assistant.message': {
      const text = String(data.content ?? '');
      if (!text) return state;
      const entries = [...state.entries];
      const last = entries[entries.length - 1];
      if (last && last.kind === 'assistant') {
        entries[entries.length - 1] = { ...last, text, status: data.final ? 'ok' : 'running' };
        return { ...state, entries };
      }
      return withEntry(state, { kind: 'assistant', text, status: data.final ? 'ok' : 'running' });
    }
    case 'tool.call':
      return withEntry(state, {
        kind: 'tool',
        name: String(data.name ?? 'tool'),
        args: preview(data.args, 600),
        text: '',
        status: 'running',
        step: typeof data.step === 'number' ? data.step : undefined,
      });
    case 'tool.result':
    case 'tool.error': {
      const name = String(data.name ?? '');
      const content = String(data.content ?? data.message ?? '');
      if (!name && content && typeof data.type === 'string') {
        // tool-emitted progress events (e.g. file.written)
        return withEntry(state, { kind: 'notice', text: `${String(data.type)} ${String(data.path ?? '')}`.trim(), status: 'ok' });
      }
      const entries = [...state.entries];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]!;
        if (entry.kind === 'tool' && entry.name === name && entry.status === 'running') {
          entries[i] = { ...entry, text: content, status: event === 'tool.error' ? 'error' : 'ok' };
          return { ...state, entries };
        }
      }
      return withEntry(state, {
        kind: 'tool',
        name: name || 'tool',
        text: content,
        status: event === 'tool.error' ? 'error' : 'ok',
      });
    }
    case 'checkpoint':
      return withEntry(state, { kind: 'notice', text: `Checkpoint saved: ${String(data.label ?? data.id ?? '')}`, status: 'ok' });
    case 'heal':
      return withEntry(state, {
        kind: 'notice',
        text: `Self-heal: ${String(data.detail ?? data.kind ?? 'retrying')}`,
        status: 'running',
      });
    case 'retry':
      return withEntry(state, { kind: 'notice', text: `Retrying after a transport error`, status: 'running' });
    case 'context':
      return {
        ...state,
        context: {
          tokens: Number(data.totalTokens ?? 0),
          budget: Number(data.budgetTokens ?? 0),
          dropped: Array.isArray(data.dropped) ? data.dropped.length : 0,
          truncated: Array.isArray(data.truncated) ? data.truncated.length : 0,
        },
      };
    case 'result': {
      const result = data as unknown as AgentResult;
      return {
        ...state,
        streaming: false,
        result,
        runId: result.runId ?? state.runId,
        entries: [
          ...state.entries,
          {
            id: nextId++,
            kind: 'notice',
            text:
              result.status === 'completed'
                ? `Completed in ${result.steps} step(s), ${result.toolCalls} tool call(s).`
                : `${result.status.toUpperCase()}: ${result.message}`,
            status: result.status === 'completed' ? 'ok' : result.status === 'failed' ? 'error' : 'running',
          },
        ],
      };
    }
    case 'error':
      return {
        ...state,
        streaming: false,
        error: String(data.message ?? 'Unknown error'),
        entries: [...state.entries, { id: nextId++, kind: 'notice', text: String(data.message ?? 'Unknown error'), status: 'error' }],
      };
    case 'done':
      return { ...state, streaming: false };
    default:
      return state;
  }
}
