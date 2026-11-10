import fs from 'node:fs';
import path from 'node:path';

export type Autonomy = 'autopilot' | 'supervised';

/** Where completions come from: a local LM Studio server or a hosted API. */
export type ModelProvider = 'lmstudio' | 'external';

export interface AnnealConfig {
  /** Absolute path of the workspace the agent is allowed to touch. */
  workspaceRoot: string;
  /** OpenAI-compatible base URL. LM Studio defaults to 127.0.0.1:1234/v1. */
  lmStudioBaseUrl: string;
  /** Model identifier exactly as reported by LM Studio. */
  model: string;
  /** Which endpoint chat requests go to. */
  provider: ModelProvider;
  /** OpenAI-compatible base URL used when `provider` is 'external'. */
  externalBaseUrl: string;
  /** Model name sent to the external provider; falls back to `model` when empty. */
  externalModel: string;
  /** Bearer token for the external provider. Supplied by env, never written to config.json. */
  externalApiKey: string;
  temperature: number;
  /** Max completion tokens requested per call. */
  maxTokens: number;
  /** Prompt budget (tokens) the context engine may spend. */
  contextBudgetTokens: number;
  /** Tokens reserved for the model's reply, subtracted from the model context. */
  reserveOutputTokens: number;
  maxAgentSteps: number;
  /** How many times a failing tool call may be repaired inside one step. */
  maxToolRepairs: number;
  /** LLM transport attempts (1 = no retry). */
  maxAttempts: number;
  requestTimeoutMs: number;
  autonomy: Autonomy;
  commandTimeoutMs: number;
  allowCommands: boolean;
}

export const DEFAULT_CONFIG: Omit<AnnealConfig, 'workspaceRoot'> = {
  lmStudioBaseUrl: 'http://127.0.0.1:1234/v1',
  model: 'local-model',
  provider: 'lmstudio',
  externalBaseUrl: 'https://api.openai.com/v1',
  externalModel: '',
  externalApiKey: '',
  temperature: 0.2,
  maxTokens: 2048,
  contextBudgetTokens: 8192,
  reserveOutputTokens: 2048,
  maxAgentSteps: 24,
  maxToolRepairs: 3,
  maxAttempts: 4,
  requestTimeoutMs: 120_000,
  autonomy: 'autopilot',
  commandTimeoutMs: 60_000,
  allowCommands: true,
};

export interface AnnealPaths {
  anneal: string;
  config: string;
  specs: string;
  runs: string;
  checkpoints: string;
  hooks: string;
  steering: string;
  mcp: string;
}

export function annealPaths(workspaceRoot: string): AnnealPaths {
  const anneal = path.join(workspaceRoot, '.anneal');
  return {
    anneal,
    config: path.join(anneal, 'config.json'),
    specs: path.join(anneal, 'specs'),
    runs: path.join(anneal, 'runs'),
    checkpoints: path.join(anneal, 'checkpoints'),
    hooks: path.join(anneal, 'hooks'),
    steering: path.join(anneal, 'steering'),
    mcp: path.join(anneal, 'mcp.json'),
  };
}

function readJsonIfExists(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export interface LoadConfigOptions {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<AnnealConfig>;
}

/**
 * Layered config: defaults <- .anneal/config.json <- environment <- explicit overrides.
 * Never throws on malformed config; bad values fall back to defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): AnnealConfig {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const file = readJsonIfExists(annealPaths(workspaceRoot).config);

  const autonomyRaw = str(env.ANNEAL_AUTONOMY ?? file.autonomy, DEFAULT_CONFIG.autonomy);
  const autonomy: Autonomy = autonomyRaw === 'supervised' ? 'supervised' : 'autopilot';

  const config: AnnealConfig = {
    workspaceRoot,
    lmStudioBaseUrl: str(
      env.LMSTUDIO_BASE_URL ?? env.ANNEAL_LMSTUDIO_URL ?? file.lmStudioBaseUrl,
      DEFAULT_CONFIG.lmStudioBaseUrl,
    ),
    model: str(env.ANNEAL_MODEL ?? file.model, DEFAULT_CONFIG.model),
    provider:
      str(env.ANNEAL_PROVIDER ?? file.provider, DEFAULT_CONFIG.provider) === 'external' ? 'external' : 'lmstudio',
    externalBaseUrl: str(
      env.ANNEAL_EXTERNAL_BASE_URL ?? file.externalBaseUrl,
      DEFAULT_CONFIG.externalBaseUrl,
    ),
    externalModel: str(env.ANNEAL_EXTERNAL_MODEL ?? file.externalModel, DEFAULT_CONFIG.externalModel),
    externalApiKey: str(
      env.ANNEAL_EXTERNAL_API_KEY ?? file.externalApiKey,
      DEFAULT_CONFIG.externalApiKey,
    ),
    temperature: num(env.ANNEAL_TEMPERATURE ?? file.temperature, DEFAULT_CONFIG.temperature),
    maxTokens: num(env.ANNEAL_MAX_TOKENS ?? file.maxTokens, DEFAULT_CONFIG.maxTokens),
    contextBudgetTokens: Math.max(
      1024,
      num(env.ANNEAL_CONTEXT_BUDGET ?? file.contextBudgetTokens, DEFAULT_CONFIG.contextBudgetTokens),
    ),
    reserveOutputTokens: num(
      env.ANNEAL_RESERVE_OUTPUT ?? file.reserveOutputTokens,
      DEFAULT_CONFIG.reserveOutputTokens,
    ),
    maxAgentSteps: Math.max(1, num(env.ANNEAL_MAX_STEPS ?? file.maxAgentSteps, DEFAULT_CONFIG.maxAgentSteps)),
    maxToolRepairs: Math.max(0, num(file.maxToolRepairs, DEFAULT_CONFIG.maxToolRepairs)),
    maxAttempts: Math.max(1, num(env.ANNEAL_MAX_ATTEMPTS ?? file.maxAttempts, DEFAULT_CONFIG.maxAttempts)),
    requestTimeoutMs: Math.max(
      1000,
      num(env.ANNEAL_REQUEST_TIMEOUT ?? file.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    ),
    autonomy,
    commandTimeoutMs: Math.max(
      1000,
      num(file.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs),
    ),
    allowCommands: bool(env.ANNEAL_ALLOW_COMMANDS ?? file.allowCommands, DEFAULT_CONFIG.allowCommands),
    ...options.overrides,
  };

  return config;
}

export interface ResolvedEndpoint {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** The endpoint the LLM client should talk to for this config. */
export function resolveEndpoint(config: AnnealConfig): ResolvedEndpoint {
  if (config.provider === 'external') {
    return {
      provider: 'external',
      baseUrl: config.externalBaseUrl,
      model: config.externalModel || config.model,
      ...(config.externalApiKey ? { apiKey: config.externalApiKey } : {}),
    };
  }
  return { provider: 'lmstudio', baseUrl: config.lmStudioBaseUrl, model: config.model };
}
