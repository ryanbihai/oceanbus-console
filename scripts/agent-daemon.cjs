#!/usr/bin/env node
/**
 * OceanBus Console — Agent Daemon
 *
 * Always runs in foreground. Backgrounding handled by hooks shell command (&).
 * Uses oceanbus SDK as a library.
 *
 *   agent-daemon.cjs                    → run agent
 *   agent-daemon.cjs stop               → kill running daemon
 *   agent-daemon.cjs status [--json]    → daemon status
 *   agent-daemon.cjs inbox [--clear]    → read pending messages
 *   agent-daemon.cjs ack                → clear inbox
 *   agent-daemon.cjs reply --text "..." → send reply via OB
 *
 * Identity: ~/.oceanbus/windows/<name>/credentials.json (per-window)
 * Peer:     <project>/.ob-console-peer.json          (project-level)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Config ──────────────────────────────────────────────────
const OCEANBUS_DIR = path.join(os.homedir(), '.oceanbus');
const WINDOWS_DIR = path.join(OCEANBUS_DIR, 'windows');

// ── Subcommand routing ──────────────────────────────────────
const subCmd = process.argv[2];
if (subCmd === 'stop')     { stopDaemon(); process.exit(0); }
if (subCmd === 'status')   { statusDaemon(); process.exit(0); }
if (subCmd === 'context')  { statusDaemon(); process.exit(0); }
if (subCmd === 'inbox')    { inboxDaemon(); process.exit(0); }
if (subCmd === 'ack')      { ackDaemon(); process.exit(0); }
if (subCmd === 'reply')    { replyDaemon().then(() => process.exit(0)).catch(e => { console.log(JSON.stringify({error:e.message})); process.exit(1); }); /* async exit handled in promise */ }
if (subCmd === 'inbox-monitor') { monitorInbox(); /* blocks forever */ }

