import fs from 'node:fs/promises';
import path from 'node:path';
import { CheckpointStore } from './agent/checkpoints';
import { RunJournal, listRuns, newRunId, type RunSummary } from './agent/journal';
import { runAgent, type AgentEvent, type AgentResult } from './agent/loop';
import { AGENT_SYSTEM_PROMPT, TASK_AGENT_PROMPT } from './agent/prompts';
import type { ContextSection } from './context/builder';
import { retrieveFiles } from './context/retrieval';
import { geniePaths, loadConfig, type Autonomy, type GenieConfig } from './config';
import { HookEngine, loadHooks, type HookDefinition, type HookEvent, type HookRunResult } from './hooks/hooks';
import { LMStudioClient, type ChatMessage } from './llm/client';
import { loadMcpConfig, McpClient, mcpTools, type McpTool } from './mcp/client';
import { generateSpec, type GenerateSpecResult } from './spec/generator';
import { SpecStore, parseTasks, type SpecTask } from './spec/spec';
import { loadSteering, selectSteering, steeringSections } from './steering/steering';
import { createDefaultTools, findTool, runCommandTool, type Tool } from './tools';
import { ensureDir, resolveInWorkspace, toRelative } from './util/paths';

export interface RunRequest {
  goal: string;
  files?: string[];
  specId?: string;
  taskId?: string;
  autonomy?: Autonomy;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  trigger?: 'user' | 'hook';
}

export interface ChatStreamRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

const MAX_SECTION_FILE_CHARS = 60_000;

/**
 * Owns every long-lived resource: the LM Studio client, tool registry, journal
 * directory, spec store, checkpoints, steering and hooks.
 */
export class GenieService {
  config: GenieConfig;
  private client: LMStudioClient;
  private readonly tools: Tool[];
  private readonly specStore: SpecStore;
  private readonly checkpoints: CheckpointStore;
  private hookEngine: HookEngine;
  private readonly active = new Map<string, AbortController>();
  private mcpClients: McpClient[] = [];
  private mcpToolList: McpTool[] = [];

  constructor(config: GenieConfig) {
    this.config = config;
    this.client = new LMStudioClient({
      baseUrl: config.lmStudioBaseUrl,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      timeoutMs: config.requestTimeoutMs,
      maxAttempts: config.maxAttempts,
    });
    this.tools = createDefaultTools();
    const paths = geniePaths(config.workspaceRoot);
    this.specStore = new SpecStore(paths.specs);
    this.checkpoints = new CheckpointStore(config.workspaceRoot, paths.checkpoints);
    this.hookEngine = new HookEngine([], async () => ({ ok: true }));
  }

  async init(): Promise<void> {
    const paths = geniePaths(this.config.workspaceRoot);
    await Promise.all([
      ensureDir(paths.genie),
      ensureDir(paths.specs),
      ensureDir(paths.runs),
      ensureDir(paths.checkpoints),
      ensureDir(paths.hooks),
      ensureDir(paths.steering),
    ]);
    await this.reloadHooks();
  }

  get lmStudio(): LMStudioClient {
    return this.client;
  }

  get hookDefinitions(): HookDefinition[] {
    return this.hookEngine.definitions;
  }

  async reloadHooks(): Promise<void> {
    const loaded = await loadHooks(geniePaths(this.config.workspaceRoot).hooks);
    const hooks = loaded.filter((entry) => !entry.error).map((entry) => entry.hook);
    this.hookEngine = new HookEngine(hooks, (hook, event) => this.executeHook(hook, event));
  }

  async updateConfig(patch: Partial<GenieConfig>): Promise<GenieConfig> {
    const paths = geniePaths(this.config.workspaceRoot);
    const next: GenieConfig = { ...this.config, ...patch };
    const persisted = {
      lmStudioBaseUrl: next.lmStudioBaseUrl,
      model: next.model,
      temperature: next.temperature,
      maxTokens: next.maxTokens,
      contextBudgetTokens: next.contextBudgetTokens,
      reserveOutputTokens: next.reserveOutputTokens,
      maxAgentSteps: next.maxAgentSteps,
      autonomy: next.autonomy,
      allowCommands: next.allowCommands,
    };
    await fs.writeFile(paths.config, JSON.stringify(persisted, null, 2));
    await this.closeMcp();
    this.config = next;
    this.client = new LMStudioClient({
      baseUrl: next.lmStudioBaseUrl,
      model: next.model,
      temperature: next.temperature,
      maxTokens: next.maxTokens,
      timeoutMs: next.requestTimeoutMs,
      maxAttempts: next.maxAttempts,
    });
    return next;
  }

