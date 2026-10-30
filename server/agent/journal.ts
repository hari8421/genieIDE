import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../util/paths';

export type JournalEventType =
  | 'run.start'
  | 'run.end'
  | 'resume'
  | 'context'
  | 'assistant'
  | 'tool.call'
  | 'tool.result'
  | 'step.complete'
  | 'checkpoint'
  | 'error'
  | 'task.update';

export interface JournalEntry {
  seq: number;
  at: string;
  type: JournalEventType;
  step?: number;
  key?: string;
  data?: unknown;
}

export interface RunSummary {
  id: string;
  file: string;
  createdAt: string;
  updatedAt: string;
  goal: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'unknown';
  steps: number;
  events: number;
  error?: string;
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Append-only JSONL journal. Every event is fsync'd before the loop continues,
 * so a crash mid-run leaves a replayable record instead of a corrupt state file.
 * Unparsable trailing lines (a write torn by process death) are ignored on load.
 */
export class RunJournal {
  private constructor(
    readonly id: string,
    readonly file: string,
    private entries: JournalEntry[],
  ) {}

  static async create(runsDir: string, runId = newRunId()): Promise<RunJournal> {
    const dir = path.join(runsDir, runId);
    await ensureDir(dir);
    const file = path.join(dir, 'journal.jsonl');
    await fs.writeFile(file, '', { flag: 'a' });
    return new RunJournal(runId, file, []);
  }

  static async open(runsDir: string, runId: string): Promise<RunJournal> {
    const file = path.join(runsDir, runId, 'journal.jsonl');
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      throw new Error(`Run ${runId} was not found in ${runsDir}`);
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as JournalEntry;
        if (typeof parsed?.seq === 'number' && typeof parsed?.type === 'string') entries.push(parsed);
      } catch {
        // torn write from a killed process: drop the partial line
      }
    }
    return new RunJournal(runId, file, entries);
  }

  get all(): readonly JournalEntry[] {
    return this.entries;
  }

  get lastSeq(): number {
    return this.entries.length ? this.entries[this.entries.length - 1]!.seq : 0;
  }

  async append(
    type: JournalEventType,
    payload: { step?: number; key?: string; data?: unknown } = {},
  ): Promise<JournalEntry> {
    const entry: JournalEntry = {
      seq: this.lastSeq + 1,
      at: new Date().toISOString(),
      type,
      ...(payload.step !== undefined ? { step: payload.step } : {}),
      ...(payload.key !== undefined ? { key: payload.key } : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    };
    this.entries.push(entry);
    const handle = await fs.open(this.file, 'a');
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return entry;
  }

  /** Idempotency key check used by resume. */
  hasKey(key: string): boolean {
    return this.entries.some((entry) => entry.key === key);
  }

  entryByKey(key: string): JournalEntry | undefined {
    return this.entries.find((entry) => entry.key === key);
  }

  completedSteps(): number[] {
    const set = new Set<number>();
    for (const entry of this.entries) {
      if (entry.type === 'step.complete' && typeof entry.step === 'number') set.add(entry.step);
    }
    return [...set].sort((a, b) => a - b);
  }

  entriesOfType(type: JournalEventType): JournalEntry[] {
    return this.entries.filter((entry) => entry.type === type);
  }

  summary(): RunSummary {
    const start = this.entries.find((e) => e.type === 'run.start');
    const end = [...this.entries].reverse().find((e) => e.type === 'run.end');
    const error = [...this.entries].reverse().find((e) => e.type === 'error');
    const status =
      (end?.data as { status?: RunSummary['status'] } | undefined)?.status ??
      (error ? 'failed' : this.entries.length ? 'running' : 'unknown');
    const goal = (start?.data as { goal?: string } | undefined)?.goal ?? '';
    return {
      id: this.id,
      file: this.file,
      createdAt: start?.at ?? this.entries[0]?.at ?? '',
      updatedAt: this.entries[this.entries.length - 1]?.at ?? '',
      goal,
      status: status as RunSummary['status'],
      steps: this.completedSteps().length,
      events: this.entries.length,
      ...(error ? { error: String((error.data as { message?: string } | undefined)?.message ?? '') } : {}),
    };
  }

  /** Rebuild the chat history needed to continue a run after a restart. */
  replayMessages(): Array<{ role: 'assistant'; content: string; toolCalls?: unknown } | { role: 'tool'; content: string }> {
    const messages: Array<{ role: 'assistant'; content: string; toolCalls?: unknown } | { role: 'tool'; content: string }> = [];
    for (const entry of this.entries) {
      if (entry.type === 'assistant') {
        const data = entry.data as { content?: string; toolCalls?: unknown } | undefined;
        if (data) messages.push({ role: 'assistant', content: data.content ?? '', toolCalls: data.toolCalls });
      } else if (entry.type === 'tool.result') {
        const data = entry.data as { content?: string } | undefined;
        messages.push({ role: 'tool', content: data?.content ?? '' });
      }
    }
    return messages;
  }
}

export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let ids: string[] = [];
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const id of ids) {
    try {
      summaries.push((await RunJournal.open(runsDir, id)).summary());
    } catch {
      // ignore half-created run dirs
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
