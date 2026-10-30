import type { MemoryEvent } from './types';

export function rawFromEvent(event: MemoryEvent): string {
  return JSON.stringify({ kind: event.kind, ts: event.timestamp });
}

export function maybeExtractFacts(event: MemoryEvent): { key: string; value: string; sourceSessionId: string; ts: number }[] {
  if (event.kind !== 'fact') return [];
  try {
    const parsed = JSON.parse(event.body) as { key?: string; value?: string };
    if (parsed.key && parsed.value) {
      return [{ key: parsed.key, value: parsed.value, sourceSessionId: event.sessionId, ts: event.timestamp }];
    }
  } catch {
    // not a fact payload
  }
  return [];
}
