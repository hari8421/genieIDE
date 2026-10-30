import { buildContext, renderSections, type ContextSection } from '../context/builder';
import { LLMError, type ChatResult, type LMStudioClient, type ToolCall } from '../llm/client';
import type { Tool } from '../tools';
import { estimateTokens, truncateToTokens } from '../util/tokens';
import type { CheckpointStore } from './checkpoints';
import type { RunJournal } from './journal';
import { goalDirective, stepNudge } from './prompts';

export type AgentEventType =
  | 'run.start'
  | 'run.end'
  | 'resume'
  | 'step.start'
  | 'assistant.delta'
  | 'assistant.message'
  | 'tool.call'
  | 'tool.result'
  | 'tool.error'
  | 'checkpoint'
  | 'context'
  | 'heal'
  | 'retry';

export interface AgentEvent {
  type: AgentEventType;
  runId: string;
  step?: number;
  data?: unknown;
}

export type AgentStatus = 'completed' | 'failed' | 'cancelled' | 'paused';

export interface AgentRunOptions {
  client: LMStudioClient;
  journal: RunJournal;
  workspaceRoot: string;
  goal: string;
  systemPrompt: string;
  tools: Tool[];
  contextSections?: ContextSection[];
  budgetTokens: number;
  reserveOutputTokens?: number;
  maxSteps: number;
  maxToolRepairs: number;
  autonomy: 'autopilot' | 'supervised';
  allowCommands: boolean;
  commandTimeoutMs: number;
  signal?: AbortSignal;
  checkpoints?: CheckpointStore;
  checkpointOnWrite?: boolean;
  approve?: (request: { tool: string; args: Record<string, unknown> }) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  status: AgentStatus;
  runId: string;
  steps: number;
  message: string;
  error?: string;
  resumable: boolean;
  toolCalls: number;
  usage: { promptTokens: number; completionTokens: number };
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof LLMError)) return false;
  const text = error.message.toLowerCase();
  return (
    (error.status === 400 || error.status === 413 || error.status === 500) &&
    /context|token|too long|length|exceed/.test(text)
  );
}

function turnsFromJournal(journal: RunJournal, goal: string): Turn[] {
  const turns: Turn[] = [{ role: 'user', content: `Goal:\n${goal}` }];
  for (const entry of journal.all) {
    if (entry.type === 'assistant') {
      const data = entry.data as
        | { content?: string; toolCalls?: Array<{ function?: { name?: string; arguments?: string } }> }
        | undefined;
      const calls = data?.toolCalls ?? [];
      const callText = calls.length
        ? `\n[called ${calls.map((c) => `${c.function?.name ?? 'tool'}(${c.function?.arguments ?? '{}'})`).join(', ')}]`
        : '';
      const content = (data?.content ?? '').trim();
      if (content || callText) turns.push({ role: 'assistant', content: `${content}${callText}`.trim() });
    } else if (entry.type === 'tool.result') {
      const data = entry.data as { name?: string; ok?: boolean; content?: string } | undefined;
      if (!data) continue;
      turns.push({
        role: 'user',
        content: `<tool_result name="${data.name ?? 'tool'}" ok="${data.ok ? 'true' : 'false'}">\n${data.content ?? ''}\n</tool_result>`,
      });
    } else if (entry.type === 'error') {
      const data = entry.data as { message?: string } | undefined;
      if (data?.message) turns.push({ role: 'user', content: `<previous_error>\n${data.message}\n</previous_error>` });
    }
  }
  return turns;
}

function parseToolArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, error: 'Tool arguments must be a JSON object.' };
  } catch (error) {
    return {
      ok: false,
      error: `Tool arguments were not valid JSON (${(error as Error).message}). Send a single JSON object. Arguments received: ${text.slice(0, 200)}`,
    };
  }
}

