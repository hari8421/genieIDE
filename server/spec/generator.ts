import type { LMStudioClient } from '../llm/client';
import { parseTasks, type SpecStore } from './spec';
import {
  DESIGN_SYSTEM_PROMPT,
  REQUIREMENTS_SYSTEM_PROMPT,
  TASKS_SYSTEM_PROMPT,
  designUserPrompt,
  requirementsUserPrompt,
  tasksUserPrompt,
} from '../agent/prompts';

export interface GenerateSpecOptions {
  client: LMStudioClient;
  store: SpecStore;
  id: string;
  featureRequest: string;
  steering?: string;
  signal?: AbortSignal;
  onDelta?: (stage: 'requirements' | 'design' | 'tasks', text: string) => void;
  onStage?: (stage: 'requirements' | 'design' | 'tasks', status: 'start' | 'done') => void;
}

export interface GenerateSpecResult {
  id: string;
  requirements: string;
  design: string;
  tasks: string;
  taskCount: number;
}

async function complete(
  client: LMStudioClient,
  system: string,
  user: string,
  options: { signal?: AbortSignal; onDelta?: (text: string) => void; maxTokens?: number; temperature?: number },
): Promise<string> {
  const result = await client.chat(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? 3000,
      stream: true,
      signal: options.signal,
    },
    options.onDelta,
  );
  const text = result.content.trim();
  if (!text) throw new Error('The model returned an empty document. Check that a model is loaded in LM Studio.');
  return text;
}

function ensureTitle(markdown: string, title: string): string {
  return /^\s*#\s+/m.test(markdown) ? markdown : `# ${title}\n\n${markdown}`;
}

/**
 * Kiro-style three-stage spec workflow: requirements -> design -> tasks.
 * Each stage is streamed to the caller and persisted immediately, so a failure
 * in a later stage leaves the earlier approved documents intact.
 */
export async function generateSpec(options: GenerateSpecOptions): Promise<GenerateSpecResult> {
  const { client, store, id } = options;
  const steeringText = options.steering ?? '';

  options.onStage?.('requirements', 'start');
  const requirements = ensureTitle(
    await complete(
      client,
      REQUIREMENTS_SYSTEM_PROMPT,
      requirementsUserPrompt(options.featureRequest, steeringText),
      { signal: options.signal, onDelta: (text) => options.onDelta?.('requirements', text), maxTokens: 3200 },
    ),
    `${id} Requirements`,
  );
  await store.write(id, 'requirements', requirements);
  options.onStage?.('requirements', 'done');

  options.onStage?.('design', 'start');
  const design = ensureTitle(
    await complete(
      client,
      DESIGN_SYSTEM_PROMPT,
      designUserPrompt(options.featureRequest, requirements, steeringText),
      { signal: options.signal, onDelta: (text) => options.onDelta?.('design', text), maxTokens: 3600 },
    ),
    `${id} Design`,
  );
  await store.write(id, 'design', design);
  options.onStage?.('design', 'done');

  options.onStage?.('tasks', 'start');
  let tasks = await complete(client, TASKS_SYSTEM_PROMPT, tasksUserPrompt(design, requirements), {
    signal: options.signal,
    onDelta: (text) => options.onDelta?.('tasks', text),
    maxTokens: 2200,
    temperature: 0.2,
  });
  tasks = ensureTitle(tasks, 'Implementation Plan');

  if (!parseTasks(tasks).length) {
    // One repair pass: local models occasionally answer with prose.
    const repair = await complete(
      client,
      TASKS_SYSTEM_PROMPT,
      `${tasksUserPrompt(design, requirements)}\n\nYour previous answer contained no "- [ ] N. task" lines. Reply with the checkbox list only.`,
      { signal: options.signal, maxTokens: 2200, temperature: 0.1 },
    );
    tasks = ensureTitle(repair, 'Implementation Plan');
  }

  await store.write(id, 'tasks', tasks);
  options.onStage?.('tasks', 'done');

  return { id, requirements, design, tasks, taskCount: parseTasks(tasks).length };
}
