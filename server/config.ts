import fs from 'node:fs';
import path from 'node:path';

export type Autonomy = 'autopilot' | 'supervised';

export interface GenieConfig {
  /** Absolute path of the workspace the agent is allowed to touch. */
  workspaceRoot: string;
  /** OpenAI-compatible base URL. LM Studio defaults to 127.0.0.1:1234/v1. */
  lmStudioBaseUrl: string;
  /** Model identifier exactly as reported by LM Studio. */
  model: string;
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

export const DEFAULT_CONFIG: Omit<GenieConfig, 'workspaceRoot'> = {
  lmStudioBaseUrl: 'http://127.0.0.1:1234/v1',
  model: 'local-model',
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

export interface GeniePaths {
  genie: string;
  config: string;
  specs: string;
  runs: string;
  checkpoints: string;
  hooks: string;
  steering: string;
  mcp: string;
}

export function geniePaths(workspaceRoot: string): GeniePaths {
  const genie = path.join(workspaceRoot, '.genie');
  return {
    genie,
    config: path.join(genie, 'config.json'),
    specs: path.join(genie, 'specs'),
    runs: path.join(genie, 'runs'),
    checkpoints: path.join(genie, 'checkpoints'),
    hooks: path.join(genie, 'hooks'),
    steering: path.join(genie, 'steering'),
    mcp: path.join(genie, 'mcp.json'),
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
  overrides?: Partial<GenieConfig>;
}

/**
 * Layered config: defaults <- .genie/config.json <- environment <- explicit overrides.
 * Never throws on malformed config; bad values fall back to defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): GenieConfig {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const file = readJsonIfExists(geniePaths(workspaceRoot).config);

  const autonomyRaw = str(env.GENIE_AUTONOMY ?? file.autonomy, DEFAULT_CONFIG.autonomy);
  const autonomy: Autonomy = autonomyRaw === 'supervised' ? 'supervised' : 'autopilot';

  const config: GenieConfig = {
    workspaceRoot,
    lmStudioBaseUrl: str(
      env.LMSTUDIO_BASE_URL ?? env.GENIE_LMSTUDIO_URL ?? file.lmStudioBaseUrl,
      DEFAULT_CONFIG.lmStudioBaseUrl,
    ),
    model: str(env.GENIE_MODEL ?? file.model, DEFAULT_CONFIG.model),
    temperature: num(env.GENIE_TEMPERATURE ?? file.temperature, DEFAULT_CONFIG.temperature),
    maxTokens: num(env.GENIE_MAX_TOKENS ?? file.maxTokens, DEFAULT_CONFIG.maxTokens),
    contextBudgetTokens: Math.max(
      1024,
      num(env.GENIE_CONTEXT_BUDGET ?? file.contextBudgetTokens, DEFAULT_CONFIG.contextBudgetTokens),
    ),
    reserveOutputTokens: num(
      env.GENIE_RESERVE_OUTPUT ?? file.reserveOutputTokens,
      DEFAULT_CONFIG.reserveOutputTokens,
    ),
    maxAgentSteps: Math.max(1, num(env.GENIE_MAX_STEPS ?? file.maxAgentSteps, DEFAULT_CONFIG.maxAgentSteps)),
    maxToolRepairs: Math.max(0, num(file.maxToolRepairs, DEFAULT_CONFIG.maxToolRepairs)),
    maxAttempts: Math.max(1, num(env.GENIE_MAX_ATTEMPTS ?? file.maxAttempts, DEFAULT_CONFIG.maxAttempts)),
    requestTimeoutMs: Math.max(
      1000,
      num(env.GENIE_REQUEST_TIMEOUT ?? file.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    ),
    autonomy,
    commandTimeoutMs: Math.max(
      1000,
      num(file.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs),
    ),
    allowCommands: bool(env.GENIE_ALLOW_COMMANDS ?? file.allowCommands, DEFAULT_CONFIG.allowCommands),
    ...options.overrides,
  };

  return config;
}