/**
 * The agent loop.
 *
 * Self-healing guarantees:
 *  - transport failures retry with backoff inside the LLM client (+ circuit breaker)
 *  - context overflow shrinks the prompt budget and retries instead of dying
 *  - tool failures are fed back to the model with an explicit repair budget
 *  - every step and tool result is journaled, so an interrupted run resumes and
 *    never re-executes a tool call that already succeeded
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentResult> {
  const { client, journal } = options;
  const emit = (type: AgentEventType, step?: number, data?: unknown): void => {
    options.onEvent?.({ type, runId: journal.id, ...(step !== undefined ? { step } : {}), ...(data !== undefined ? { data } : {}) });
  };

  const isResume = journal.all.length > 0;
  if (!isResume) {
    await journal.append('run.start', { data: { goal: options.goal, startedAt: new Date().toISOString() } });
    emit('run.start', undefined, { goal: options.goal });
  } else {
    await journal.append('resume', { data: { goal: options.goal } });
    emit('resume', undefined, { completedSteps: journal.completedSteps() });
  }

  const turns = turnsFromJournal(journal, options.goal);
  let budget = Math.max(1024, options.budgetTokens);
  const reserve = options.reserveOutputTokens ?? 0;
  const usage = { promptTokens: 0, completionTokens: 0 };
  let toolCalls = 0;
  let stepsRun = 0;
  let consecutiveFailures = 0;
  const completed = new Set(journal.completedSteps());
  const startStep = completed.size ? Math.max(...completed) + 1 : 0;

  const finish = async (
    status: AgentStatus,
    message: string,
    extra: { error?: string; resumable?: boolean } = {},
  ): Promise<AgentResult> => {
    await journal.append('run.end', { data: { status, message, ...(extra.error ? { error: extra.error } : {}) } });
    emit('run.end', undefined, { status, message, ...(extra.error ? { error: extra.error } : {}) });
    return {
      status,
      runId: journal.id,
      steps: stepsRun,
      message,
      ...(extra.error ? { error: extra.error } : {}),
      resumable: extra.resumable ?? status !== 'completed',
      toolCalls,
      usage,
    };
  };

  if (startStep >= options.maxSteps) {
    return finish('paused', `Step budget of ${options.maxSteps} exhausted before the goal completed.`, {
      resumable: true,
    });
  }

  for (let step = startStep; step < options.maxSteps; step += 1) {
    if (options.signal?.aborted) {
      return finish('cancelled', 'Run cancelled by the user. It can be resumed.', { resumable: true });
    }
    stepsRun += 1;

    const stepKey = `step:${step}`;
    if (journal.hasKey(`${stepKey}:done`)) continue;

    emit('step.start', step, { total: options.maxSteps });

    // --- Build the prompt for this step -------------------------------------
    const guidance: Turn[] = [];
    if (step === startStep && turns.length <= 1) {
      guidance.push({ role: 'user', content: goalDirective(options.goal, step, options.maxSteps) });
    } else {
      guidance.push({ role: 'user', content: stepNudge(step, options.maxSteps) });
    }
    const history = [...turns, ...guidance].map((turn) => ({ role: turn.role, content: turn.content }));
    const built = buildContext({
      budgetTokens: budget,
      reserveOutputTokens: reserve,
      sections: options.contextSections ?? [],
      history,
      historyShare: 0.45,
    });
    emit('context', step, {
      totalTokens: built.totalTokens,
      budgetTokens: built.budgetTokens,
      dropped: built.dropped,
      truncated: built.truncated,
      historyNote: built.historyNote ?? null,
    });

    // Instructions stay in the system message; retrieved context is a separate
    // user block so the self-heal path can shrink it without losing the prompt.
    const renderedContext = renderSections(built.sections);
    const messages = [
      { role: 'system' as const, content: options.systemPrompt },
      ...(renderedContext ? [{ role: 'user' as const, content: `<context>\n${renderedContext}\n</context>` }] : []),
      ...(built.historyNote ? [{ role: 'user' as const, content: built.historyNote }] : []),
      ...built.history.map((turn) => ({ role: turn.role, content: turn.content })),
    ];

    // --- Ask the model, healing recoverable failures ------------------------
    let response: ChatResult;
    try {
      response = await requestWithHealing({
        client,
        messages,
        tools: options.tools,
        signal: options.signal,
        onDelta: (text) => emit('assistant.delta', step, { text }),
        onHeal: (info) => emit('heal', step, info),
        getBudget: () => budget,
        onRetryShrink: () => {
          budget = Math.max(1024, Math.floor(budget * 0.6));
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted || (error instanceof LLMError && error.kind === 'aborted')) {
        return finish('cancelled', 'Run cancelled by the user. It can be resumed.', { resumable: true });
      }
      await journal.append('error', { step, data: { message } });
      emit('tool.error', step, { message });
      return finish('failed', `Stopped at step ${step + 1}: ${message}`, { error: message, resumable: true });
    }

    if (response.usage) {
      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
    }

    const content = response.content.trim();
    const calls = response.toolCalls;
    await journal.append('assistant', {
      step,
      key: `${stepKey}:assistant`,
      data: { content, toolCalls: calls },
    });
    emit('assistant.message', step, { content, toolCalls: calls.length });

    if (!calls.length) {
      if (!content) {
        consecutiveFailures += 1;
        const message = 'The model returned an empty response.';
        turns.push({ role: 'assistant', content: '(empty)' });
        turns.push({
          role: 'user',
          content: 'Your previous response was empty. Continue the task with a tool call, or reply "DONE:" if it is complete.',
        });
        if (consecutiveFailures > options.maxToolRepairs) {
          return finish('failed', message, { error: message, resumable: true });
        }
        continue;
      }
      await journal.append('step.complete', { step, key: `${stepKey}:done`, data: { final: true } });
      emit('assistant.message', step, { content, final: true });
      return finish('completed', content);
    }

    // --- Execute tool calls (idempotent on resume) --------------------------
    let stepHadSuccess = false;
    for (const call of calls) {
      const resultKey = `tool:${step}:${call.id}`;
      const previous = journal.entryByKey(resultKey);
      if (previous) {
        const data = previous.data as { name?: string; ok?: boolean; content?: string } | undefined;
        emit('tool.result', step, { name: data?.name, content: data?.content, replayed: true });
        turns.push({
          role: 'user',
          content: `<tool_result name="${data?.name ?? call.function.name}" ok="${data?.ok ? 'true' : 'false'}">\n${data?.content ?? ''}\n</tool_result>`,
        });
        if (data?.ok) stepHadSuccess = true;
        continue;
      }

      const tool = options.tools.find((t) => t.name === call.function.name);
      if (!tool) {
        const message = `Unknown tool "${call.function.name}". Available tools: ${options.tools.map((t) => t.name).join(', ')}.`;
        await journal.append('tool.result', { step, key: resultKey, data: { callId: call.id, name: call.function.name, ok: false, content: message } });
        emit('tool.error', step, { name: call.function.name, message });
        turns.push({ role: 'user', content: `<tool_result name="${call.function.name}" ok="false">\n${message}\n</tool_result>` });
        continue;
      }

      const parsed = parseToolArgs(call.function.arguments);
      if (!parsed.ok) {
        await journal.append('tool.result', {
          step,
          key: resultKey,
          data: { callId: call.id, name: tool.name, ok: false, content: parsed.error },
        });
        emit('tool.error', step, { name: tool.name, message: parsed.error });
        turns.push({ role: 'user', content: `<tool_result name="${tool.name}" ok="false">\n${parsed.error}\n</tool_result>` });
        continue;
      }

      if (options.autonomy === 'supervised' && options.approve) {
        const approved = await options.approve({ tool: tool.name, args: parsed.value });
        if (!approved) {
          const message = 'The user rejected this tool call. Do not retry it; choose a different approach.';
          await journal.append('tool.result', {
            step,
            key: resultKey,
            data: { callId: call.id, name: tool.name, ok: false, content: message },
          });
          emit('tool.error', step, { name: tool.name, message });
          turns.push({ role: 'user', content: `<tool_result name="${tool.name}" ok="false">\n${message}\n</tool_result>` });
          continue;
        }
      }

      toolCalls += 1;
      await journal.append('tool.call', {
        step,
        key: `${resultKey}:call`,
        data: { callId: call.id, name: tool.name, args: parsed.value },
      });
      emit('tool.call', step, { name: tool.name, args: parsed.value });

      let result: { ok: boolean; content: string };
      try {
        result = await tool.run(parsed.value, {
          workspaceRoot: options.workspaceRoot,
          allowCommands: options.allowCommands,
          commandTimeoutMs: options.commandTimeoutMs,
          signal: options.signal,
          onEvent: (event) => emit('tool.result', step, event),
          beforeWrite: async (label, paths) => {
            if (!options.checkpoints || !options.checkpointOnWrite) return;
            const manifest = await options.checkpoints.create(label, { runId: journal.id, step });
            await journal.append('checkpoint', { step, data: { id: manifest.id, label, paths } });
            emit('checkpoint', step, { id: manifest.id, label });
          },
        });
      } catch (error) {
        result = { ok: false, content: `Tool crashed: ${(error as Error).message}` };
      }

      await journal.append('tool.result', {
        step,
        key: resultKey,
        data: { callId: call.id, name: tool.name, ok: result.ok, content: result.content },
      });
      emit(result.ok ? 'tool.result' : 'tool.error', step, { name: tool.name, content: result.content });
      turns.push({
        role: 'user',
        content: `<tool_result name="${tool.name}" ok="${result.ok ? 'true' : 'false'}">\n${result.content}\n</tool_result>`,
      });
      if (result.ok) stepHadSuccess = true;
    }

    await journal.append('step.complete', { step, key: `${stepKey}:done`, data: { toolCalls: calls.length } });

    if (stepHadSuccess) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures > options.maxToolRepairs) {
        const message = `Stopped after ${consecutiveFailures} consecutive failed steps. The last errors are in the run journal; resume after fixing the cause or roll back to a checkpoint.`;
        await journal.append('error', { step, data: { message } });
        return finish('failed', message, { error: message, resumable: true });
      }
    }
  }

  return finish(
    'paused',
    `Reached the step budget of ${options.maxSteps} with the goal still open. Resume to continue from where it stopped.`,
    { resumable: true },
  );
}

interface HealingRequest {
  client: LMStudioClient;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: Tool[];
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onHeal: (info: { kind: string; detail: string; attempt: number }) => void;
  onRetryShrink: () => void;
  getBudget: () => number;
}

/**
 * Shrink an already-built prompt. Retrying an over-long prompt unchanged would
 * fail identically, so the healing path must actually remove content.
 */