// ── Helpers ─────────────────────────────────────────────────
function log(msg) { process.stderr.write(`[ob] ${msg}\n`); }
function loadJSON(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null; } catch { return null; } }
function saveJSON(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function slugify(name) { return name.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_'); }

function windowName() {
  const args = process.argv.slice(subCmd ? 3 : 2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) return args[i + 1];
  }
  if (process.env.OCEANBUS_WINDOW_NAME) return process.env.OCEANBUS_WINDOW_NAME;
  const base = path.basename(process.cwd()) || 'agent';
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const prefix = sessionId ? 'cc-' + sessionId.slice(0, 8) + '-' : '';
  return prefix + base + '-' + process.pid;
}

function credsPath(winName)  { return path.join(WINDOWS_DIR, slugify(winName), 'credentials.json'); }
function inboxPath(winName)  { return path.join(WINDOWS_DIR, slugify(winName), 'inbox.jsonl'); }
function lockPath(winName)   { return path.join(OCEANBUS_DIR, `agent-${slugify(winName)}.lock`); }

function projectPeerFile() { return path.join(process.cwd(), '.ob-console-peer.json'); }
function globalPeerFile()  { return path.join(OCEANBUS_DIR, 'console-peer.json'); }
function loadProjectPeer() { const d = loadJSON(projectPeerFile()) || loadJSON(globalPeerFile()); return d?.peer || ''; }
function loadProjectH5Id() { const d = loadJSON(projectPeerFile()) || loadJSON(globalPeerFile()); return d?.h5id || ''; }
function projectGatewayFile() { return path.join(process.cwd(), '.ob-console-gateway.json'); }
function globalGatewayFile()  { return path.join(OCEANBUS_DIR, 'console-gateway.json'); }
function loadProjectGateway() { const d = loadJSON(projectGatewayFile()) || loadJSON(globalGatewayFile()); return d?.url || ''; }

// ── Subcommand helpers ──────────────────────────────────────
function subArgs() {
  const args = process.argv.slice(3);
  const opts = { clear: false, text: '', json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--text' && i + 1 < args.length) { opts.text = args[++i]; }
    else if (args[i] === '--clear') { opts.clear = true; }
    else if (args[i] === '--json') { opts.json = true; }
  }
  return opts;
}

function findActiveWindow() {
  if (!fs.existsSync(WINDOWS_DIR)) return null;
  const entries = fs.readdirSync(WINDOWS_DIR);
  for (const entry of entries) {
    const lf = lockPath(entry);
    if (!fs.existsSync(lf)) continue;
    const lock = loadJSON(lf);
    const pid = lock?.pid;
    if (!pid) continue;
    try { process.kill(pid, 0); return { name: entry, pid }; } catch {}
  }
  return null;
}

// ── Stop ────────────────────────────────────────────────────
function stopDaemon() {
  if (!fs.existsSync(WINDOWS_DIR)) { log('no windows directory'); return; }
  const entries = fs.readdirSync(WINDOWS_DIR);
  for (const entry of entries) {
    const lf = lockPath(entry);
    if (!fs.existsSync(lf)) continue;
    const lock = loadJSON(lf);
    const pid = lock?.pid;
    if (!pid) continue;
    try {
      log(`stopping ${entry} (PID ${pid})...`);
      if (process.platform === 'win32') {
        require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
        const start = Date.now();
        while (Date.now() - start < 3000) { try { process.kill(pid, 0); } catch { break; } }
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      fs.unlinkSync(lf);
      log(`stopped ${entry}`);
    } catch (e) { log(`stop failed for ${entry}: ${e.message}`); }
  }
}

// ── Status ─────────────────────────────────────────────────
function statusDaemon() {
  const opts = subArgs();
  const active = findActiveWindow();
  if (!active) { console.log(opts.json ? '{"online":false}' : 'OceanBus Agent: offline'); return; }
  const peer = loadProjectPeer();
  const ibPath = inboxPath(active.name);
  let inboxCount = 0;
  if (fs.existsSync(ibPath)) inboxCount = fs.readFileSync(ibPath, 'utf-8').split('\n').filter(l => l.trim()).length;
  console.log(opts.json ? JSON.stringify({
    online: true, window: active.name, pid: active.pid,
    peer: peer ? 'bound' : 'unpaired', inbox: inboxCount,
  }) : `OceanBus Agent: online | window: ${active.name} | peer: ${peer ? 'bound' : 'unpaired'} | inbox: ${inboxCount}`);
}

// ── Inbox ──────────────────────────────────────────────────
function inboxDaemon() {
  const opts = subArgs();
  const active = findActiveWindow();
  if (!active) { console.log('[]'); return; }
  const ibPath = inboxPath(active.name);
  if (!fs.existsSync(ibPath)) { console.log('[]'); return; }
  const lines = fs.readFileSync(ibPath, 'utf-8').split('\n').filter(l => l.trim());
  const msgs = lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  console.log(JSON.stringify(msgs, null, 2));
  if (opts.clear) { fs.writeFileSync(ibPath, ''); log(`inbox cleared (${msgs.length} msg)`); }
}

// ── Ack ────────────────────────────────────────────────────
function ackDaemon() {
  const active = findActiveWindow();
  if (!active) { console.log('{"ok":false,"error":"no active window"}'); return; }
  const ibPath = inboxPath(active.name);
  let count = 0;
  if (fs.existsSync(ibPath)) { count = fs.readFileSync(ibPath, 'utf-8').split('\n').filter(l => l.trim()).length; fs.writeFileSync(ibPath, ''); }
  console.log(JSON.stringify({ ok: true, cleared: count }));
  log(`ack: cleared ${count} messages`);
}

// ── Inbox Monitor (real-time message stream for CC AI Monitor tool) ──
function monitorInbox() {
  const active = findActiveWindow();
  if (!active) {
    process.stdout.write(JSON.stringify({ type: 'error', text: 'no active daemon window found' }) + '\n');
    process.exit(1);
  }
  const ibPath = inboxPath(active.name);
  let lastSize = 0;
  if (fs.existsSync(ibPath)) lastSize = fs.statSync(ibPath).size;

  process.stdout.write(JSON.stringify({ type: 'ready', window: active.name, peer: loadProjectPeer() ? 'bound' : 'unpaired' }) + '\n');

  const poll = setInterval(() => {
    try {
      if (!fs.existsSync(ibPath)) return;
      const stat = fs.statSync(ibPath);
      if (stat.size < lastSize) lastSize = 0; // file was truncated (e.g. inbox --clear)
      if (stat.size <= lastSize) return;

      const fd = fs.openSync(ibPath, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;

      const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            type: 'wechat_msg',
            chat_id: 'h5',
            sender: msg.sender || 'h5',
            text: msg.text || '',
            window: msg.window || active.name,
            time: msg.time || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            reply_style: 'detailed',
          }) + '\n');
        } catch {
          process.stdout.write(JSON.stringify({ type: 'message', raw: line }) + '\n');
        }
      }
    } catch { /* file temporarily unavailable, retry next interval */ }
  }, 1000);

  process.on('SIGINT', () => { clearInterval(poll); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(poll); process.exit(0); });
  setInterval(() => {}, 60_000).unref(); // keep process alive
}

