import crypto from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, isIgnoredPath } from '../util/paths';

export interface CheckpointFile {
  path: string;
  hash: string;
  size: number;
}

export interface CheckpointManifest {
  id: string;
  label: string;
  createdAt: string;
  runId?: string;
  step?: number;
  files: CheckpointFile[];
}

export interface CheckpointDiffEntry {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  beforeBytes?: number;
  afterBytes?: number;
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  unchanged: number;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 40_000_000;

function hashContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function newCheckpointId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Snapshot/restore of workspace files, stored under .genie/checkpoints.
 *
 * Deliberately not git-based: checkpoints must work in a workspace that is not a
 * repository, must never touch the user's index or stash, and must be cheap to
 * create before every mutating tool call.
 */
export class CheckpointStore {
  readonly dir: string;

  constructor(private readonly workspaceRoot: string, checkpointsDir?: string) {
    this.dir = checkpointsDir ?? path.join(workspaceRoot, '.genie', 'checkpoints');
  }

  private async collectFiles(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 10) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(this.workspaceRoot, absolute).split(path.sep).join('/');
        if (isIgnoredPath(relative)) continue;
        if (entry.isDirectory()) await walk(absolute, depth + 1);
        else if (entry.isFile()) files.push(relative);
      }
    };
    await walk(this.workspaceRoot, 0);
    return files.sort();
  }

  async create(
    label: string,
    options: { runId?: string; step?: number; signal?: AbortSignal } = {},
  ): Promise<CheckpointManifest> {
    const id = newCheckpointId();
    const snapshotDir = path.join(this.dir, id, 'files');
    await ensureDir(snapshotDir);

    const files: CheckpointFile[] = [];
    let total = 0;
    for (const relative of await this.collectFiles()) {
      if (options.signal?.aborted) throw new Error('Checkpoint creation cancelled');
      const absolute = path.join(this.workspaceRoot, relative);
      let stat: Stats;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) continue;
      const target = path.join(snapshotDir, relative);
      await ensureDir(path.dirname(target));
      await fs.copyFile(absolute, target);
      files.push({ path: relative, hash: hashContent(await fs.readFile(absolute)), size: stat.size });
      total += stat.size;
    }

    const manifest: CheckpointManifest = {
      id,
      label,
      createdAt: new Date().toISOString(),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}),
      files,
    };
    await fs.writeFile(path.join(this.dir, id, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  async list(): Promise<CheckpointManifest[]> {
    let ids: string[] = [];
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const manifests: CheckpointManifest[] = [];
    for (const id of ids) {
      try {
        const raw = await fs.readFile(path.join(this.dir, id, 'manifest.json'), 'utf8');
        manifests.push(JSON.parse(raw) as CheckpointManifest);
      } catch {
        // ignore incomplete checkpoints
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async latest(): Promise<CheckpointManifest | undefined> {
    return (await this.list())[0];
  }

  private async loadManifest(id: string): Promise<CheckpointManifest> {
    const raw = await fs.readFile(path.join(this.dir, id, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as CheckpointManifest;
  }

  async diff(id: string): Promise<CheckpointDiffEntry[]> {
    const manifest = await this.loadManifest(id);
    const snapshot = new Map(manifest.files.map((f) => [f.path, f]));
    const currentPaths = await this.collectFiles();
    const out: CheckpointDiffEntry[] = [];

    for (const file of manifest.files) {
      const absolute = path.join(this.workspaceRoot, file.path);
      try {
        const now = await fs.readFile(absolute);
        const hash = hashContent(now);
        if (hash !== file.hash) {
          out.push({ path: file.path, change: 'modified', beforeBytes: file.size, afterBytes: now.length });
        }
      } catch {
        out.push({ path: file.path, change: 'deleted', beforeBytes: file.size });
      }
    }
    for (const relative of currentPaths) {
      if (!snapshot.has(relative)) {
        try {
          const stat = await fs.stat(path.join(this.workspaceRoot, relative));
          out.push({ path: relative, change: 'added', afterBytes: stat.size });
        } catch {
          // vanished between listing and stat
        }
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Restore workspace content to the snapshot; files added since are removed. */
  async restore(id: string): Promise<RestoreResult> {
    const manifest = await this.loadManifest(id);
    const snapshotDir = path.join(this.dir, id, 'files');
    const snapshot = new Map(manifest.files.map((f) => [f.path, f]));
    const restored: string[] = [];
    const deleted: string[] = [];
    let unchanged = 0;

    for (const file of manifest.files) {
      const absolute = path.join(this.workspaceRoot, file.path);
      const copy = path.join(snapshotDir, file.path);
      let same = false;
      try {
        same = hashContent(await fs.readFile(absolute)) === file.hash;
      } catch {
        same = false;
      }
      if (same) {
        unchanged += 1;
        continue;
      }
      await ensureDir(path.dirname(absolute));
      await fs.copyFile(copy, absolute);
      restored.push(file.path);
    }

    for (const relative of await this.collectFiles()) {
      if (snapshot.has(relative)) continue;
      await fs.rm(path.join(this.workspaceRoot, relative), { force: true });
      deleted.push(relative);
    }

    return { restored, deleted, unchanged };
  }

  async readSnapshotFile(id: string, relative: string): Promise<string> {
    return fs.readFile(path.join(this.dir, id, 'files', relative), 'utf8');
  }

  async prune(keep = 30): Promise<string[]> {
    const manifests = await this.list();
    const victims = manifests.slice(keep);
    for (const manifest of victims) {
      await fs.rm(path.join(this.dir, manifest.id), { recursive: true, force: true });
    }
    return victims.map((v) => v.id);
  }
}
