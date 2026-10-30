import { spawn } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parsePatch } from '../agent/patch';
import type { ToolSpec } from '../llm/client';
import { matchesAnyGlob } from '../util/glob';
import { ensureDir, isIgnoredPath, resolveInWorkspace, toRelative } from '../util/paths';

export interface ToolContext {
  workspaceRoot: string;
  allowCommands: boolean;
  commandTimeoutMs: number;
  signal?: AbortSignal;
  /** Called before any mutation so the agent can snapshot for checkpoints. */
  beforeWrite?: (label: string, paths: string[]) => Promise<void>;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_READ_CHARS = 120_000;
const MAX_WRITE_CHARS = 2_000_000;
const MAX_OUTPUT_CHARS = 24_000;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`Missing required string argument "${key}"`);
  return value;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clip(text: string, max = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[output truncated, ${text.length - max} chars omitted]`, truncated: true };
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Always read a file before patching it. Use start_line/end_line for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path, e.g. src/app.ts' },
      start_line: { type: 'number', description: '1-based first line to return' },
      end_line: { type: 'number', description: '1-based last line to return' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const requested = reqStr(args, 'path');
    const absolute = resolveInWorkspace(ctx.workspaceRoot, requested);
    let raw: string;
    try {
      raw = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      return { ok: false, content: `Could not read ${requested}: ${(error as Error).message}` };
    }
    const allLines = raw.split('\n');
    const start = Math.max(1, numArg(args, 'start_line') ?? 1);
    const end = Math.min(allLines.length, numArg(args, 'end_line') ?? allLines.length);
    if (start > end) return { ok: false, content: `Invalid range: start_line ${start} > end_line ${end}` };
    const body = allLines.slice(start - 1, end).join('\n');
    const numbered = body
      .split('\n')
      .map((line, index) => `${String(start + index).padStart(5, ' ')}| ${line}`)
      .join('\n');
    const clipped = clip(numbered, MAX_READ_CHARS);
    return {
      ok: true,
      content: `# ${toRelative(ctx.workspaceRoot, absolute)} (${allLines.length} lines)\n${clipped.text}`,
    };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or fully overwrite a file. Prefer apply_patch for edits to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const requested = reqStr(args, 'path');
    const content = str(args, 'content') ?? '';
    if (content.length > MAX_WRITE_CHARS) {
      return { ok: false, content: `Refusing to write ${content.length} chars (limit ${MAX_WRITE_CHARS}). Write in smaller pieces.` };
    }
    const absolute = resolveInWorkspace(ctx.workspaceRoot, requested);
    let existed = false;
    try {
      await fs.stat(absolute);
      existed = true;
    } catch {
      existed = false;
    }
    await ctx.beforeWrite?.(`Before writing ${requested}`, [projectRel(ctx.workspaceRoot, absolute)]);
    await ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, content, 'utf8');
    ctx.onEvent?.({ type: 'file.written', path: projectRel(ctx.workspaceRoot, absolute) });
    return {
      ok: true,
      content: `${existed ? 'Overwrote' : 'Created'} ${requested} (${content.split('\n').length} lines, ${content.length} bytes).`,
    };
  },
};

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Edit an existing file with one or more SEARCH/REPLACE blocks. The SEARCH text must match the file exactly. All blocks apply atomically or nothing is written.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      patch: {
        type: 'string',
        description:
          'Blocks formatted as: <<<<<<< SEARCH\\nold\\n=======\\nnew\\n>>>>>>> REPLACE (repeat for multiple edits)',
      },
    },
    required: ['path', 'patch'],
  },
  async run(args, ctx) {
    const requested = reqStr(args, 'path');
    const patchText = reqStr(args, 'patch');
    const absolute = resolveInWorkspace(ctx.workspaceRoot, requested);
    let original: string;
    try {
      original = await fs.readFile(absolute, 'utf8');
    } catch {
      return { ok: false, content: `${requested} does not exist. Use write_file to create it.` };
    }
    let blocks;
    try {
      blocks = parsePatch(patchText);
    } catch (error) {
      return { ok: false, content: `Patch rejected: ${(error as Error).message}` };
    }
    let result;
    try {
      result = applyPatch(original, blocks);
    } catch (error) {
      return { ok: false, content: `Patch failed: ${(error as Error).message}` };
    }
    if (result.content === original) {
      return { ok: true, content: `No change: ${requested} already contains the replacement text.` };
    }
    await ctx.beforeWrite?.(`Before patching ${requested}`, [projectRel(ctx.workspaceRoot, absolute)]);
    await fs.writeFile(absolute, result.content, 'utf8');
    ctx.onEvent?.({ type: 'file.written', path: projectRel(ctx.workspaceRoot, absolute) });
    return {
      ok: true,
      content: `Patched ${requested}: ${result.applied} block(s) applied${result.fuzzy ? `, ${result.fuzzy} matched with whitespace tolerance` : ''}.`,
    };
  },
};

