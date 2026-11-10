import * as monaco from 'monaco-editor';
import { api } from '../lib/api';

/**
 * Loads the workspace into Monaco's TypeScript language service.
 *
 * Monaco ships a full TS language service inside its worker, which is what
 * powers IntelliJ-style navigation: F12 go to definition, Alt+F12 peek
 * definition, Shift+F12 find usages (peek), Ctrl+F12 implementations, hover
 * quick info, the file outline and inline diagnostics. The worker only knows
 * the programs it is given, so every workspace source is registered as an extra
 * lib under a `file:///workspace/...` URI; open editor models use the same URI
 * and therefore take precedence over the lib.
 */

export const WORKSPACE_URI = 'file:///workspace';

const extraLibs = new Map<string, monaco.IDisposable>();
const sources = new Map<string, string>();
let wired = false;

const fileUri = (path: string): string => `${WORKSPACE_URI}/${path.replace(/^\/+/, '')}`;

function compilerOptions(): monaco.languages.typescript.CompilerOptions {
  const ts = monaco.languages.typescript;
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.React,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
    allowNonTsExtensions: true,
  };
}

function addLib(uri: string, content: string): void {
  extraLibs.get(uri)?.dispose();
  extraLibs.set(uri, monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri));
}

/** Keep libs and models from duplicating each other as files open and close. */
function syncModels(): void {
  if (wired) return;
  wired = true;
  monaco.editor.onDidCreateModel((model) => {
    const uri = model.uri.toString();
    if (!sources.has(uri)) return;
    extraLibs.get(uri)?.dispose();
    extraLibs.delete(uri);
  });
  monaco.editor.onWillDisposeModel((model) => {
    const uri = model.uri.toString();
    const content = sources.get(uri);
    if (content !== undefined) addLib(uri, content);
  });
}

export interface IntelLoadResult {
  files: number;
  truncated: boolean;
}

export async function loadWorkspaceIntel(): Promise<IntelLoadResult> {
  const bundle = await api.sources();
  const ts = monaco.languages.typescript;
  const options = compilerOptions();
  ts.typescriptDefaults.setCompilerOptions(options);
  ts.javascriptDefaults.setCompilerOptions(options);
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, onlyVisible: false });
  ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, onlyVisible: false });

  syncModels();

  for (const file of bundle.files) {
    const uri = fileUri(file.path);
    sources.set(uri, file.content);
    if (!monaco.editor.getModel(monaco.Uri.parse(uri))) addLib(uri, file.content);
  }

  return { files: bundle.files.length, truncated: bundle.truncated };
}

/** Register a freshly saved file so navigation sees it without a reload. */
export function updateIntelSource(path: string, content: string): void {
  const uri = fileUri(path);
  sources.set(uri, content);
  if (!monaco.editor.getModel(monaco.Uri.parse(uri))) addLib(uri, content);
}

/**
 * Breakpoint helpers: the gutter carries the decorations, the server owns the
 * breakpoint list (the inspector is told about them when the session starts).
 */
export function breakpointDecorations(
  breakpoints: Array<{ path: string; line: number }>,
  path: string,
): monaco.editor.IModelDeltaDecoration[] {
  return breakpoints
    .filter((breakpoint) => breakpoint.path === path)
    .map((breakpoint) => ({
      range: new monaco.Range(breakpoint.line, 1, breakpoint.line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: 'anneal-breakpoint',
        glyphMarginHoverMessage: { value: `Breakpoint at line ${breakpoint.line}` },
      },
    }));
}
