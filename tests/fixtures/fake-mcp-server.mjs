#!/usr/bin/env node
// Minimal MCP server over stdio, used by tests/mcp.test.ts.
let buffer = '';

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
};

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fake', version: '1.0.0' },
          capabilities: { tools: {} },
        });
        break;
      case 'tools/list':
        reply(message.id, {
          tools: [
            {
              name: 'echo',
              description: 'Echo text back',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        });
        break;
      case 'tools/call':
        reply(message.id, {
          content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }],
        });
        break;
      default:
        if (typeof message.id === 'number') reply(message.id, {});
    }
  }
});

process.stdin.on('end', () => process.exit(0));
