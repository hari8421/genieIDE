import { useState } from 'react';
import type { FileNode } from '../lib/api';

interface FileTreeProps {
  nodes: FileNode[];
  activePath: string | null;
  selected: string[];
  onOpen: (path: string) => void;
  onToggleSelect: (path: string) => void;
}

interface NodeProps extends FileTreeProps {
  depth: number;
}

function TreeNode({ node, depth, activePath, selected, onOpen, onToggleSelect }: NodeProps & { node: FileNode }) {
  const [open, setOpen] = useState(depth === 0);
  const isDir = node.type === 'dir';
  const isActive = activePath === node.path;
  const isSelected = selected.includes(node.path);

  return (
    <div>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (isDir ? setOpen((value) => !value) : onOpen(node.path))}
        title={node.path}
      >
        {isDir ? (
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
        ) : (
          <label
            className="tree-check"
            onClick={(event) => {
              event.stopPropagation();
              onToggleSelect(node.path);
            }}
            title="Include this file in agent context"
          >
            <span className={`checkbox${isSelected ? ' checked' : ''}`} />
          </label>
        )}
        <span className={`tree-name${isDir ? ' dir' : ''}`}>{node.name}</span>
      </div>
      {isDir && open && node.children?.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          nodes={[]}
          activePath={activePath}
          selected={selected}
          onOpen={onOpen}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

export default function FileTree({ nodes, activePath, selected, onOpen, onToggleSelect }: FileTreeProps) {
  if (!nodes.length) return <div className="empty">No files yet. Create one below.</div>;
  return (
    <div className="tree">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          nodes={[]}
          activePath={activePath}
          selected={selected}
          onOpen={onOpen}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}
