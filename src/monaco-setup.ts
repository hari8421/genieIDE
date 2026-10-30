import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// A local-first IDE must not fetch the editor from a CDN.
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

monaco.editor.defineTheme('genie-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c4a7ff' },
    { token: 'string', foreground: '9ae6b4' },
    { token: 'number', foreground: 'f6c177' },
    { token: 'type', foreground: '7dd3fc' },
  ],
  colors: {
    'editor.background': '#0d1016',
    'editor.lineHighlightBackground': '#151a23',
    'editorLineNumber.foreground': '#3d4657',
    'editorCursor.foreground': '#7c9cff',
    'editor.selectionBackground': '#26314a',
    'editorIndentGuide.background1': '#1c2230',
  },
});
