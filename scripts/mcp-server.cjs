#!/usr/bin/env node
/**
 * OceanBus Console — MCP Server
 *
 * Thin wrapper around agent-daemon.cjs subcommands.
 * Translates MCP tool calls into daemon invocations via child_process.
 *
 * Tools:
 *   ob_inbox   — read pending H5 messages
 *   ob_reply   — reply to H5 message via OB
 *   ob_status  — daemon status (online, window, peer, inbox count)
 *   ob_ack     — clear inbox
 */

const { spawnSync } = require('child_process');
const path = require('path');

const DAEMON = path.join(__dirname, 'agent-daemon.cjs');

function daemon(args) {
  const r = spawnSync(process.execPath, [DAEMON, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status };
}

// ── MCP JSON-RPC ────────────────────────────────────────────
const TOOLS = [
  {
    name: 'ob_inbox',
    description: '读取 OceanBus Console 中 H5 Board 发来的待处理消息。返回消息数组，每条含 sender、text、window、time。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ob_reply',
    description: '通过 OceanBus 回复 H5 Board 消息。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '回复文本内容' } },
      required: ['text'],
    },
  },
  {
    name: 'ob_status',
    description: '查看 OceanBus agent daemon 状态。返回在线状态、窗口名、peer 绑定、待处理消息数。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ob_ack',
    description: '清空 OceanBus Console 消息收件箱（标记所有消息已读）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }

    const { id, method, params } = req;

    if (method === 'initialize') {
      send(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'oceanbus-console', version: '0.2.0' },
      });
    } else if (method === 'notifications/initialized') {
      // no response
    } else if (method === 'tools/list') {
      send(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        let result;
        switch (name) {
          case 'ob_inbox': {
            const r = daemon(['inbox']);
            result = { content: [{ type: 'text', text: r.stdout || '[]' }] };
            break;
          }
          case 'ob_reply': {
            if (!args?.text) { sendError(id, -32602, 'Missing required parameter: text'); return; }
            const r = daemon(['reply', '--text', args.text]);
            result = { content: [{ type: 'text', text: r.stdout || '{"ok":true}' }] };
            break;
          }
          case 'ob_status': {
            const r = daemon(['status', '--json']);
            result = { content: [{ type: 'text', text: r.stdout || '{"online":false}' }] };
            break;
          }
          case 'ob_ack': {
            const r = daemon(['ack']);
            result = { content: [{ type: 'text', text: r.stdout || '{"ok":true}' }] };
            break;
          }
          default:
            sendError(id, -32601, `Unknown tool: ${name}`);
            return;
        }
        send(id, result);
      } catch (e) {
        sendError(id, -32603, e.message);
      }
    } else {
      sendError(id, -32601, `Unknown method: ${method}`);
    }
  }
});

process.stdin.resume();
