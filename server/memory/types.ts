/** A durable fact the agent has learned and wants to keep across runs. */
export interface Fact {
  readonly key: string;
  readonly value: string;
  /** Run that introduced the fact; empty for user-authored facts. */
  readonly runId: string;
  readonly ts: number;
  readonly tags?: string[];
}

export type MemoryEventKind = 'run.start' | 'run.end' | 'fact' | 'note';

/** Append-only history entry. Cheap to write, never rewritten. */
export interface MemoryEvent {
  readonly kind: MemoryEventKind;
  readonly runId: string;
  readonly ts: number;
  readonly body: string;
}

export interface MemorySettings {
  /** Hard cap on core.md lines so pinned memory cannot flood the prompt. */
  readonly maxCoreLines: number;
  /** Events kept before the oldest are dropped. */
  readonly maxEvents: number;
}

/** What the UI and the prompt builder need to know about memory. */
export interface MemorySnapshot {
  readonly core: string;
  readonly facts: readonly Fact[];
  readonly events: number;
  readonly coreLines: number;
  readonly coreBytes: number;
}