// ── Reply ──────────────────────────────────────────────────
async function replyDaemon() {
  const opts = subArgs();
  if (!opts.text) { console.log('{"error":"--text required"}'); process.exit(1); }
  const active = findActiveWindow();
  if (!active) { console.log('{"error":"no active window"}'); process.exit(1); }
  const creds = loadJSON(credsPath(active.name));
  if (!creds?.openid) { console.log('{"error":"no credentials"}'); process.exit(1); }
  const boardOpenId = loadProjectPeer();
  if (!boardOpenId) { console.log('{"error":"no peer (pair first)"}'); process.exit(1); }
  const h5Id = loadProjectH5Id() || boardOpenId;
  const oceanbus = await import('oceanbus');
  const ob = await oceanbus.createOceanBus({
    keyStore: { type: 'memory' },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid, encryption_key: creds.encryption_key },
  });
  try {
    await ob.send(boardOpenId, JSON.stringify({
      action: 'reply', window: active.name, text: opts.text, h5_openid: h5Id, from: 'agent',
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    }));
    console.log(JSON.stringify({ ok: true }));
    log(`reply sent: ${opts.text.slice(0, 40)}`);
  } catch (e) { console.log(JSON.stringify({ error: e.message })); }
  await ob.destroy().catch(() => {});
}

// ═══════════════════════════════════════════════════════════
// Agent (always foreground) — only when no subcommand
// ═══════════════════════════════════════════════════════════

if (subCmd) return; // subcommand handled above (sync: process.exit already, reply: async exit in promise)

const yargs = require('yargs');
const argv = yargs(process.argv.slice(2))
  .option('name', { type: 'string' })
  .option('peer', { type: 'string' })
  .option('temp-identity', { type: 'boolean', default: false })
  .parse();

const finalWin = windowName();

// Already running check
const lf = lockPath(finalWin);
if (fs.existsSync(lf)) {
  const lock = loadJSON(lf);
  if (lock?.pid) {
    try { process.kill(lock.pid, 0); log(`daemon already running (PID ${lock.pid}).`); process.exit(0); } catch {}
  }
}

// ── Utilities ──────────────────────────────────────────────
function isPidAlive(pid) {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction Stop"`, { timeout: 3000, stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 0); return true;
  } catch { return false; }
}

function procStartToken() {
  const bigNow = BigInt(Date.now()) * 1000000n;
  const hrtime = typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint() % 1000000n : 0n;
  return String(bigNow + hrtime);
}

function acquireLock(winName) {
  const lockFile = lockPath(winName);
  try {
    if (fs.existsSync(lockFile)) {
      const old = loadJSON(lockFile);
      const oldPid = old?.pid || parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid && isPidAlive(oldPid)) {
        log(`killing previous instance "${winName}" (PID ${oldPid})...`);
        try { process.kill(oldPid, 'SIGTERM'); } catch { try { process.kill(oldPid, 'SIGKILL'); } catch {} }
        const start = Date.now();
        while (isPidAlive(oldPid) && Date.now() - start < 3000) {}
      }
    }
  } catch {}
  fs.mkdirSync(OCEANBUS_DIR, { recursive: true });
  saveJSON(lockFile, { pid: process.pid, procStart: procStartToken(), windowName: winName });
}

function releaseLock(winName) {
  try {
    const lockFile = lockPath(winName);
    if (fs.existsSync(lockFile)) {
      const d = loadJSON(lockFile);
      if (d?.pid === process.pid || String(d?.pid) === String(process.pid)) fs.unlinkSync(lockFile);
    }
  } catch {}
}

function isCC() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}

function saveProjectPeer(peer, h5id) {
  const data = { peer, savedAt: new Date().toISOString() };
  if (h5id) data.h5id = h5id;
  saveJSON(projectPeerFile(), data);
  saveJSON(globalPeerFile(), data);
  log(`peer saved: ${peer.slice(0, 8)}...`);
}

