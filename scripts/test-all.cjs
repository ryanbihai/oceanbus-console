#!/usr/bin/env node
/**
 * OceanBus Console — Full Regression Test Suite
 *
 * Usage:
 *   cd oceanbus-console
 *   node scripts/test-all.cjs
 *
 * Tests every action/command. Daemon startup is verified via artifact checks.
 * MCP, reply-ob, subcommands tested via direct invocation.
 *
 * Sections:
 *   A. Cloud (5 tests)  — startup, /api/identity, /api/my-address, /api/peers, /api/windows
 *   B. Subcommands (9)  — status, inbox, inbox --clear, ack, reply, stop, artifact checks
 *   C. Message Flow (5) — H5→Cloud→Agent, inbox verify, ack verify, reply verify
 *   D. MCP Server (6)   — ob_status, ob_inbox, ob_reply, ob_ack, tools/list, error handling
 *   E. reply-ob.cjs (1) — standalone reply script
 *   F. Persistence (1)  — sessions.json
 *   G. Stop+Cleanup (2) — daemon stop, lock cleanup
 *
 * Prerequisites: npm install oceanbus (SDK must be available)
 */

const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPTS = __dirname;
const ROOT = path.join(SCRIPTS, '..');
const CLOUD = path.join(ROOT, 'cloud', 'server.js');
const DAEMON = path.join(SCRIPTS, 'agent-daemon.cjs');
const MCP = path.join(SCRIPTS, 'mcp-server.cjs');
const REPLY = path.join(SCRIPTS, 'reply-ob.cjs');

const PEER_FILE = path.join(process.cwd(), '.ob-console-peer.json');
const GATEWAY_URL = 'http://127.0.0.1:3456';
const H5_ID = 'test-suite-' + Date.now();
const WIN = 'test-suite-daemon';

let passed = 0, failed = 0;
const failures = [];

