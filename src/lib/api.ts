export type Autonomy = 'autopilot' | 'supervised';

export interface ModelInfo {
  id: string;
  contextLength?: number;
  state?: string;
}

export type ModelProvider = 'lmstudio' | 'external';

export interface MemoryFact {
  key: string;
  value: string;
  runId: string;
  ts: number;
  tags?: string[];
}

export interface MemorySnapshot {
  core: string;
  facts: MemoryFact[];
  events: number;
  coreLines: number;
  coreBytes: number;
}

export interface Health {
  ok: boolean;
  lmStudio: {
    ok: boolean;
    baseUrl: string;
    models: ModelInfo[];
    error?: string;
    provider?: ModelProvider;
    model: string;
    loaded: boolean;
  };
  config: {
    workspaceRoot: string;
    provider: ModelProvider;
    model: string;
    baseUrl: string;
    lmStudioBaseUrl: string;
    externalBaseUrl: string;
    externalModel: string;
    hasApiKey: boolean;
    contextBudgetTokens: number;
    autonomy: Autonomy;
    maxSteps: number;
    allowCommands: boolean;
  };
  memory: { facts: number; events: number; coreBytes: number };
  hooks: number;
  mcp: { servers: number; tools: number };
  runs: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface SpecTask {
  id: string;
  title: string;
  checked: boolean;
  depth: number;
  line: number;
}

export interface SpecSummary {
  id: string;
  title: string;
  hasRequirements: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  progress: { done: number; total: number };
  updatedAt: string;
}

export interface SpecDetail {
  id: string;
  requirements: string | null;
  design: string | null;
  tasks: string | null;
  tasksParsed: SpecTask[];
}

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  steps: number;
  events: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  running?: boolean;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  files: Array<{ path: string; size: number; hash: string }>;
}

export interface CheckpointDiff {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  beforeBytes?: number;
  afterBytes?: number;
}

export interface HookDefinition {
  name: string;
  when: { type: string; patterns?: string[] };
  then: { type: 'agent'; prompt: string } | { type: 'command'; command: string };
  enabled?: boolean;
}

export interface AgentResult {
  status: 'completed' | 'failed' | 'cancelled' | 'paused';
  runId: string;
  steps: number;
  message: string;
  error?: string;
  resumable: boolean;
  toolCalls: number;
  usage: { promptTokens: number; completionTokens: number };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { error: raw.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const message = (parsed as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  memory: () => request<MemorySnapshot>('/api/memory'),
  addMemoryFact: (key: string, value: string) =>
    request<MemoryFact>('/api/memory/facts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    }),
  forgetMemoryFact: (key: string) =>
    request<{ removed: boolean }>(`/api/memory/facts/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  models: () => request<{ models: ModelInfo[] }>('/api/models'),
  updateConfig: (patch: Record<string, unknown>) =>
    request<{ config: Health['config'] }>('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  tree: () => request<{ root: string; tree: FileNode[] }>('/api/files?depth=5'),
  readFile: (path: string) => request<FileContent>(`/api/file?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string) =>
    request<{ path: string }>('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  createFile: (path: string, kind: 'file' | 'dir') =>
    request<{ path: string }>('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, kind, content: '' }),
    }),
  deleteFile: (path: string) => request<{ path: string }>(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  specs: () => request<{ specs: SpecSummary[] }>('/api/specs'),
  createSpec: (name: string) =>
    request<{ spec: SpecSummary }>('/api/specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  spec: (id: string) => request<SpecDetail>(`/api/specs/${encodeURIComponent(id)}`),
  saveSpec: (id: string, artifact: string, content: string) =>
    request<{ ok: boolean }>(`/api/specs/${encodeURIComponent(id)}/${artifact}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  runs: () => request<{ runs: RunSummary[] }>('/api/runs'),
  run: (id: string) =>
    request<{ summary: RunSummary; events: Array<{ seq: number; type: string; at: string; data?: unknown }> }>(
      `/api/runs/${encodeURIComponent(id)}`,
    ),
  cancelRun: (id: string) => request<{ cancelled: boolean }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  checkpoints: () => request<{ checkpoints: Checkpoint[] }>('/api/checkpoints'),
  createCheckpoint: (label: string) =>
    request<{ checkpoint: Checkpoint }>('/api/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }),
  checkpointDiff: (id: string) => request<{ diff: CheckpointDiff[] }>(`/api/checkpoints/${encodeURIComponent(id)}/diff`),
  restoreCheckpoint: (id: string) =>
    request<{ restored: string[]; deleted: string[]; unchanged: number }>(`/api/checkpoints/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),
  hooks: () => request<{ hooks: HookDefinition[] }>('/api/hooks'),
  runHook: (name: string, event: string, path?: string) =>
    request<{ matched: boolean; result: { ok: boolean; detail?: string } | null }>(
      `/api/hooks/${encodeURIComponent(name)}/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, path }),
      },
    ),
  steering: () => request<{ steering: Array<{ name: string; inclusion: string; globs: string[] }> }>('/api/steering'),
  mcp: () => request<{ servers: string[]; tools: string[] }>('/api/mcp'),
  connectMcp: () => request<{ servers: Array<{ server: string; ok: boolean; tools?: number; error?: string }> }>('/api/mcp/connect', { method: 'POST' }),
  sources: () => request<SourceBundle>('/api/intel/sources'),
  debugState: () => request<DebugState>('/api/debug/state'),
  debugStart: (script: string, breakpoints: Array<{ path: string; line: number }>) =>
    request<DebugState>('/api/debug/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script, breakpoints }),
    }),
  debugSetBreakpoints: (breakpoints: Array<{ path: string; line: number }>) =>
    request<DebugState>('/api/debug/breakpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ breakpoints }),
    }),
  debugAction: (action: 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut') =>
    request<DebugState>('/api/debug/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  debugEvaluate: (expression: string) =>
    request<{ value: string }>('/api/debug/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expression }),
    }),
  debugStop: () => request<{ status: string }>('/api/debug/stop', { method: 'POST' }),
};

export interface SourceBundle {
  root: string;
  files: Array<{ path: string; content: string }>;
  truncated: boolean;
  bytes: number;
}

export type DebugStatus = 'idle' | 'starting' | 'paused' | 'running' | 'exited';

export interface DebugBreakpoint {
  path: string;
  line: number;
  verified?: boolean;
}

export interface DebugFrame {
  id: string;
  functionName: string;
  path: string | null;
  line: number;
  column: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export interface DebugState {
  status: DebugStatus;
  script: string | null;
  frames: DebugFrame[];
  variables: DebugVariable[];
  breakpoints: DebugBreakpoint[];
  output: Array<{ stream: string; text: string }>;
  exitCode?: number | null;
  error?: string;
}

export type StreamHandler = (event: string, data: Record<string, unknown>) => void;

/** POST and consume a server-sent-event stream, dispatching named events. */
export async function stream(url: string, body: unknown, onEvent: StreamHandler, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      if (block.startsWith(':')) continue;
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        onEvent(eventName, JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
      } catch {
        onEvent(eventName, { raw: dataLines.join('\n') });
      }
    }
  }
}