export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List workspace files as a tree. Ignored directories (node_modules, .git, dist, .genie) are skipped.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root (default: root)' },
      depth: { type: 'number', description: 'Recursion depth, default 2, max 5' },
    },
  },
  async run(args, ctx) {
    const requested = str(args, 'path') ?? '.';
    const maxDepth = Math.min(5, Math.max(0, numArg(args, 'depth') ?? 2));
    const absolute = resolveInWorkspace(ctx.workspaceRoot, requested);
    const lines: string[] = [];
    let count = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || count > 500) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const sorted = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (count > 500) return;
        const child = path.join(dir, entry.name);
        const rel = projectRel(ctx.workspaceRoot, child);
        if (isIgnoredPath(rel)) continue;
        const indent = '  '.repeat(depth);
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`);
          await walk(child, depth + 1);
        } else {
          lines.push(`${indent}${entry.name}`);
          count += 1;
        }
      }
    };
    await walk(absolute, 0);
    if (!lines.length) return { ok: true, content: `No files under ${requested}` };
    return { ok: true, content: clip(lines.join('\n')).text };
  },
};

export const searchTool: Tool = {
  name: 'search',
  description: 'Search file contents with a regular expression or plain text. Returns path:line matches.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regex or plain text to find' },
      glob: { type: 'string', description: 'Optional path filter, e.g. src/**/*.ts' },
      limit: { type: 'number', description: 'Max matches, default 60' },
      regex: { type: 'boolean', description: 'Interpret query as a regular expression (default true)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = reqStr(args, 'query');
    const glob = str(args, 'glob');
    const limit = Math.min(400, Math.max(1, numArg(args, 'limit') ?? 60));
    const useRegex = args.regex !== false;

    let matcher: (line: string) => boolean;
    if (useRegex) {
      let regex: RegExp;
      try {
        regex = new RegExp(query, 'i');
      } catch (error) {
        return { ok: false, content: `Invalid regex: ${(error as Error).message}` };
      }
      matcher = (line) => regex.test(line);
    } else {
      const needle = query.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(needle);
    }

    const hits: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || hits.length >= limit || ctx.signal?.aborted) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= limit || ctx.signal?.aborted) return;
        const child = path.join(dir, entry.name);
        const rel = projectRel(ctx.workspaceRoot, child);
        if (isIgnoredPath(rel)) continue;
        if (entry.isDirectory()) {
          await walk(child, depth + 1);
          continue;
        }
        if (glob && !matchesAnyGlob(rel, [glob])) continue;
        let stat: Stats;
        try {
          stat = await fs.stat(child);
        } catch {
          continue;
        }
        if (stat.size > 500_000) continue;
        let content: string;
        try {
          content = await fs.readFile(child, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
          if (matcher(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`);
        }
      }
    };
    await walk(ctx.workspaceRoot, 0);

    if (!hits.length) return { ok: true, content: `No matches for ${JSON.stringify(query)}.` };
    return { ok: true, content: clip(hits.join('\n')).text };
  },
};

const DENIED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME)/i, reason: 'recursive delete of a root/home path' },
  { pattern: /\bmkfs(\.|\s)/i, reason: 'filesystem formatting' },
  { pattern: /\bdd\s+if=.*of=\/dev\//i, reason: 'raw device write' },
  { pattern: /\bsudo\b|\bsu\s+-/i, reason: 'privilege escalation' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'host shutdown' },
  { pattern: /:\(\)\s*\{.*\};:/, reason: 'fork bomb' },
  { pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i, reason: 'destructive or remote git operation (run it yourself)' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/i, reason: 'piping a download into a shell' },
];

export function checkCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  for (const { pattern, reason } of DENIED_COMMAND_PATTERNS) {
    if (pattern.test(command)) return { allowed: false, reason };
  }
  return { allowed: true };
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const collect = (target: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString();
      if (target === 'out' && stdout.length < 200_000) stdout += text;
      if (target === 'err' && stderr.length < 200_000) stderr += text;
    };
    child.stdout?.on('data', (chunk: Buffer) => collect('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('err', chunk));

    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => {
      if (!killed) finish(code);
      else finish(timedOut ? code : null);
    });
  });
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace and return its output. Use for builds, tests and formatters. Destructive commands are blocked.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    if (!ctx.allowCommands) {
      return { ok: false, content: 'Command execution is disabled. Set "allowCommands": true in .genie/config.json to enable it.' };
    }
    const command = reqStr(args, 'command');
    const verdict = checkCommandAllowed(command);
    if (!verdict.allowed) {
      return { ok: false, content: `Command blocked (${verdict.reason}). Ask the user to run it manually.` };
    }
    let cwd = ctx.workspaceRoot;
    if (str(args, 'cwd')) {
      try {
        cwd = resolveInWorkspace(ctx.workspaceRoot, str(args, 'cwd')!);
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
    }
    const result = await executeCommand(command, cwd, ctx.commandTimeoutMs, ctx.signal);
    const out = clip(result.stdout.trim());
    const err = clip(result.stderr.trim());
    const header = result.timedOut
      ? `Timed out after ${Math.round(ctx.commandTimeoutMs / 1000)}s (process killed).`
      : `Exit code: ${result.code ?? 'unknown'}`;
    const body = [`$ ${command}`, header, out.text, err.text ? `stderr:\n${err.text}` : '']
      .filter(Boolean)
      .join('\n');
    return { ok: result.code === 0 && !result.timedOut, content: body };
  },
};

function projectRel(root: string, absolute: string): string {
  const rel = toRelative(root, absolute);
  return rel || '.';
}

export function createDefaultTools(): Tool[] {
  return [readFileTool, listFilesTool, searchTool, applyPatchTool, writeFileTool, runCommandTool];
}

export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