function ok(name)  { passed++; console.log(`  ✅ ${name}`); }
function fail(n,d) { failed++; failures.push({ name:n, detail:d }); console.log(`  ❌ ${n}: ${d}`); }
function log(msg)  { console.log(`\n${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let boardOpenId = '';

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  return res.json();
}

// ── Subcommand runner ─────────────────────────────────────
function cmd(args) {
  const r = spawnSync(process.execPath, [DAEMON, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 20_000 });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

// ── MCP runner ────────────────────────────────────────────
function mcp(jsonRpc) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stdout.on('end', () => {
      resolve(out.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    });
    child.stdin.write(JSON.stringify(jsonRpc) + '\n');
    child.stdin.end();
  });
}

// ── Daemon startup (verified via artifacts, not stdout) ──
function startDaemon() {
  // Start daemon as background child - on Windows this may not work,
  // so we also try the require-based approach as fallback
  const daemonProc = spawn(process.execPath, [
    DAEMON, '--gateway-url', GATEWAY_URL, '--name', WIN,
  ], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-suite' },
    stdio: 'ignore',
    detached: true,
  });
  daemonProc.unref();
  return daemonProc;
}

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  OceanBus Console — Regression Test Suite    ║');
  console.log('╚══════════════════════════════════════════════╝');

  // ── Setup ──────────────────────────────────────────
  log('── Setup ──');
  const windowsDir = path.join(os.homedir(), '.oceanbus', 'windows');
  const oceanbusDir = path.join(os.homedir(), '.oceanbus');
  if (fs.existsSync(windowsDir)) fs.rmSync(windowsDir, { recursive: true, force: true });
  if (fs.existsSync(oceanbusDir)) {
    fs.readdirSync(oceanbusDir).filter(f => f.startsWith('agent-') && f.endsWith('.lock'))
      .forEach(f => fs.unlinkSync(path.join(oceanbusDir, f)));
  }
  if (fs.existsSync(PEER_FILE)) fs.unlinkSync(PEER_FILE);
  console.log('  Cleaned');

  // ═══════════════════════════════════════════════════
  //  SECTION A: Cloud
  // ═══════════════════════════════════════════════════
  log('═══ A: Cloud ═══');

  // A1: Start Cloud
  const cloudChild = spawn(process.execPath, [CLOUD], { cwd: ROOT, detached: true, stdio: 'ignore' });
  cloudChild.unref();
  await sleep(12_000);
  let ready = false;
  for (let i = 0; i < 5; i++) {
    try { const s = await fetchJSON(`${GATEWAY_URL}/api/status`); if (s.ok) { ready = true; break; } } catch {}
    await sleep(2000);
  }
  ready ? ok('Cloud started') : fail('Cloud', 'not reachable');

  // A2: Identity endpoints
  const identity = await fetchJSON(`${GATEWAY_URL}/api/identity`);
  identity.openid ? ok('GET /api/identity') : fail('/api/identity', 'no openid');

  boardOpenId = (await fetchJSON(`${GATEWAY_URL}/api/my-address?h5_openid=${H5_ID}`)).openid;
  boardOpenId ? ok('GET /api/my-address') : fail('/api/my-address', 'no openid');
  console.log(`  Board: ${boardOpenId.slice(0, 12)}...`);

  // A3: Save peer, verify peers/windows endpoints
  fs.writeFileSync(PEER_FILE, JSON.stringify({ peer: boardOpenId, savedAt: new Date().toISOString() }));
  const peers = await fetchJSON(`${GATEWAY_URL}/api/peers?h5_openid=${H5_ID}`);
  Array.isArray(peers) ? ok('GET /api/peers') : fail('/api/peers', String(peers));
  const windows = await fetchJSON(`${GATEWAY_URL}/api/windows?h5_openid=${H5_ID}`);
  Array.isArray(windows) ? ok('GET /api/windows') : fail('/api/windows', String(windows));

  // ═══════════════════════════════════════════════════
  //  SECTION B: Daemon Startup
  // ═══════════════════════════════════════════════════
  log('═══ B: Daemon Startup ═══');

  startDaemon();
  // Poll for daemon to come online (check artifacts)
  let daemonOnline = false;
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    // Check if lock file exists and PID is alive
    const lockPath = path.join(oceanbusDir, `agent-${WIN}.lock`);
    if (fs.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        try { process.kill(lock.pid, 0); daemonOnline = true; break; } catch {}
      } catch {}
    }
  }
  daemonOnline ? ok('Daemon online') : fail('Daemon online', 'not started after 30s');

  // B1: Artifacts
  const credsPath = path.join(windowsDir, WIN, 'credentials.json');
  fs.existsSync(credsPath) ? ok('credentials.json') : fail('credentials.json', 'not found');
  if (fs.existsSync(credsPath)) {
    const c = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    c.openid ? ok('cred has openid') : fail('cred openid', 'missing');
    c.encryption_key ? ok('cred has encryption_key') : fail('cred encryption_key', 'missing');
    c.agent_id ? ok('cred has agent_id') : fail('cred agent_id', 'missing');
  }

  const lockPath = path.join(oceanbusDir, `agent-${WIN}.lock`);
  fs.existsSync(lockPath) ? ok('lock file') : fail('lock file', 'not found');
  if (fs.existsSync(lockPath)) {
    const l = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    l.pid ? ok('lock has pid') : fail('lock pid', 'missing');
    l.procStart ? ok('lock has procStart') : fail('lock procStart', 'missing');
  }

  // B2: Cloud sees the window
  const cwAfter = await fetchJSON(`${GATEWAY_URL}/api/windows?h5_openid=${H5_ID}`);
  cwAfter.some(w => w.name === WIN && w.status === 'online') ? ok('Cloud shows window online') : fail('Cloud window', JSON.stringify(cwAfter));

  // ═══════════════════════════════════════════════════
  //  SECTION C: Subcommands
  // ═══════════════════════════════════════════════════
  log('═══ C: Subcommands ═══');

  // C1: status
  const st = cmd(['status', '--json']);
  try {
    const s = JSON.parse(st.stdout);
    s.online ? ok('status --json (online)') : fail('status', 'offline');
    s.window === WIN ? ok('status window name') : fail('status window', s.window);
    (s.inbox !== undefined) ? ok('status inbox count') : fail('status inbox', 'missing');
  } catch { fail('status', 'invalid JSON: ' + st.stdout.slice(0, 60)); }

  // C2: inbox (should be empty at start)
  const ib0 = cmd(['inbox']);
  ib0.stdout === '[]' ? ok('inbox (empty)') : fail('inbox empty', ib0.stdout.slice(0, 60));

  // C3: Send H5 message → verify inbox
  const s1 = await fetchJSON(`${GATEWAY_URL}/api/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ h5_openid: H5_ID, window: WIN, text: '测试消息A', msg_id: 'c3' }),
  });
  s1.ok ? ok('H5 send message') : fail('H5 send', JSON.stringify(s1));
  await sleep(4000);

  const ib1 = cmd(['inbox']);
  try {
    const msgs = JSON.parse(ib1.stdout);
    msgs.length >= 1 ? ok('inbox (1 msg)') : fail('inbox 1', ib0.stdout.slice(0, 60));
  } catch { fail('inbox 1', 'parse error'); }

  // C4: inbox --clear
  const s2 = await fetchJSON(`${GATEWAY_URL}/api/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ h5_openid: H5_ID, window: WIN, text: '测试消息B', msg_id: 'c4' }),
  });
  await sleep(4000);
  const ibClear = cmd(['inbox', '--clear']);
  try {
    const msgs = JSON.parse(ibClear.stdout);
    msgs.length >= 2 ? ok('inbox --clear (reads all)') : fail('inbox --clear', `${msgs.length} msgs`);
  } catch { fail('inbox --clear', 'parse error'); }
  cmd(['inbox']).stdout === '[]' ? ok('inbox empty after clear') : fail('inbox after clear', 'not empty');

  // C5: ack
  const s3 = await fetchJSON(`${GATEWAY_URL}/api/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ h5_openid: H5_ID, window: WIN, text: '测试消息C', msg_id: 'c5' }),
  });
  await sleep(4000);
  const ackR = cmd(['ack']);
  try {
    const a = JSON.parse(ackR.stdout);
    (a.ok && a.cleared >= 1) ? ok(`ack (cleared ${a.cleared})`) : fail('ack', JSON.stringify(a));
  } catch { fail('ack', 'parse error'); }

  // C6: reply
  const replyR = cmd(['reply', '--text', '回归测试回复']);
  try {
    const r = JSON.parse(replyR.stdout);
    r.ok ? ok('reply') : fail('reply', JSON.stringify(r));
  } catch { fail('reply', 'parse error: ' + replyR.stdout.slice(0, 60)); }

  // ═══════════════════════════════════════════════════
  //  SECTION D: MCP Server
  // ═══════════════════════════════════════════════════
  log('═══ D: MCP Server ═══');

  const ms = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ob_status', arguments: {} } });
  ms[0]?.result ? ok('MCP ob_status') : fail('MCP ob_status', JSON.stringify(ms).slice(0, 80));

  const mi = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ob_inbox', arguments: {} } });
  mi[0]?.result ? ok('MCP ob_inbox') : fail('MCP ob_inbox', JSON.stringify(mi).slice(0, 80));

  const mr = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ob_reply', arguments: { text: 'MCP测试' } } });
  mr[0]?.result ? ok('MCP ob_reply') : fail('MCP ob_reply', JSON.stringify(mr).slice(0, 80));

  const ma = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ob_ack', arguments: {} } });
  ma[0]?.result ? ok('MCP ob_ack') : fail('MCP ob_ack', JSON.stringify(ma).slice(0, 80));

  const ml = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  (ml[0]?.result?.tools?.length === 4) ? ok('MCP tools/list (4)') : fail('MCP tools/list', `${ml[0]?.result?.tools?.length}`);

  const me = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ob_reply', arguments: {} } });
  me[0]?.error?.code === -32602 ? ok('MCP missing param → error') : fail('MCP error handling', JSON.stringify(me).slice(0, 80));

  // ═══════════════════════════════════════════════════
  //  SECTION E: reply-ob.cjs
  // ═══════════════════════════════════════════════════
  log('═══ E: reply-ob.cjs ═══');
  const rob = spawnSync(process.execPath, [
    REPLY, '--text', '云测回复', '--h5-openid', boardOpenId,
    '--window', WIN, '--window-name', WIN,
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 15_000 });
  rob.stdout.trim() === 'OK' ? ok('reply-ob.cjs') : fail('reply-ob.cjs', rob.stdout.trim() || rob.stderr.trim() || 'no output');

  // ═══════════════════════════════════════════════════
  //  SECTION F: Cloud Session Persistence
  // ═══════════════════════════════════════════════════
  log('═══ F: Persistence ═══');
  await sleep(5000);
  const sessionsFile = path.join(os.homedir(), '.oceanbus-console', 'sessions.json');
  if (fs.existsSync(sessionsFile)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    (sessions.users && Object.keys(sessions.users).length > 0) ? ok('sessions.json saved') : fail('sessions.json', 'empty');
  } else { fail('sessions.json', 'not found'); }

  // ═══════════════════════════════════════════════════
  //  SECTION G: Stop & Cleanup
  // ═══════════════════════════════════════════════════
  log('═══ G: Stop ═══');
  cmd(['stop']);
  await sleep(2000);

  const st2 = cmd(['status', '--json']);
  try {
    JSON.parse(st2.stdout).online ? fail('stop', 'still online') : ok('daemon stopped');
  } catch { ok('daemon stopped'); }

  fs.existsSync(lockPath) ? fail('lock cleaned', 'still exists') : ok('lock file cleaned');

  // ── Summary ────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed}/${total} passed (${failed} failed)    ║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.detail}`));
  }

  // Cleanup
  try { cloudChild.kill(); } catch {}
  if (fs.existsSync(windowsDir)) fs.rmSync(windowsDir, { recursive: true, force: true });
  if (fs.existsSync(PEER_FILE)) fs.unlinkSync(PEER_FILE);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Harness error:', e.message); process.exit(2); });
