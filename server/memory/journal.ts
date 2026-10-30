import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChanceManager, Fact, MemoryEvent, MemoryIndex, MemoryVersion, QueryOptions, QueryResult } from './types';
import { Geneproperties } from './settings';
import { MemoryIndex as Index } from './index';
import { rawFromEvent, maybeExtractFacts } from './extract';
import { mergeFactsIntoCore, pruneStaleCore } from './core';

export class MemoryJournal {
  private readonly root: string;
  private readonly chance: ChanceManager;
  private readonly index: MemoryIndex;
  private readonly settings: Geneproperties;
  private readonly corePath: string;
  private readonly eventsPath: string;

  constructor(root: string, opts?: { maxCoreLines?: number; contextBudgetTokens?: number }) {
    this.root = root;
    this.settings = new Geneproperties(opts ?? {});
    this.chance = new DummyChanceManager(this.settings);
    this.index = new Index(this.root);
    this.corePath = path.join(this.root, 'core.md');
    this.eventsPath = path.join(this.root, 'events.jsonl');
  }

  async append(event: MemoryEvent): Promise<MemoryVersion> {
    await fs.appendFile(this.eventsPath, rawFromEvent(event) + '\n');
    const facts = maybeExtractFacts(event);
    if (facts.length) {
      await this.applyFacts(facts);
      await this.index.addAll(facts);
    }
    this.index.sweep();
    return this.version();
  }

  async version(): Promise<MemoryVersion> {
    const core = await this.readCore();
    return { core, events: await this.eventCount(), facts: await this.index.factCount() };
  }

  async readCore(): Promise<string> {
    try {
      return await fs.readFile(this.corePath, 'utf8');
    } catch {
      return '';
    }
  }

  async eventCount(): Promise<number> {
    try {
      const raw = await fs.readFile(this.eventsPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }

  async applyFacts(facts: Fact[]): Promise<void> {
    const core = await this.readCore();
    const merged = mergeFactsIntoCore(core, facts, this.settings);
    if (merged !== null) {
      await fs.writeFile(this.corePath, merged, 'utf8');
    }
    this.chance.onFactsChanged();
  }

  async query(opts: QueryOptions = {}): Promise<QueryResult> {
    const core = await this.readCore();
    const facts = await this.index.query(opts.sessionTag ?? opts.sessionId ?? '');
    return { core, facts, coreBytes: Buffer.byteLength(core, 'utf8') };
  }

  async pruneBeforeCutoff(ts: number): Promise<void> {
    await this.index.pruneEventsBefore(ts);
    await pruneStaleCore(this.corePath, ts, this.settings);
  }
}

class DummyChanceManager implements ChanceManager {
  constructor(_settings: Geneproperties) {}
  onFactsChanged(): void {
    // persistence happens in applyFacts
  }
  currentTag(): string {
    return '';
  }
}
