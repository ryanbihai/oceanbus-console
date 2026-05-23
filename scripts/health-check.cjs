#!/usr/bin/env node
/**
 * OceanBus Console — Health Check + Error Tracker
 *
 * Usage:
 *   node health-check.cjs           # full health report
 *   node health-check.cjs --json    # machine-readable
 *
 * Checks:
 *   1. SDK available (oceanbus npm package)
 *   2. Daemon alive (lock file + PID)
 *   3. Cloud reachable (HTTP /api/status)
 *   4. Peer bound (project or global peer file)
 *   5. RestartGuard status
 *   6. Hook failure tracking
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const OCEANBUS_DIR = path.join(os.homedir(), '.oceanbus');
const WINDOWS_DIR = path.join(OCEANBUS_DIR, 'windows');
const FAILURES_FILE = path.join(OCEANBUS_DIR, 'console-failures.json');
const DEFAULT_GATEWAY = process.env.OB_CONSOLE_URL || 'http://127.0.0.1:3456';

// CLI modes: track-success | track-failure "msg" | (default: health check)
const mode = process.argv[2];
if (mode === 'track-success') { trackSuccess(); process.exit(0); }
if (mode === 'track-failure') { trackFailure(process.argv[3] || 'unknown'); process.exit(0); }

const jsonMode = process.argv.includes('--json');

function loadJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null; } catch { return null; } }
function saveJSON(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const checks = [];

function check(name, passed, detail) {
  checks.push({ name, status: passed ? 'ok' : 'fail', detail: detail || '' });
}

// 1. SDK availability
try { require.resolve('oceanbus'); check('SDK', true); }
catch { check('SDK', false, 'npm install -g oceanbus@latest'); }

// 2. Daemon alive
let daemonWindow = null;
if (fs.existsSync(WINDOWS_DIR)) {
  for (const entry of fs.readdirSync(WINDOWS_DIR)) {
    const lf = path.join(OCEANBUS_DIR, `agent-${entry}.lock`);
    if (!fs.existsSync(lf)) continue;
    const lock = loadJSON(lf);
    if (!lock?.pid) continue;
    try { process.kill(lock.pid, 0); daemonWindow = entry; break; } catch {}
  }
}
check('Daemon', !!daemonWindow, daemonWindow ? `window: ${daemonWindow}` : 'no daemon running');

// 3. Peer bound
let peerBound = false;
const globalPeer = loadJSON(path.join(OCEANBUS_DIR, 'console-peer.json'));
const projectPeer = loadJSON(path.join(process.cwd(), '.ob-console-peer.json'));
if (globalPeer?.peer || projectPeer?.peer) peerBound = true;
check('Peer', peerBound, peerBound ? 'bound' : 'unpaired — paste pairing command');

// 4. Cloud reachable (async, check last)
async function checkCloud() {
  try {
    const res = await fetch(`${DEFAULT_GATEWAY}/api/status`);
    const data = await res.json();
    check('Cloud', data.ok, `users: ${data.users || '?'}`);
  } catch {
    check('Cloud', false, `unreachable at ${DEFAULT_GATEWAY}`);
  }
  finish();
}

// 5. RestartGuard
if (daemonWindow) {
  const gf = path.join(OCEANBUS_DIR, `agent-${daemonWindow}-guard.json`);
  const guard = loadJSON(gf);
  if (guard?.blocked) {
    check('RestartGuard', false, `BLOCKED at ${guard.blockedAt} — ${(guard.restarts||[]).length} restarts`);
  } else if (guard) {
    check('RestartGuard', true, `${(guard.restarts||[]).length} restarts in last 60s`);
  } else {
    check('RestartGuard', true, 'clean');
  }
} else {
  check('RestartGuard', true, 'no daemon');
}

// 6. Hook failure tracking
const failures = loadJSON(FAILURES_FILE) || { count: 0, lastFailure: null };
if (failures.count > 0) {
  check('Hooks', failures.count < 3, `${failures.count} recent failures${failures.lastFailure ? ', last: ' + failures.lastFailure : ''}`);
} else {
  check('Hooks', true, 'clean');
}

function trackFailure(error) {
  const f = loadJSON(FAILURES_FILE) || { count: 0, lastFailure: null };
  f.count = (f.count || 0) + 1;
  f.lastFailure = new Date().toISOString();
  f.lastError = error;
  saveJSON(FAILURES_FILE, f);
  if (f.count >= 3) {
    process.stderr.write(`[health] WARNING: ${f.count} consecutive hook failures. Last: ${error}\n`);
  }
}

function trackSuccess() {
  if (fs.existsSync(FAILURES_FILE)) {
    const f = loadJSON(FAILURES_FILE);
    if (f && f.count > 0) {
      f.count = 0;
      f.lastSuccess = new Date().toISOString();
      saveJSON(FAILURES_FILE, f);
    }
  }
}

function finish() {
  if (jsonMode) {
    console.log(JSON.stringify({
      checks: checks.map(c => ({ name: c.name, status: c.status, detail: c.detail })),
      allPassed: checks.every(c => c.status === 'ok'),
    }));
  } else {
    console.log('OceanBus Console Health Check');
    console.log('─────────────────────────────');
    for (const c of checks) {
      const icon = c.status === 'ok' ? '✅' : '❌';
      console.log(`  ${icon} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
    }
    const ok = checks.filter(c => c.status === 'ok').length;
    console.log(`\n  ${ok}/${checks.length} checks passed`);
  }
  process.exit(checks.every(c => c.status === 'ok') ? 0 : 1);
}

// Export for use by hooks
module.exports = { trackFailure, trackSuccess };

// Cloud check is async — run last
checkCloud();
