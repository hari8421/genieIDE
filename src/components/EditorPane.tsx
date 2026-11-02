import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useRef } from 'react';
import type { OpenFile } from '../App';
import { WORKSPACE_URI, breakpointDecorations } from '../editor/intel';

export interface Breakpoint {
  path: string;
  line: number;
}

interface EditorPaneProps {
  files: OpenFile[];
  activePath: string | null;
  dirtyPaths: string[];
  breakpoints: Breakpoint[];
  reveal: { path: string; line: number } | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
  onToggleBreakpoint: (path: string, line: number) => void;
}

type EditorLike = Parameters<OnMount>[0];
type MonacoLike = Parameters<OnMount>[1];

export default function EditorPane({
  files,
  activePath,
  dirtyPaths,
  breakpoints,
  reveal,
  onSelect,
  onClose,
  onChange,
  onSave,
  onToggleBreakpoint,
}: EditorPaneProps) {
  const active = files.find((file) => file.path === activePath) ?? files[0] ?? null;

  const editorRef = useRef<EditorLike | null>(null);
  const monacoRef = useRef<MonacoLike | null>(null);
  const collectionRef = useRef<ReturnType<EditorLike['createDecorationsCollection']> | null>(null);
  const activePathRef = useRef<string | null>(active?.path ?? null);
  const toggleRef = useRef(onToggleBreakpoint);
  const breakpointsRef = useRef(breakpoints);

  activePathRef.current = active?.path ?? null;
  toggleRef.current = onToggleBreakpoint;
  breakpointsRef.current = breakpoints;

  const paintBreakpoints = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const path = activePathRef.current;
    if (!editor || !monaco || !path) return;
    if (!collectionRef.current) {
      collectionRef.current = editor.createDecorationsCollection([]);
    }
    collectionRef.current.set(breakpointDecorations(breakpointsRef.current, path));
  }, []);

  useEffect(() => {
    paintBreakpoints();
  }, [breakpoints, active?.path, paintBreakpoints]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.path !== active?.path) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: 1 });
    editor.focus();
  }, [reveal, active?.path]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    collectionRef.current = null;
    paintBreakpoints();

    // Breakpoints live in the glyph margin, like IntelliJ's gutter.
    editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const path = activePathRef.current;
      if (line && path) toggleRef.current(path, line);
    });

    editor.addAction({
      id: 'genie.toggleBreakpoint',
      label: 'Toggle Breakpoint',
      keybindings: [monaco.KeyCode.F9],
      run: (instance) => {
        const line = instance.getPosition()?.lineNumber;
        const path = activePathRef.current;
        if (line && path) toggleRef.current(path, line);
      },
    });
  };

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
            path={`${WORKSPACE_URI}/${active.path}`}
            language={active.language}
            theme="genie-dark"
            value={active.content}
            onChange={(value) => onChange(active.path, value ?? '')}
            onMount={onMount}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
              minimap: { enabled: true, scale: 0.7 },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: 'selection',
              automaticLayout: true,
              tabSize: 2,
              glyphMargin: true,
              padding: { top: 12 },
              quickSuggestions: { other: true, comments: false, strings: false },
              suggestOnTriggerCharacters: true,
              peekWidgetDefaultFocus: 'tree',
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
              <li>F12 / Alt+F12 / Shift+F12 peek definitions and usages; F9 sets a breakpoint.</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
