export interface Fact {
  readonly key: string;
  readonly value: string;
  readonly sourceSessionId: string;
  readonly ts: number;
  readonly confidence?: number;
  readonly tags?: string[];
}

export interface MemoryEvent {
  readonly kind: 'message' | 'task' | 'tool' | 'fact' | 'meta';
  readonly sessionId: string;
  readonly timestamp: number;
  readonly body: string;
  readonly meta?: Record<string, unknown>;
}

export interface MemoryVersion {
  readonly core: string;
  readonly events: number;
  readonly facts: number;
}

export interface QueryOptions {
  readonly sessionId?: string;
  readonly sessionTag?: string;
}

export interface QueryResult {
  readonly core: string;
  readonly facts: readonly Fact[];
  readonly coreBytes: number;
}

export interface ChanceManager {
  onFactsChanged(): void;
  currentTag(): string;
}

export interface CoreSnapshot {
  readonly text: string;
  readonly lineCount: number;
  readonly bytes: number;
}

export interface Geneproperties {
  readonly maxCoreLines: number;
  readonly contextBudgetTokens: number;
}

export interface MemoryIndex {
  readonly factCount: () => Promise<number>;
  readonly query: (tag: string) => Promise<readonly Fact[]>;
  readonly addAll: (facts: readonly Fact[]) => Promise<void>;
  readonly sweep: () => void;
  readonly pruneEventsBefore: (ts: number) => Promise<void>;
}