  async health() {
    const studio = await this.client.health();
    return {
      ok: studio.ok,
      lmStudio: {
        ...studio,
        model: this.config.model,
        loaded: studio.models.some((m) => m.id === this.config.model),
      },
      config: {
        workspaceRoot: this.config.workspaceRoot,
        model: this.config.model,
        lmStudioBaseUrl: this.config.lmStudioBaseUrl,
        contextBudgetTokens: this.config.contextBudgetTokens,
        autonomy: this.config.autonomy,
        maxSteps: this.config.maxAgentSteps,
        allowCommands: this.config.allowCommands,
      },
      hooks: this.hookEngine.definitions.length,
      mcp: { servers: this.mcpClients.length, tools: this.mcpToolList.length },
      runs: (await listRuns(geniePaths(this.config.workspaceRoot).runs)).length,
    };
  }

  async listModels() {
    return this.client.listModels();
  }

  async chatStream(request: ChatStreamRequest): Promise<{ content: string; model: string }> {
    const result = await this.client.chat(
      { messages: request.messages as ChatMessage[], stream: true, signal: request.signal },
      request.onDelta,
    );
    return { content: result.content, model: result.model ?? this.config.model };
  }

  private async buildSections(
    files: string[] = [],
    specId?: string,
    taskId?: string,
    query?: string,
  ): Promise<ContextSection[]> {
    const sections: ContextSection[] = [];
    const steering = await loadSteering(geniePaths(this.config.workspaceRoot).steering);
    sections.push(...steeringSections(selectSteering(steering, files)));

    if (specId) {
      const spec = await this.specStore.read(specId);
      if (spec.requirements) {
        sections.push({
          id: `spec:${specId}:requirements`,
          kind: 'spec',
          title: `${specId} requirements`,
          content: spec.requirements,
          priority: 78,
        });
      }
      if (spec.design) {
        sections.push({
          id: `spec:${specId}:design`,
          kind: 'spec',
          title: `${specId} design`,
          content: spec.design,
          priority: 74,
        });
      }
      if (spec.tasks) {
        sections.push({
          id: `spec:${specId}:tasks`,
          kind: 'task',
          title: `${specId} tasks`,
          content: spec.tasks,
          priority: taskId ? 88 : 70,
        });
      }
    }

    let index = 0;
    for (const file of files.slice(0, 8)) {
      if (file === 'tasks.md' && taskId) continue;
      try {
        const absolute = resolveInWorkspace(this.config.workspaceRoot, file);
        const content = await fs.readFile(absolute, 'utf8');
        sections.push({
          id: `file:${file}`,
          kind: 'file',
          title: file,
          content: content.length > MAX_SECTION_FILE_CHARS ? content.slice(0, MAX_SECTION_FILE_CHARS) : content,
          priority: 60 - index,
        });
        index += 1;
      } catch {
        // missing file: skip the section rather than failing the run
      }
    }

    if (!files.length && query) {
      const retrieved = await retrieveFiles(this.config.workspaceRoot, query, { limit: 5 });
      retrieved.forEach((file, position) => {
        sections.push({
          id: `retrieval:${file.path}`,
          kind: 'file',
          title: `${file.path} (relevance match)`,
          content: `# ${file.path}\n…${file.snippet}…`,
          priority: 52 - position,
        });
      });
    }

    return sections;
  }

  private async allTools(): Promise<Tool[]> {
    return [...this.tools, ...mcpToolsFor(this.mcpClients, this.mcpToolList)];
  }

