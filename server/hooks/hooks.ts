import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesAnyGlob } from '../util/glob';

export type HookEventType = 'fileEdited' | 'fileCreated' | 'fileDeleted' | 'taskCompleted' | 'agentStop' | 'manual';

export interface HookEvent {
  type: HookEventType;
  path?: string;
  spec?: string;
  runId?: string;
  message?: string;
}

export type HookAction =
  | { type: 'agent'; prompt: string; autonomy?: 'autopilot' | 'supervised' }
  | { type: 'command'; command: string };

export interface HookDefinition {
  name: string;
  when: { type: HookEventType | 'manual'; patterns?: string[] };
  then: HookAction;
  enabled?: boolean;
}

const EVENT_TYPES: HookEventType[] = ['fileEdited', 'fileCreated', 'fileDeleted', 'taskCompleted', 'agentStop', 'manual'];

export function validateHook(value: unknown, fallbackName = 'hook'): HookDefinition {
  const raw = value as Partial<HookDefinition> | null;
  if (!raw || typeof raw !== 'object') throw new Error(`Hook ${fallbackName} must be an object`);
  const when = raw.when as HookDefinition['when'] | undefined;
  if (!when || typeof when.type !== 'string') throw new Error(`Hook ${fallbackName} is missing "when.type"`);
  if (!EVENT_TYPES.includes(when.type as HookEventType)) {
    throw new Error(`Hook ${fallbackName} has unknown event type "${when.type}"`);
  }
  const then = raw.then as HookAction | undefined;
  if (!then || (then.type !== 'agent' && then.type !== 'command')) {
    throw new Error(`Hook ${fallbackName} needs "then.type" of "agent" or "command"`);
  }
  if (then.type === 'agent' && !then.prompt) throw new Error(`Hook ${fallbackName} agent action needs a prompt`);
  if (then.type === 'command' && !then.command) throw new Error(`Hook ${fallbackName} command action needs a command`);
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackName,
    when: {
      type: when.type,
      ...(Array.isArray(when.patterns) && when.patterns.length ? { patterns: when.patterns.filter((p) => typeof p === 'string') } : {}),
    },
    then,
    enabled: raw.enabled !== false,
  };
}

export function matchesHook(hook: HookDefinition, event: HookEvent): boolean {
  if (hook.enabled === false) return false;
  if (hook.when.type !== event.type) return false;
  if (event.path) return matchesAnyGlob(event.path, hook.when.patterns);
  // A file-scoped pattern cannot match a non-file event.
  if (hook.when.patterns?.length && (event.type === 'agentStop' || event.type === 'manual' || event.type === 'taskCompleted')) {
    return false;
  }
  return true;
}

export async function loadHooks(dir: string): Promise<Array<{ hook: HookDefinition; error?: string }>> {
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ hook: HookDefinition; error?: string }> = [];
  for (const name of names.sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      out.push({ hook: validateHook(JSON.parse(raw), name.replace(/\.json$/, '')) });
    } catch (error) {
      out.push({
        hook: { name: name.replace(/\.json$/, ''), when: { type: 'manual' }, then: { type: 'command', command: '' }, enabled: false },
        error: (error as Error).message,
      });
    }
  }
  return out;
}

export interface HookRunResult {
  hook: string;
  ok: boolean;
  error?: string;
  detail?: string;
}

export type HookRunner = (hook: HookDefinition, event: HookEvent) => Promise<{ ok: boolean; detail?: string }>;

/**
 * Dispatches events to matching hooks. A failing hook is reported but never
 * blocks the others: hooks are side automation, not part of the agent's result.
 */
export class HookEngine {
  constructor(
    private readonly hooks: HookDefinition[],
    private readonly runner: HookRunner,
  ) {}

  get definitions(): HookDefinition[] {
    return this.hooks;
  }

  matching(event: HookEvent): HookDefinition[] {
    return this.hooks.filter((hook) => matchesHook(hook, event));
  }

  async dispatch(event: HookEvent): Promise<HookRunResult[]> {
    const results: HookRunResult[] = [];
    for (const hook of this.matching(event)) {
      try {
        const outcome = await this.runner(hook, event);
        results.push({ hook: hook.name, ok: outcome.ok, detail: outcome.detail });
      } catch (error) {
        results.push({ hook: hook.name, ok: false, error: (error as Error).message });
      }
    }
    return results;
  }
}