function shrinkPrompt(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ratio: number,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const system = messages[0];
  const rest = messages.slice(1);
  const tail = rest.slice(-2).map((message) => ({
    ...message,
    content: truncateToTokens(message.content, Math.max(120, Math.floor(estimateTokens(message.content) * 0.8))),
  }));
  const middle = rest
    .slice(0, Math.max(0, rest.length - 2))
    .slice(-4)
    .map((message) => ({
      ...message,
      content: truncateToTokens(message.content, Math.max(64, Math.floor(estimateTokens(message.content) * ratio))),
    }));
  return system ? [system, ...middle, ...tail] : [...middle, ...tail];
}

async function requestWithHealing(request: HealingRequest): Promise<ChatResult> {
  const toolSpecs = request.tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  let messages = request.messages.map((message) => ({ ...message }));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await request.client.chat(
        {
          messages,
          tools: toolSpecs,
          stream: true,
          signal: request.signal,
          maxTokens: undefined,
        },
        request.onDelta,
      );

      // Local models sometimes emit tool calls as fenced JSON instead of using
      // the tool-call channel. Recover those before asking for another step.
      if (!response.toolCalls.length && response.finishReason === 'stop') {
        const rescued = rescueToolCall(response.content);
        if (rescued) {
          request.onHeal({ kind: 'tool-call-rescue', detail: 'Recovered a tool call emitted as JSON text.', attempt });
          return { ...response, toolCalls: [rescued], finishReason: 'tool_calls' };
        }
      }
      return response;
    } catch (error) {
      const canShrink = isContextOverflow(error) && attempt <= 3 && request.getBudget() > 1500;
      if (canShrink) {
        messages = shrinkPrompt(messages, 0.4);
        request.onHeal({
          kind: 'context-overflow',
          detail: `Prompt did not fit; trimming context and retrying (attempt ${attempt}).`,
          attempt,
        });
        request.onRetryShrink();
        continue;
      }
      throw error;
    }
  }
}

function rescueToolCall(content: string): ToolCall | null {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? content.match(/(\{[\s\S]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!.trim()) as { name?: string; tool?: string; arguments?: unknown; args?: unknown };
    const name = parsed.name ?? parsed.tool;
    if (!name || typeof name !== 'string') return null;
    const args = parsed.arguments ?? parsed.args ?? {};
    return {
      id: `rescued_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    };
  } catch {
    return null;
  }
}

/** Rough prompt-size estimate for callers that want to pre-flight a run. */
export function estimatePromptTokens(systemPrompt: string, sections: ContextSection[], turns: Turn[]): number {
  return (
    estimateTokens(systemPrompt) +
    sections.reduce((sum, s) => sum + estimateTokens(s.content), 0) +
    turns.reduce((sum, t) => sum + estimateTokens(t.content) + 4, 0)
  );
}