  private async startRun(request: RunRequest, journal: RunJournal): Promise<AgentResult> {
    if (!request.goal.trim()) throw new Error('A goal is required to start a run');
    const autonomy = request.autonomy ?? this.config.autonomy;
    const sections = await this.buildSections(request.files, request.specId, request.taskId, request.goal);
    const controller = new AbortController();
    const external = request.signal;
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    this.active.set(journal.id, controller);

    try {
      const systemPrompt = request.taskId
        ? `${TASK_AGENT_PROMPT}\n\n${AGENT_SYSTEM_PROMPT.split('\n').slice(2).join('\n')}`
        : AGENT_SYSTEM_PROMPT;
      const result = await runAgent({
        client: this.client,
        journal,
        workspaceRoot: this.config.workspaceRoot,
        goal: request.goal,
        systemPrompt,
        tools: await this.allTools(),
        contextSections: sections,
        budgetTokens: this.config.contextBudgetTokens,
        reserveOutputTokens: this.config.reserveOutputTokens,
        maxSteps: request.maxSteps ?? this.config.maxAgentSteps,
        maxToolRepairs: this.config.maxToolRepairs,
        autonomy,
        allowCommands: this.config.allowCommands,
        commandTimeoutMs: this.config.commandTimeoutMs,
        signal: controller.signal,
        checkpoints: this.checkpoints,
        checkpointOnWrite: true,
        onEvent: request.onEvent,
      });

      if (request.specId && request.taskId && result.status === 'completed') {
        try {
          await this.specStore.updateTaskStatus(request.specId, request.taskId, true);
          await journal.append('task.update', { data: { specId: request.specId, taskId: request.taskId, checked: true } });
          await this.dispatchHooks({ type: 'taskCompleted', spec: request.specId, runId: journal.id, message: request.taskId });
        } catch (error) {
          await journal.append('error', { data: { message: `Task status update failed: ${(error as Error).message}` } });
        }
      }

      if (request.trigger !== 'hook') {
        await this.dispatchHooks({
          type: 'agentStop',
          runId: journal.id,
          message: result.status === 'completed' ? 'completed' : result.status,
        });
      }
      return result;
    } finally {
      external?.removeEventListener('abort', onAbort);
      this.active.delete(journal.id);
    }
  }

  async run(request: RunRequest): Promise<AgentResult> {
    const journal = await RunJournal.create(geniePaths(this.config.workspaceRoot).runs, newRunId());
    return this.startRun(request, journal);
  }

  async resume(runId: string, request: RunRequest): Promise<AgentResult> {
    const journal = await RunJournal.open(geniePaths(this.config.workspaceRoot).runs, runId);
    return this.startRun({ ...request, goal: request.goal || journal.summary().goal }, journal);
  }

