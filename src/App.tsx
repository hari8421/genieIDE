import { useCallback, useEffect, useRef, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import EditorPane from './components/EditorPane';
import FileTree from './components/FileTree';
import { CheckpointsTab, HooksTab, RunsTab, SpecsTab } from './components/Panels';
import { api, stream, type Autonomy, type FileNode, type Health, type RunSummary } from './lib/api';
import { applyEvent, emptySession, type SessionState } from './lib/session';

export interface OpenFile {
  path: string;
  content: string;
  saved: string;
  language: string;
}

type Tab = 'files' | 'specs' | 'hooks' | 'checkpoints' | 'runs';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'files', label: 'Files' },
  { key: 'specs', label: 'Specs' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'checkpoints', label: 'Undo' },
  { key: 'runs', label: 'Runs' },
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('files');
  const [session, setSession] = useState<SessionState>(emptySession);
  const [autonomy, setAutonomy] = useState<Autonomy>('autopilot');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newFile, setNewFile] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const autonomyTouched = useRef(false);

  const refreshHealth = useCallback(async () => {
    try {
      const next = await api.health();
      setHealth(next);
      if (!autonomyTouched.current) setAutonomy(next.config.autonomy);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const { tree: nodes } = await api.tree();
      setTree(nodes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const { runs: list } = await api.runs();
      setRuns(list);
    } catch {
      // run list is best-effort
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    void refreshTree();
    void refreshRuns();
    const timer = setInterval(() => void refreshHealth(), 15_000);
    return () => clearInterval(timer);
  }, [refreshHealth, refreshTree, refreshRuns]);

  useEffect(() => {
    if (session.streaming) return;
    void refreshRuns();
    void refreshTree();
  }, [session.streaming, refreshRuns, refreshTree]);

  const openFile = useCallback(
    async (path: string) => {
      setActivePath(path);
      if (openFiles.some((file) => file.path === path)) return;
      try {
        const file = await api.readFile(path);
        setOpenFiles((prev) =>
          prev.some((entry) => entry.path === file.path)
            ? prev
            : [...prev, { path: file.path, content: file.content, saved: file.content, language: file.language }],
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [openFiles],
  );

  const saveActive = useCallback(async () => {
    const active = openFiles.find((file) => file.path === activePath);
    if (!active || active.content === active.saved) return;
    try {
      await api.saveFile(active.path, active.content);
      setOpenFiles((prev) => prev.map((file) => (file.path === active.path ? { ...file, saved: file.content } : file)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activePath, openFiles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveActive]);

  const broadcast = useCallback((event: string, data: Record<string, unknown>) => {
    setSession((prev) => applyEvent(prev, event, data));
  }, []);

  const listen = useCallback(
    async (url: string, body: unknown, label: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSession({
        ...emptySession(),
        streaming: true,
        entries: [{ id: Date.now(), kind: 'user', text: label }],
      });
      setError(null);
      try {
        await stream(url, body, broadcast, controller.signal);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const message = (err as Error).message;
          setSession((prev) => ({ ...prev, streaming: false, error: message }));
          setError(message);
        }
      } finally {
        abortRef.current = null;
        await refreshTree();
        await refreshRuns();
      }
    },
    [broadcast, refreshRuns, refreshTree],
  );

  const contextFiles = useCallback(() => {
    if (selected.length) return selected;
    return activePath ? [activePath] : [];
  }, [activePath, selected]);

  const runGoal = useCallback(
    (goal: string) => {
      void listen('/api/run', { goal, files: contextFiles(), autonomy }, goal);
    },
    [autonomy, contextFiles, listen],
  );

  const resumeRun = useCallback(
    (runId: string) => {
      void listen(`/api/runs/${encodeURIComponent(runId)}/resume`, { files: contextFiles(), autonomy }, `Resume run ${runId}`);
    },
    [autonomy, contextFiles, listen],
  );

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
    if (session.runId) void api.cancelRun(session.runId).catch(() => undefined);
  }, [session.runId]);

  const runSpecTask = useCallback(
    (specId: string, taskId: string) => {
      void listen(`/api/specs/${encodeURIComponent(specId)}/tasks/${encodeURIComponent(taskId)}/run`, {}, `Implement task ${taskId} in ${specId}`);
    },
    [listen],
  );

  const runNextTask = useCallback(
    (specId: string) => {
      void listen(`/api/specs/${encodeURIComponent(specId)}/run-next`, {}, `Run the next task of ${specId}`);
    },
    [listen],
  );

  const createFile = useCallback(async () => {
    const name = newFile.trim();
    if (!name) return;
    try {
      const created = await api.createFile(name, 'file');
      setNewFile('');
      await refreshTree();
      await openFile(created.path);
      setTab('files');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [newFile, openFile, refreshTree]);

  const deleteActive = useCallback(async () => {
    if (!activePath) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${activePath}? This cannot be undone unless a checkpoint covers it.`)) return;
    try {
      await api.deleteFile(activePath);
      setOpenFiles((prev) => prev.filter((file) => file.path !== activePath));
      setActivePath(null);
      await refreshTree();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activePath, refreshTree]);

  const changeModel = useCallback(
    async (model: string) => {
      try {
        await api.updateConfig({ model });
        await refreshHealth();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshHealth],
  );

  const changeAutonomy = useCallback(
    (next: Autonomy) => {
      autonomyTouched.current = true;
      setAutonomy(next);
      void api.updateConfig({ autonomy: next }).catch(() => undefined);
    },
    [],
  );

  const dirtyPaths = openFiles.filter((file) => file.content !== file.saved).map((file) => file.path);
  const context = session.context;
  const models = health?.lmStudio.models ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> genie
          <span className="tag">local-first</span>
        </div>

        <div className="topbar-center">
          <span className={`status-dot ${health?.lmStudio.ok ? 'ok' : 'bad'}`} />
          <span className="muted small">
            {health ? (health.lmStudio.ok ? health.lmStudio.baseUrl : 'LM Studio offline') : 'connecting…'}
          </span>
          <select className="select" value={health?.config.model ?? ''} onChange={(event) => void changeModel(event.target.value)}>
            {(models.length ? models : [{ id: health?.config.model ?? 'local-model' }]).map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
                {model.contextLength ? ` · ${Math.round(model.contextLength / 1024)}k ctx` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="topbar-right">
          <span className="pill">{health?.config.allowCommands ? 'commands on' : 'commands off'}</span>
          <span className="pill accent">{autonomy}</span>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <nav className="tabs-nav">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                className={`tabs-nav-item${tab === entry.key ? ' active' : ''}`}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
                {entry.key === 'runs' && runs.length > 0 && <span className="count">{runs.length}</span>}
              </button>
            ))}
          </nav>

          {tab === 'files' && (
            <div className="panel-body">
              <div className="field">
                <input
                  className="input"
                  placeholder="src/new-file.ts"
                  value={newFile}
                  onChange={(event) => setNewFile(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && void createFile()}
                />
                <button className="btn ghost small" onClick={() => void createFile()}>
                  New
                </button>
              </div>
              <FileTree
                nodes={tree}
                activePath={activePath}
                selected={selected}
                onOpen={(path) => void openFile(path)}
                onToggleSelect={(path) =>
                  setSelected((prev) => (prev.includes(path) ? prev.filter((entry) => entry !== path) : [...prev, path]))
                }
              />
              <div className="panel-footer">
                <button className="btn ghost tiny" disabled={!activePath} onClick={() => void deleteActive()}>
                  Delete active file
                </button>
                <span className="muted tiny">{openFiles.length} open</span>
              </div>
            </div>
          )}

          {tab === 'specs' && <SpecsTab busy={session.streaming} onRunTask={runSpecTask} onRunNext={runNextTask} />}
          {tab === 'hooks' && <HooksTab running={session.streaming} />}
          {tab === 'checkpoints' && <CheckpointsTab onRestored={() => void refreshTree()} />}
          {tab === 'runs' && (
            <RunsTab
              runs={runs}
              onResume={resumeRun}
              onCancel={(id) => {
                void api.cancelRun(id).catch(() => undefined);
                void refreshRuns();
              }}
              onRefresh={() => void refreshRuns()}
            />
          )}
        </aside>

        <EditorPane
          files={openFiles}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          onSelect={setActivePath}
          onClose={(path) => {
            setOpenFiles((prev) => prev.filter((file) => file.path !== path));
            if (activePath === path) setActivePath(null);
          }}
          onChange={(path, content) =>
            setOpenFiles((prev) => prev.map((file) => (file.path === path ? { ...file, content } : file)))
          }
          onSave={() => void saveActive()}
        />

        <ChatPanel
          session={session}
          health={health}
          autonomy={autonomy}
          selectedFiles={contextFiles()}
          onAutonomyChange={changeAutonomy}
          onRun={runGoal}
          onCancel={cancelRun}
          onResume={() => session.runId && resumeRun(session.runId)}
          onRemoveFile={(path) => setSelected((prev) => prev.filter((entry) => entry !== path))}
        />
      </div>

      <footer className="statusbar">
        <span className={`status-dot ${health?.lmStudio.ok ? 'ok' : 'bad'}`} />
        <span>{health?.lmStudio.ok ? 'connected' : 'offline'}</span>
        <span className="divider" />
        <span>{health?.config.workspaceRoot ?? ''}</span>
        <span className="divider" />
        <span>
          context {context ? `${context.tokens}/${context.budget}` : health?.config.contextBudgetTokens ?? 0} tokens
          {context && context.dropped > 0 ? ` · ${context.dropped} section(s) dropped` : ''}
        </span>
        <span className="grow" />
        {session.streaming && <span className="running">agent running…</span>}
        <span>{health?.hooks ?? 0} hooks</span>
        <span>{health?.mcp.tools ?? 0} MCP tools</span>
      </footer>

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
