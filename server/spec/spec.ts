import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../util/paths';

export interface SpecTask {
  id: string;
  title: string;
  checked: boolean;
  depth: number;
  line: number;
}

export interface SpecProgress {
  done: number;
  total: number;
}

export interface SpecSummary {
  id: string;
  title: string;
  dir: string;
  hasRequirements: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  progress: SpecProgress;
  updatedAt: string;
}

export type SpecArtifact = 'requirements' | 'design' | 'tasks';

export const SPEC_ARTIFACTS: SpecArtifact[] = ['requirements', 'design', 'tasks'];

const TASK_LINE = /^(\s*)[-*]\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)*)([.)]?)\s+)?(.*)$/;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'spec'
  );
}

export function parseTasks(markdown: string): SpecTask[] {
  const tasks: SpecTask[] = [];
  const lines = (markdown ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(TASK_LINE);
    if (!match) continue;
    const indent = match[1] ?? '';
    const title = (match[5] ?? '').trim();
    if (!title) continue;
    tasks.push({
      id: match[3] ?? `${tasks.length + 1}`,
      title,
      checked: (match[2] ?? '').toLowerCase() === 'x',
      depth: Math.floor(indent.replace(/\t/g, '  ').length / 2),
      line: index,
    });
  }
  return tasks;
}

export function taskProgress(tasks: SpecTask[]): SpecProgress {
  return { done: tasks.filter((t) => t.checked).length, total: tasks.length };
}

/** Toggle one task's checkbox, preserving every other byte of the document. */
export function setTaskChecked(markdown: string, taskId: string, checked: boolean): string {
  const lines = (markdown ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(TASK_LINE);
    if (!match) continue;
    if (match[3] !== taskId) continue;
    // Rewrite only the checkbox so numbering, punctuation and spacing stay
    // byte-identical to what the author (or the model) wrote.
    const checkbox = line.indexOf('[', match.index ?? 0);
    if (checkbox < 0) continue;
    lines[index] = `${line.slice(0, checkbox)}${checked ? '[x]' : '[ ]'}${line.slice(checkbox + 3)}`;
    return lines.join('\n');
  }
  throw new Error(`Task "${taskId}" was not found in tasks.md`);
}

export function firstUncheckedTask(tasks: SpecTask[]): SpecTask | undefined {
  return tasks.find((task) => !task.checked);
}

export function extractTitle(markdown: string, fallback: string): string {
  const match = (markdown ?? '').match(/^\s*#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

/** Spec storage: `.genie/specs/<id>/{requirements,design,tasks}.md`. */
export class SpecStore {
  constructor(private readonly specsDir: string) {}

  private specDir(id: string): string {
    return path.join(this.specsDir, id);
  }

  async list(): Promise<SpecSummary[]> {
    let ids: string[] = [];
    try {
      const entries = await fs.readdir(this.specsDir, { withFileTypes: true });
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const summaries: SpecSummary[] = [];
    for (const id of ids) {
      try {
        const dir = this.specDir(id);
        const read = async (name: string): Promise<string | null> => {
          try {
            return await fs.readFile(path.join(dir, `${name}.md`), 'utf8');
          } catch {
            return null;
          }
        };
        const requirements = await read('requirements');
        const design = await read('design');
        const tasks = await read('tasks');
        const parsed = tasks ? parseTasks(tasks) : [];
        const stat = await fs.stat(dir);
        summaries.push({
          id,
          title: extractTitle(requirements ?? design ?? '', id),
          dir,
          hasRequirements: requirements !== null,
          hasDesign: design !== null,
          hasTasks: tasks !== null,
          progress: taskProgress(parsed),
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        // ignore unreadable spec dirs
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(name: string): Promise<SpecSummary> {
    const id = slugify(name);
    const dir = this.specDir(id);
    await ensureDir(dir);
    const tasksPath = path.join(dir, 'tasks.md');
    try {
      await fs.access(tasksPath);
    } catch {
      await fs.writeFile(tasksPath, `# ${name} — Tasks\n\n- [ ] 1. Write requirements and design\n`, 'utf8');
    }
    const all = await this.list();
    const found = all.find((s) => s.id === id);
    if (!found) throw new Error(`Failed to create spec ${id}`);
    return found;
  }

  async read(id: string): Promise<{
    id: string;
    requirements: string | null;
    design: string | null;
    tasks: string | null;
    tasksParsed: SpecTask[];
  }> {
    const dir = this.specDir(id);
    const read = async (name: SpecArtifact): Promise<string | null> => {
      try {
        return await fs.readFile(path.join(dir, `${name}.md`), 'utf8');
      } catch {
        return null;
      }
    };
    const tasks = await read('tasks');
    return {
      id,
      requirements: await read('requirements'),
      design: await read('design'),
      tasks,
      tasksParsed: tasks ? parseTasks(tasks) : [],
    };
  }

  async write(id: string, artifact: SpecArtifact, content: string): Promise<void> {
    const dir = this.specDir(id);
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, `${artifact}.md`), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  async updateTaskStatus(id: string, taskId: string, checked: boolean): Promise<SpecTask[]> {
    const tasksPath = path.join(this.specDir(id), 'tasks.md');
    const markdown = await fs.readFile(tasksPath, 'utf8');
    const updated = setTaskChecked(markdown, taskId, checked);
    await fs.writeFile(tasksPath, updated, 'utf8');
    return parseTasks(updated);
  }
}
