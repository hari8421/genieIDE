import Editor from '@monaco-editor/react';
import type { OpenFile } from '../App';

interface EditorPaneProps {
  files: OpenFile[];
  activePath: string | null;
  dirtyPaths: string[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
}

export default function EditorPane({ files, activePath, dirtyPaths, onSelect, onClose, onChange, onSave }: EditorPaneProps) {
  const active = files.find((file) => file.path === activePath) ?? files[0] ?? null;

  return (
    <section className="editor-pane">
      <div className="tabs">
        {files.map((file) => (
          <div
            key={file.path}
            className={`tab${file.path === active?.path ? ' active' : ''}`}
            onClick={() => onSelect(file.path)}
            title={file.path}
          >
            <span className="tab-name">{file.path.split('/').pop()}</span>
            {dirtyPaths.includes(file.path) && <span className="dot" />}
            <button
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation();
                onClose(file.path);
              }}
              aria-label={`Close ${file.path}`}
            >
              ×
            </button>
          </div>
        ))}
        <div className="tabs-spacer" />
        {active && (
          <button className="btn ghost small" onClick={onSave} title="Save (Ctrl/Cmd+S)">
            Save
          </button>
        )}
      </div>

      <div className="editor-body">
        {active ? (
          <Editor
            key={active.path}
            path={active.path}
            language={active.language}
            theme="genie-dark"
            value={active.content}
            onChange={(value) => onChange(active.path, value ?? '')}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
              minimap: { enabled: true, scale: 0.7 },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: 'selection',
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 12 },
            }}
          />
        ) : (
          <div className="editor-empty">
            <h2>genie</h2>
            <p>A spec-driven agentic IDE running against your own LM Studio models.</p>
            <ul>
              <li>Open a file on the left, or create one.</li>
              <li>Describe a goal in the chat and let the agent work.</li>
              <li>Every write is checkpointed; every step is journaled and resumable.</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