// ── RestartGuard ──────────────────────────────────────────
function guardPath(winName) {
  return path.join(OCEANBUS_DIR, `agent-${slugify(winName)}-guard.json`);
}

function checkRestartGuard(winName) {
  const gf = guardPath(winName);
  const now = Date.now();
  let guard = loadJSON(gf) || { restarts: [], blocked: false };
  // Clean entries older than 60s
  guard.restarts = (guard.restarts || []).filter(t => now - new Date(t).getTime() < 60_000);
  // Unblock after 5 minutes
  if (guard.blocked && now - new Date(guard.blockedAt || 0).getTime() > 300_000) {
    guard.blocked = false;
  }
  // Check limit
  if (guard.restarts.length >= 10) {
    guard.blocked = true;
    guard.blockedAt = new Date().toISOString();
    saveJSON(gf, guard);
    log('RestartGuard: BLOCKED — too many restarts (10+ in 60s). Check agent.log for crash cause.');
    return false;
  }
  // Allow but track
  guard.restarts.push(new Date().toISOString());
  saveJSON(gf, guard);
  return true;
}

function clearRestartGuard(winName) {
  const gf = guardPath(winName);
  if (fs.existsSync(gf)) fs.unlinkSync(gf);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  // Pre-flight: check SDK availability, auto-install if missing
  try { require.resolve('oceanbus'); } catch {
    log('oceanbus SDK not found. Auto-installing...');
    try {
      require('child_process').execSync('npm install -g oceanbus@latest', { stdio: 'inherit', timeout: 60_000 });
      log('SDK installed successfully.');
    } catch (e) {
      log('FATAL: Failed to install oceanbus SDK. Run manually: npm install -g oceanbus@latest');
      process.exit(1);
    }
  }

  if (!checkRestartGuard(finalWin)) process.exit(1);

  const tempIdentity = !!argv['temp-identity'];
  const ccMode = isCC();

  acquireLock(finalWin);

  // OB identity
  const oceanbus = await import('oceanbus');
  let ob = await oceanbus.createOceanBus({ keyStore: { type: 'memory' } });
  let creds;
  const cPath = credsPath(finalWin);

  if (tempIdentity) {
    log('Creating temporary identity...');
    await ob.createIdentity();
    const openid = await ob.getAddress();
    const state = ob.identity.exportState();
    creds = { agent_id: state.agent_id, api_key: state.api_key, openid, encryption_key: state.encryption_key };
    log(`temp identity: ${creds.openid.slice(0, 8)}...`);
  } else {
    creds = loadJSON(cPath);
    if (creds?.openid && creds?.encryption_key && creds?.agent_id) {
      ob = await oceanbus.createOceanBus({
        keyStore: { type: 'memory' },
        identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid, encryption_key: creds.encryption_key },
      });
    } else {
      log('No per-window identity. Creating new...');
      await ob.createIdentity();
      const openid = await ob.getAddress();
      const state = ob.identity.exportState();
      creds = { agent_id: state.agent_id, api_key: state.api_key, openid, encryption_key: state.encryption_key };
      saveJSON(cPath, creds);
      log(`new identity: ${creds.openid.slice(0, 8)}...`);
    }
  }
  const myAddr = await ob.getAddress();

  // Peer (Cloud OB address for routing) + h5id (Board UUID for user identification)
  let peerOpenId = argv.peer || '';
  if (!peerOpenId) peerOpenId = loadProjectPeer();
  if (!peerOpenId) peerOpenId = process.env.OB_CONSOLE_PEER || '';
  const h5Id = loadProjectH5Id() || peerOpenId; // fallback: use peer as h5id for old pairing commands
  if (argv.peer) saveProjectPeer(argv.peer, h5Id);

  log(`ob: ${myAddr.slice(0, 8)}...  window: ${finalWin}  mode: ${ccMode ? 'CC' : 'terminal'}  identity: ${tempIdentity ? 'temp' : 'persisted'}`);
  if (peerOpenId) log(`peer: ${peerOpenId.slice(0, 8)}...  h5id: ${h5Id.slice(0, 8)}...`);

  // Board OB is --peer value. Agent sends directly to it — Cloud proxies for browser.
  // No HTTP bootstrap needed. No Cloud OB. Just Board OB ↔ Agent OB.

  // window-open → Board OB
  if (peerOpenId) {
    try {
      await ob.send(peerOpenId, JSON.stringify({
        action: 'window-open', window: finalWin, cwd: process.cwd(),
        agent_name: finalWin, agent_openid: myAddr, agent_type: 'cc-window', h5_openid: h5Id,
      }));
      log(`window-open → Board (${finalWin})`);

      await ob.send(peerOpenId, JSON.stringify({
        action: 'message',
        window: finalWin,
        text: `👋 ${finalWin} 上线了！`,
        from: 'agent',
        h5_openid: h5Id,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      })).catch(() => {});
    } catch (e) { log(`window-open failed: ${e.message}`); }
  }

  // Heartbeat → Board OB
  const heartbeat = peerOpenId ? setInterval(() => {
    const cur = windowName();
    ob.send(peerOpenId, JSON.stringify({
      action: 'heartbeat', window: finalWin,
      newname: cur !== finalWin ? cur : undefined,
      agent_openid: myAddr, h5_openid: h5Id,
    })).catch(() => {});
  }, 15_000) : null;

  // Message dedup
  const seen = new Map();

  // OB listener
  ob.startListening(async (msg) => {
    if (msg.from_openid === myAddr) return;
    let parsed;
    try { parsed = JSON.parse(msg.content || '{}'); } catch { parsed = { text: msg.content || '' }; }
    const action = parsed.action || parsed.type || 'message';
    const text = parsed.text || '';
    const msgWindow = parsed.window || '';

    const now = Date.now();
    for (const [k, t] of seen) { if (now - t > 5000) seen.delete(k); }
    if (seen.has(`${msg.from_openid}:${text.slice(0, 50)}`)) return;
    seen.set(`${msg.from_openid}:${text.slice(0, 50)}`, now);

    if (msgWindow && msgWindow !== finalWin) return;

    const time = new Date(msg.created_at || now).toLocaleTimeString('zh-CN', { hour12: false });

    if ((action === 'message' || action === 'reply' || action === 'command') && text) {
      // Append to inbox
      try {
        fs.mkdirSync(path.dirname(inboxPath(finalWin)), { recursive: true });
        fs.appendFileSync(inboxPath(finalWin), JSON.stringify({
          type: 'wechat_msg', chat_id: 'h5', sender: parsed.from || 'h5',
          text, window: msgWindow || finalWin, time,
        }) + '\n');
      } catch {}

      // Emit to CC (Monitor JSON)
      if (ccMode) {
        process.stdout.write(JSON.stringify({
          type: 'wechat_msg', chat_id: 'h5', sender: parsed.from || 'h5',
          text, window: msgWindow || finalWin, time, reply_style: 'detailed',
        }) + '\n');
      } else {
        console.log(`[${msgWindow || finalWin}] ${parsed.from || 'h5'}: ${text}`);
      }

      // Auto-ack to H5
      if (parsed.from === 'h5' && peerOpenId) {
        ob.send(peerOpenId, JSON.stringify({
          action: 'reply', window: msgWindow || finalWin, text: '已收到',
          from: 'agent', h5_openid: h5Id,
          msg_id: parsed.msg_id ? 'ack_' + parsed.msg_id : undefined,
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        })).catch(() => {});
      }
    }
  });

  // Stdin listener (CC AI → OB reply)
  if (ccMode && peerOpenId) {
    let stdinBuf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      stdinBuf += chunk;
      const lines = stdinBuf.split('\n');
      stdinBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          if (req.type === 'reply' && req.text && peerOpenId) {
            ob.send(peerOpenId, JSON.stringify({
              action: 'reply', window: req.window || finalWin, text: req.text,
              h5_openid: h5Id, from: 'agent',
              time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            })).catch(() => {});
          }
        } catch {}
      }
    });
  }

  log('ready');
  clearRestartGuard(finalWin); // daemon stable — reset guard
  if (ccMode) process.stdout.write(JSON.stringify({ type: 'ready', window: finalWin, peer: peerOpenId ? 'bound' : 'unpaired' }) + '\n');

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down...');
    releaseLock(finalWin);
    if (heartbeat) clearInterval(heartbeat);
    if (peerOpenId) {
      try { await ob.send(peerOpenId, JSON.stringify({ action: 'window-close', window: finalWin, h5_openid: h5Id })); } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