  cancelRun(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  async runs(): Promise<RunSummary[]> {
    return listRuns(geniePaths(this.config.workspaceRoot).runs);
  }

  async runJournal(runId: string) {
    const journal = await RunJournal.open(geniePaths(this.config.workspaceRoot).runs, runId);
    return { summary: journal.summary(), events: journal.all };
  }

  async generateSpec(
    id: string,
    featureRequest: string,
    options: { onDelta?: (stage: string, text: string) => void; onStage?: (stage: string, status: string) => void; signal?: AbortSignal } = {},
  ): Promise<GenerateSpecResult> {
    const steering = (await loadSteering(geniePaths(this.config.workspaceRoot).steering))
      .map((file) => `## ${file.name}\n${file.content}`)
      .join('\n\n');
    return generateSpec({
      client: this.client,
      store: this.specStore,
      id,
      featureRequest,
      steering,
      signal: options.signal,
      onDelta: (stage, text) => options.onDelta?.(stage, text),
      onStage: (stage, status) => options.onStage?.(stage, status),
    });
  }

  async executeTask(
    specId: string,
    taskId: string,
    options: { onEvent?: (event: AgentEvent) => void; signal?: AbortSignal; autonomy?: Autonomy } = {},
  ): Promise<AgentResult> {
    const spec = await this.specStore.read(specId);
    const task = parseTasks(spec.tasks ?? '').find((t) => t.id === taskId);
    if (!task) throw new Error(`Task "${taskId}" was not found in spec "${specId}"`);
    return this.run({
      goal: `Implement task ${task.id}: ${task.title}\n\nAcceptance: the change must satisfy the referenced requirements and the project must still build.`,
      specId,
      taskId,
      autonomy: options.autonomy,
      onEvent: options.onEvent,
      signal: options.signal,
    });
  }

  /** Run the next unchecked task in a spec. */
  async executeNextTask(specId: string, options: { onEvent?: (event: AgentEvent) => void; signal?: AbortSignal } = {}) {
    const spec = await this.specStore.read(specId);
    const task = parseTasks(spec.tasks ?? '').find((t) => !t.checked);
    if (!task) throw new Error(`Spec "${specId}" has no remaining unchecked tasks`);
    return this.executeTask(specId, task.id, options);
  }

  async tasks(specId: string): Promise<SpecTask[]> {
    const spec = await this.specStore.read(specId);
    return parseTasks(spec.tasks ?? '');
  }

  get specs(): SpecStore {
    return this.specStore;
  }

  get checkpointStore(): CheckpointStore {
    return this.checkpoints;
  }

  async dispatchHooks(event: HookEvent): Promise<HookRunResult[]> {
    return this.hookEngine.dispatch(event);
  }

  private async executeHook(hook: HookDefinition, event: HookEvent): Promise<{ ok: boolean; detail?: string }> {
    if (hook.then.type === 'command') {
      const result = await runCommandTool.run(
        { command: hook.then.command },
        {
          workspaceRoot: this.config.workspaceRoot,
          allowCommands: this.config.allowCommands,
          commandTimeoutMs: this.config.commandTimeoutMs,
        },
      );
      return { ok: result.ok, detail: result.content.slice(0, 600) };
    }

    const prompt = hook.then.prompt
      .replace(/\{\{\s*path\s*\}\}/g, event.path ?? '')
      .replace(/\{\{\s*message\s*\}\}/g, event.message ?? '')
      .replace(/\{\{\s*spec\s*\}\}/g, event.spec ?? '');
    const result = await this.run({ goal: prompt, autonomy: hook.then.autonomy ?? 'autopilot', trigger: 'hook' });
    return { ok: result.status === 'completed', detail: result.message.slice(0, 600) };
  }

  async notifyFileEvent(type: 'fileEdited' | 'fileCreated' | 'fileDeleted', filePath: string): Promise<HookRunResult[]> {
    const relative = toRelative(this.config.workspaceRoot, resolveInWorkspace(this.config.workspaceRoot, filePath));
    return this.dispatchHooks({ type, path: relative });
  }

  async connectMcp(): Promise<Array<{ server: string; ok: boolean; tools?: number; error?: string }>> {
    await this.closeMcp();
    const servers = await loadMcpConfig(geniePaths(this.config.workspaceRoot).mcp);
    const results: Array<{ server: string; ok: boolean; tools?: number; error?: string }> = [];
    this.mcpToolList = [];
    for (const server of servers) {
      const client = new McpClient({ ...server, cwd: server.cwd ?? this.config.workspaceRoot });
      try {
        await client.connect();
        const tools = await client.listTools();
        this.mcpClients.push(client);
        this.mcpToolList.push(...tools.map((tool) => ({ ...tool, name: `mcp__${server.name}__${tool.name}` })));
        results.push({ server: server.name, ok: true, tools: tools.length });
      } catch (error) {
        await client.close().catch(() => undefined);
        results.push({ server: server.name, ok: false, error: (error as Error).message });
      }
    }
    return results;
  }

  async closeMcp(): Promise<void> {
    const clients = this.mcpClients;
    this.mcpClients = [];
    this.mcpToolList = [];
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  mcpStatus() {
    return { servers: this.mcpClients.map((c) => c.name), tools: this.mcpToolList.map((t) => t.name) };
  }

  async steeringFiles() {
    return loadSteering(geniePaths(this.config.workspaceRoot).steering);
  }

  async ensureWorkspace(): Promise<void> {
    await ensureDir(path.join(this.config.workspaceRoot, '.genie'));
  }
}

function mcpToolsFor(clients: McpClient[], tools: McpTool[]): Tool[] {
  if (!clients.length || !tools.length) return [];
  const byServer = new Map<string, McpTool[]>();
  for (const tool of tools) {
    const server = tool.name.startsWith('mcp__') ? tool.name.split('__')[1] ?? '' : '';
    const client = clients.find((c) => c.name === server);
    if (!client) continue;
    const list = byServer.get(server) ?? [];
    list.push(tool);
    byServer.set(server, list);
  }
  const out: Tool[] = [];
  for (const [server, list] of byServer) {
    const client = clients.find((c) => c.name === server);
    if (!client) continue;
    out.push(
      ...mcpTools(
        client,
        list.map((tool) => ({ ...tool, name: tool.name.replace(`mcp__${server}__`, '') })),
        `mcp__${server}__`,
      ),
    );
  }
  return out;
}

export async function createService(workspaceRoot: string, overrides: Partial<GenieConfig> = {}): Promise<GenieService> {
  const config = loadConfig({ workspaceRoot, overrides });
  const service = new GenieService(config);
  await service.init();
  return service;
}

export { findTool };
