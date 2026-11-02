import fs from 'node:fs/promises';
import path from 'node:path';
import type { Fact, MemoryEvent, MemorySettings, MemorySnapshot } from './types';

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  maxCoreLines: 120,
  maxEvents: 500,
};

export interface RememberInput {
  key: string;
  value: string;
  runId?: string;
  tags?: string[];
}

/**
 * File-backed agent memory.
 *
 * Three files under `.genie/memory/`:
 *  - `facts.jsonl`  durable key/value facts, deduplicated by key
 *  - `core.md`      the pinned working set rendered from the facts; this is what
 *                   gets injected into the agent prompt, so it stays small
 *  - `events.jsonl` append-only run history, pruned to `maxEvents`
 *
 * Writes are deliberately simple (read, merge, rewrite) because the files are
 * tiny and correctness matters more than throughput here.
 */
export class AgentMemory {
  readonly root: string;
  readonly settings: MemorySettings;
  readonly corePath: string;
  readonly eventsPath: string;
  readonly factsPath: string;

  constructor(root: string, settings: Partial<MemorySettings> = {}) {
    this.root = root;
    this.settings = { ...DEFAULT_MEMORY_SETTINGS, ...settings };
    this.corePath = path.join(root, 'core.md');
    this.eventsPath = path.join(root, 'events.jsonl');
    this.factsPath = path.join(root, 'facts.jsonl');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async readCore(): Promise<string> {
    try {
      return (await fs.readFile(this.corePath, 'utf8')).trim();
    } catch {
      return '';
    }
  }

  async listFacts(): Promise<Fact[]> {
    const lines = await this.readLines(this.factsPath);
    const facts: Fact[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Partial<Fact>;
        if (!parsed.key || !parsed.value) continue;
        facts.push({
          key: parsed.key,
          value: parsed.value,
          runId: parsed.runId ?? '',
          ts: parsed.ts ?? 0,
          ...(parsed.tags?.length ? { tags: parsed.tags } : {}),
        });
      } catch {
        // A corrupt line should never take memory down; skip it.
      }
    }
    return facts;
  }

  /** Add or replace a fact, then re-render the pinned core from the fact list. */
  async addFact(input: RememberInput): Promise<Fact> {
    const key = input.key.trim();
    const value = input.value.trim().replace(/\s+/g, ' ');
    if (!key) throw new Error('A memory fact needs a key');
    if (!value) throw new Error('A memory fact needs a value');
    const fact: Fact = {
      key,
      value,
      runId: input.runId ?? '',
      ts: Date.now(),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    };
    const facts = (await this.listFacts()).filter((existing) => existing.key !== key);
    facts.push(fact);
    await this.writeFacts(facts);
    return fact;
  }

  async forgetFact(key: string): Promise<boolean> {
    const facts = await this.listFacts();
    const next = facts.filter((fact) => fact.key !== key);
    if (next.length === facts.length) return false;
    await this.writeFacts(next);
    return true;
  }

  async appendEvent(event: MemoryEvent): Promise<void> {
    await this.init();
    await fs.appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    if (Math.random() < 0.05) await this.prune();
  }

  /** Record the outcome of a run so later runs can see what was already tried. */
  async recordRun(input: {
    runId: string;
    goal: string;
    status: string;
    message: string;
    steps?: number;
  }): Promise<void> {
    const body = [
      `goal: ${truncate(input.goal, 400)}`,
      `status: ${input.status}`,
      ...(input.steps === undefined ? [] : [`steps: ${input.steps}`]),
      `outcome: ${truncate(input.message, 400)}`,
    ].join('\n');
    await this.appendEvent({ kind: 'run.end', runId: input.runId, ts: Date.now(), body });
  }

  async readEvents(limit = 50): Promise<MemoryEvent[]> {
    const lines = await this.readLines(this.eventsPath);
    const events: MemoryEvent[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        events.push(JSON.parse(line) as MemoryEvent);
      } catch {
        // skip corrupt line
      }
    }
    return events;
  }

  async eventCount(): Promise<number> {
    return (await this.readLines(this.eventsPath)).length;
  }

  /** Drop the oldest events, keeping the most recent `keep`. */
  async prune(keep = this.settings.maxEvents): Promise<number> {
    const lines = await this.readLines(this.eventsPath);
    if (lines.length <= keep) return 0;
    const kept = lines.slice(-Math.max(1, keep));
    await fs.writeFile(this.eventsPath, `${kept.join('\n')}\n`, 'utf8');
    return lines.length - kept.length;
  }

  async snapshot(): Promise<MemorySnapshot> {
    const [core, facts, events] = await Promise.all([this.readCore(), this.listFacts(), this.eventCount()]);
    return {
      core,
      facts,
      events,
      coreLines: core ? core.split('\n').length : 0,
      coreBytes: Buffer.byteLength(core, 'utf8'),
    };
  }

  private async writeFacts(facts: Fact[]): Promise<void> {
    await this.init();
    const body = facts.map((fact) => JSON.stringify(fact)).join('\n');
    await fs.writeFile(this.factsPath, body ? `${body}\n` : '', 'utf8');
    await this.renderCore(facts);
  }

  private async renderCore(facts: Fact[]): Promise<void> {
    const lines = ['# Working memory', '', 'Durable facts from earlier runs. Keep them accurate; correct one if it is wrong.'];
    if (facts.length) {
      lines.push('');
      for (const fact of facts) lines.push(`- ${fact.key}: ${fact.value}`);
    }
    const capped = lines.slice(0, Math.max(8, this.settings.maxCoreLines));
    if (capped.length < lines.length) {
      capped.push(`… ${lines.length - capped.length} more fact(s) not shown; use remember to replace stale ones.`);
    }
    await fs.writeFile(this.corePath, `${capped.join('\n')}\n`, 'utf8');
  }

  private async readLines(file: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return raw.split('\n').filter((line) => line.trim());
    } catch {
      return [];
    }
  }
}

function truncate(value: string, max: number): string {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
